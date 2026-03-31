/**
 * SQLite-backed candidate store for lesson extraction.
 * Uses better-sqlite3 (same as pi-memory) with a separate DB file.
 */
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { LessonCandidate, CandidateEvidence } from "./types.js";

const DEFAULT_DB_PATH = `${process.env.HOME}/.pi/agent/lesson-extractor/candidates.db`;

export class CandidateStore {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lesson_candidates (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        rule TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        negative INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.0,
        frequency INTEGER NOT NULL DEFAULT 1,
        session_ids TEXT NOT NULL DEFAULT '[]',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'candidate',
        promoted_lesson_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_candidates_status ON lesson_candidates(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_type ON lesson_candidates(type);
      CREATE INDEX IF NOT EXISTS idx_candidates_confidence ON lesson_candidates(confidence DESC);
    `);
  }

  /**
   * Upsert a candidate — dedup by Jaccard similarity on rule text within same type.
   * If a similar candidate exists, merge (increment frequency, update timestamps).
   * Returns the candidate ID (new or merged).
   */
  upsert(candidate: Omit<LessonCandidate, "id" | "created_at" | "updated_at">): string {
    // Check for similar existing candidates by type
    const existing = this.db.prepare(
      "SELECT * FROM lesson_candidates WHERE type = ? AND status IN ('candidate', 'promoted')"
    ).all(candidate.type) as any[];

    for (const row of existing) {
      const similarity = jaccard(candidate.rule, row.rule);
      if (similarity >= 0.6) {
        // Merge: increment frequency, update timestamps, keep longer rule
        const existingSessionIds: string[] = JSON.parse(row.session_ids);
        const mergedSessionIds = [...new Set([...existingSessionIds, ...candidate.session_ids])];
        const newRule = candidate.rule.length > row.rule.length ? candidate.rule : row.rule;
        const newFrequency = mergedSessionIds.length;

        // Recompute confidence with updated frequency
        const newConfidence = computeConfidence({
          ...candidate,
          id: row.id,
          frequency: newFrequency,
          first_seen: row.first_seen,
          last_seen: candidate.last_seen,
          created_at: row.created_at,
          updated_at: new Date().toISOString(),
        });

        this.db.prepare(`
          UPDATE lesson_candidates SET
            rule = ?,
            frequency = ?,
            session_ids = ?,
            last_seen = ?,
            confidence = ?,
            evidence = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          newRule,
          newFrequency,
          JSON.stringify(mergedSessionIds),
          candidate.last_seen,
          newConfidence,
          JSON.stringify({
            ...JSON.parse(row.evidence),
            ...candidate.evidence,
          }),
          row.id,
        );

        return row.id;
      }
    }

    // Also check for error_signature exact match (for error_fix type)
    if (candidate.type === "error_fix" && candidate.evidence.error_signature) {
      for (const row of existing) {
        const rowEvidence: CandidateEvidence = JSON.parse(row.evidence);
        if (rowEvidence.error_signature === candidate.evidence.error_signature) {
          // Same error — merge
          const existingSessionIds: string[] = JSON.parse(row.session_ids);
          const mergedSessionIds = [...new Set([...existingSessionIds, ...candidate.session_ids])];
          const newFrequency = mergedSessionIds.length;

          const newConfidence = computeConfidence({
            ...candidate,
            id: row.id,
            frequency: newFrequency,
            first_seen: row.first_seen,
            last_seen: candidate.last_seen,
            created_at: row.created_at,
            updated_at: new Date().toISOString(),
          });

          this.db.prepare(`
            UPDATE lesson_candidates SET
              frequency = ?,
              session_ids = ?,
              last_seen = ?,
              confidence = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(
            newFrequency,
            JSON.stringify(mergedSessionIds),
            candidate.last_seen,
            newConfidence,
            row.id,
          );

          return row.id;
        }
      }
    }

    // No match — insert new candidate
    const id = crypto.randomUUID();
    const confidence = computeConfidence({
      ...candidate,
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    this.db.prepare(`
      INSERT INTO lesson_candidates (id, type, rule, category, negative, confidence, frequency,
        session_ids, first_seen, last_seen, evidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      candidate.type,
      candidate.rule,
      candidate.category,
      candidate.negative ? 1 : 0,
      confidence,
      candidate.frequency,
      JSON.stringify(candidate.session_ids),
      candidate.first_seen,
      candidate.last_seen,
      JSON.stringify(candidate.evidence),
      candidate.status,
    );

    return id;
  }

  /** Get a single candidate by ID. */
  get(id: string): LessonCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM lesson_candidates WHERE id = ?").get(id) as any;
    return row ? deserializeRow(row) : undefined;
  }

  /** List candidates filtered by status. */
  list(status?: string, limit: number = 50): LessonCandidate[] {
    let rows: any[];
    if (status) {
      rows = this.db.prepare(
        "SELECT * FROM lesson_candidates WHERE status = ? ORDER BY confidence DESC LIMIT ?"
      ).all(status, limit);
    } else {
      rows = this.db.prepare(
        "SELECT * FROM lesson_candidates ORDER BY confidence DESC LIMIT ?"
      ).all(limit);
    }
    return rows.map(deserializeRow);
  }

  /** Count candidates by status. */
  countByStatus(status: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM lesson_candidates WHERE status = ?"
    ).get(status) as any;
    return row?.c ?? 0;
  }

  /** Get candidates ready for auto-promotion (confidence >= 0.85). */
  getPromotable(): LessonCandidate[] {
    return this.db.prepare(
      "SELECT * FROM lesson_candidates WHERE status = 'candidate' AND confidence >= 0.85 ORDER BY confidence DESC"
    ).all().map(deserializeRow);
  }

  /** Get candidates ready for review (confidence 0.60-0.84). */
  getReviewable(): LessonCandidate[] {
    return this.db.prepare(
      "SELECT * FROM lesson_candidates WHERE status = 'candidate' AND confidence >= 0.60 AND confidence < 0.85 ORDER BY confidence DESC"
    ).all().map(deserializeRow);
  }

  /** Mark a candidate as promoted and record the lesson ID. */
  promote(id: string, lessonId: string): void {
    this.db.prepare(`
      UPDATE lesson_candidates SET
        status = 'promoted',
        promoted_lesson_id = ?,
        reviewed_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(lessonId, id);
  }

  /** Mark a candidate as rejected. */
  reject(id: string): void {
    this.db.prepare(`
      UPDATE lesson_candidates SET
        status = 'rejected',
        reviewed_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  }

  /** Expire stale candidates (confidence < 0.40, no activity in 60 days). */
  expireStale(): number {
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      UPDATE lesson_candidates SET
        status = 'expired',
        updated_at = datetime('now')
      WHERE status = 'candidate'
        AND confidence < 0.40
        AND last_seen < ?
    `).run(cutoff);
    return result.changes;
  }

  /** Get recently promoted candidates (within last N hours). */
  getRecentPromotions(hours: number = 24): LessonCandidate[] {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db.prepare(
      "SELECT * FROM lesson_candidates WHERE status = 'promoted' AND reviewed_at >= ? ORDER BY reviewed_at DESC"
    ).all(since).map(deserializeRow);
  }

  /** Stats for display. */
  stats(): { total: number; candidate: number; promoted: number; rejected: number; expired: number } {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as c FROM lesson_candidates GROUP BY status"
    ).all() as { status: string; c: number }[];

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      counts[r.status] = r.c;
      total += r.c;
    }

    return {
      total,
      candidate: counts["candidate"] ?? 0,
      promoted: counts["promoted"] ?? 0,
      rejected: counts["rejected"] ?? 0,
      expired: counts["expired"] ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function deserializeRow(row: any): LessonCandidate {
  return {
    ...row,
    negative: !!row.negative,
    session_ids: JSON.parse(row.session_ids),
    evidence: JSON.parse(row.evidence),
  };
}

/**
 * Jaccard similarity between two strings (word-level).
 */
export function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute confidence score for a candidate based on frequency, recency,
 * consistency, and evidence strength.
 */
export function computeConfidence(candidate: LessonCandidate): number {
  const weights = {
    frequency: 0.35,
    recency: 0.20,
    consistency: 0.25,
    strength: 0.20,
  };

  // Frequency: logarithmic scaling, saturates around 10 occurrences
  const freqScore = Math.min(1.0, Math.log2(candidate.frequency + 1) / Math.log2(11));

  // Recency: exponential decay over 30 days
  const daysSinceLastSeen = (Date.now() - new Date(candidate.last_seen).getTime()) / 86400000;
  const recencyScore = Math.exp(-daysSinceLastSeen / 30);

  // Consistency: 0.5 for single observation, 0.8 for multiple
  const consistencyScore = candidate.frequency === 1 ? 0.5 : 0.8;

  // Strength: how clear is the evidence?
  const strengthScore = computeEvidenceStrength(candidate);

  return (
    weights.frequency * freqScore +
    weights.recency * recencyScore +
    weights.consistency * consistencyScore +
    weights.strength * strengthScore
  );
}

function computeEvidenceStrength(candidate: LessonCandidate): number {
  switch (candidate.type) {
    case "correction":
      return 0.95;
    case "error_fix":
      return candidate.evidence.error_signature ? 0.85 : 0.6;
    case "retry_loop":
      return candidate.evidence.successful_approach ? 0.75 : 0.5;
    case "anti_pattern":
      return 0.8;
    default:
      return 0.5;
  }
}
