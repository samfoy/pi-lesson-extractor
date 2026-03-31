/**
 * State management for the lesson-extractor extension.
 * Tracks which sessions have been analyzed and aggregate stats.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtractorState } from "./types.js";

const STATE_DIR = join(process.env.HOME || "~", ".pi", "agent", "lesson-extractor");
const STATE_PATH = join(STATE_DIR, "state.json");

const DEFAULT_STATE: ExtractorState = {
  version: 1,
  lastAnalyzed: new Date(0).toISOString(),
  analyzedSessionIds: [],
  stats: {
    totalCandidatesExtracted: 0,
    autoPromoted: 0,
    userPromoted: 0,
    rejected: 0,
    expired: 0,
  },
};

/** Load state from disk, returning defaults if not found. */
export function loadState(): ExtractorState {
  try {
    if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Save state to disk. */
export function saveState(state: ExtractorState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/** Check if a session has already been analyzed. */
export function isSessionAnalyzed(state: ExtractorState, sessionId: string): boolean {
  return state.analyzedSessionIds.includes(sessionId);
}

/** Mark a session as analyzed. */
export function markSessionAnalyzed(state: ExtractorState, sessionId: string): void {
  if (!state.analyzedSessionIds.includes(sessionId)) {
    state.analyzedSessionIds.push(sessionId);
    // Keep last 500 session IDs to avoid unbounded growth
    if (state.analyzedSessionIds.length > 500) {
      state.analyzedSessionIds = state.analyzedSessionIds.slice(-500);
    }
  }
  state.lastAnalyzed = new Date().toISOString();
}
