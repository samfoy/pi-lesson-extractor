/**
 * Pattern detection algorithms for extracting lessons from session entries.
 *
 * Three detectors:
 * 1. Retry loop detection — same tool fails then succeeds differently
 * 2. Error→fix pair detection — error messages mapped to resolutions
 * 3. User correction detection — user messages that corrected agent behavior
 *
 * All detectors operate on parsed ToolAction sequences extracted from session entries.
 */
import type {
  ToolAction,
  RetryPattern,
  ErrorFixPattern,
  CorrectionPattern,
  ConfirmationPattern,
  LessonCandidate,
} from "./types.js";

// ─── Entry Parsing ───────────────────────────────────────────────────

/**
 * Parse session entries into a flat list of tool actions with their results.
 * Pairs tool_call entries (in assistant messages) with their tool_result entries.
 */
export function parseToolActions(entries: any[]): ToolAction[] {
  const actions: ToolAction[] = [];

  // First pass: collect tool call args from assistant messages
  const toolCallArgs = new Map<string, { toolName: string; args: Record<string, any> }>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall" && block.id) {
          toolCallArgs.set(block.id, {
            toolName: block.toolName || "",
            args: block.arguments || {},
          });
        }
      }
    }
  }

  // Second pass: collect tool results
  let idx = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "toolResult") {
      const callInfo = toolCallArgs.get(msg.toolCallId);
      const resultText = extractResultText(msg.content);
      const isError = !!msg.isError;
      const exitCode = extractExitCode(resultText);

      actions.push({
        index: idx,
        toolName: callInfo?.toolName || msg.toolName || "unknown",
        toolCallId: msg.toolCallId,
        args: callInfo?.args || {},
        result: resultText,
        isError: isError || (exitCode !== undefined && exitCode !== 0),
        exitCode,
      });
    }
    idx++;
  }

  return actions;
}

/**
 * Extract user messages with their positions (for correction detection).
 */
export function parseUserMessages(entries: any[]): Array<{ index: number; text: string }> {
  const messages: Array<{ index: number; text: string }> = [];
  let idx = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
          : "";
      if (text.trim()) {
        messages.push({ index: idx, text: text.trim() });
      }
    }
    idx++;
  }

  return messages;
}

// ─── Retry Loop Detection ────────────────────────────────────────────

/**
 * Detect sequences where the agent retried the same tool on the same target,
 * failed, then eventually succeeded with a different approach.
 */
export function detectRetryLoops(actions: ToolAction[]): RetryPattern[] {
  const patterns: RetryPattern[] = [];

  // Group consecutive actions by (toolName, target)
  let i = 0;
  while (i < actions.length) {
    const action = actions[i];
    if (!action.isError) { i++; continue; }

    const target = extractTarget(action);
    const chain: ToolAction[] = [action];

    // Look ahead for retries on the same target
    let j = i + 1;
    while (j < actions.length && j - i < 10) {
      const next = actions[j];
      const nextTarget = extractTarget(next);

      // Same tool, same target
      if (next.toolName === action.toolName && nextTarget === target) {
        chain.push(next);
        if (!next.isError) break; // Success — end of chain
      }
      // Different tool on same target that succeeds
      else if (nextTarget === target && !next.isError) {
        chain.push(next);
        break;
      }
      // Unrelated action — could still find a fix later, keep looking
      else if (next.isError && next.toolName === action.toolName) {
        chain.push(next);
      }
      j++;
    }

    // Need at least 2 actions and the last one should succeed
    const lastInChain = chain[chain.length - 1];
    if (chain.length >= 2 && !lastInChain.isError) {
      const failedActions = chain.filter(a => a.isError);
      const failedApproach = summarizeAction(failedActions[0]);
      const errorText = failedActions
        .map(a => a.result?.slice(0, 200) || "")
        .filter(Boolean)
        .join("; ");

      patterns.push({
        toolName: action.toolName,
        target,
        failedAttempts: failedActions.length,
        failedApproach,
        errorText,
        successfulApproach: summarizeAction(lastInChain),
        entryIndices: chain.map(a => a.index),
      });

      i = j + 1;
    } else {
      i++;
    }
  }

  return patterns;
}

// ─── Error→Fix Detection ─────────────────────────────────────────────

/**
 * Map error messages to the resolutions that fixed them.
 * Scans for errors then looks forward for successful actions that address them.
 */
export function detectErrorFixes(actions: ToolAction[]): ErrorFixPattern[] {
  const patterns: ErrorFixPattern[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!action.isError || !action.result) continue;

    const errorSig = normalizeErrorSignature(action.result);
    if (!errorSig) continue;

    const triggerContext = inferTriggerContext(action);

    // Look forward for a fix (within next 15 actions)
    for (let j = i + 1; j < Math.min(i + 15, actions.length); j++) {
      const candidate = actions[j];
      if (candidate.isError) continue; // Skip other errors

      // Check if this action fixes the error
      const fixRelation = classifyFix(action, candidate);
      if (fixRelation) {
        patterns.push({
          errorSignature: errorSig,
          rawError: action.result.slice(0, 500),
          triggerContext,
          fixAction: summarizeAction(candidate),
          fixCategory: fixRelation,
          entryIndices: [action.index, candidate.index],
        });
        break; // Only take first fix
      }
    }
  }

  return patterns;
}

// ─── User Correction Detection ───────────────────────────────────────

const CORRECTION_WORDS = [
  "don't", "dont", "do not", "no,", "no ", "wrong", "instead",
  "actually", "not that", "stop", "should have", "shouldn't",
  "use .* instead", "rather", "that's not", "thats not",
  "you should", "please don't", "never", "avoid",
];

const CORRECTION_REGEX = new RegExp(
  `\\b(${CORRECTION_WORDS.join("|")})\\b`,
  "i"
);

/**
 * Words/phrases indicating the user confirmed or validated an approach.
 * These capture positive signal — approaches the user explicitly approved.
 * Important: if we only capture corrections, the agent drifts toward
 * excessive caution. Confirmations anchor validated approaches.
 */
const CONFIRMATION_WORDS = [
  "yes exactly", "perfect", "that's right", "thats right",
  "good call", "nice", "ship it", "lgtm", "looks good",
  "that works", "great", "exactly right", "yes that's",
  "correct", "right approach", "well done", "nailed it",
  "that's the way", "keep doing", "yes, do that",
  "good approach", "smart", "clever", "that's what i want",
];

const CONFIRMATION_REGEX = new RegExp(
  `\\b(${CONFIRMATION_WORDS.join("|")})\\b`,
  "i"
);

/**
 * Detect user messages that corrected agent behavior.
 * Looks for negation/correction words in user messages that follow agent actions.
 */
export function detectCorrections(
  actions: ToolAction[],
  userMessages: Array<{ index: number; text: string }>,
): CorrectionPattern[] {
  const patterns: CorrectionPattern[] = [];

  for (const msg of userMessages) {
    if (!CORRECTION_REGEX.test(msg.text)) continue;
    if (msg.text.length < 10) continue; // Too short to be meaningful

    // Find the most recent action before this user message
    const precedingAction = findPrecedingAction(actions, msg.index);
    if (!precedingAction) continue;

    // Find the next action after this user message
    const followingAction = findFollowingAction(actions, msg.index);
    if (!followingAction) continue;

    // The correction is meaningful if:
    // 1. The preceding action failed OR
    // 2. The following action is different from the preceding action
    const isDifferentApproach =
      precedingAction.toolName !== followingAction.toolName ||
      extractTarget(precedingAction) !== extractTarget(followingAction) ||
      summarizeAction(precedingAction) !== summarizeAction(followingAction);

    if (precedingAction.isError || isDifferentApproach) {
      patterns.push({
        agentAction: summarizeAction(precedingAction),
        correctionText: msg.text.slice(0, 500),
        correctedAction: summarizeAction(followingAction),
        entryIndices: [precedingAction.index, msg.index, followingAction.index],
      });
    }
  }

  return patterns;
}

// ─── Orchestrator ────────────────────────────────────────────────────

/**
 * Detect user messages that confirmed/validated agent behavior.
 * Captures positive signal — approaches the user explicitly approved.
 * Without this, the agent only learns what NOT to do and drifts toward
 * excessive caution, losing validated approaches over time.
 */
export function detectConfirmations(
  actions: ToolAction[],
  userMessages: Array<{ index: number; text: string }>,
): ConfirmationPattern[] {
  const patterns: ConfirmationPattern[] = [];

  for (const msg of userMessages) {
    if (!CONFIRMATION_REGEX.test(msg.text)) continue;
    // Skip if also matches correction (ambiguous)
    if (CORRECTION_REGEX.test(msg.text)) continue;
    if (msg.text.length < 5) continue; // Too short

    // Find the most recent action before this confirmation
    const precedingAction = findPrecedingAction(actions, msg.index);
    if (!precedingAction) continue;
    // Only capture confirmations of successful actions
    if (precedingAction.isError) continue;

    patterns.push({
      agentAction: summarizeAction(precedingAction),
      confirmationText: msg.text.slice(0, 500),
      entryIndices: [precedingAction.index, msg.index],
    });
  }

  return patterns;
}

// ─── Orchestrator (main) ─────────────────────────────────────────────

/**
 * Extract all patterns from a session's entries and convert to LessonCandidates.
 */
export function extractPatterns(
  entries: any[],
  sessionId: string,
): LessonCandidate[] {
  const now = new Date().toISOString();
  const actions = parseToolActions(entries);
  const userMessages = parseUserMessages(entries);
  const candidates: LessonCandidate[] = [];

  // 1. Retry loops → error_fix + anti_pattern candidates
  const retryPatterns = detectRetryLoops(actions);
  for (const rp of retryPatterns) {
    // Main lesson: how to fix the error
    candidates.push({
      id: "", // Will be assigned by store
      type: "error_fix",
      rule: `When ${rp.toolName} fails on ${rp.target} with "${truncate(rp.errorText, 100)}", ${rp.successfulApproach}`,
      category: inferCategory(rp.toolName, rp.target),
      negative: false,
      confidence: 0,
      frequency: 1,
      session_ids: [sessionId],
      first_seen: now,
      last_seen: now,
      evidence: {
        trigger: `${rp.toolName} failure on ${rp.target}`,
        failed_approach: rp.failedApproach,
        successful_approach: rp.successfulApproach,
        error_signature: normalizeErrorSignature(rp.errorText) || undefined,
        context: [rp.toolName, rp.target],
      },
      status: "candidate",
      created_at: now,
      updated_at: now,
    });

    // Anti-pattern: what didn't work (only if repeated retries, not just one failure)
    if (rp.failedAttempts >= 2) {
      candidates.push({
        id: "",
        type: "anti_pattern",
        rule: `${rp.failedApproach} does not resolve "${truncate(rp.errorText, 80)}" — use ${rp.successfulApproach} instead`,
        category: inferCategory(rp.toolName, rp.target),
        negative: true,
        confidence: 0,
        frequency: 1,
        session_ids: [sessionId],
        first_seen: now,
        last_seen: now,
        evidence: {
          trigger: truncate(rp.errorText, 200),
          failed_approach: rp.failedApproach,
        },
        status: "candidate",
        created_at: now,
        updated_at: now,
      });
    }
  }

  // 2. Error→fix pairs
  const errorFixes = detectErrorFixes(actions);
  for (const ef of errorFixes) {
    candidates.push({
      id: "",
      type: "error_fix",
      rule: `When encountering "${truncate(ef.errorSignature, 100)}" during ${ef.triggerContext}, fix with: ${ef.fixAction}`,
      category: inferCategory("", ef.triggerContext),
      negative: false,
      confidence: 0,
      frequency: 1,
      session_ids: [sessionId],
      first_seen: now,
      last_seen: now,
      evidence: {
        trigger: ef.triggerContext,
        error_signature: ef.errorSignature,
        successful_approach: ef.fixAction,
        context: [ef.fixCategory],
      },
      status: "candidate",
      created_at: now,
      updated_at: now,
    });
  }

  // 3. User corrections
  const corrections = detectCorrections(actions, userMessages);
  for (const cp of corrections) {
    candidates.push({
      id: "",
      type: "correction",
      rule: cp.correctionText,
      category: inferCategory("", cp.agentAction),
      negative: false,
      confidence: 0,
      frequency: 1,
      session_ids: [sessionId],
      first_seen: now,
      last_seen: now,
      evidence: {
        trigger: cp.agentAction,
        failed_approach: cp.agentAction,
        successful_approach: cp.correctedAction,
      },
      status: "candidate",
      created_at: now,
      updated_at: now,
    });
  }

  // 4. User confirmations (positive signal — validated approaches)
  const confirmations = detectConfirmations(actions, userMessages);
  for (const cf of confirmations) {
    candidates.push({
      id: "",
      type: "confirmation",
      rule: `When ${cf.agentAction}: this approach was validated by the user ("${truncate(cf.confirmationText, 80)}")`,
      category: inferCategory("", cf.agentAction),
      negative: false,
      confidence: 0,
      frequency: 1,
      session_ids: [sessionId],
      first_seen: now,
      last_seen: now,
      evidence: {
        trigger: cf.agentAction,
        successful_approach: cf.agentAction,
      },
      status: "candidate",
      created_at: now,
      updated_at: now,
    });
  }

  // Deduplicate within session (Jaccard >= 0.7 on rule text)
  return deduplicateWithinSession(candidates);
}

// ─── Internal Helpers ────────────────────────────────────────────────

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function extractExitCode(resultText: string): number | undefined {
  // bash tool results often contain exit code info
  const match = resultText.match(/exit[_ ]code[:\s=]+(\d+)/i);
  if (match) return parseInt(match[1], 10);

  // Check for common error indicators
  if (resultText.includes("command not found")) return 127;
  if (resultText.includes("Permission denied")) return 1;
  return undefined;
}

/**
 * Extract the target resource from a tool action (file path, command prefix).
 */
function extractTarget(action: ToolAction): string {
  const args = action.args;

  // File-targeting tools
  if (args.path) return String(args.path);

  // bash: extract command prefix (first 2-3 words)
  if (action.toolName === "bash" && args.command) {
    const cmd = String(args.command).trim();
    // Strip environment variables and cd prefixes
    const cleaned = cmd.replace(/^(cd [^;]+;\s*|[A-Z_]+=\S+\s+)*/, "");
    const words = cleaned.split(/\s+/).slice(0, 3);
    return words.join(" ");
  }

  return action.toolName;
}

/**
 * Summarize a tool action into a human-readable description.
 */
function summarizeAction(action: ToolAction): string {
  const args = action.args;

  if (action.toolName === "bash" && args.command) {
    return `run: ${String(args.command).slice(0, 150)}`;
  }
  if (action.toolName === "edit" && args.path) {
    return `edit ${args.path}`;
  }
  if (action.toolName === "write" && args.path) {
    return `write ${args.path}`;
  }
  if (action.toolName === "read" && args.path) {
    return `read ${args.path}`;
  }
  if (action.toolName === "lsp_diagnostics") {
    return `check diagnostics${args.path ? ` for ${args.path}` : ""}`;
  }

  return `${action.toolName}(${JSON.stringify(args).slice(0, 100)})`;
}

/**
 * Normalize an error message into a signature for deduplication.
 * Strips paths, line numbers, timestamps, UUIDs.
 */
function normalizeErrorSignature(errorText: string): string | null {
  if (!errorText || errorText.length < 10) return null;

  let sig = errorText.slice(0, 500);

  // Strip absolute paths
  sig = sig.replace(/\/[\w./-]+/g, "*");
  // Strip line/column numbers
  sig = sig.replace(/:\d+:\d+/g, ":*:*");
  sig = sig.replace(/line \d+/gi, "line *");
  // Strip timestamps
  sig = sig.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*/g, "*");
  // Strip UUIDs
  sig = sig.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "*");
  // Collapse whitespace
  sig = sig.replace(/\s+/g, " ").trim();

  // Must have some meaningful content left
  if (sig.length < 10 || sig === "*") return null;
  return sig;
}

/**
 * Infer what triggered the error (build, test, deploy, etc.).
 */
function inferTriggerContext(action: ToolAction): string {
  const cmd = String(action.args.command || "").toLowerCase();

  if (cmd.includes("brazil-build") || cmd.includes("bb ")) return "build";
  if (cmd.includes("test") || cmd.includes("jest") || cmd.includes("pytest")) return "test";
  if (cmd.includes("deploy") || cmd.includes("cdk")) return "deployment";
  if (cmd.includes("npm install") || cmd.includes("pip install")) return "dependency install";
  if (cmd.includes("git")) return "git";
  if (cmd.includes("cr ")) return "code review";
  if (action.toolName === "edit" || action.toolName === "write") return "file editing";
  if (action.toolName === "lsp_diagnostics") return "type checking";

  return action.toolName;
}

/**
 * Classify whether an action is a fix for a preceding error.
 */
function classifyFix(
  error: ToolAction,
  candidate: ToolAction,
): ErrorFixPattern["fixCategory"] | null {
  // edit/write to a file after a compile/lint error
  if (
    (error.toolName === "bash" || error.toolName === "lsp_diagnostics") &&
    (candidate.toolName === "edit" || candidate.toolName === "write")
  ) {
    return "code_change";
  }

  // bash command after bash error (could be many things)
  if (error.toolName === "bash" && candidate.toolName === "bash") {
    const errCmd = String(error.args.command || "");
    const fixCmd = String(candidate.args.command || "");

    // Same command succeeding → retry
    if (extractTarget(error) === extractTarget(candidate)) return "retry_different";

    // Install command → dependency fix
    if (fixCmd.includes("install") || fixCmd.includes("ws use")) return "dependency";

    // Config/env command
    if (fixCmd.includes("export") || fixCmd.includes("config")) return "config_change";

    // Different command → different approach
    if (errCmd !== fixCmd) return "command";
  }

  // edit after lsp error on same file
  if (error.toolName === "lsp_diagnostics" && candidate.toolName === "edit") {
    return "code_change";
  }

  return null;
}

/**
 * Infer category from tool name and target.
 */
function inferCategory(toolName: string, target: string): string {
  const combined = `${toolName} ${target}`.toLowerCase();

  if (combined.includes("brazil") || combined.includes("bb ")) return "build";
  if (combined.includes("test") || combined.includes("jest")) return "test";
  if (combined.includes("deploy") || combined.includes("cdk")) return "deployment";
  if (combined.includes("git") || combined.includes("cr ")) return "git";
  if (combined.includes("vault") || combined.includes("obsidian")) return "vault";
  if (combined.includes("npm") || combined.includes("pip") || combined.includes("install")) return "dependency";
  if (combined.includes("lsp") || combined.includes("diagnostic")) return "type-checking";

  return "general";
}

/**
 * Find the most recent tool action before a given entry index.
 */
function findPrecedingAction(actions: ToolAction[], beforeIndex: number): ToolAction | undefined {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].index < beforeIndex) return actions[i];
  }
  return undefined;
}

/**
 * Find the next tool action after a given entry index.
 */
function findFollowingAction(actions: ToolAction[], afterIndex: number): ToolAction | undefined {
  for (const action of actions) {
    if (action.index > afterIndex) return action;
  }
  return undefined;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Deduplicate candidates within a single extraction (same session).
 * Uses Jaccard >= 0.7 on rule text.
 */
function deduplicateWithinSession(candidates: LessonCandidate[]): LessonCandidate[] {
  const result: LessonCandidate[] = [];

  for (const candidate of candidates) {
    let isDuplicate = false;
    for (const existing of result) {
      const ruleWords = new Set(candidate.rule.toLowerCase().split(/\s+/));
      const existingWords = new Set(existing.rule.toLowerCase().split(/\s+/));
      let intersection = 0;
      for (const w of ruleWords) {
        if (existingWords.has(w)) intersection++;
      }
      const union = ruleWords.size + existingWords.size - intersection;
      const similarity = union === 0 ? 0 : intersection / union;

      if (similarity >= 0.7) {
        // Keep the longer/more detailed rule
        if (candidate.rule.length > existing.rule.length) {
          existing.rule = candidate.rule;
          existing.evidence = { ...existing.evidence, ...candidate.evidence };
        }
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) result.push(candidate);
  }

  return result;
}
