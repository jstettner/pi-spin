import { Context, type Effect } from "effect";
import type { SpinRejected } from "./errors.ts";
import type { ApprovalResult, BeginRequest, HostEvent, SpinSummary, StopReason } from "./model.ts";

/**
 * Owns setup, approval and the running loop for the current session, one change at a time.
 * It alone decides whether to complete, stop or continue, using SpinStore, CheckEvaluator and
 * PiHost, which its layer provides. Callers pass ordinary values, never services or Pi contexts.
 *
 * Failures inside a running Spin become a stop with a reason, not errors here. Methods fail
 * only with SpinRejected, when the call does not fit the current phase.
 */
export class Spin extends Context.Service<Spin, {
  /** `/spin <intent>` after the carry mode is chosen: record the anchor and start setup. */
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
}>()("pi-spin/spin/Spin") {}
