import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { CARRY_HEADER, CARRY_TYPE, type CarryMode } from "../src/carry-core.ts";
import { CheckEvaluator } from "../src/spin/check-evaluator.ts";
import { CheckFailed } from "../src/spin/errors.ts";
import { CurrentInvocation } from "../src/spin/invocation.ts";
import {
  ANCHOR_ENTRY,
  type CheckInput,
  type CheckVerdict,
  DEFINITION_ENTRY,
  type EvaluationRecord,
  FEEDBACK_MESSAGE,
  type HostEvent,
  SETUP_MESSAGE,
  STATE_ENTRY,
} from "../src/spin/model.ts";
import { CONTINUE_COMMAND, PiHost } from "../src/spin/pi-host.ts";
import { Spin } from "../src/spin/spin.ts";
import { SpinStore } from "../src/spin/spin-store.ts";
import { checkSource, proposal } from "./spin-fixtures.ts";

// The live Spin, SpinStore and PiHost over a real in-memory SessionManager. Pi itself is faked:
// `pi` writes to the manager, navigation follows Pi's rules (user and custom_message targets
// land on their parent), and task runs are simulated by appending an assistant message and
// emitting the events Pi would. The check is a scripted fake.

type Message = Parameters<SessionManager["appendMessage"]>[0];
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as Message;
const assistant = (text: string, stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason,
  api: "openai-responses", provider: "synthetic", model: "synthetic", usage, timestamp: 0,
}) as Message;

const verdict = (value: CheckVerdict["verdict"], extra: Partial<CheckVerdict> = {}): CheckVerdict => ({
  verdict: value, reason: `Synthetic ${value}.`, ...extra,
});

type Step = CheckVerdict | Effect.Effect<EvaluationRecord, CheckFailed>;

function world(options: { steps?: Step[]; anchor?: "assistant" | "carry" } = {}) {
  const manager = SessionManager.inMemory("/synthetic/project");
  manager.appendMessage(user("Earlier context."));
  manager.appendMessage(assistant("Earlier reply."));
  if (options.anchor === "carry") {
    manager.appendCustomMessageEntry(CARRY_TYPE, `${CARRY_HEADER}User:\nCarried text.`, true);
  }
  const invocation = { sessionId: manager.getSessionId(), leafId: manager.getLeafId()! };

  const state = {
    idle: true,
    pending: false,
    notifications: [] as Array<{ text: string; level: string }>,
    submitted: [] as string[],
    scheduled: [] as string[],
    navigations: [] as string[],
    inputs: [] as CheckInput[],
    steps: [...(options.steps ?? [])],
  };

  let activeTools = ["read"];
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = names; },
    appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
    sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
    sendUserMessage: (text: string, sendOptions?: { expandPromptTemplates?: boolean }) => {
      const prefix = `/${CONTINUE_COMMAND} `;
      if (sendOptions?.expandPromptTemplates && text.startsWith(prefix)) state.scheduled.push(text.slice(prefix.length));
      else {
        state.submitted.push(text);
        manager.appendMessage(user(text));
      }
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/synthetic/project",
    sessionManager: manager,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    ui: {
      notify: (text: string, level: string) => state.notifications.push({ text, level }),
      setStatus: () => {},
    },
    navigateTree: async (targetId: string) => {
      state.navigations.push(targetId);
      const target = manager.getEntry(targetId)!;
      const toParent = (target.type === "message" && target.message.role === "user") || target.type === "custom_message";
      const leafId = toParent ? target.parentId : targetId;
      if (leafId === null) manager.resetLeaf();
      else manager.branch(leafId);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  const evaluator = Layer.succeed(CheckEvaluator, CheckEvaluator.of({
    evaluate: Effect.fn("evaluate")(function*(request) {
      state.inputs.push(request.input);
      const step = state.steps.shift() ?? verdict("done");
      if (Effect.isEffect(step)) return yield* step;
      return { iteration: request.input.iteration, verdict: step, diagnostics: "", classifierCalls: 0, durationMs: 0 };
    }),
  }));
  const layer = Spin.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(SpinStore.layer(pi), PiHost.layer(pi), evaluator)),
  );

  // Every call runs as if from a command handler with this context.
  const inPi = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CurrentInvocation, { context: ctx, command: ctx }));
  const observe = (event: HostEvent) => inPi(Spin.use((spin) => spin.observe(event)));
  const continueWith = (token: string) => inPi(Spin.use((spin) => spin.continue(token)));
  const takeToken = () => {
    const token = state.scheduled.shift();
    assert.ok(token, "a continuation was scheduled");
    return token;
  };

  /** Pi's events for one task run, then the continuation it schedules. */
  const runTask = Effect.fnUntraced(function*(reply: string, stopReason = "stop") {
    yield* observe({ _tag: "RunStarted" });
    manager.appendMessage(assistant(reply, stopReason));
    yield* observe({ _tag: "RunEnded", lastStopReason: stopReason });
    if (stopReason === "stop") yield* observe({ _tag: "BeforeSettle", outcome: "completed" });
    yield* observe({ _tag: "Settled" });
    return takeToken();
  });

  /** /spin, the setup agent's approved proposal, and the setup run settling. */
  const setUp = Effect.fnUntraced(function*(carryMode: CarryMode = "last") {
    yield* inPi(Spin.use((spin) => spin.begin({ invocation, intent: "Burn down lint errors.", carryMode })));
    manager.appendMessage(assistant("Here is a proposal."));
    const approval = yield* inPi(Spin.use((spin) => spin.startApproved(proposal())));
    assert.isTrue(approval.accepted, approval.message);
    yield* observe({ _tag: "Settled" });
    return takeToken();
  });

  const launch = Effect.fnUntraced(function*(carryMode: CarryMode = "last") {
    yield* continueWith(yield* setUp(carryMode));
  });

  const record = () => inPi(SpinStore.use((store) => store.listUnfinished));
  const spinEntries = () =>
    manager.getEntries().filter((entry): entry is Extract<SessionEntry, { type: "custom" }> =>
      entry.type === "custom" && (entry.customType === DEFINITION_ENTRY || entry.customType === STATE_ENTRY));
  const lastState = () => spinEntries().at(-1)!.data as { revision: number; state: { status: { _tag: string; reason?: string; detail?: string }; iteration: number } };
  const definitionEntry = () => spinEntries().find((entry) => entry.customType === DEFINITION_ENTRY)!;
  const messages = (entries: SessionEntry[]) => entries.flatMap((entry) => {
    if (entry.type === "message") {
      const { content } = entry.message as { content: string | Array<{ text?: string }> };
      return [`${entry.message.role}: ${typeof content === "string" ? content : content.map((block) => block.text ?? "").join("")}`];
    }
    if (entry.type === "custom_message") return [`${entry.customType}: ${String(entry.content)}`];
    return [];
  });

  return {
    manager, invocation, state, ctx, layer, inPi, observe, continueWith, takeToken, runTask, setUp, launch,
    record, spinEntries, lastState, definitionEntry, messages,
    activeTools: () => activeTools,
  };
}

const provide = (w: ReturnType<typeof world>) => Effect.provide(w.layer);
const task = proposal().task;

describe("Spin", () => {
  it.effect("runs setup on a branch, then repeats the task from the definition entry until the check is done", () => {
    const w = world({ steps: [verdict("continue"), verdict("continue", { reason: "3 errors remain." }), verdict("done")] });
    return Effect.gen(function*() {
      const token = yield* w.setUp();
      assert.deepStrictEqual(w.activeTools(), ["read", "spin_start"], "spin_start is declared during setup");
      yield* w.continueWith(token);
      assert.deepStrictEqual(w.activeTools(), ["read"], "and not once the Spin runs");
      // Setup branched from a spin-anchor entry at the invocation leaf.
      const anchor = w.manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === ANCHOR_ENTRY)!;
      assert.strictEqual(anchor.parentId, w.invocation.leafId);
      const definition = w.definitionEntry();
      assert.strictEqual(definition.parentId, anchor.id);
      // Back to the anchor to save the definition, then from the saved first check to the definition.
      assert.deepStrictEqual(w.state.navigations, [anchor.id, definition.id]);
      assert.deepStrictEqual(w.state.submitted, ["Burn down lint errors.", task]);
      assert.deepStrictEqual(w.state.inputs, [{ iteration: 0 }]);

      yield* w.continueWith(yield* w.runTask("Fixed batch one."));
      assert.deepStrictEqual(w.state.inputs.at(-1), { iteration: 1 });
      // Iteration 2 sees the definition-level context, the carry from iteration 1 and the
      // check's feedback, but nothing from setup or earlier carries.
      const context = w.messages(w.manager.getBranch());
      assert.deepStrictEqual(context.slice(0, 2), ["user: Earlier context.", "assistant: Earlier reply."]);
      assert.strictEqual(context[2], `${CARRY_TYPE}: ${CARRY_HEADER}Assistant:\nFixed batch one.`);
      assert.match(context[3]!, new RegExp(`^${FEEDBACK_MESSAGE}: Spin's completion check after iteration 1 reports: continue\\.`));
      assert.include(context[3]!, "Reason: 3 errors remain.");
      assert.strictEqual(context[4], `user: ${task}`);
      assert.strictEqual(context.length, 5);
      assert.notInclude(context.join("\n"), "Burn down lint errors.");

      yield* w.continueWith(yield* w.runTask("Fixed batch two."));
      const last = w.lastState();
      assert.strictEqual(last.state.status._tag, "completed");
      assert.strictEqual(last.state.iteration, 2);
      assert.strictEqual(last.revision, 3);
      assert.deepStrictEqual(yield* w.record(), []);
      assert.match(w.state.notifications.at(-1)!.text, /done after 2 iterations/);
      // Each iteration is a sibling branch under the definition entry, next to the saved checks.
      const children = w.manager.getEntries().filter((entry) => entry.parentId === definition.id);
      assert.deepStrictEqual(children.map((entry) => entry.type === "custom" ? entry.customType : entry.type), [
        STATE_ENTRY, "custom_message", "custom_message",
      ]);
      assert.strictEqual(yield* Spin.use((spin) => spin.summary).pipe(Effect.map((summary) => summary.phase)), "idle");
    }).pipe(provide(w));
  });

  it.effect("finishes without running the task when the first check is already done", () => {
    const w = world({ steps: [verdict("done")] });
    return Effect.gen(function*() {
      yield* w.launch();
      assert.deepStrictEqual(w.state.submitted, ["Burn down lint errors."]);
      assert.strictEqual(w.lastState().state.status._tag, "completed");
      assert.strictEqual(w.lastState().state.iteration, 0);
    }).pipe(provide(w));
  });

  it.effect("returns to a custom_message anchor exactly, keeping it in the task's context", () => {
    const w = world({ anchor: "carry", steps: [verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch();
      const context = w.messages(w.manager.getBranch());
      assert.include(context, `${CARRY_TYPE}: ${CARRY_HEADER}User:\nCarried text.`);
      assert.strictEqual(context.at(-1), `user: ${task}`);
    }).pipe(provide(w));
  });

  it.effect("carries user messages and the final assistant in users mode", () => {
    const w = world({ steps: [verdict("continue"), verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch("users");
      yield* w.continueWith(yield* w.runTask("Batch one."));
      const carry = w.messages(w.manager.getBranch()).find((line) => line.startsWith(CARRY_TYPE))!;
      assert.strictEqual(carry, `${CARRY_TYPE}: ${CARRY_HEADER}User:\n${task}\n\nAssistant:\nBatch one.`);
    }).pipe(provide(w));
  });

  it.effect("stops at the iteration limit", () => {
    const w = world({ steps: Array.from({ length: 20 }, () => verdict("continue")) });
    return Effect.gen(function*() {
      yield* w.launch();
      for (let i = 0; i < 10; i++) yield* w.continueWith(yield* w.runTask(`Batch ${i}.`));
      assert.strictEqual(w.state.submitted.length, 11, "setup intent plus 10 iterations");
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "limit" });
      assert.strictEqual(w.lastState().state.iteration, 10);
    }).pipe(provide(w));
  });

  it.effect("stops at the time limit", () => {
    const w = world({ steps: [verdict("continue"), verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch();
      yield* TestClock.adjust("2 hours");
      yield* w.continueWith(yield* w.runTask("Slow batch."));
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "limit", detail: "Reached the time limit of 60 minutes." });
    }).pipe(provide(w));
  });

  it.effect("stops when the progress fingerprint stops changing", () => {
    const same = verdict("continue", { progressFingerprint: "a" });
    const w = world({ steps: [verdict("continue", { progressFingerprint: "start" }), same, same, same] });
    return Effect.gen(function*() {
      // The fixture allows 10 iterations; the definition caps unchanged progress at 2.
      const original = proposal();
      const withGuard = { ...original, limits: { ...original.limits, maxUnchangedProgress: 2 } };
      yield* w.inPi(Spin.use((spin) => spin.begin({ invocation: w.invocation, intent: "Lint.", carryMode: "last" })));
      yield* w.inPi(Spin.use((spin) => spin.startApproved(withGuard)));
      yield* w.observe({ _tag: "Settled" });
      yield* w.continueWith(w.takeToken());
      for (let i = 0; i < 3; i++) yield* w.continueWith(yield* w.runTask(`Batch ${i}.`));
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "no-progress" });
      assert.strictEqual(w.lastState().state.iteration, 3);
    }).pipe(provide(w));
  });

  it.effect("stops on blocked and uncertain verdicts with their reason", () => {
    const w = world({ steps: [verdict("continue"), verdict("blocked", { reason: "Needs a token." })] });
    return Effect.gen(function*() {
      yield* w.launch();
      yield* w.continueWith(yield* w.runTask("Tried."));
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "blocked", detail: "Needs a token." });
    }).pipe(provide(w));
  });

  it.effect("stops when the check fails; a failure is never a verdict", () => {
    const failure = Effect.fail(new CheckFailed({ kind: "script", message: "Lint report missing" }));
    const w = world({ steps: [failure] });
    return Effect.gen(function*() {
      yield* w.launch();
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "check-failed", detail: "script: Lint report missing" });
      assert.deepStrictEqual(w.state.submitted, ["Burn down lint errors."]);
    }).pipe(provide(w));
  });

  it.effect("stops without checking when the task run is aborted or fails", () => {
    const w = world({ steps: [verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch();
      yield* w.continueWith(yield* w.runTask("", "aborted"));
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "run-aborted" });
      assert.strictEqual(w.state.inputs.length, 1);
    }).pipe(provide(w));
  });

  it.effect("stops when the user sends input during an iteration", () => {
    const w = world({ steps: [verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch();
      yield* w.observe({ _tag: "Input", source: "interactive" });
      yield* w.continueWith(yield* w.runTask("Done, plus the follow-up."));
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "foreign-input" });
      assert.strictEqual(w.state.inputs.length, 1);
    }).pipe(provide(w));
  });

  it.effect("ignores input Spin sent itself", () => {
    const w = world({ steps: [verdict("continue"), verdict("done")] });
    return Effect.gen(function*() {
      yield* w.launch();
      yield* w.observe({ _tag: "Input", source: "extension" });
      yield* w.continueWith(yield* w.runTask("Batch."));
      assert.strictEqual(w.lastState().state.status._tag, "completed");
    }).pipe(provide(w));
  });

  it.effect("stops without starting another iteration when input arrives during the check", () => {
    const w = world({ steps: [verdict("continue")] });
    return Effect.gen(function*() {
      const spin = yield* Spin;
      w.state.steps.push(Effect.gen(function*() {
        // The user's prompt starts a run while Pi is idle for the check.
        yield* w.inPi(spin.observe({ _tag: "Input", source: "interactive" }));
        w.manager.appendMessage(user("Typed during the check."));
        return { iteration: 1, verdict: verdict("continue"), diagnostics: "", classifierCalls: 0, durationMs: 0 };
      }));
      yield* w.launch();
      yield* w.continueWith(yield* w.runTask("Batch."));
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "foreign-input" });
      assert.strictEqual(w.state.submitted.length, 2, "no further task");
    }).pipe(provide(w));
  });

  it.effect("stopping interrupts a check in flight", () => {
    const w = world();
    let interrupted = false;
    return Effect.gen(function*() {
      w.state.steps.push(Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted = true))));
      const fiber = yield* Effect.forkChild(w.launch());
      for (let i = 0; i < 100 && w.state.inputs.length === 0; i++) yield* Effect.yieldNow;
      assert.strictEqual(w.state.inputs.length, 1, "the check is running");
      yield* w.inPi(Spin.use((spin) => spin.stop("user")));
      yield* Fiber.join(fiber);
      assert.isTrue(interrupted);
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "user" });
      assert.deepStrictEqual(w.state.submitted, ["Burn down lint errors."]);
    }).pipe(provide(w));
  });

  it.effect("ignores unknown and reused continuation tokens", () => {
    const w = world({ steps: [verdict("continue"), verdict("continue"), verdict("continue")] });
    return Effect.gen(function*() {
      const token = yield* w.setUp();
      yield* w.continueWith("forged");
      yield* w.continueWith("");
      assert.strictEqual(w.state.inputs.length, 0);
      yield* w.continueWith(token);
      yield* w.continueWith(token);
      assert.strictEqual(w.state.inputs.length, 1);
      assert.strictEqual(w.state.submitted.length, 2);
    }).pipe(provide(w));
  });

  it.effect("stops when the conversation moved between the run settling and the continuation", () => {
    const w = world({ steps: [verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch();
      const token = yield* w.runTask("Batch.");
      w.manager.branch(w.invocation.leafId);
      yield* w.continueWith(token);
      assert.deepInclude(w.lastState().state.status, { _tag: "stopped", reason: "session-changed" });
      assert.strictEqual(w.state.inputs.length, 1);
    }).pipe(provide(w));
  });

  it.effect("rejects proposals outside setup and invalid ones, and a second /spin while one is active", () => {
    const w = world();
    return Effect.gen(function*() {
      const early = yield* w.inPi(Spin.use((spin) => spin.startApproved(proposal())));
      assert.isFalse(early.accepted);
      yield* w.inPi(Spin.use((spin) => spin.begin({ invocation: w.invocation, intent: "Lint.", carryMode: "all" })));
      const again = yield* w.inPi(Spin.use((spin) => spin.begin({ invocation: w.invocation, intent: "Lint.", carryMode: "all" }))).pipe(Effect.flip);
      assert.strictEqual(again._tag, "SpinRejected");
      const invalid = yield* w.inPi(Spin.use((spin) => spin.startApproved({ ...proposal(), carryMode: "last" })));
      assert.isFalse(invalid.accepted);
      assert.match(invalid.message, /carryMode/);
      assert.strictEqual((yield* Spin.use((spin) => spin.summary)).phase, "setup");
    }).pipe(provide(w));
  });

  it.effect("input before launch returns to setup instead of launching", () => {
    const w = world();
    return Effect.gen(function*() {
      yield* w.inPi(Spin.use((spin) => spin.begin({ invocation: w.invocation, intent: "Lint.", carryMode: "all" })));
      yield* w.inPi(Spin.use((spin) => spin.startApproved(proposal())));
      yield* w.observe({ _tag: "Input", source: "interactive" });
      yield* w.observe({ _tag: "Settled" });
      assert.deepStrictEqual(w.state.scheduled, []);
      assert.strictEqual((yield* Spin.use((spin) => spin.summary)).phase, "setup");
      assert.match(w.state.notifications.at(-1)!.text, /did not start/);
    }).pipe(provide(w));
  });

  it.effect("stopping during setup cancels it and writes nothing", () => {
    const w = world();
    return Effect.gen(function*() {
      yield* w.inPi(Spin.use((spin) => spin.begin({ invocation: w.invocation, intent: "Lint.", carryMode: "all" })));
      yield* w.inPi(Spin.use((spin) => spin.stop("user")));
      assert.strictEqual((yield* Spin.use((spin) => spin.summary)).phase, "idle");
      assert.deepStrictEqual(w.spinEntries(), []);
      assert.deepStrictEqual(w.activeTools(), ["read"]);
      const idle = yield* w.inPi(Spin.use((spin) => spin.stop("user"))).pipe(Effect.flip);
      assert.strictEqual(idle._tag, "SpinRejected");
    }).pipe(provide(w));
  });

  it.effect("shutdown writes nothing; the next session start reports the Spin as interrupted", () => {
    const w = world({ steps: [verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch();
      const entries = w.spinEntries().length;
      yield* w.inPi(Spin.use((spin) => spin.stop("shutdown")));
      assert.strictEqual(w.spinEntries().length, entries);
      assert.strictEqual((yield* w.record()).length, 1);
      // A fresh runtime, as after reload or reopening the session.
      yield* w.observe({ _tag: "SessionStarted" }).pipe(Effect.provide(w.layer));
      assert.match(w.state.notifications.at(-1)!.text, /interrupted \(its last check ran after iteration 0\) and will not resume/);
    }).pipe(provide(w));
  });

  it.effect("the setup message holds the instructions and the chosen carry mode", () => {
    const w = world();
    return Effect.gen(function*() {
      yield* w.inPi(Spin.use((spin) => spin.begin({ invocation: w.invocation, intent: "Lint.", carryMode: "users" })));
      const setup = w.manager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === SETUP_MESSAGE);
      assert.ok(setup?.type === "custom_message");
      assert.include(String(setup.content), "spin_start");
      assert.include(String(setup.content), "User messages + final assistant");
    }).pipe(provide(w));
  });
});

describe("SpinStore", () => {
  it.effect("rejects a stale revision and a malformed entry", () => {
    const w = world({ steps: [verdict("continue")] });
    return Effect.gen(function*() {
      yield* w.launch();
      const [record] = yield* w.record();
      const store = yield* SpinStore;
      const stale = yield* w.inPi(store.updateRunState(record!.spinId, 0, record!.state)).pipe(Effect.flip);
      assert.strictEqual(stale._tag, "RevisionConflict");

      w.manager.appendCustomEntry(STATE_ENTRY, { version: 1, spinId: record!.spinId, revision: 2, state: { status: "bogus" } });
      const malformed = yield* w.inPi(store.load(record!.spinId)).pipe(Effect.flip);
      assert.strictEqual(malformed._tag, "MalformedRecord");
      assert.deepStrictEqual(yield* w.record(), [], "unreadable Spins are skipped");
    }).pipe(provide(w));
  });

  it.effect("refuses to save a check whose source does not match its hash", () => {
    const w = world();
    return Effect.gen(function*() {
      const store = yield* SpinStore;
      const definition = {
        invocation: w.invocation,
        task,
        carryMode: "last" as const,
        check: { source: checkSource, sha256: "0".repeat(64) },
        permissions: { commands: false, classifier: false },
        limits: { maxIterations: 1, maxDurationMs: 60_000 },
      };
      const error = yield* w.inPi(store.create(definition, { status: { _tag: "running" }, iteration: 0, startedAtMs: 0, unchangedProgress: 0 })).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MalformedRecord");
      assert.deepStrictEqual(w.spinEntries(), []);
    }).pipe(provide(w));
  });
});
