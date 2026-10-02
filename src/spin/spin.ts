import { randomUUID } from "node:crypto";
import type { AgentActivityOutcome, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Clock, Context, Deferred, Effect, Layer, Result } from "effect";
import { buildCarryTranscript, type CarryMode } from "../carry-core.ts";
import { CheckEvaluator } from "./check-evaluator.ts";
import { SpinRejected } from "./errors.ts";
import {
  type ApprovalResult,
  approveProposal,
  type BeginRequest,
  type EvaluationRecord,
  HARD_LIMITS,
  type HostEvent,
  type SpinDefinition,
  type SpinRunState,
  type SpinStatus,
  type SpinSummary,
  type StopReason,
} from "./model.ts";
import { PiHost } from "./pi-host.ts";
import { SpinStore } from "./spin-store.ts";

/**
 * Owns setup, approval and the running loop for the current session, one change at a time.
 * It alone decides whether to complete, stop or continue, using SpinStore, CheckEvaluator and
 * PiHost, which its layer provides. Callers pass ordinary values, never services or Pi contexts.
 *
 * Failures inside a running Spin become a stop with a reason, not errors here. Methods fail
 * only with SpinRejected, when the call does not fit the current phase.
 */
export class Spin extends Context.Service<Spin, {
  /** `/spin <intent>` after the carry mode is chosen: mark the anchor and start setup. */
  begin(request: BeginRequest): Effect.Effect<void, SpinRejected>;

  /**
   * The setup agent's save-and-start request, after the user approved the proposal in the UI.
   * Validates the untrusted proposal and schedules launch through the continuation command;
   * tool handlers cannot navigate. Rejections are returned to the agent, not thrown.
   */
  startApproved(proposal: unknown): Effect.Effect<ApprovalResult>;

  /** Lifecycle facts from Pi's event handlers. On Settled it may schedule a continuation. */
  observe(event: HostEvent): Effect.Effect<void>;

  /**
   * The internal continuation command, in a fresh command context. Ignores unknown or reused
   * tokens. Launches an approved Spin, or handles the iteration that just ended: check,
   * save, then complete, stop, or rewind and submit the next task.
   */
  continue(token: string): Effect.Effect<void>;

  /** End automatic repetition. Keeps history and files; never rewinds. */
  stop(reason: StopReason, detail?: string): Effect.Effect<void, SpinRejected>;

  readonly summary: Effect.Effect<SpinSummary>;
}>()("pi-spin/spin/Spin") {
  static readonly layer = Layer.effect(Spin, Effect.gen(function*() {
    return makeSpin(yield* SpinStore, yield* CheckEvaluator, yield* PiHost);
  }));
}

export type FinalStatus = Exclude<SpinStatus, { readonly _tag: "running" }>;

/**
 * What happens after a check, given the run state that already includes it: a final status,
 * or undefined to run another iteration. `state.iteration` is the number of task runs so far.
 */
export function decide(definition: SpinDefinition, state: SpinRunState, nowMs: number): FinalStatus | undefined {
  const evaluation = state.lastEvaluation;
  if (!evaluation) return { _tag: "stopped", reason: "check-failed", detail: "No check result." };
  const { verdict, reason } = evaluation.verdict;
  if (verdict === "done") return { _tag: "completed" };
  if (verdict === "blocked" || verdict === "uncertain") return { _tag: "stopped", reason: verdict, detail: reason };
  const { limits } = definition;
  if (state.iteration >= limits.maxIterations) {
    return { _tag: "stopped", reason: "limit", detail: `Reached the limit of ${limits.maxIterations} iterations.` };
  }
  if (nowMs - state.startedAtMs >= limits.maxDurationMs) {
    return { _tag: "stopped", reason: "limit", detail: `Reached the time limit of ${limits.maxDurationMs / 60_000} minutes.` };
  }
  if (limits.maxUnchangedProgress !== undefined && state.unchangedProgress >= limits.maxUnchangedProgress) {
    return {
      _tag: "stopped",
      reason: "no-progress",
      detail: `The progress fingerprint was unchanged for ${state.unchangedProgress} checks in a row.`,
    };
  }
  return undefined;
}

/** Consecutive checks whose fingerprints are equal. Spin never compares them any other way. */
export function unchangedProgress(state: SpinRunState, evaluation: EvaluationRecord): number {
  const previous = state.lastEvaluation?.verdict.progressFingerprint;
  const current = evaluation.verdict.progressFingerprint;
  return previous !== undefined && previous === current ? state.unchangedProgress + 1 : 0;
}

/**
 * Carry from the iteration's branch: everything after the definition entry, which is where
 * every iteration starts. Undefined when the branch does not pass through it.
 */
export function selectCarry(
  branch: ReadonlyArray<SessionEntry>,
  definitionEntryId: string,
  mode: CarryMode,
): { readonly text: string | undefined } | undefined {
  const index = branch.findIndex((entry) => entry.id === definitionEntryId);
  if (index === -1) return undefined;
  return { text: buildCarryTranscript(branch.slice(index + 1), mode) };
}

/** The check's result as the next iteration sees it. */
export function feedbackText(evaluation: EvaluationRecord, iteration: number, maxIterations: number): string {
  const { verdict } = evaluation;
  const when = iteration === 0 ? "before the first iteration" : `after iteration ${iteration}`;
  const lines = [
    `Spin's completion check ${when} reports: ${verdict.verdict}.`,
    `Reason: ${verdict.reason}`,
  ];
  lines.push(`This is iteration ${iteration + 1} of at most ${maxIterations}. This message comes from Spin, not the user.`);
  return lines.join("\n");
}

export function describeStatus(status: FinalStatus, iterations: number): string {
  const runs = `${iterations} iteration${iterations === 1 ? "" : "s"}`;
  if (status._tag === "completed") return `Spin finished: the check reports done after ${runs}.`;
  const detail = status.detail ? `: ${status.detail}` : ".";
  return `Spin stopped after ${runs} (${status.reason})${detail}`;
}

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const initialState = (startedAtMs: number): SpinRunState => ({
  status: { _tag: "running" },
  iteration: 0,
  startedAtMs,
  unchangedProgress: 0,
});

interface Setup {
  readonly _tag: "Setup";
  readonly request: BeginRequest;
  /** The `spin-anchor` entry setup branched from. */
  readonly anchorId: string;
}

interface Launching extends Omit<Setup, "_tag"> {
  readonly _tag: "Launching";
  readonly definition: SpinDefinition;
  /** Consumed when the continuation command arrives. */
  token: string | undefined;
  scheduled: boolean;
}

interface Running {
  readonly _tag: "Running";
  readonly spinId: string;
  readonly definition: SpinDefinition;
  /** Every iteration starts here. */
  readonly definitionEntryId: string;
  revision: number;
  /** Live state; saved at each check. */
  state: SpinRunState;
  /** The task run Spin submitted: none yet, submitted, started, or settled. */
  run: "none" | "submitted" | "active" | "settled";
  outcome: AgentActivityOutcome | undefined;
  /** Input Spin did not submit arrived since the iteration started. */
  foreign: boolean;
  token: string | undefined;
  /** The leaf when the task run settled; the continuation must find it unchanged. */
  settledLeaf: string | null;
  /** Completed when the Spin ends, to interrupt a check in flight. */
  readonly ended: Deferred.Deferred<void>;
}

type Phase = { readonly _tag: "Idle" } | Setup | Launching | Running;

const IDLE: Phase = { _tag: "Idle" };

function makeSpin(store: SpinStore["Service"], evaluator: CheckEvaluator["Service"], host: PiHost["Service"]): Spin["Service"] {
  // One Spin per session runtime. JavaScript runs one handler at a time, so the phase changes
  // only at yields; after any await, a step checks it still owns the phase (`phase === r`)
  // before acting.
  let phase: Phase = IDLE;
  let last: { readonly spinId: string; readonly iteration: number; readonly status: FinalStatus } | undefined;

  const newToken = Effect.sync(() => randomUUID());

  const finish = Effect.fnUntraced(function*(r: Running, status: FinalStatus, options: { readonly save?: boolean } = {}) {
    if (phase !== r) return;
    phase = IDLE;
    last = { spinId: r.spinId, iteration: r.state.iteration, status };
    yield* Deferred.succeed(r.ended, undefined);
    yield* host.setStatus(undefined);
    if (options.save === false) return;
    yield* store.updateRunState(r.spinId, r.revision, { ...r.state, status }).pipe(
      Effect.catch((error) => host.notify(`Spin could not save its final state (${error._tag}).`, "error")),
    );
    const quiet = status._tag === "completed" || (status._tag === "stopped" && status.reason === "user");
    yield* host.notify(describeStatus(status, r.state.iteration), quiet ? "info" : "warning");
  });

  const stopped = (reason: StopReason, detail?: string): FinalStatus => ({
    _tag: "stopped",
    reason,
    ...(detail ? { detail: truncate(detail, HARD_LIMITS.reason) } : {}),
  });

  const backToSetup = Effect.fnUntraced(function*(l: Launching, why: string) {
    if (phase !== l) return;
    phase = { _tag: "Setup", request: l.request, anchorId: l.anchorId };
    yield* host.notify(`Spin did not start: ${why} Ask the setup agent to call spin_start again, or run /spin stop.`, "warning");
  });

  /** Run the check, then complete, stop, or start the next iteration from the definition entry. */
  const checkAndContinue = Effect.fnUntraced(function*(r: Running, leafId: string) {
    const { definition } = r;
    const { maxIterations } = definition.limits;
    const at = { sessionId: definition.invocation.sessionId, leafId };
    const iteration = r.state.iteration;

    yield* host.setStatus(`Spin: checking after iteration ${iteration}/${maxIterations}`);
    const result = yield* evaluator.evaluate({
      check: definition.check,
      permissions: definition.permissions,
      input: { iteration },
    }).pipe(
      Effect.result,
      // Stopping interrupts the check, which closes its sandbox.
      Effect.raceFirst(Deferred.await(r.ended).pipe(Effect.as(undefined))),
    );
    if (phase !== r || result === undefined) return;

    // Pi was idle during the check, so anything may have happened meanwhile.
    const facts = yield* Effect.result(host.inspectSession);
    if (Result.isFailure(facts)) return yield* finish(r, stopped("host-failed", facts.failure.message));
    if (r.foreign) return yield* finish(r, stopped("foreign-input", "You sent input while the check ran."));
    if (facts.success.sessionId !== at.sessionId || facts.success.leafId !== leafId || !facts.success.idle) {
      return yield* finish(r, stopped("session-changed", "The conversation changed while the check ran."));
    }
    if (Result.isFailure(result)) {
      const { kind, message } = result.failure;
      return yield* finish(r, stopped("check-failed", `${kind}: ${message}`));
    }

    const evaluation = result.success;
    r.state = { ...r.state, lastEvaluation: evaluation, unchangedProgress: unchangedProgress(r.state, evaluation) };
    const final = decide(definition, r.state, yield* Clock.currentTimeMillis);
    if (final) return yield* finish(r, final);

    let carry: string | undefined;
    if (iteration > 0) {
      const branch = yield* Effect.result(host.captureBranch(at));
      if (Result.isFailure(branch)) return yield* finish(r, stopped("session-changed", branch.failure.message));
      const selected = selectCarry(branch.success, r.definitionEntryId, definition.carryMode);
      if (!selected) return yield* finish(r, stopped("session-changed", "The iteration is no longer on the Spin's branch."));
      carry = selected.text;
    }

    // Save the check at the end of this iteration's branch, then start the next from the definition.
    const saved = yield* Effect.result(store.updateRunState(r.spinId, r.revision, r.state));
    if (Result.isFailure(saved)) return yield* finish(r, stopped("host-failed", `Could not save state: ${saved.failure._tag}`), { save: false });
    r.revision = saved.success.revision;
    if (phase !== r) return;

    r.run = "submitted";
    r.outcome = undefined;
    r.settledLeaf = null;
    const started = yield* Effect.result(host.startIteration({
      targetId: r.definitionEntryId,
      ...(carry ? { carry } : {}),
      feedback: feedbackText(evaluation, iteration, maxIterations),
      prompt: definition.task,
      expected: { sessionId: at.sessionId, leafId: saved.success.entryId },
    }));
    if (Result.isFailure(started)) {
      r.run = "none";
      const reason = started.failure._tag === "SessionChanged" ? "session-changed" : "host-failed";
      return yield* finish(r, stopped(reason, started.failure.message));
    }
    r.state = { ...r.state, iteration: iteration + 1 };
    yield* host.setStatus(`Spin: iteration ${iteration + 1}/${maxIterations}`);
  });

  const launch = Effect.fnUntraced(function*(l: Launching) {
    const facts = yield* Effect.result(host.inspectSession);
    if (Result.isFailure(facts)) return yield* backToSetup(l, facts.failure.message);
    const { sessionId, leafId, idle } = facts.success;
    if (sessionId !== l.request.invocation.sessionId) return yield* backToSetup(l, "a different session is open.");
    if (!idle || leafId === null) return yield* backToSetup(l, "Pi is busy.");

    const returned = yield* Effect.result(host.navigate({ targetId: l.anchorId, expected: { sessionId, leafId } }));
    if (Result.isFailure(returned)) return yield* backToSetup(l, returned.failure.message);
    if (phase !== l) return;
    yield* host.setSetupTool(false);

    const startedAtMs = yield* Clock.currentTimeMillis;
    const record = yield* Effect.result(store.create(l.definition, initialState(startedAtMs)));
    if (Result.isFailure(record)) return yield* backToSetup(l, `could not save the definition (${record.failure._tag}).`);
    if (phase !== l) return;

    const r: Running = {
      _tag: "Running",
      spinId: record.success.spinId,
      definition: l.definition,
      definitionEntryId: record.success.entryId,
      revision: record.success.revision,
      state: record.success.state,
      run: "none",
      outcome: undefined,
      foreign: false,
      token: undefined,
      settledLeaf: record.success.entryId,
      ended: yield* Deferred.make<void>(),
    };
    phase = r;
    yield* host.notify("Spin started. Running the check before the first iteration.", "info");
    yield* checkAndContinue(r, r.definitionEntryId);
  });

  const iterationEnded = Effect.fnUntraced(function*(r: Running) {
    const facts = yield* Effect.result(host.inspectSession);
    if (Result.isFailure(facts)) return yield* finish(r, stopped("host-failed", facts.failure.message));
    const { sessionId, leafId, idle, pendingMessages } = facts.success;
    if (sessionId !== r.definition.invocation.sessionId) {
      return yield* finish(r, stopped("session-changed", "A different session is open."), { save: false });
    }
    if (r.outcome === "aborted") return yield* finish(r, stopped("run-aborted", "The task run was aborted."));
    if (r.outcome !== "completed") return yield* finish(r, stopped("run-error", "The task run ended with an error."));
    if (r.foreign) return yield* finish(r, stopped("foreign-input", "You sent input during the iteration."));
    if (!idle || pendingMessages || leafId === null || leafId !== r.settledLeaf) {
      return yield* finish(r, stopped("session-changed", "The conversation changed after the iteration ended."));
    }
    yield* checkAndContinue(r, leafId);
  });

  const reportInterrupted = Effect.gen(function*() {
    if (phase._tag !== "Idle") return;
    for (const record of yield* store.listUnfinished) {
      yield* host.notify(
        `A Spin in this session was interrupted (its last check ran after iteration ${record.state.iteration}) and will not resume. Start a new /spin to continue.`,
        "warning",
      );
    }
  });

  const onSettled = Effect.fnUntraced(function*() {
    const p = phase;
    if (p._tag === "Launching" && p.token !== undefined && !p.scheduled) {
      p.scheduled = true;
      const scheduled = yield* Effect.result(host.scheduleContinuation(p.token));
      if (Result.isFailure(scheduled)) yield* backToSetup(p, scheduled.failure.message);
      return;
    }
    if (p._tag !== "Running" || p.run !== "active") return;
    p.run = "settled";
    const facts = yield* Effect.result(host.inspectSession);
    if (Result.isFailure(facts)) return yield* finish(p, stopped("host-failed", facts.failure.message));
    p.settledLeaf = facts.success.leafId;
    p.token = yield* newToken;
    const scheduled = yield* Effect.result(host.scheduleContinuation(p.token));
    if (Result.isFailure(scheduled)) yield* finish(p, stopped("host-failed", scheduled.failure.message));
  });

  return Spin.of({
    begin: Effect.fn("Spin.begin")(function*(request) {
      if (phase._tag !== "Idle") {
        return yield* new SpinRejected({ message: "A Spin is already being set up or running. Use /spin stop first." });
      }
      yield* host.setSetupTool(true);
      const anchorId = yield* host.beginSetupConversation(request).pipe(
        Effect.tapError(() => host.setSetupTool(false)),
        Effect.mapError((error) => new SpinRejected({ message: `Could not start setup: ${error.message}` })),
      );
      phase = { _tag: "Setup", request, anchorId };
    }),

    startApproved: Effect.fn("Spin.startApproved")(function*(proposal) {
      const p = phase;
      if (p._tag === "Launching") return { accepted: false, message: "A proposal is already approved; Spin starts when this response ends." };
      if (p._tag !== "Setup") return { accepted: false, message: "No /spin setup is waiting for a proposal." };
      const definition = yield* Effect.result(approveProposal(proposal, {
        invocation: p.request.invocation,
        carryMode: p.request.carryMode,
      }));
      if (Result.isFailure(definition)) return { accepted: false, message: `Invalid proposal: ${definition.failure.message}` };
      phase = { _tag: "Launching", request: p.request, anchorId: p.anchorId, definition: definition.success, token: yield* newToken, scheduled: false };
      return {
        accepted: true,
        message: "Approved. Spin starts when this response ends: end your turn now, without further tool calls.",
      };
    }),

    observe: Effect.fn("Spin.observe")(function*(event) {
      const p = phase;
      switch (event._tag) {
        case "SessionStarted":
          return yield* reportInterrupted;
        case "Input":
          if (event.source === "extension") return;
          if (p._tag === "Running") p.foreign = true;
          if (p._tag === "Launching") yield* backToSetup(p, "you sent a message before it launched.");
          return;
        case "RunStarted":
          if (p._tag !== "Running") return;
          if (p.run === "submitted") {
            p.run = "active";
            p.outcome = undefined;
          } else {
            // A run Spin did not start, for example from a prompt sent while the check ran.
            p.foreign = true;
          }
          return;
        case "RunEnded":
          if (p._tag === "Running" && p.run === "active") {
            p.outcome = event.lastStopReason === "aborted" ? "aborted" : event.lastStopReason === "error" ? "error" : "completed";
          }
          return;
        case "BeforeSettle":
          if (p._tag === "Running" && p.run === "active") p.outcome = event.outcome;
          return;
        case "Settled":
          return yield* onSettled();
      }
    }),

    continue: Effect.fn("Spin.continue")(function*(token) {
      const p = phase;
      if (token === "") return;
      if (p._tag === "Launching" && p.token === token) {
        p.token = undefined;
        return yield* launch(p);
      }
      if (p._tag === "Running" && p.token === token) {
        p.token = undefined;
        return yield* iterationEnded(p);
      }
    }),

    stop: Effect.fn("Spin.stop")(function*(reason, detail) {
      const p = phase;
      if (p._tag === "Idle") return yield* new SpinRejected({ message: "No Spin is being set up or running." });
      if (p._tag !== "Running") {
        phase = IDLE;
        yield* host.setSetupTool(false);
        if (reason !== "shutdown") yield* host.notify("Spin setup cancelled.", "info");
        return;
      }
      // On shutdown nothing is written: the Spin reads as interrupted when the session reopens.
      yield* finish(p, stopped(reason, detail), { save: reason !== "shutdown" });
    }),

    summary: Effect.sync((): SpinSummary => {
      const p = phase;
      switch (p._tag) {
        case "Idle":
          return { phase: "idle", ...(last ? { spinId: last.spinId, iteration: last.iteration, last: last.status } : {}) };
        case "Setup":
          return { phase: "setup" };
        case "Launching":
          return { phase: "launching" };
        case "Running":
          return { phase: "running", spinId: p.spinId, iteration: p.state.iteration };
      }
    }),
  });
}
