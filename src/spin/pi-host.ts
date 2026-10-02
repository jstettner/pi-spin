import { Context, type Effect } from "effect";
import type { HostActionFailed, SessionChanged } from "./errors.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BeginRequest, IterationRequest, SessionFacts, SessionPosition } from "./model.ts";

/**
 * Reads Pi session facts and performs the session actions Spin is allowed. Every action
 * re-checks `expected` immediately before changing the session. It never decides whether a
 * check passed or whether Spin continues.
 */
export class PiHost extends Context.Service<PiHost, {
  readonly inspectSession: Effect.Effect<SessionFacts, HostActionFailed>;

  /** Start the setup conversation for `/spin`, outside the task's context. */
  beginSetupConversation(request: BeginRequest): Effect.Effect<void, SessionChanged | HostActionFailed>;

  /** Read the iteration's branch, ending at `expected`, for carry selection. */
  captureBranch(
    expected: SessionPosition,
  ): Effect.Effect<ReadonlyArray<SessionEntry>, SessionChanged | HostActionFailed>;

  /**
   * Navigate to the target without summarizing, attach carry and check feedback, then submit
   * the task prompt. The guards run once before any of it. Command context only.
   */
  startIteration(request: IterationRequest): Effect.Effect<void, SessionChanged | HostActionFailed>;

  /**
   * Ask Pi to run the internal continuation command with `token` after the current
   * `agent_settled` handlers return. Safe from any handler; does not navigate.
   */
  scheduleContinuation(token: string): Effect.Effect<void, HostActionFailed>;

  /** Show a notification and the status widget. UI only, never model context. */
  notify(text: string, level: "info" | "warning" | "error"): Effect.Effect<void>;
  setStatus(text: string | undefined): Effect.Effect<void>;
}>()("pi-spin/spin/PiHost") {}
