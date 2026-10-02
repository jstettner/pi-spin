import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context } from "effect";

/**
 * The Pi context of the handler currently calling into Spin. The extension provides it per
 * call, so it lives only as long as that handler. Live PiHost, SpinStore and CheckEvaluator
 * read it inside their methods; it never appears in a service interface, and nothing keeps it.
 *
 * `command` is set only for command handlers (`/spin`, the continuation command), the only
 * place `navigateTree` is safe.
 */
export interface Invocation {
  readonly context: ExtensionContext;
  readonly command?: ExtensionCommandContext;
}

export const CurrentInvocation = Context.Reference<Invocation | undefined>("pi-spin/spin/CurrentInvocation", {
  defaultValue: () => undefined,
});
