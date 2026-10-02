import type { AgentActivityOutcome } from "@earendil-works/pi-coding-agent";
import type { CarryMode } from "../carry-core.ts";

// Data passed between Spin's services. These are plain types for now; the schema milestone
// replaces the persisted and untrusted ones (definition, run state, verdict, proposal) with
// Effect Schemas and derives these types from them.

export type { CarryMode };

/** A session and a leaf in its tree. Guards compare against it before changing the session. */
export interface SessionPosition {
  readonly sessionId: string;
  readonly leafId: string;
}

/** Facts from PiHost.inspectSession(). Spin decides what they mean. */
export interface SessionFacts {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly idle: boolean;
  readonly pendingMessages: boolean;
}

/** What /spin collects before the setup conversation starts. */
export interface BeginRequest {
  readonly invocation: SessionPosition;
  readonly intent: string;
  readonly carryMode: CarryMode;
}

export interface CheckSnapshot {
  readonly source: string;
  readonly sha256: string;
}

/** What the approved check may reach. Enforced by CheckEvaluator's capabilities. */
export interface CapabilityPolicy {
  readonly readPaths: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
  readonly classifier: boolean;
}

export interface SpinLimits {
  readonly maxIterations: number;
  readonly maxDurationMs: number;
  /** Stop after this many consecutive checks report an unchanged progress fingerprint. */
  readonly maxUnchangedProgress?: number;
  readonly checkTimeoutMs: number;
}

/** What the setup agent proposes and the user approves. Untrusted until validated. */
export interface SpinProposal {
  readonly task: string;
  readonly checkSource: string;
  readonly capabilities: CapabilityPolicy;
  readonly limits: SpinLimits;
}

/**
 * The approved snapshot. Never changes after SpinStore.create. The proposal plus the fields
 * the agent must not set: the anchor, the carry mode picked in the UI, and the check's hash.
 */
export interface SpinDefinition extends Omit<SpinProposal, "checkSource"> {
  readonly invocation: SessionPosition;
  readonly carryMode: CarryMode;
  readonly check: CheckSnapshot;
}

export type Verdict = "done" | "continue" | "blocked" | "uncertain";

/** The envelope a check script returns. Evidence and progress are bounded, check-defined JSON. */
export interface CheckVerdict {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly evidence?: unknown;
  readonly progress?: { readonly fingerprint: string };
}

export interface CheckInput {
  readonly iteration: number;
  readonly previous?: CheckVerdict;
}

export interface EvaluationRecord {
  readonly iteration: number;
  readonly verdict: CheckVerdict;
  /** Bounded script output for display; never parsed for the verdict. */
  readonly diagnostics: string;
  readonly classifierCalls: number;
  readonly costUsd?: number;
  readonly durationMs: number;
}

export type StopReason =
  | "user"
  | "limit"
  | "no-progress"
  | "blocked"
  | "uncertain"
  | "check-failed"
  | "run-aborted"
  | "run-error"
  | "foreign-input"
  | "session-changed"
  | "host-failed"
  | "shutdown"
  | "interrupted";

export type SpinStatus =
  | { readonly _tag: "running" }
  | { readonly _tag: "completed" }
  | { readonly _tag: "stopped"; readonly reason: StopReason; readonly detail?: string };

export interface SpinRunState {
  readonly status: SpinStatus;
  readonly iteration: number;
  readonly startedAtMs: number;
  readonly lastEvaluation?: EvaluationRecord;
  readonly unchangedProgress: number;
}

export interface SpinRecord {
  readonly spinId: string;
  readonly revision: number;
  readonly definition: SpinDefinition;
  readonly state: SpinRunState;
  /** The session entry holding this revision. Writing it moved the leaf onto it. */
  readonly entryId: string;
}

/** One iteration's start: rewind, attach carry and feedback, submit the task. */
export interface IterationRequest {
  /** The entry to land on; the definition entry, so navigation lands exactly on it. */
  readonly targetId: string;
  readonly carry?: string;
  readonly feedback?: string;
  readonly prompt: string;
  readonly expected: SessionPosition;
}

/**
 * Lifecycle facts the extension forwards from Pi's events. Spin derives each run's outcome
 * from them (agent_before_settle is skipped on abort). Input from any source but "extension"
 * is foreign; user messages injected by other extensions are deliberately not detected.
 */
export type HostEvent =
  | { readonly _tag: "SessionStarted" }
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunEnded"; readonly lastStopReason: string | undefined }
  | { readonly _tag: "BeforeSettle"; readonly outcome: AgentActivityOutcome }
  | { readonly _tag: "Input"; readonly source: string }
  | { readonly _tag: "Settled" };

/** Result of Spin.startApproved, shown to the setup agent. */
export interface ApprovalResult {
  readonly accepted: boolean;
  readonly message: string;
}

/** What /spin status and the status widget show. */
export interface SpinSummary {
  readonly phase: "idle" | "setup" | "launching" | "running";
  readonly spinId?: string;
  readonly iteration?: number;
  readonly last?: SpinStatus;
}
