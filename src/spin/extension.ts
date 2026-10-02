import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, type Layer, ManagedRuntime, Result, Schema } from "effect";
import { selectCarryMode } from "../carry-core.ts";
import { CurrentInvocation } from "./invocation.ts";
import { type HostEvent, SpinProposal } from "./model.ts";
import { CONTINUE_COMMAND } from "./pi-host.ts";
import { START_TOOL } from "./setup.ts";
import { Spin } from "./spin.ts";

// The Pi side of /spin: thin Promise/callback adapters that turn commands, the setup tool and
// lifecycle events into Spin calls. Decisions and session actions live behind Spin.

export const SPIN_COMMAND = "spin";
/** Internal. Scheduled by PiHost.scheduleContinuation; the only way back into a command context. */
export { CONTINUE_COMMAND, START_TOOL };

export interface SpinWiring {
  /** Builds Spin with its services. Called once per session runtime. */
  readonly layer: (pi: ExtensionAPI) => Layer.Layer<Spin>;
}

export function registerSpin(pi: ExtensionAPI, wiring: SpinWiring): void {
  // One runtime per session: created on first use, disposed on session_shutdown, so Spin's
  // in-memory state never outlives the session it belongs to.
  let runtime: ManagedRuntime.ManagedRuntime<Spin, never> | undefined;

  const run = <A, E>(
    effect: Effect.Effect<A, E, Spin>,
    context: ExtensionContext,
    command?: ExtensionCommandContext,
  ): Promise<A> => {
    runtime ??= ManagedRuntime.make(wiring.layer(pi));
    return runtime.runPromise(
      effect.pipe(Effect.provideService(CurrentInvocation, command ? { context, command } : { context })),
    );
  };
  const observe = (event: HostEvent, context: ExtensionContext) =>
    run(Spin.use((spin) => spin.observe(event)), context);

  pi.registerCommand(SPIN_COMMAND, {
    description: `Repeat a task from here until a saved check says it is done (/${SPIN_COMMAND} stop, /${SPIN_COMMAND} status)`,
    handler: async (args, ctx) => {
      const intent = args.trim();
      if (intent === "stop") {
        return run(stopForUser(ctx), ctx, ctx);
      }
      if (intent === "status") {
        const summary = await run(Spin.use((spin) => spin.summary), ctx, ctx);
        ctx.ui.notify(JSON.stringify(summary), "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(`/${SPIN_COMMAND} setup needs an interactive UI.`, "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(`Wait for the current response to finish before using /${SPIN_COMMAND}.`, "warning");
        return;
      }
      // Capture the anchor before any configuration, so setup cannot move it.
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        ctx.ui.notify(`/${SPIN_COMMAND} needs at least one message to anchor on.`, "warning");
        return;
      }
      const invocation = { sessionId: ctx.sessionManager.getSessionId(), leafId };

      const carryMode = (await selectCarryMode((title, options) => ctx.ui.select(title, options), "Carry what between iterations?"))?.value;
      if (!carryMode) return;
      const requested = intent || (await ctx.ui.input("What should Spin do?", "e.g. burn down all linter errors"))?.trim();
      if (!requested) return;

      await run(
        Spin.use((spin) => spin.begin({ invocation, intent: requested, carryMode })).pipe(
          Effect.catchTag("SpinRejected", (error) => Effect.sync(() => ctx.ui.notify(error.message, "warning"))),
        ),
        ctx,
        ctx,
      );
    },
  });

  pi.registerCommand(CONTINUE_COMMAND, {
    description: `Internal: used by /${SPIN_COMMAND} to continue its loop`,
    handler: (args, ctx) => run(Spin.use((spin) => spin.continue(args.trim())), ctx, ctx),
  });

  pi.registerTool({
    name: START_TOOL,
    label: "Start Spin",
    description: `Save and start the Spin proposal the user approved during /${SPIN_COMMAND} setup.`,
    // Plain JSON Schema derived from SpinProposal, rejecting unknown keys like the decode below.
    // `params` is unknown: Pi's validator cannot check everything, so that decode is authoritative.
    parameters: Schema.toJsonSchemaDocument(SpinProposal, { onExcessProperty: "error" }).schema,
    // Declared to the model only while a /spin setup waits for a proposal (PiHost.setSetupTool).
    defaultActive: false,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // JSON Schema cannot express every rule (the check snapshot, limits), so decode before
      // asking: the user only ever approves a valid proposal.
      const decoded = decodeProposal(params);
      if (Result.isFailure(decoded)) {
        const message = `Invalid proposal: ${decoded.failure.message}`;
        return { content: [{ type: "text", text: message }], details: { accepted: false, message } };
      }
      // Registered for every conversation; outside setup there is nothing to confirm.
      const { phase } = await run(Spin.use((spin) => spin.summary), ctx);
      if (phase !== "setup") {
        const message = `No /${SPIN_COMMAND} setup is waiting for a proposal.`;
        return { content: [{ type: "text", text: message }], details: { accepted: false, message } };
      }
      // The user approves here, in the UI, so the agent cannot start a Spin on its own claim.
      // Pi's confirm cannot scroll, so it shows a summary; the setup agent shows the full proposal.
      const approved = ctx.hasUI
        && await ctx.ui.confirm("Start this Spin?", formatProposal(decoded.success), signal ? { signal } : {});
      const result = approved
        ? await run(Spin.use((spin) => spin.startApproved(decoded.success)), ctx)
        : { accepted: false, message: "The user did not approve this proposal." };
      return { content: [{ type: "text", text: result.message }], details: { ...result } };
    },
  });

  pi.on("session_start", (_event, ctx) => observe({ _tag: "SessionStarted" }, ctx));
  pi.on("agent_start", (_event, ctx) => observe({ _tag: "RunStarted" }, ctx));
  pi.on("agent_end", (event, ctx) => observe({ _tag: "RunEnded", lastStopReason: lastStopReason(event.messages) }, ctx));
  pi.on("agent_before_settle", (event, ctx) => observe({ _tag: "BeforeSettle", outcome: event.outcome }, ctx));
  // Wrapped so the handler returns nothing: an input handler's result can transform the input.
  pi.on("input", async (event, ctx) => {
    await observe({ _tag: "Input", source: event.source }, ctx);
  });
  // Notification-only: Spin may schedule the continuation command here, never navigate.
  pi.on("agent_settled", (_event, ctx) => observe({ _tag: "Settled" }, ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = runtime;
    if (!current) return;
    runtime = undefined;
    try {
      await current.runPromise(
        Spin.use((spin) => spin.stop("shutdown")).pipe(
          Effect.catchTag("SpinRejected", () => Effect.void),
          Effect.provideService(CurrentInvocation, { context: ctx }),
        ),
      );
    } finally {
      await current.dispose();
    }
  });
}

const decodeProposal = Schema.decodeUnknownResult(SpinProposal, { onExcessProperty: "error", errors: "all" });

/** What the check may do and how long Spin runs. The task and script are in the conversation above. */
export function formatProposal(proposal: SpinProposal): string {
  const { permissions, limits } = proposal;
  return [
    permissions.commands
      ? "Commands: YES. The check can run ANY shell command, unattended, on every iteration. Read the script."
      : "Commands: no",
    "Reads: the check can read any file and use Pi's grep, find and ls.",
    `Classifier: ${permissions.classifier ? "yes, models.classify (costs money per call)" : "no"}`,
    `Limits: ${limits.maxIterations} iterations, ${limits.maxDurationMs / 60_000} min total`
    + (limits.maxUnchangedProgress ? `, stop after ${limits.maxUnchangedProgress} checks without progress` : ""),
  ].join("\n");
}

const stopForUser = (ctx: ExtensionCommandContext) =>
  Spin.use((spin) => spin.stop("user")).pipe(
    Effect.catchTag("SpinRejected", (error) => Effect.sync(() => ctx.ui.notify(error.message, "warning"))),
  );

// Pi skips agent_before_settle on abort, so the last assistant message's stop reason
// ("stop", "aborted", "error", ...) is the only sign of an aborted run.
function lastStopReason(messages: AgentEndEvent["messages"]): string | undefined {
  const last = messages.findLast((message) => message.role === "assistant");
  return last && "stopReason" in last ? last.stopReason : undefined;
}
