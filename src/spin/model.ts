import { createHash } from "node:crypto";
import type { AgentActivityOutcome } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { CARRY_MODES, type CarryMode } from "../carry-core.ts";
import { CheckFailed, InvalidProposal, MalformedRecord } from "./errors.ts";

// Data passed between Spin's services. Everything that crosses a trust boundary or is saved in
// the session file is a Schema, and its type is derived from it: the setup agent's proposal,
// the check script's verdict, and the session entries. Values Spin builds itself and never
// stores (session facts, host events, requests between services) stay plain types.

export type { CarryMode };

/**
 * Ceilings Spin enforces whatever the proposal or a script's `// @options` header asks for.
 * A proposal above a cap is rejected, not clamped, so the user approves exactly what runs.
 */
export const HARD_LIMITS = {
  task: 8_000,
  checkSource: 64 * 1024,
  maxIterations: 200,
  maxDurationMs: 24 * 60 * 60 * 1000,
  maxUnchangedProgress: 50,
  reason: 2_000,
  evidenceBytes: 16 * 1024,
  fingerprint: 512,
  diagnostics: 8 * 1024,
} as const;

/**
 * What the check may do beyond reading. The approved script itself is the permission: it can
 * read any file and use Pi's read-only tools. Commands and the classifier are switched on
 * separately so the approval dialog can call them out.
 */
export const CheckPermissions = Schema.Struct({
  /** Whether `tools.bash` exists. It runs any command, unattended, every iteration. */
  commands: Schema.Boolean.annotate({
    description: "Whether the check may run shell commands with tools.bash. Any command; not read-only",
  }),
  /** Whether the `models` global exists. Spending is bounded by the check timeout and Spin's limits. */
  classifier: Schema.Boolean.annotate({ description: "Whether the check may call classifier models with models.classify" }),
});
export type CheckPermissions = typeof CheckPermissions.Type;

export const SpinLimits = Schema.Struct({
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HARD_LIMITS.maxIterations }))
    .annotate({ description: "Task runs before Spin stops" }),
  maxDurationMs: Schema.Int.check(Schema.isBetween({ minimum: 60_000, maximum: HARD_LIMITS.maxDurationMs }))
    .annotate({ description: "Wall-clock budget for the whole Spin" }),
  /** Stop after this many consecutive checks report an unchanged progress fingerprint. */
  maxUnchangedProgress: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HARD_LIMITS.maxUnchangedProgress }))
      .annotate({ description: "Stop after this many consecutive checks return the same progress.fingerprint" }),
  ),
});
export type SpinLimits = typeof SpinLimits.Type;

/**
 * What the setup agent submits through `spin_start`. It cannot set the anchor or the carry
 * mode, which the user chose before setup; unknown keys are rejected rather than ignored.
 */
export const SpinProposal = Schema.Struct({
  task: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(HARD_LIMITS.task))
    .annotate({ description: "The prompt repeated from the anchor on every iteration" }),
  checkSource: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(HARD_LIMITS.checkSource)).annotate({
    description: "Codemode script body (top-level await and return) returning { verdict, reason, evidence?, progress? }",
  }),
  permissions: CheckPermissions,
  limits: SpinLimits,
});
export type SpinProposal = typeof SpinProposal.Type;

export const SessionPosition = Schema.Struct({
  sessionId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  leafId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
});
export type SessionPosition = typeof SessionPosition.Type;

const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");

/** The approved check script and its hash. A hash that does not match marks a corrupted entry. */
export const CheckSnapshot = Schema.Struct({
  source: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(HARD_LIMITS.checkSource)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
}).check(Schema.makeFilter((check) =>
  sha256(check.source) === check.sha256 || { path: ["sha256"], issue: "does not match the check source" }
));
export type CheckSnapshot = typeof CheckSnapshot.Type;

export const snapshotCheck = (source: string): CheckSnapshot => ({ source, sha256: sha256(source) });

/**
 * The approved snapshot. Never changes after SpinStore.create. The proposal plus the fields
 * the agent must not set: the anchor, the carry mode picked in the UI, and the check's hash.
 */
export const SpinDefinition = Schema.Struct({
  invocation: SessionPosition,
  task: SpinProposal.fields.task,
  carryMode: Schema.Literals(CARRY_MODES.map((mode) => mode.value)),
  check: CheckSnapshot,
  permissions: CheckPermissions,
  limits: SpinLimits,
});
export type SpinDefinition = typeof SpinDefinition.Type;

export const Verdict = Schema.Literals(["done", "continue", "blocked", "uncertain"]);
export type Verdict = typeof Verdict.Type;

/**
 * The envelope a check script returns (trust boundary: the script). Evidence and progress are
 * check-defined. Unknown keys are rejected so a misspelt field cannot silently drop out of a
 * stopping rule.
 */
export const CheckVerdict = Schema.Struct({
  verdict: Verdict,
  reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(HARD_LIMITS.reason)),
  /** JSON (no cycles, non-finite numbers or class instances), bounded by its UTF-8 size. */
  evidence: Schema.optionalKey(Schema.Json.check(Schema.makeFilter((value) =>
    new TextEncoder().encode(JSON.stringify(value)).length <= HARD_LIMITS.evidenceBytes
    || `must serialize to at most ${HARD_LIMITS.evidenceBytes} bytes of JSON`
  ))),
  /** Equal fingerprints mean no progress; Spin never compares them any other way. */
  progress: Schema.optionalKey(Schema.Struct({
    fingerprint: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(HARD_LIMITS.fingerprint)),
  })),
});
export type CheckVerdict = typeof CheckVerdict.Type;

/** What the script sees as the read-only `spin` global. */
export const CheckInput = Schema.Struct({
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  previous: Schema.optionalKey(CheckVerdict),
});
export type CheckInput = typeof CheckInput.Type;

export const EvaluationRecord = Schema.Struct({
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  verdict: CheckVerdict,
  /** Script output for display, truncated by the evaluator; never parsed for the verdict. */
  diagnostics: Schema.String.check(Schema.isMaxLength(HARD_LIMITS.diagnostics)),
  classifierCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Absent when the provider reports no cost. */
  costUsd: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type EvaluationRecord = typeof EvaluationRecord.Type;

export const StopReason = Schema.Literals([
  "user",
  "limit",
  "no-progress",
  "blocked",
  "uncertain",
  "check-failed",
  "run-aborted",
  "run-error",
  "foreign-input",
  "session-changed",
  "host-failed",
  "shutdown",
  "interrupted",
]);
export type StopReason = typeof StopReason.Type;

export const SpinStatus = Schema.TaggedUnion({
  running: {},
  completed: {},
  stopped: {
    reason: StopReason,
    detail: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(HARD_LIMITS.reason))),
  },
});
export type SpinStatus = typeof SpinStatus.Type;

export const SpinRunState = Schema.Struct({
  status: SpinStatus,
  /** 0 until the first task is submitted. */
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastEvaluation: Schema.optionalKey(EvaluationRecord),
  unchangedProgress: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SpinRunState = typeof SpinRunState.Type;

export const DEFINITION_ENTRY = "spin-definition";
export const STATE_ENTRY = "spin-state";

/** `data` of a `spin-definition` entry: the definition and revision 0. */
export const DefinitionEntryData = Schema.Struct({
  version: Schema.Literal(1),
  spinId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  revision: Schema.Literal(0),
  definition: SpinDefinition,
  state: SpinRunState,
});
export type DefinitionEntryData = typeof DefinitionEntryData.Type;

/** `data` of a `spin-state` entry: one later revision. */
export const StateEntryData = Schema.Struct({
  version: Schema.Literal(1),
  spinId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: SpinRunState,
});
export type StateEntryData = typeof StateEntryData.Type;

/** A Spin rebuilt from its entries. Not stored as a whole. */
export interface SpinRecord {
  readonly spinId: string;
  readonly revision: number;
  readonly definition: SpinDefinition;
  readonly state: SpinRunState;
  /** The session entry holding this revision. Writing it moved the leaf onto it. */
  readonly entryId: string;
}

/** Validate the agent's proposal and fix the fields it may not set. */
export const approveProposal = Effect.fn("approveProposal")(function*(
  proposal: unknown,
  fixed: { readonly invocation: SessionPosition; readonly carryMode: CarryMode },
) {
  const valid = yield* Schema.decodeUnknownEffect(SpinProposal)(proposal, { onExcessProperty: "error", errors: "all" }).pipe(
    Effect.mapError((error) => new InvalidProposal({ message: error.message })),
  );
  const { checkSource, ...rest } = valid;
  return { ...rest, ...fixed, check: snapshotCheck(checkSource) } satisfies SpinDefinition;
});

/** Validate a check script's return value. A bad envelope fails the check; it is never a verdict. */
export const decodeVerdict = Effect.fn("decodeVerdict")(function*(value: unknown) {
  return yield* Schema.decodeUnknownEffect(CheckVerdict)(value, { onExcessProperty: "error", errors: "all" }).pipe(
    Effect.mapError((error) => new CheckFailed({ kind: "verdict", message: error.message })),
  );
});

/** Validate a spin entry read back from the session file. */
export const decodeEntry = Effect.fn("decodeEntry")(function*(entry: { readonly id: string; readonly customType: string; readonly data?: unknown }) {
  const schema = entry.customType === DEFINITION_ENTRY ? DefinitionEntryData : StateEntryData;
  return yield* Schema.decodeUnknownEffect(schema)(entry.data, { onExcessProperty: "error", errors: "all" }).pipe(
    Effect.mapError((error) => new MalformedRecord({ entryId: entry.id, message: error.message })),
  );
});

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
