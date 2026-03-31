/**
 * Type definitions for the lesson-extractor extension.
 */

/** A retry loop where the agent tried something, failed, and eventually succeeded differently. */
export interface RetryPattern {
  /** Tool that was retried */
  toolName: string;
  /** Target resource (file path, command prefix) */
  target: string;
  /** Number of failed attempts */
  failedAttempts: number;
  /** What the agent tried that failed */
  failedApproach: string;
  /** Error text from the failures */
  errorText: string;
  /** What eventually worked */
  successfulApproach: string;
  /** Entry indices in the session */
  entryIndices: number[];
}

/** An error message mapped to the resolution that fixed it. */
export interface ErrorFixPattern {
  /** Normalized error signature */
  errorSignature: string;
  /** Raw error text */
  rawError: string;
  /** Context: what triggered the error (build, test, etc.) */
  triggerContext: string;
  /** What fixed it (command, edit, etc.) */
  fixAction: string;
  /** Category of fix */
  fixCategory: "code_change" | "config_change" | "dependency" | "environment" | "retry_different" | "command";
  /** Entry indices */
  entryIndices: number[];
}

/** A user message that corrected agent behavior. */
export interface CorrectionPattern {
  /** What the agent did before the correction */
  agentAction: string;
  /** The user's correction text */
  correctionText: string;
  /** What the agent did after the correction */
  correctedAction: string;
  /** Entry indices */
  entryIndices: number[];
}

/** A user message that confirmed/validated an agent's approach. */
export interface ConfirmationPattern {
  /** What the agent did that was confirmed */
  agentAction: string;
  /** The user's confirmation text */
  confirmationText: string;
  /** Entry indices */
  entryIndices: number[];
}

/** Structured evidence for a lesson candidate. */
export interface CandidateEvidence {
  trigger?: string;
  failed_approach?: string;
  successful_approach?: string;
  error_signature?: string;
  context?: string[];
}

/** A candidate lesson extracted from session analysis. */
export interface LessonCandidate {
  id: string;
  type: "retry_loop" | "correction" | "confirmation" | "error_fix" | "anti_pattern";
  rule: string;
  category: string;
  negative: boolean;
  confidence: number;
  frequency: number;
  session_ids: string[];
  first_seen: string;
  last_seen: string;
  evidence: CandidateEvidence;
  status: "candidate" | "promoted" | "rejected" | "expired";
  promoted_lesson_id?: string;
  created_at: string;
  updated_at: string;
  reviewed_at?: string;
}

/** Incremental processing state persisted to disk. */
export interface ExtractorState {
  version: number;
  lastAnalyzed: string;
  analyzedSessionIds: string[];
  stats: {
    totalCandidatesExtracted: number;
    autoPromoted: number;
    userPromoted: number;
    rejected: number;
    expired: number;
  };
}

/** Parsed tool action from a session entry. */
export interface ToolAction {
  index: number;
  toolName: string;
  toolCallId?: string;
  args: Record<string, any>;
  result?: string;
  isError: boolean;
  exitCode?: number;
}
