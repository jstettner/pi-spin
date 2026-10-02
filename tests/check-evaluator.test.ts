import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { afterAll } from "vitest";
import type { CheckEnvironment, ClassifierRegistry } from "../src/spin/check-tools.ts";
import { CheckEvaluator, CheckTimeoutMs, runCheck } from "../src/spin/check-evaluator.ts";
import { CurrentInvocation } from "../src/spin/invocation.ts";
import { type CheckPermissions, type CheckInput, HARD_LIMITS, snapshotCheck } from "../src/spin/model.ts";

// Real sandboxes, files and commands in a synthetic working directory. No model requests:
// the classifier registry is a fake.

const root = mkdtempSync(join(tmpdir(), "pi-spin-check-"));
const cwd = join(root, "project");
const outside = join(root, "outside");
mkdirSync(join(cwd, "docs", "nested"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(cwd, "docs", "plan.md"), "- [x] A\n- [ ] B\n");
writeFileSync(join(cwd, "docs", "nested", "deep.md"), "deep");
writeFileSync(join(outside, "passwd"), "outside");
symlinkSync(join(outside, "passwd"), join(cwd, "docs", "escape.md"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const node = (script: string) => `node -e ${JSON.stringify(script)}`;
const lint = node("console.log(JSON.stringify({ errors: 2 })); console.error('warn'); process.exit(1)");
const slow = node("setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 1500)");

const classifierCalls: unknown[] = [];
const fakeModels = (stopReason = "stop") => ({
  getModelOfType: (type: string, provider: string, id: string) =>
    type === "classifier" && provider === "fake" && id === "clf"
      ? { type, provider, id, name: "Fake", api: "fake", headers: { authorization: "secret" } }
      : undefined,
  getModelsOfType: () => [],
  getAvailableOfType: async () => [],
  classify: async (model: { id: string }, context: unknown) => {
    classifierCalls.push({ model: model.id, context });
    return {
      provider: "fake", model: model.id, stopReason, answers: { ready: { type: "bool", probability: 0.97 } },
      usage: { cost: { total: 0.25 } },
      ...(stopReason === "stop" ? {} : { errorMessage: "provider down" }),
    };
  },
}) as unknown as ClassifierRegistry;

const env = (models = fakeModels()): CheckEnvironment => ({ cwd, models });
const permissions = (overrides: Partial<CheckPermissions> = {}): CheckPermissions => ({ commands: true, classifier: false, ...overrides });

const evaluate = (source: string, options: {
  permissions?: CheckPermissions;
  input?: CheckInput;
  timeoutMs?: number;
  env?: CheckEnvironment;
} = {}) =>
  runCheck({
    check: snapshotCheck(source),
    permissions: options.permissions ?? permissions(),
    input: options.input ?? { iteration: 1 },
  }, options.env ?? env()).pipe(Effect.provideService(CheckTimeoutMs, options.timeoutMs ?? 20_000));

const fails = (source: string, options: Parameters<typeof evaluate>[1] = {}) => Effect.flip(evaluate(source, options));

describe("verdicts", () => {
  it.live("returns the validated verdict with diagnostics and the iteration", () =>
    Effect.gen(function*() {
      const record = yield* evaluate(`
        console.log("checking");
        const plan = await tools.read({ path: "docs/plan.md" });
        const open = plan.split("\\n").filter((line) => line.startsWith("- [ ]")).length;
        return { verdict: open ? "continue" : "done", reason: open + " open", progressFingerprint: plan };`,
        { input: { iteration: 3 } });
      assert.strictEqual(record.iteration, 3);
      assert.deepStrictEqual(record.verdict, {
        verdict: "continue", reason: "1 open", progressFingerprint: "- [x] A\n- [ ] B\n",
      });
      assert.strictEqual(record.diagnostics, "checking");
      assert.strictEqual(record.classifierCalls, 0);
      assert.isUndefined(record.costUsd);
      assert.isAtLeast(record.durationMs, 0);
    }));

  it.live("exposes the check input as a frozen spin global", () =>
    Effect.gen(function*() {
      const record = yield* evaluate(`
        spin.iteration = 9;
        return { verdict: "continue", reason: spin.iteration + ":" + Object.isFrozen(spin) };`,
        { input: { iteration: 2 } });
      assert.strictEqual(record.verdict.reason, "2:true");
    }));

  it.live("keeps line numbers with and without an options header", () =>
    Effect.gen(function*() {
      const withHeader = yield* fails(`// @options: {"timeout_ms": 5000}\n\nthrow new Error("here");`);
      assert.match(withHeader.diagnostics ?? "", /codemode\.js:3/);
      const without = yield* fails(`\nthrow new Error("here");`);
      assert.match(without.diagnostics ?? "", /codemode\.js:2/);
    }));

  it.live("a malformed envelope fails as a verdict error, never as a verdict", () =>
    Effect.gen(function*() {
      for (const value of [`undefined`, `"done"`, `{ verdict: "finished", reason: "x" }`, `{ verdict: "done", reason: "x", extra: 1 }`,
        `{ verdict: "done", reason: "${"x".repeat(HARD_LIMITS.reason + 1)}" }`]) {
        const error = yield* fails(`return ${value};`);
        assert.strictEqual(error.kind, "verdict", value.slice(0, 40));
      }
    }));

  it.live("exit() without a verdict fails", () =>
    Effect.gen(function*() {
      assert.strictEqual((yield* fails(`exit();`)).kind, "verdict");
    }));

  it.live("script errors and bad option headers fail as script errors with their output", () =>
    Effect.gen(function*() {
      const thrown = yield* fails(`text("before"); throw new Error("no checklist found");`);
      assert.strictEqual(thrown.kind, "script");
      assert.strictEqual(thrown.message, "no checklist found");
      assert.match(thrown.diagnostics ?? "", /^before\n.*no checklist found/s);
      assert.strictEqual((yield* fails(`// @options: {"timeout": 5}\nreturn 1;`)).kind, "script");
      assert.strictEqual((yield* fails(`return {`)).kind, "script");
    }));
});

describe("limits", () => {
  it.live("the fixed deadline stops a runaway script", () =>
    Effect.gen(function*() {
      const started = Date.now();
      const error = yield* fails(`while (true) {}`, { timeoutMs: 1_000 });
      assert.strictEqual(error.kind, "timeout");
      assert.match(error.message, /1000 ms/);
      assert.isBelow(Date.now() - started, 5_000);
    }));

  it.live("header values are parsed but ignored", () =>
    Effect.gen(function*() {
      const longer = yield* fails(`// @options: {"timeout_ms": 600000}\nwhile (true) {}`, { timeoutMs: 1_000 });
      assert.strictEqual(longer.kind, "timeout");
      const record = yield* evaluate(`// @options: {"timeout_ms": 200, "max_output_tokens": 10}
        await tools.bash({ command: ${JSON.stringify(node("setTimeout(() => {}, 600)"))} });
        text("y".repeat(500));
        return { verdict: "done", reason: "ok" };`);
      assert.strictEqual(record.diagnostics.length, 500);
    }));

  it.live("diagnostics are truncated to the hard cap", () =>
    Effect.gen(function*() {
      const large = yield* evaluate(`text("y".repeat(100000)); return { verdict: "done", reason: "ok" };`);
      assert.strictEqual(large.diagnostics.length, HARD_LIMITS.diagnostics);
      assert.match(large.diagnostics, /more characters truncated\]$/);
    }));

  it.live("interruption stops the script and kills its commands", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(evaluate(`await tools.bash({ command: ${JSON.stringify(slow)} }); return { verdict: "done", reason: "x" };`));
      yield* Effect.sleep("400 millis");
      yield* Fiber.interrupt(fiber);
      yield* Effect.sleep("1800 millis");
      assert.isFalse(existsSync(join(cwd, "late.txt")), "the command outlived the check");
    }));

  it.live("the deadline kills a running command", () =>
    Effect.gen(function*() {
      const error = yield* fails(`await tools.bash({ command: ${JSON.stringify(slow)} });`, { timeoutMs: 1_000 });
      assert.strictEqual(error.kind, "timeout");
      yield* Effect.sleep("1000 millis");
      assert.isFalse(existsSync(join(cwd, "late.txt")));
    }));
});

describe("tools.read", () => {
  it.live("reads whole files relative to the working directory or anywhere else", () =>
    Effect.gen(function*() {
      const record = yield* evaluate(`
        const deep = await tools.read({ path: "docs/nested/deep.md" });
        const elsewhere = await tools.read({ path: ${JSON.stringify(join(outside, "passwd"))} });
        const linked = await tools.read({ path: "docs/escape.md" });
        const up = await tools.read({ path: "../outside/passwd" });
        return { verdict: "done", reason: [deep, elsewhere, linked, up].join(":") };`);
      assert.strictEqual(record.verdict.reason, "deep:outside:outside:outside");
    }));

  it.live("does not truncate", () =>
    Effect.gen(function*() {
      writeFileSync(join(cwd, "docs", "big.md"), "z".repeat(300_000));
      const record = yield* evaluate(`return { verdict: "done", reason: String((await tools.read({ path: "docs/big.md" })).length) };`);
      assert.strictEqual(record.verdict.reason, "300000");
    }));

  it.live("missing files and directories are script errors the check can handle", () =>
    Effect.gen(function*() {
      const uncaught = yield* fails(`await tools.read({ path: "docs/missing.md" });`);
      assert.strictEqual(uncaught.kind, "script");
      assert.match(uncaught.message, /does not exist/);
      const caught = yield* evaluate(`
        try { await tools.read({ path: "docs/missing.md" }); } catch { return { verdict: "uncertain", reason: "no plan" }; }`);
      assert.strictEqual(caught.verdict.verdict, "uncertain");
      assert.strictEqual((yield* fails(`await tools.read({ path: "docs" });`)).message, "tools.read: docs is not a file");
      assert.strictEqual((yield* fails(`await tools.read({ path: "~" });`)).message, "tools.read: ~ is not a file");
    }));
});

describe("Pi's read-only tools", () => {
  it.live("ls, grep and find work against the working directory", () =>
    Effect.gen(function*() {
      const record = yield* evaluate(`
        const names = ALL_TOOLS.map((tool) => tool.name).sort().join(",");
        const listing = await tools.ls({ path: "docs" });
        const hits = await tools.grep({ pattern: "- [ ]", path: "docs", literal: true });
        const found = await tools.find({ pattern: "*.md", path: "docs" });
        return { verdict: "done", reason: JSON.stringify({ names, listing, hits, found }) };`);
      const evidence = JSON.parse(record.verdict.reason) as Record<string, string>;
      assert.strictEqual(evidence.names, "bash,find,grep,ls,read");
      assert.match(evidence.listing!, /plan\.md/);
      assert.match(evidence.hits!, /plan\.md.*- \[ \] B/);
      assert.match(evidence.found!, /nested\/deep\.md/);
    }));

  it.live("arguments are checked against Pi's schemas", () =>
    Effect.gen(function*() {
      const error = yield* fails(`await tools.grep({ path: "docs" });`);
      assert.strictEqual(error.kind, "script");
      assert.match(error.message, /tools\.grep: invalid arguments/);
    }));
});

describe("tools.bash", () => {
  it.live("runs any command and returns its exit code and output without throwing", () =>
    Effect.gen(function*() {
      const record = yield* evaluate(`
        const run = await tools.bash({ command: ${JSON.stringify(lint)} });
        const echo = await tools.bash({ command: "echo hi && pwd" });
        return { verdict: "continue", reason: JSON.stringify({ run, echo: echo.stdout }) };`);
      assert.deepStrictEqual(JSON.parse(record.verdict.reason), {
        run: { exit_code: 1, signal: null, stdout: "{\"errors\":2}\n", stderr: "warn\n", truncated: false },
        echo: `hi\n${realpathSync(cwd)}\n`,
      });
    }));

  it.live("is absent unless commands are approved", () =>
    Effect.gen(function*() {
      const noCommands = permissions({ commands: false });
      const listed = yield* evaluate(`return { verdict: "done", reason: String(ALL_TOOLS.some((t) => t.name === "bash")) };`, { permissions: noCommands });
      assert.strictEqual(listed.verdict.reason, "false");
      const error = yield* fails(`await tools.bash({ command: "echo hi" });`, { permissions: noCommands });
      assert.strictEqual(error.kind, "script");
      assert.match(error.message, /tools\.bash does not exist/);
    }));

  it.live("bad arguments are script errors", () =>
    Effect.gen(function*() {
      const error = yield* fails(`await tools.bash({ cmd: "echo" });`);
      assert.strictEqual(error.kind, "script");
      assert.match(error.message, /invalid arguments/);
    }));
});

describe("models", () => {
  const classify = `
    const jev = await models.getModelOfType("classifier", "fake", "clf");
    const result = await models.classify(jev, {
      state: { guide: "text" },
      questions: { ready: { type: "bool", instructions: "Ready?", criteria: { true: "yes", false: "no" } } },
    });`;
  const withClassifier = permissions({ classifier: true });

  it.live("is absent unless the policy approves a classifier", () =>
    Effect.gen(function*() {
      const record = yield* evaluate(`return { verdict: "done", reason: typeof models };`);
      assert.strictEqual(record.verdict.reason, "undefined");
    }));

  it.live("classifies through the registry and records calls and cost", () =>
    Effect.gen(function*() {
      classifierCalls.length = 0;
      const record = yield* evaluate(`${classify}
        return { verdict: "done", reason: JSON.stringify([jev.headers, result.answers.ready.probability]) };`,
        { permissions: withClassifier });
      assert.strictEqual(record.verdict.reason, "[null,0.97]", "headers must not reach the script");
      assert.strictEqual(record.classifierCalls, 1);
      assert.strictEqual(record.costUsd, 0.25);
      assert.strictEqual(classifierCalls.length, 1);
    }));

  it.live("counts every call and sums its cost", () =>
    Effect.gen(function*() {
      const record = yield* evaluate(`${classify}
        await Promise.all([1, 2].map(() => models.classify(jev, { state: {}, questions: { q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } })));
        return { verdict: "done", reason: "x" };`, { permissions: withClassifier });
      assert.strictEqual(record.classifierCalls, 3);
      assert.strictEqual(record.costUsd, 0.75);
    }));

  it.live("a provider failure fails the check even if the script ignores stopReason", () =>
    Effect.gen(function*() {
      const error = yield* fails(`${classify}\nreturn { verdict: "done", reason: "ignored" };`,
        { permissions: withClassifier, env: env(fakeModels("error")) });
      assert.strictEqual(error.kind, "classifier");
      assert.match(error.message, /provider down/);
    }));

  it.live("unknown models are script errors", () =>
    Effect.gen(function*() {
      const unknown = yield* fails(`await models.classify({ provider: "fake", id: "other" }, { state: {}, questions: {} });`, { permissions: withClassifier });
      assert.strictEqual(unknown.kind, "script");
      assert.match(unknown.message, /Unknown classifier model/);
    }));
});

describe("CheckEvaluator.layer", () => {
  const request = {
    check: snapshotCheck(`return { verdict: "done", reason: "ok" };`),
    permissions: permissions(),
    input: { iteration: 1 },
  };

  it.live("runs in the calling handler's working directory", () =>
    Effect.gen(function*() {
      const evaluator = yield* CheckEvaluator;
      const context = { cwd, modelRegistry: fakeModels() } as unknown as ExtensionContext;
      const record = yield* evaluator.evaluate(request).pipe(Effect.provideService(CurrentInvocation, { context }));
      assert.strictEqual(record.verdict.verdict, "done");
    }).pipe(Effect.provide(CheckEvaluator.layer)));

  it.live("fails without a Pi context", () =>
    Effect.gen(function*() {
      const evaluator = yield* CheckEvaluator;
      const error = yield* Effect.flip(evaluator.evaluate(request));
      assert.strictEqual(error.kind, "sandbox");
    }).pipe(Effect.provide(CheckEvaluator.layer)));
});
