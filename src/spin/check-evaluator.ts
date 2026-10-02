import { CodemodeSandbox, type CodemodeResult, parseCodemodeSource } from "@earendil-works/pi-codemode";
import { Clock, Context, Effect, Layer } from "effect";
import { type CheckEnvironment, makeCheckTools } from "./check-tools.ts";
import { CheckFailed } from "./errors.ts";
import { CurrentInvocation } from "./invocation.ts";
import { type CheckInput, decodeVerdict, type EvaluationRecord, HARD_LIMITS, type SpinDefinition } from "./model.ts";

/** Heap cap for the check's QuickJS VM, the same as Pi's codemode. Unset, it is 4 GiB of Pi's process. */
const CHECK_MEMORY_BYTES = 256 * 1024 * 1024;

/**
 * Deadline for one check run, including its tool calls. Fixed rather than configured; a
 * script's `// @options` header is parsed so codemode scripts still load, but its values are
 * ignored. A Reference so tests can shorten it.
 */
export const CheckTimeoutMs = Context.Reference<number>("pi-spin/spin/CheckTimeoutMs", {
  defaultValue: () => 10 * 60 * 1000,
});

export interface EvaluateRequest extends Pick<SpinDefinition, "check" | "permissions"> {
  readonly input: CheckInput;
}

/**
 * Runs an approved check script in a scoped codemode sandbox with the tools its approved
 * permissions allow, validates the returned verdict, and reports diagnostics and classifier usage.
 * The sandbox is closed on success, failure and interruption. It never decides whether Spin
 * repeats.
 */
export class CheckEvaluator extends Context.Service<CheckEvaluator, {
  evaluate(request: EvaluateRequest): Effect.Effect<EvaluationRecord, CheckFailed>;
}>()("pi-spin/spin/CheckEvaluator") {
  /** Reads the working directory and model registry from the calling handler's Pi context. */
  static readonly layer = Layer.succeed(CheckEvaluator, CheckEvaluator.of({
    evaluate: Effect.fn("CheckEvaluator.evaluate")(function*(request) {
      const invocation = yield* CurrentInvocation;
      if (!invocation) {
        return yield* new CheckFailed({ kind: "sandbox", message: "No Pi context to run the check in." });
      }
      return yield* runCheck(request, { cwd: invocation.context.cwd, models: invocation.context.modelRegistry });
    }),
  }));
}

/** Run one check in a fresh sandbox against `env`. */
export const runCheck = Effect.fn("runCheck")(function*(request: EvaluateRequest, env: CheckEnvironment) {
  const startedAt = yield* Clock.currentTimeMillis;
  const parsed = yield* Effect.try({
    try: () => parseCodemodeSource(request.check.source),
    catch: (error) => new CheckFailed({ kind: "script", message: errorMessage(error) }),
  });
  const timeoutMs = yield* CheckTimeoutMs;
  const tools = makeCheckTools(request.permissions, env);
  const sandbox = yield* Effect.acquireRelease(
    Effect.sync(() => new CodemodeSandbox({
      tools: tools.tools,
      globals: tools.globals,
      timeoutMs,
      memoryLimitBytes: CHECK_MEMORY_BYTES,
    })),
    (sandbox) => Effect.promise(() => sandbox.close()),
  );
  // Interruption aborts the signal: the sandbox stops the script and aborts its tool calls.
  const result = yield* Effect.tryPromise({
    try: (signal) => sandbox.execute(withSpinGlobal(parsed.code, request.input), { signal, timeoutMs }),
    catch: (error) => new CheckFailed({ kind: "sandbox", message: errorMessage(error) }),
  });
  const usage = tools.usage();
  const output = renderOutput(result);
  const diagnostics = truncate(output, HARD_LIMITS.diagnostics);
  const fail = (kind: CheckFailed["kind"], message: string) =>
    new CheckFailed({ kind, message, ...(diagnostics ? { diagnostics } : {}), ...usage });

  // A classifier failure fails the check even when the script caught it or ignored
  // stopReason: its verdict would rest on answers it did not get.
  const [classifierFailure] = tools.failures();
  if (classifierFailure !== undefined) return yield* fail("classifier", `Classifier call failed: ${classifierFailure}`);
  if (!result.ok) {
    const { kind, message } = result.error;
    if (kind === "timeout") return yield* fail("timeout", `The check did not finish within ${timeoutMs} ms.`);
    if (kind === "script") return yield* fail("script", message);
    return yield* fail("sandbox", message);
  }

  const verdict = yield* decodeVerdict(result.value).pipe(
    Effect.mapError((error) => fail("verdict", error.message)),
  );
  const finishedAt = yield* Clock.currentTimeMillis;
  return {
    iteration: request.input.iteration,
    verdict,
    diagnostics,
    ...usage,
    durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
  } satisfies EvaluationRecord;
}, Effect.scoped);

/**
 * Expose the check input as a deeply frozen `spin` global. It goes on the script's first
 * line, which is blank when the source had an options header, so line numbers still match.
 */
function withSpinGlobal(code: string, input: CheckInput): string {
  const freeze = "(function f(v){if(v&&typeof v==='object'){Object.values(v).forEach(f);Object.freeze(v)}return v})";
  return `const spin = ${freeze}(${JSON.stringify(input)});${code}`;
}

function renderOutput(result: CodemodeResult): string {
  const lines = result.output.map((item) => (item.type === "text" ? item.text : "[image omitted]"));
  if (!result.ok) lines.push(result.error.stack ?? result.error.message);
  return lines.join("\n");
}

function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const marker = `\n[${text.length - budget} more characters truncated]`;
  return budget > marker.length ? text.slice(0, budget - marker.length) + marker : text.slice(0, budget);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
