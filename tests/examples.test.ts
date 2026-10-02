import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll } from "vitest";
import { CheckTimeoutMs, runCheck } from "../src/spin/check-evaluator.ts";
import type { ClassifierRegistry } from "../src/spin/check-tools.ts";
import { snapshotCheck } from "../src/spin/model.ts";

// The shipped example checks, run through the real evaluator against synthetic projects.

const root = mkdtempSync(join(tmpdir(), "pi-spin-examples-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const example = (name: string) => readFileSync(new URL(`../examples/checks/${name}`, import.meta.url), "utf8");

const check = (source: string, cwd: string) =>
  runCheck(
    { check: snapshotCheck(source), permissions: { commands: false, classifier: false }, input: { iteration: 1 } },
    { cwd, models: {} as ClassifierRegistry },
  ).pipe(Effect.provideService(CheckTimeoutMs, 20_000));

describe("markdown-checklist.js", () => {
  const source = example("markdown-checklist.js");
  const plan = (cwd: string, lines: string[]) => writeFileSync(join(cwd, "PLAN.md"), `# Plan\n\n${lines.join("\n")}\n`);

  it.live("continues while boxes are open, tracking progress through the file, then reports done", () =>
    Effect.gen(function*() {
      const cwd = mkdtempSync(join(root, "plan-"));
      plan(cwd, ["- [x] Set up the project", "- [ ] Add the parser", "- [ ] Write tests"]);
      const first = yield* check(source, cwd);
      assert.strictEqual(first.verdict.verdict, "continue");
      assert.strictEqual(first.verdict.reason, "2 of 3 items in PLAN.md are open; next: Add the parser");

      // An iteration that ticks nothing leaves the fingerprint unchanged.
      const unchanged = yield* check(source, cwd);
      assert.strictEqual(unchanged.verdict.progressFingerprint, first.verdict.progressFingerprint);

      // The task agent ticks the next box in the file.
      plan(cwd, ["- [x] Set up the project", "- [x] Add the parser", "- [ ] Write tests"]);
      const second = yield* check(source, cwd);
      assert.strictEqual(second.verdict.reason, "1 of 3 items in PLAN.md are open; next: Write tests");
      assert.notStrictEqual(second.verdict.progressFingerprint, first.verdict.progressFingerprint);

      plan(cwd, ["- [x] Set up the project", "- [X] Add the parser", "* [x] Write tests"]);
      const done = yield* check(source, cwd);
      assert.deepStrictEqual(done.verdict, { verdict: "done", reason: "All 3 items in PLAN.md are checked." });
    }));

  it.live("fails rather than reporting done when the plan is missing or has no checklist", () =>
    Effect.gen(function*() {
      const cwd = mkdtempSync(join(root, "plan-"));
      const missing = yield* Effect.flip(check(source, cwd));
      assert.strictEqual(missing.kind, "script");
      plan(cwd, ["Nothing to tick here."]);
      const empty = yield* Effect.flip(check(source, cwd));
      assert.strictEqual(empty.kind, "script");
      assert.match(empty.message, /no checklist items/);
    }));
});
