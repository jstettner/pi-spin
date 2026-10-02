import { getMarkdownTheme, keyText, type ExtensionAPI, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Layer } from "effect";
import { CheckEvaluator } from "../src/spin/check-evaluator.ts";
import { registerSpin } from "../src/spin/extension.ts";
import { FEEDBACK_MESSAGE, SETUP_MESSAGE } from "../src/spin/model.ts";
import { PiHost } from "../src/spin/pi-host.ts";
import { Spin } from "../src/spin/spin.ts";
import { SpinStore } from "../src/spin/spin-store.ts";

export default function spin(pi: ExtensionAPI) {
  // Collapsed like carry: the setup instructions are long, and feedback repeats every iteration.
  pi.registerMessageRenderer(SETUP_MESSAGE, collapsible("Spin setup instructions for the agent", () => undefined));
  pi.registerMessageRenderer(FEEDBACK_MESSAGE, collapsible("Spin check result", (text) => text.split("\n", 1)[0]));

  registerSpin(pi, {
    layer: (pi) => Spin.layer.pipe(
      Layer.provide(Layer.mergeAll(SpinStore.layer(pi), PiHost.layer(pi), CheckEvaluator.layer)),
    ),
  });
}

function collapsible(title: string, preview: (text: string) => string | undefined): MessageRenderer {
  return (message, { expanded, outputPad }, theme) => {
    const text = typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[spin]\x1b[22m"), 0, 0));
    box.addChild(new Spacer(1));
    if (expanded) {
      box.addChild(new Markdown(`**${title}**\n\n${text}`, 0, 0, getMarkdownTheme(), {
        color: (t) => theme.fg("customMessageText", t),
      }));
    } else {
      box.addChild(new Text(theme.fg("customMessageText", `${preview(text) ?? title} (`)
        + theme.fg("dim", keyText("app.tools.expand"))
        + theme.fg("customMessageText", " to expand)"), 0, 0));
    }
    return box;
  };
}
