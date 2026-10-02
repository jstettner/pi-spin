import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Compile } from "typebox/compile";
import { Type } from "typebox";
import {
  approveProposal,
  CheckSnapshot,
  decodeEntry,
  decodeVerdict,
  DEFINITION_ENTRY,
  HARD_LIMITS,
  snapshotCheck,
  SpinProposal,
  STATE_ENTRY,
  type SpinDefinition,
  type SpinRunState,
} from "../src/spin/model.ts";
import { checkSource, proposal } from "./spin-fixtures.ts";

const decodeProposal = Schema.decodeUnknownResult(SpinProposal, { onExcessProperty: "error", errors: "all" });
const fixed = { invocation: { sessionId: "session-1", leafId: "anchor" }, carryMode: "last" } as const;

const rejects = (value: unknown, pattern: RegExp) => {
  const result = decodeProposal(value);
  assert.strictEqual(result._tag, "Failure");
  if (result._tag === "Failure") assert.match(result.failure.message, pattern);
};
const withPermissions = (permissions: object) => ({ ...proposal(), permissions: { ...proposal().permissions, ...permissions } });
const withLimits = (limits: object) => ({ ...proposal(), limits: { ...proposal().limits, ...limits } });

describe("proposal", () => {
  it("accepts a valid proposal unchanged", () => {
    const result = decodeProposal(proposal());
    assert.strictEqual(result._tag, "Success");
    if (result._tag === "Success") assert.deepStrictEqual(result.success, proposal());
  });

  it("rejects limits above the hard caps instead of clamping them", () => {
    rejects(withLimits({ maxIterations: HARD_LIMITS.maxIterations + 1 }), /maxIterations/);
    rejects(withLimits({ checkTimeoutMs: 60_000 }), /checkTimeoutMs/);
    rejects(withLimits({ maxDurationMs: HARD_LIMITS.maxDurationMs + 1 }), /maxDurationMs/);
    rejects(withLimits({ maxIterations: 1.5 }), /maxIterations/);
  });

  it("takes commands and the classifier as switches", () => {
    rejects(withPermissions({ commands: ["npm test"] }), /commands/);
    rejects({ ...proposal(), permissions: {} }, /commands/);
    rejects(withPermissions({ readPaths: ["src"] }), /readPaths/);
    rejects(withPermissions({ classifier: { maxCallsPerCheck: 3 } }), /classifier/);
    rejects({ ...proposal(), permissions: { commands: true } }, /classifier/);
    assert.strictEqual(decodeProposal(withPermissions({ commands: false, classifier: true }))._tag, "Success");
  });

  it("rejects fields the agent may not set and missing ones", () => {
    rejects({ ...proposal(), carryMode: "all" }, /carryMode/);
    rejects({ ...proposal(), invocation: fixed.invocation }, /invocation/);
    const { checkSource: _omitted, ...missing } = proposal();
    rejects(missing, /checkSource/);
    rejects({ ...proposal(), task: "" }, /task/);
    rejects({ ...proposal(), checkSource: "x".repeat(HARD_LIMITS.checkSource + 1) }, /checkSource/);
  });

  it.effect("approval fixes the anchor and carry mode and snapshots the check", () =>
    Effect.gen(function*() {
      const definition = yield* approveProposal(proposal(), fixed);
      const { checkSource: _source, ...rest } = proposal();
      assert.deepStrictEqual(definition, { ...rest, ...fixed, check: snapshotCheck(checkSource) });
      assert.match(definition.check.sha256, /^[0-9a-f]{64}$/);
      const error = yield* Effect.flip(approveProposal({ ...proposal(), carryMode: "all" }, fixed));
      assert.strictEqual(error._tag, "InvalidProposal");
    }));

  it("Pi's tool validator enforces the derived JSON Schema", () => {
    const document = Schema.toJsonSchemaDocument(SpinProposal, { onExcessProperty: "error" });
    // Only the root schema reaches Pi, so nothing may live in definitions.
    assert.deepStrictEqual(document.definitions, {});
    const schema = document.schema;
    const validator = Compile(Type.Unsafe(schema));
    assert.isTrue(validator.Check(proposal()));
    assert.isTrue(validator.Check(withPermissions({ classifier: true })));
    assert.isFalse(validator.Check(withLimits({ maxIterations: HARD_LIMITS.maxIterations + 1 })));
    assert.isFalse(validator.Check({ ...proposal(), carryMode: "all" }));
    assert.isFalse(validator.Check({ ...proposal(), task: "" }));
  });
});

describe("verdict", () => {
  const verdictError = (value: unknown) =>
    Effect.flip(decodeVerdict(value)).pipe(Effect.map((error) => {
      assert.strictEqual(error._tag, "CheckFailed");
      assert.strictEqual(error.kind, "verdict");
      return error.message;
    }));

  it.effect("accepts the minimal and the full envelope", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* decodeVerdict({ verdict: "done", reason: "All clear." }), { verdict: "done", reason: "All clear." });
      const full = {
        verdict: "continue",
        reason: "3 lint errors remain.",
        progressFingerprint: "a.ts:1|b.ts:4",
      } as const;
      assert.deepStrictEqual(yield* decodeVerdict(full), full);
      // Nothing remaining joins to "".
      const empty = { verdict: "done", reason: "Nothing remains.", progressFingerprint: "" } as const;
      assert.deepStrictEqual(yield* decodeVerdict(empty), empty);
    }));

  it.effect("rejects malformed envelopes", () =>
    Effect.gen(function*() {
      assert.match(yield* verdictError(undefined), /object/);
      assert.match(yield* verdictError({ verdict: "maybe", reason: "?" }), /verdict/);
      assert.match(yield* verdictError({ verdict: "done" }), /reason/);
      assert.match(yield* verdictError({ verdict: "done", reason: "" }), /reason/);
      assert.match(yield* verdictError({ verdict: "done", reason: "x".repeat(HARD_LIMITS.reason + 1) }), /reason/);
      assert.match(yield* verdictError({ verdict: "done", reason: "ok", summary: "typo for reason" }), /summary/);
      assert.match(yield* verdictError({ verdict: "done", reason: "ok", evidence: { errors: 3 } }), /evidence/);
      assert.match(yield* verdictError({ verdict: "done", reason: "ok", progressFingerprint: "x".repeat(HARD_LIMITS.fingerprint + 1) }), /progressFingerprint/);
      assert.match(yield* verdictError({ verdict: "done", reason: "ok", progress: { fingerprint: "a" } }), /progress/);
    }));
});

describe("session entries", () => {
  const definition = (): SpinDefinition => ({
    ...fixed,
    task: proposal().task,
    check: snapshotCheck(checkSource),
    permissions: proposal().permissions,
    limits: proposal().limits,
  });
  const state: SpinRunState = {
    status: { _tag: "stopped", reason: "limit", detail: "10 iterations" },
    iteration: 10,
    startedAtMs: 1_000,
    unchangedProgress: 0,
    lastEvaluation: {
      iteration: 10,
      verdict: { verdict: "continue", reason: "2 errors remain." },
      diagnostics: "",
      classifierCalls: 0,
      durationMs: 1_200,
    },
  };
  const entry = (customType: string, data: unknown) => ({ id: "entry-1", customType, data });

  it.effect("round-trips definition and state entries", () =>
    Effect.gen(function*() {
      const definitionData = { version: 1, spinId: "spin-1", revision: 0, definition: definition(), state: { ...state, status: { _tag: "running" } } } as const;
      assert.deepStrictEqual(yield* decodeEntry(entry(DEFINITION_ENTRY, definitionData)), definitionData);
      const stateData = { version: 1, spinId: "spin-1", revision: 4, state } as const;
      assert.deepStrictEqual(yield* decodeEntry(entry(STATE_ENTRY, stateData)), stateData);
    }));

  it.effect("reports malformed entries with their id", () =>
    Effect.gen(function*() {
      const bad = [
        entry(STATE_ENTRY, { version: 1, spinId: "spin-1", revision: 0, state }),
        entry(STATE_ENTRY, { version: 2, spinId: "spin-1", revision: 1, state }),
        entry(STATE_ENTRY, { version: 1, spinId: "spin-1", revision: 1, state: { ...state, status: { _tag: "stopped", reason: "bored" } } }),
        entry(DEFINITION_ENTRY, { version: 1, spinId: "spin-1", revision: 0, definition: { ...definition(), carryMode: "some" }, state }),
        entry(DEFINITION_ENTRY, undefined),
      ];
      for (const value of bad) {
        const error = yield* Effect.flip(decodeEntry(value));
        assert.strictEqual(error._tag, "MalformedRecord");
        assert.strictEqual(error.entryId, "entry-1");
      }
    }));

  it("detects a check source that no longer matches its hash", () => {
    const decode = Schema.decodeUnknownResult(CheckSnapshot);
    assert.strictEqual(decode(snapshotCheck(checkSource))._tag, "Success");
    const tampered = decode({ ...snapshotCheck(checkSource), source: `${checkSource}\n// edited` });
    assert.strictEqual(tampered._tag, "Failure");
    if (tampered._tag === "Failure") assert.match(tampered.failure.message, /does not match the check source/);
  });
});
