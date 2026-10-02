import { Context, type Effect } from "effect";
import type { CheckFailed } from "./errors.ts";
import type { CheckInput, EvaluationRecord, SpinDefinition, SpinLimits } from "./model.ts";

/**
 * Runs an approved check script in a scoped codemode sandbox with only the approved
 * capabilities, validates the returned verdict, and reports diagnostics and classifier usage.
 * The sandbox is closed on success, failure and interruption. It never decides whether Spin
 * repeats.
 */
export class CheckEvaluator extends Context.Service<CheckEvaluator, {
  evaluate(
    request: Pick<SpinDefinition, "check" | "capabilities"> & {
      readonly input: CheckInput;
      /** Hard caps; the script's `// @options` header may only lower them. */
      readonly limits: Pick<SpinLimits, "checkTimeoutMs">;
    },
  ): Effect.Effect<EvaluationRecord, CheckFailed>;
}>()("pi-spin/spin/CheckEvaluator") {}
