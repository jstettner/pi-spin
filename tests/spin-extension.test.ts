import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Schema } from "effect";
import { test } from "vitest";
import { CARRY_MODES } from "../src/carry-core.ts";
import { SpinRejected } from "../src/spin/errors.ts";
import { CONTINUE_COMMAND, registerSpin, SPIN_COMMAND, START_TOOL } from "../src/spin/extension.ts";
import { CurrentInvocation } from "../src/spin/invocation.ts";
import type { ApprovalResult } from "../src/spin/model.ts";
import { SpinProposal } from "../src/spin/model.ts";
import { Spin } from "../src/spin/spin.ts";
import { checkSource, proposal } from "./spin-fixtures.ts";

// Drives registerSpin through a fake ExtensionAPI and a fake Spin layer that records each call
// and the invocation context it ran with.

interface Call {
  method: string;
  arg?: unknown;
  context: unknown;
  command: unknown;
}

type Handler = (...args: never[]) => unknown;

function harness(options: { reject?: string; approval?: ApprovalResult } = {}) {
  const calls: Call[] = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const selections: string[][] = [];
  const confirms: Array<{ title: string; message: string }> = [];
  let layersBuilt = 0;
  let disposed = 0;

  const record = Effect.fnUntraced(function*(method: string, arg?: unknown) {
    const invocation = yield* CurrentInvocation;
    calls.push({ method, arg, context: invocation?.context, command: invocation?.command });
  });
  const layer = () =>
    Layer.effect(
      Spin,
      Effect.gen(function*() {
        layersBuilt += 1;
        yield* Effect.addFinalizer(() => Effect.sync(() => disposed += 1));
        return Spin.of({
          begin: Effect.fn("begin")(function*(request) {
            yield* record("begin", request);
            if (options.reject) return yield* new SpinRejected({ message: options.reject });
          }),
          startApproved: Effect.fn("startApproved")(function*(proposal) {
            yield* record("startApproved", proposal);
            return options.approval ?? { accepted: true, message: "Starting." };
          }),
          observe: Effect.fn("observe")((event) => record("observe", event)),
          continue: Effect.fn("continue")((token) => record("continue", token)),
          stop: Effect.fn("stop")(function*(reason) {
            yield* record("stop", reason);
            if (options.reject) return yield* new SpinRejected({ message: options.reject });
          }),
          summary: Effect.succeed({ phase: "idle" }),
        });
      }),
    );

  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, { execute: Handler; parameters: unknown }>();
  const handlers = new Map<string, Handler>();
  const pi = {
    registerCommand: (name: string, command: never) => commands.set(name, command),
    registerTool: (tool: { name: string; execute: Handler; parameters: unknown }) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  registerSpin(pi, { layer });

  const answers = {
    select: CARRY_MODES[0].label as string | undefined,
    input: "burn down lint" as string | undefined,
    confirm: true,
  };
  const ui = {
    notify: (text: string, level: string) => notifications.push({ text, level }),
    select: async (_title: string, labels: string[]) => {
      selections.push(labels);
      return answers.select;
    },
    input: async () => answers.input,
    confirm: async (title: string, message: string) => {
      confirms.push({ title, message });
      return answers.confirm;
    },
  };
  const session = { getLeafId: () => "anchor", getSessionId: () => "session-1" };
  const ctx = {
    hasUI: true,
    ui,
    isIdle: () => true,
    sessionManager: session,
  } as unknown as ExtensionCommandContext;

  const command = (name: string, args: string) => commands.get(name)!.handler(args, ctx);
  const emit = (event: string, payload: object, context: ExtensionContext = ctx) =>
    (handlers.get(event) as (event: object, ctx: ExtensionContext) => Promise<unknown>)(payload, context);
  const toolParameters = () => (tools.get(START_TOOL) as unknown as { parameters: unknown }).parameters;
  const tool = (params: object) =>
    (tools.get(START_TOOL)!.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>)(
      "call-1", params, undefined, undefined, ctx,
    );
  return {
    ctx, calls, notifications, selections, confirms, answers, command, emit, tool, toolParameters,
    get layersBuilt() { return layersBuilt; },
    get disposed() { return disposed; },
  };
}

test("/spin <intent> captures the anchor, picks the carry mode, then begins in command context", async () => {
  const h = harness();
  h.answers.select = CARRY_MODES[2].label;
  await h.command(SPIN_COMMAND, "  burn down all linter failures ");
  assert.deepEqual(h.selections, [CARRY_MODES.map((mode) => mode.label)]);
  assert.deepEqual(h.calls, [{
    method: "begin",
    arg: { invocation: { sessionId: "session-1", leafId: "anchor" }, intent: "burn down all linter failures", carryMode: "users" },
    context: h.ctx,
    command: h.ctx,
  }]);
});

test("/spin without an intent asks for it after the carry picker", async () => {
  const h = harness();
  await h.command(SPIN_COMMAND, "");
  assert.equal(h.selections.length, 1);
  assert.equal((h.calls[0]!.arg as { intent: string }).intent, "burn down lint");
});

test("cancelling the picker or the intent starts nothing", async () => {
  const h = harness();
  h.answers.select = undefined;
  await h.command(SPIN_COMMAND, "lint");
  h.answers.select = CARRY_MODES[0].label;
  h.answers.input = "  ";
  await h.command(SPIN_COMMAND, "");
  assert.deepEqual(h.calls, []);
  assert.equal(h.layersBuilt, 0);
});

test("/spin refuses without a UI, while busy, or with nothing to anchor on", async () => {
  for (const change of [{ hasUI: false }, { isIdle: () => false }, { sessionManager: { getLeafId: () => null } }]) {
    const h = harness();
    Object.assign(h.ctx, change);
    await h.command(SPIN_COMMAND, "lint");
    assert.deepEqual(h.calls, []);
    assert.equal(h.notifications.length, 1);
  }
});

test("Spin rejections are shown to the user", async () => {
  const h = harness({ reject: "A Spin is already running." });
  await h.command(SPIN_COMMAND, "lint");
  await h.command(SPIN_COMMAND, "stop");
  assert.deepEqual(h.notifications, [
    { text: "A Spin is already running.", level: "warning" },
    { text: "A Spin is already running.", level: "warning" },
  ]);
});

test("/spin stop stops for the user", async () => {
  const h = harness();
  await h.command(SPIN_COMMAND, "stop");
  assert.deepEqual(h.calls.map((call) => [call.method, call.arg]), [["stop", "user"]]);
});

test("the continuation command hands its token to Spin with its own command context", async () => {
  const h = harness();
  await h.command(CONTINUE_COMMAND, " token-1 ");
  assert.deepEqual(h.calls, [{ method: "continue", arg: "token-1", context: h.ctx, command: h.ctx }]);
});

test("lifecycle events reach Spin as host events without a command context", async () => {
  const h = harness();
  const eventCtx = { ui: h.ctx.ui } as unknown as ExtensionContext;
  await h.emit("agent_start", {}, eventCtx);
  await h.emit("input", { source: "interactive", text: "typed" }, eventCtx);
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }, { role: "assistant", stopReason: "aborted" }] }, eventCtx);
  await h.emit("agent_before_settle", { outcome: "completed" }, eventCtx);
  await h.emit("agent_settled", {}, eventCtx);
  assert.deepEqual(h.calls.map((call) => call.arg), [
    { _tag: "RunStarted" },
    { _tag: "Input", source: "interactive" },
    { _tag: "RunEnded", lastStopReason: "aborted" },
    { _tag: "BeforeSettle", outcome: "completed" },
    { _tag: "Settled" },
  ]);
  assert.ok(h.calls.every((call) => call.context === eventCtx && call.command === undefined));
  assert.equal(h.layersBuilt, 1);
});

test("the start tool rejects an invalid proposal without asking the user", async () => {
  const h = harness();
  const bad = { ...proposal(), capabilities: { readPaths: ["../secrets"], commands: [] }, carryMode: "all" };
  const result = await h.tool(bad);
  assert.match(result.content[0]!.text, /^Invalid proposal: /);
  assert.match(result.content[0]!.text, /'\.\.' segments/);
  assert.match(result.content[0]!.text, /carryMode/);
  assert.deepEqual(h.confirms, []);
  assert.equal(h.calls.length, 0);
});

test("the start tool shows the whole proposal, then passes it to Spin only if approved", async () => {
  const h = harness({ approval: { accepted: false, message: "A Spin is already running." } });
  h.answers.confirm = false;
  const declined = await h.tool(proposal());
  assert.equal(declined.content[0]!.text, "The user did not approve this proposal.");
  assert.equal(h.calls.length, 0);
  const shown = h.confirms[0]!.message;
  for (const part of [proposal().task, checkSource, "npm run lint -- --format json", "  src", "Classifier: no", "10 iterations"]) {
    assert.ok(shown.includes(part), `dialog shows ${part}`);
  }

  h.answers.confirm = true;
  const rejected = await h.tool(proposal());
  assert.equal(rejected.content[0]!.text, "A Spin is already running.");
  assert.deepEqual(h.calls.map((call) => [call.method, call.arg, call.command]), [["startApproved", proposal(), undefined]]);
});

test("the start tool's parameters are the proposal schema", () => {
  const h = harness();
  assert.deepEqual(h.toolParameters(), Schema.toJsonSchemaDocument(SpinProposal, { onExcessProperty: "error" }).schema);
});

test("session shutdown stops the Spin and disposes the runtime; the next use builds a new one", async () => {
  const h = harness();
  await h.emit("session_shutdown", {});
  assert.equal(h.layersBuilt, 0, "nothing to stop before first use");

  await h.emit("agent_start", {});
  await h.emit("session_shutdown", {});
  assert.deepEqual(h.calls.map((call) => [call.method, call.arg]), [["observe", { _tag: "RunStarted" }], ["stop", "shutdown"]]);
  assert.equal(h.disposed, 1);

  await h.emit("agent_start", {});
  assert.equal(h.layersBuilt, 2);
});
