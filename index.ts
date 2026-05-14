/**
 * Lesson Extractor — Pi extension that extracts reusable problem-solving patterns
 * from session transcripts.
 *
 * Lifecycle:
 * - session_shutdown: fast heuristic pattern detection on current session entries
 * - session_start: check for pending candidates, show notification count,
 *   run auto-promotion pipeline
 *
 * Tools:
 * - lesson_candidates: list pending lesson candidates
 * - lesson_accept: promote a candidate to a pi-memory lesson
 * - lesson_reject: reject a candidate
 *
 * Commands:
 * - /lessons-review: interactive review of pending candidates
 */
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { CandidateStore } from "./candidate-store.js";
import { extractPatterns } from "./pattern-detector.js";
import { loadState, saveState, markSessionAnalyzed } from "./state.js";
import type { ExtractorState } from "./types.js";

// pi-memory's store for promoting lessons
import { MemoryStore } from "../pi-memory/src/store.js";

type ToolResult = AgentToolResult<unknown>;
function ok(text: string): ToolResult { return { content: [{ type: "text", text }], details: {} }; }

const CANDIDATE_DB_PATH = join(homedir(), ".pi", "agent", "lesson-extractor", "candidates.db");
const MEMORY_DB_PATH = join(homedir(), ".pi", "memory", "memory.db");

export default function (pi: ExtensionAPI) {
  let candidateStore: CandidateStore | null = null;
  let extractorState: ExtractorState | null = null;

  // ─── Lifecycle ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      candidateStore = new CandidateStore(CANDIDATE_DB_PATH);
      extractorState = loadState();

      // Run auto-promotion pipeline
      const promoted = runAutoPromotion(candidateStore);

      // Expire stale candidates
      const expired = candidateStore.expireStale();
      if (expired > 0 && extractorState) {
        extractorState.stats.expired += expired;
      }

      // Notify about auto-promotions from recent sessions
      const recentPromotions = candidateStore.getRecentPromotions(48);
      for (const lesson of recentPromotions) {
        ctx.ui.notify(
          `Auto-learned: [${lesson.category}] ${lesson.rule.slice(0, 80)}...`,
          "info",
        );
      }

      // Show pending candidate count
      const pendingCount = candidateStore.countByStatus("candidate");
      const reviewableCount = candidateStore.getReviewable().length;
      if (reviewableCount >= 3) {
        ctx.ui.setStatus(
          "lesson-extractor",
          `📝 ${reviewableCount} lesson candidates ready for review (/lessons-review)`,
        );
        setTimeout(() => ctx.ui.setStatus("lesson-extractor", ""), 8000);
      } else if (pendingCount > 0) {
        ctx.ui.setStatus(
          "lesson-extractor",
          `📝 ${pendingCount} lesson candidate(s) accumulating`,
        );
        setTimeout(() => ctx.ui.setStatus("lesson-extractor", ""), 5000);
      }

      // Save updated state
      if (extractorState) {
        extractorState.stats.autoPromoted += promoted;
        saveState(extractorState);
      }
    } catch (err: any) {
      // Don't crash pi if extension fails to initialize
      console.error(`lesson-extractor: startup error: ${err.message}`);
    }
  });

  // Extract lessons when switching sessions (/new, /resume)
  pi.on("session_before_switch", async (_event, ctx) => {
    if (!candidateStore || !extractorState) return;

    try {
      const entries = ctx.sessionManager.getBranch();

      if (entries.length < 5) return;

      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = sessionFile?.match(/([a-f0-9-]{36})/)?.[1] || `anon-${Date.now()}`;

      const startTime = Date.now();
      const candidates = extractPatterns(entries, sessionId);
      const elapsed = Date.now() - startTime;

      if (candidates.length > 0) {
        for (const candidate of candidates) {
          candidateStore.upsert(candidate);
        }

        extractorState.stats.totalCandidatesExtracted += candidates.length;
        console.error(
          `lesson-extractor: extracted ${candidates.length} candidates in ${elapsed}ms (session switch)`,
        );
      }

      markSessionAnalyzed(extractorState, sessionId);
      saveState(extractorState);
    } catch (err: any) {
      console.error(`lesson-extractor: session_before_switch error: ${err.message}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!candidateStore || !extractorState) return;

    try {
      const entries = ctx.sessionManager.getBranch();

      // Skip trivial sessions
      if (entries.length < 5) {
        candidateStore.close();
        candidateStore = null;
        return;
      }

      // Get a stable session ID
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = sessionFile?.match(/([a-f0-9-]{36})/)?.[1] || `anon-${Date.now()}`;

      // Fast pattern extraction (target < 5s)
      const startTime = Date.now();
      const candidates = extractPatterns(entries, sessionId);
      const elapsed = Date.now() - startTime;

      if (candidates.length > 0) {
        for (const candidate of candidates) {
          candidateStore.upsert(candidate);
        }

        extractorState.stats.totalCandidatesExtracted += candidates.length;
        console.error(
          `lesson-extractor: extracted ${candidates.length} candidates in ${elapsed}ms`,
        );
      }

      // Mark session as analyzed
      markSessionAnalyzed(extractorState, sessionId);
      saveState(extractorState);
    } catch (err: any) {
      // Best-effort — never crash on shutdown
      console.error(`lesson-extractor: shutdown error: ${err.message}`);
    } finally {
      candidateStore?.close();
      candidateStore = null;
    }
  });

  // ─── Auto-Promotion Pipeline ────────────────────────────────────

  function runAutoPromotion(store: CandidateStore): number {
    let promoted = 0;

    try {
      const promotable = store.getPromotable();
      if (promotable.length === 0) return 0;

      const memoryStore = new MemoryStore(MEMORY_DB_PATH);
      try {
        for (const candidate of promotable) {
          const result = memoryStore.addLesson(
            candidate.rule,
            candidate.category,
            "lesson-extractor",
            candidate.negative,
          );

          if (result.success && result.id) {
            store.promote(candidate.id, result.id);
            promoted++;
          } else if (result.reason === "duplicate" || result.reason === "similar") {
            // Already exists in memory — mark as promoted to avoid re-processing
            store.promote(candidate.id, result.id || "duplicate");
          }
        }
      } finally {
        memoryStore.close();
      }
    } catch (err: any) {
      console.error(`lesson-extractor: auto-promotion error: ${err.message}`);
    }

    return promoted;
  }

  // ─── Tools ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "lesson_candidates",
    label: "Lesson Candidates",
    description: "List pending lesson candidates extracted from session patterns. Shows candidates awaiting review or auto-promotion.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status: candidate, promoted, rejected, expired (default: candidate)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!candidateStore) return ok("Lesson extractor not initialized.");

      const status = params.status || "candidate";
      const items = candidateStore.list(status, params.limit ?? 20);

      if (items.length === 0) {
        return ok(`No ${status} lesson candidates found.`);
      }

      const stats = candidateStore.stats();
      let text = `## Lesson Candidates (${status})\n`;
      text += `Total: ${stats.total} | Active: ${stats.candidate} | Promoted: ${stats.promoted} | Rejected: ${stats.rejected}\n\n`;

      for (const item of items) {
        const neg = item.negative ? "❌ AVOID: " : "✅ ";
        text += `**${item.id.slice(0, 8)}** [${item.type}] ${neg}${item.rule}\n`;
        text += `  Category: ${item.category} | Confidence: ${item.confidence.toFixed(2)} | Frequency: ${item.frequency} | Sessions: ${item.session_ids.length}\n`;
        text += `  First seen: ${item.first_seen.slice(0, 10)} | Last: ${item.last_seen.slice(0, 10)}\n\n`;
      }

      return ok(text);
    },
  });

  pi.registerTool({
    name: "lesson_accept",
    label: "Lesson Accept",
    description: "Promote a lesson candidate to a permanent pi-memory lesson.",
    parameters: Type.Object({
      id: Type.String({ description: "Candidate ID (or prefix)" }),
      rule: Type.Optional(Type.String({ description: "Override rule text before promoting" })),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!candidateStore) return ok("Lesson extractor not initialized.");

      // Find by ID or prefix
      const candidate = findByIdOrPrefix(candidateStore, params.id);
      if (!candidate) return ok(`Candidate not found: ${params.id}`);

      if (candidate.status !== "candidate") {
        return ok(`Candidate ${params.id} is already ${candidate.status}.`);
      }

      const ruleText = params.rule || candidate.rule;

      try {
        const memoryStore = new MemoryStore(MEMORY_DB_PATH);
        try {
          const result = memoryStore.addLesson(
            ruleText,
            candidate.category,
            "lesson-extractor",
            candidate.negative,
          );

          if (result.success && result.id) {
            candidateStore!.promote(candidate.id, result.id);
            if (extractorState) {
              extractorState.stats.userPromoted++;
              saveState(extractorState);
            }
            return ok(`✅ Promoted lesson: ${ruleText}\nLesson ID: ${result.id}`);
          } else {
            return ok(`Could not promote: ${result.reason} (existing: ${result.id})`);
          }
        } finally {
          memoryStore.close();
        }
      } catch (err: any) {
        return ok(`Error promoting: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "lesson_reject",
    label: "Lesson Reject",
    description: "Reject a lesson candidate permanently.",
    parameters: Type.Object({
      id: Type.String({ description: "Candidate ID (or prefix)" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!candidateStore) return ok("Lesson extractor not initialized.");

      const candidate = findByIdOrPrefix(candidateStore, params.id);
      if (!candidate) return ok(`Candidate not found: ${params.id}`);

      candidateStore.reject(candidate.id);
      if (extractorState) {
        extractorState.stats.rejected++;
        saveState(extractorState);
      }
      return ok(`Rejected: ${candidate.rule.slice(0, 100)}`);
    },
  });

  // ─── Commands ──────────────────────────────────────────────────

  pi.registerCommand("lessons-review", {
    description: "Review pending lesson candidates extracted from sessions",
    handler: async (_args, ctx) => {
      if (!candidateStore) {
        ctx.ui.notify("Lesson extractor not initialized", "warning");
        return;
      }

      const reviewable = candidateStore.getReviewable();
      if (reviewable.length === 0) {
        ctx.ui.notify("No candidates ready for review (need confidence ≥ 0.60)", "info");
        return;
      }

      // Present candidates for review
      const items = reviewable.map(c => ({
        value: c.id,
        label: `[${c.confidence.toFixed(2)}] [${c.type}] ${c.negative ? "❌ " : ""}${c.rule.slice(0, 80)}`,
      }));

      const selected = await ctx.ui.select(
        `${reviewable.length} Lesson Candidates`,
        items,
        { multi: true },
      );

      if (!selected || selected.length === 0) return;

      const selectedIds = Array.isArray(selected) ? selected : [selected];

      for (const candidateId of selectedIds) {
        const candidate = candidateStore!.get(candidateId);
        if (!candidate) continue;

        const action = await ctx.ui.select(
          `${candidate.rule.slice(0, 60)}...`,
          [
            { value: "accept", label: "✅ Accept — promote to permanent lesson" },
            { value: "reject", label: "❌ Reject — discard permanently" },
            { value: "skip", label: "⏭ Skip — decide later" },
          ],
        );

        if (action === "accept") {
          try {
            const memoryStore = new MemoryStore(MEMORY_DB_PATH);
            try {
              const result = memoryStore.addLesson(
                candidate.rule,
                candidate.category,
                "lesson-extractor",
                candidate.negative,
              );
              if (result.success && result.id) {
                candidateStore!.promote(candidate.id, result.id);
                ctx.ui.notify(`Promoted: ${candidate.rule.slice(0, 60)}...`, "success");
                if (extractorState) extractorState.stats.userPromoted++;
              } else {
                ctx.ui.notify(`Already exists: ${result.reason}`, "info");
                candidateStore!.promote(candidate.id, result.id || "duplicate");
              }
            } finally {
              memoryStore.close();
            }
          } catch (err: any) {
            ctx.ui.notify(`Error: ${err.message}`, "error");
          }
        } else if (action === "reject") {
          candidateStore!.reject(candidate.id);
          ctx.ui.notify(`Rejected: ${candidate.rule.slice(0, 60)}...`, "info");
          if (extractorState) extractorState.stats.rejected++;
        }
      }

      if (extractorState) saveState(extractorState);
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Find a candidate by full ID or prefix match. */
function findByIdOrPrefix(store: CandidateStore, idOrPrefix: string): ReturnType<CandidateStore["get"]> {
  // Try exact match first
  const exact = store.get(idOrPrefix);
  if (exact) return exact;

  // Try prefix match
  const all = store.list(undefined, 200);
  const matches = all.filter(c => c.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];

  return undefined;
}
