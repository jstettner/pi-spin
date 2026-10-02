import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { CARRY_HEADER, CARRY_TYPE } from "../carry-core.ts";
import { HostActionFailed, SessionChanged } from "./errors.ts";
import { CurrentInvocation } from "./invocation.ts";
import {
  ANCHOR_ENTRY,
  type BeginRequest,
  FEEDBACK_MESSAGE,
  type IterationRequest,
  type NavigateRequest,
  type SessionFacts,
  type SessionPosition,
  SETUP_MESSAGE,
} from "./model.ts";
import { setupInstructions, START_TOOL } from "./setup.ts";

/** The internal command PiHost.scheduleContinuation asks Pi to run. */
export const CONTINUE_COMMAND = "spin-continue";

/**
 * Reads Pi session facts and performs the session actions Spin is allowed. Every action
 * re-checks `expected` immediately before changing the session. It never decides whether a
 * check passed or whether Spin continues.
 */
export class PiHost extends Context.Service<PiHost, {
  readonly inspectSession: Effect.Effect<SessionFacts, HostActionFailed>;

  /**
   * Mark the invocation leaf with a `spin-anchor` entry and start the setup conversation from
   * it, outside the task's context. Returns the anchor entry's id.
   */
  beginSetupConversation(request: BeginRequest): Effect.Effect<string, SessionChanged | HostActionFailed>;

  /** Read the branch ending at `expected`, for carry selection. */
  captureBranch(
    expected: SessionPosition,
  ): Effect.Effect<ReadonlyArray<SessionEntry>, SessionChanged | HostActionFailed>;

  /** Navigate to the target without summarizing, and confirm it landed there. Command context only. */
  navigate(request: NavigateRequest): Effect.Effect<void, SessionChanged | HostActionFailed>;

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

  /** Declare `spin_start` to the model, or stop declaring it. Inactive outside setup. */
  setSetupTool(active: boolean): Effect.Effect<void>;

  /** Show a notification and the status widget. UI only, never model context. */
  notify(text: string, level: "info" | "warning" | "error"): Effect.Effect<void>;
  setStatus(text: string | undefined): Effect.Effect<void>;
}>()("pi-spin/spin/PiHost") {
  /** Uses `pi` for writes and the calling handler's context (CurrentInvocation) for everything else. */
  static readonly layer = (pi: ExtensionAPI) => Layer.succeed(PiHost, makePiHost(pi));
}

const STATUS_KEY = "spin";

/** Before any session action: the session, leaf, idle state and queue are exactly as Spin expects. */
const assertInvariants = Effect.fnUntraced(function*(ctx: ExtensionContext, expected: SessionPosition) {
  if (ctx.sessionManager.getSessionId() !== expected.sessionId) {
    return yield* new SessionChanged({ message: "A different session is open." });
  }
  if (ctx.sessionManager.getLeafId() !== expected.leafId) {
    return yield* new SessionChanged({ message: "The conversation moved to a different tree position." });
  }
  if (!ctx.isIdle()) return yield* new SessionChanged({ message: "Pi is busy with another response." });
  if (ctx.hasPendingMessages()) return yield* new SessionChanged({ message: "Messages are queued." });
});

function makePiHost(pi: ExtensionAPI): PiHost["Service"] {
  const navigate = Effect.fn("PiHost.navigate")(function*(request: NavigateRequest) {
    const invocation = yield* CurrentInvocation;
    const ctx = invocation?.command;
    if (!ctx) return yield* new HostActionFailed({ action: "navigate", message: "Session actions need a command context." });
    const { sessionManager } = ctx;
    yield* assertInvariants(ctx, request.expected);
    if (request.targetId === request.expected.leafId) return;

    const result = yield* Effect.tryPromise({
      try: () => ctx.navigateTree(request.targetId, { summarize: false }),
      catch: (error) => new HostActionFailed({ action: "navigate", message: error instanceof Error ? error.message : String(error) }),
    });
    if (result.cancelled) return yield* new HostActionFailed({ action: "navigate", message: "Navigation was cancelled." });
    // session_tree handlers may append non-context extension state (e.g. Plannotator).
    // Accept only custom-entry descendants of the target, never new conversation content
    // or another branch. Keep their state instead of navigating again and retriggering them.
    const branch = sessionManager.getBranch();
    const targetIndex = branch.findIndex((entry) => entry.id === request.targetId);
    if (sessionManager.getSessionId() !== request.expected.sessionId
      || targetIndex === -1
      || branch.slice(targetIndex + 1).some((entry) => entry.type !== "custom")) {
      return yield* new HostActionFailed({ action: "navigate", message: "Navigation landed on a different tree position." });
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      return yield* new SessionChanged({ message: "Input arrived during navigation." });
    }
  });

  return PiHost.of({
    inspectSession: Effect.gen(function*() {
      const invocation = yield* CurrentInvocation;
      if (!invocation) return yield* new HostActionFailed({ action: "inspectSession", message: "No Pi context." });
      const { context } = invocation;
      return {
        sessionId: context.sessionManager.getSessionId(),
        leafId: context.sessionManager.getLeafId(),
        idle: context.isIdle(),
        pendingMessages: context.hasPendingMessages(),
      };
    }),

    beginSetupConversation: Effect.fn("PiHost.beginSetupConversation")(function*(request) {
      const invocation = yield* CurrentInvocation;
      if (!invocation) return yield* new HostActionFailed({ action: "beginSetupConversation", message: "No Pi context." });
      const { context } = invocation;
      const { sessionManager } = context;
      yield* assertInvariants(context, request.invocation);

      // pi.appendEntry and pi.sendMessage (idle, no turn) append synchronously, so the new leaf
      // is the entry just written.
      pi.appendEntry(ANCHOR_ENTRY, { version: 1 });
      const anchorId = sessionManager.getLeafId();
      const anchor = anchorId ? sessionManager.getEntry(anchorId) : undefined;
      if (anchor?.type !== "custom" || anchor.customType !== ANCHOR_ENTRY) {
        return yield* new HostActionFailed({ action: "beginSetupConversation", message: "The anchor entry was not written." });
      }
      pi.sendMessage(
        { customType: SETUP_MESSAGE, content: setupInstructions(request), display: true, details: { carryMode: request.carryMode } },
        { triggerTurn: false },
      );
      pi.sendUserMessage(request.intent);
      return anchor.id;
    }),

    captureBranch: Effect.fn("PiHost.captureBranch")(function*(expected) {
      const invocation = yield* CurrentInvocation;
      if (!invocation) return yield* new HostActionFailed({ action: "captureBranch", message: "No Pi context." });
      const { context } = invocation;
      const { sessionManager } = context;
      yield* assertInvariants(context, expected);
      return sessionManager.getBranch();
    }),

    navigate,

    startIteration: Effect.fn("PiHost.startIteration")(function*(request) {
      yield* navigate(request);
      if (request.carry) {
        pi.sendMessage({ customType: CARRY_TYPE, content: CARRY_HEADER + request.carry, display: true }, { triggerTurn: false });
      }
      if (request.feedback) {
        pi.sendMessage({ customType: FEEDBACK_MESSAGE, content: request.feedback, display: true }, { triggerTurn: false });
      }
      pi.sendUserMessage(request.prompt);
    }),

    scheduleContinuation: Effect.fn("PiHost.scheduleContinuation")(function*(token) {
      // Deferred by Pi while agent_settled handlers run, then dispatched as a command with a
      // fresh command context. Not recorded as a user message and fires no input event.
      yield* Effect.try({
        try: () => pi.sendUserMessage(`/${CONTINUE_COMMAND} ${token}`, { expandPromptTemplates: true }),
        catch: (error) => new HostActionFailed({
          action: "scheduleContinuation",
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }),

    setSetupTool: Effect.fn("PiHost.setSetupTool")(function*(active) {
      const others = pi.getActiveTools().filter((name) => name !== START_TOOL);
      pi.setActiveTools(active ? [...others, START_TOOL] : others);
    }),

    notify: Effect.fn("PiHost.notify")(function*(text, level) {
      const invocation = yield* CurrentInvocation;
      invocation?.context.ui.notify(text, level);
    }),

    setStatus: Effect.fn("PiHost.setStatus")(function*(text) {
      const invocation = yield* CurrentInvocation;
      invocation?.context.ui.setStatus(STATUS_KEY, text);
    }),
  });
}
