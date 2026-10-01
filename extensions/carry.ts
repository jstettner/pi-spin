import {
  getMarkdownTheme,
  keyText,
  TreeSelectorComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  buildCarryTranscript,
  CARRY_HEADER,
  CARRY_MODES,
  CARRY_TYPE,
  collectCarryEntries,
} from "../src/carry-core.ts";

export default function carry(pi: ExtensionAPI) {
  let running = false;

  // Mirror pi's collapsible branch-summary block, labelled as a carry.
  pi.registerMessageRenderer(CARRY_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    const text = content.startsWith(CARRY_HEADER) ? content.slice(CARRY_HEADER.length) : content;
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[carry]\x1b[22m"), 0, 0));
    box.addChild(new Spacer(1));
    if (expanded) {
      box.addChild(new Markdown(`**Carried from another branch**\n\n${text}`, 0, 0, getMarkdownTheme(), {
        color: (t) => theme.fg("customMessageText", t),
      }));
    } else {
      box.addChild(new Text(theme.fg("customMessageText", "Carried from another branch (")
        + theme.fg("dim", keyText("app.tools.expand"))
        + theme.fg("customMessageText", " to expand)"), 0, 0));
    }
    return box;
  });

  pi.registerCommand("carry", {
    description: "Carry the last message or branch conversation to a tree position",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        throw new Error("/carry requires Pi's interactive terminal mode.");
      }
      if (running) {
        ctx.ui.notify("/carry is already open.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current response to finish before using /carry.", "warning");
        return;
      }

      running = true;
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        const oldLeafId = ctx.sessionManager.getLeafId();
        const sourceBranch = ctx.sessionManager.getBranch();
        const lastMessage = buildCarryTranscript(sourceBranch, "last");
        if (!lastMessage) {
          ctx.ui.notify("No user or assistant text to carry yet.", "warning");
          return;
        }
        const ensureUnchanged = () => {
          if (ctx.sessionManager.getSessionId() !== sessionId
            || ctx.sessionManager.getLeafId() !== oldLeafId) {
            throw new Error("The session changed while /carry was open. Please retry.");
          }
        };

        let selectedId: string | undefined;
        while (true) {
          const targetId = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) =>
            new TreeSelectorComponent(
              ctx.sessionManager.getTree(),
              oldLeafId,
              tui.terminal.rows,
              done,
              () => done(undefined),
              undefined,
              selectedId,
            ),
          );
          if (targetId === undefined) return;
          ensureUnchanged();
          if (targetId === oldLeafId) {
            ctx.ui.notify("Choose a different tree position to carry the conversation to.", "warning");
            return;
          }
          selectedId = targetId;

          const choice = await ctx.ui.select("Carry what from this branch?", CARRY_MODES.map((mode) => mode.label));
          ensureUnchanged();
          // Match /tree: escape from the mode menu returns to the same tree selection.
          if (choice === undefined) continue;
          const mode = CARRY_MODES.find((mode) => mode.label === choice);
          if (!mode) return;

          const text = mode.value === "last" ? lastMessage : buildCarryTranscript(
            collectCarryEntries(sourceBranch, ctx.sessionManager.getBranch(targetId)),
            mode.value,
          );
          if (!text) {
            ctx.ui.notify("No user or assistant text in the selected carry range.", "warning");
            return;
          }

          // Navigate without summarizing, so no summarizer (pi's or pi-claude-bridge's) runs,
          // then append the transcript. The selected user's prefilled editor text stays editable.
          const result = await ctx.navigateTree(targetId, { summarize: false });
          if (result.cancelled) return;
          pi.sendMessage(
            {
              customType: CARRY_TYPE,
              content: CARRY_HEADER + text,
              display: true,
              details: { sourceLeafId: oldLeafId, targetId, mode: mode.value },
            },
            { triggerTurn: false },
          );
          ctx.ui.notify(`Carried: ${mode.label}.`, "info");
          return;
        }
      } finally {
        running = false;
      }
    },
  });
}
