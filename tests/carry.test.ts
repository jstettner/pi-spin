import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  initTheme,
  SessionManager,
  type ExtensionCommandContext,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { buildCarryTranscript, CARRY_HEADER, CARRY_MODES, collectCarryEntries, type CarryMode } from "../src/carry-core.ts";

// Load through Pi's public extension loader (including its package aliases), as /reload does.
// An empty agent directory keeps personal extensions out of the test.
initTheme("dark", false);
const extensionPath = fileURLToPath(new URL("../extensions/carry.ts", import.meta.url));
const extensionDir = dirname(extensionPath);
const agentDir = mkdtempSync(join(tmpdir(), "pi-spin-carry-"));
const HEADER = CARRY_HEADER;
const omitted = "Assistant:\n[Response omitted]";
// Pi exports no theme instance. Carry's renderer only colours text, and the tree component
// uses the global theme from initTheme().
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as unknown as Theme;
type Message = Parameters<SessionManager["appendMessage"]>[0];
// Fixtures also include non-message entries that carry must ignore.
const entry = (value: object) => value as SessionEntry;
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(content: string | object[]): Message {
  return { role: "user", content, timestamp: 0 } as Message;
}

function assistant(content: string | object[], stopReason = "stop"): Message {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    stopReason, api: "openai-responses", provider: "synthetic", model: "synthetic",
    usage, timestamp: 0,
  } as Message;
}

function message(id: string, value: Message, parentId: string | null = null): SessionEntry {
  return { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message: value };
}

const targetEntry = message("target", user("Help me design the carry menu."));
const earlierEntry = message("earlier", assistant("We could offer three modes."), "target");
const followupEntry = message("followup", user("Make mode 3 keep the final response."), "earlier");
const headEntry = message("head", assistant("Earlier responses omitted; final one preserved."), "followup");
const example = [targetEntry, earlierEntry, followupEntry, headEntry];
const fullExample = [
  "User:\nHelp me design the carry menu.",
  "Assistant:\nWe could offer three modes.",
  "User:\nMake mode 3 keep the final response.",
  "Assistant:\nEarlier responses omitted; final one preserved.",
].join("\n\n");
const usersExample = [
  "User:\nHelp me design the carry menu.",
  omitted,
  "User:\nMake mode 3 keep the final response.",
  "Assistant:\nEarlier responses omitted; final one preserved.",
].join("\n\n");

test("ancestor range includes the selected user and branch head", () => {
  const prefix = message("prefix", user("Already-retained context."));
  assert.deepEqual(collectCarryEntries([prefix, ...example], [prefix, targetEntry]), example);
});

test("selected assistant boundary is also inclusive", () => {
  assert.deepEqual(collectCarryEntries(example, example.slice(0, 2)), example.slice(1));
});

test("sideways navigation carries only the abandoned source side", () => {
  const destination = message("destination", user("Other branch."), "target");
  assert.deepEqual(collectCarryEntries(example, [targetEntry, destination]), example.slice(1));
});

test("unrelated roots carry the entire source branch", () => {
  assert.deepEqual(collectCarryEntries(example, [message("other", user("Other root."))]), example);
});

test("missing target path fails instead of carrying an accidental range", () => {
  assert.throws(() => collectCarryEntries(example, []), /no longer exists/);
});

test("last mode carries only the last conversational message", () => {
  assert.equal(buildCarryTranscript(example, "last"), "Assistant:\nEarlier responses omitted; final one preserved.");
});

test("last mode can carry a user message", () => {
  assert.equal(buildCarryTranscript(example.slice(0, -1), "last"), "User:\nMake mode 3 keep the final response.");
});

test("all mode preserves every message in chronological order", () => {
  assert.equal(buildCarryTranscript(example, "all"), fullExample);
});

test("users mode omits earlier assistants but preserves the final assistant verbatim", () => {
  assert.equal(buildCarryTranscript(example, "users"), usersExample);
});

test("users mode preserves the final assistant even when later user messages exist", () => {
  const trailingUser = message("trailing-user", user("One more question."), "head");
  assert.equal(buildCarryTranscript([...example, trailingUser], "users"),
    usersExample + "\n\nUser:\nOne more question.");
});

test("users mode without an assistant still carries all user messages", () => {
  assert.equal(buildCarryTranscript([targetEntry, followupEntry], "users"),
    "User:\nHelp me design the carry menu.\n\nUser:\nMake mode 3 keep the final response.");
});

test("a single assistant is retained in users mode", () => {
  assert.equal(buildCarryTranscript([headEntry], "users"),
    "Assistant:\nEarlier responses omitted; final one preserved.");
});

test("only assistant text is carried, not thinking, calls, results, or internal entries", () => {
  const entries = [
    targetEntry,
    message("mixed", assistant([
      { type: "thinking", thinking: "PRIVATE_THINKING" },
      { type: "text", text: "Visible " },
      { type: "toolCall", id: "tool", name: "bash", arguments: { secret: "PRIVATE_CALL" } },
      { type: "text", text: "response." },
    ])),
    message("result", { role: "toolResult", toolCallId: "tool", toolName: "bash",
      content: [{ type: "text", text: "PRIVATE_RESULT" }], isError: false, timestamp: 0 } as Message),
    message("system", { role: "system", content: "PRIVATE_SYSTEM", timestamp: 0 } as Message),
    entry({ type: "custom_message", id: "custom", content: "PRIVATE_CUSTOM" }),
    entry({ type: "compaction", id: "compaction", summary: "PRIVATE_SUMMARY" }),
  ];
  assert.equal(buildCarryTranscript(entries, "all"),
    "User:\nHelp me design the carry menu.\n\nAssistant:\nVisible response.");
});

test("tool-only and empty aborted messages do not displace the final assistant response", () => {
  const entries = [
    ...example,
    message("tool-only", assistant([{ type: "toolCall", id: "tool", name: "bash", arguments: {} }], "toolUse")),
    message("aborted", assistant([], "aborted")),
  ];
  assert.equal(buildCarryTranscript(entries, "users"), usersExample);
  assert.equal(buildCarryTranscript(entries, "last"), "Assistant:\nEarlier responses omitted; final one preserved.");
});

test("user whitespace and text blocks are preserved without trimming", () => {
  assert.equal(buildCarryTranscript([
    message("plain", user("  exact text\n\n")),
    message("blocks", user([{ type: "text", text: "first" }, { type: "text", text: "second" }])),
  ], "all"), "User:\n  exact text\n\n\n\nUser:\nfirstsecond");
});

test("images are marked as omitted without exposing attachment data", () => {
  const value = buildCarryTranscript([message("image", user([
    { type: "text", text: "Look at this:" },
    { type: "image", data: "PRIVATE_BASE64", mimeType: "image/png" },
  ]))], "all");
  assert.equal(value, "User:\nLook at this:\n[Image omitted]\n");
});

test("empty or tool-only ranges have no transcript", () => {
  assert.equal(buildCarryTranscript([], "all"), undefined);
  assert.equal(buildCarryTranscript([message("empty", assistant([], "aborted"))], "users"), undefined);
});

function conversation() {
  const manager = SessionManager.inMemory(extensionDir);
  manager.appendMessage(user("Already-retained context."));
  const prefixId = manager.appendMessage(assistant("Retained reply."));
  const ids = example.map((entry) => manager.appendMessage((entry as Extract<SessionEntry, { type: "message" }>).message as Message));
  return { manager, prefixId, targetId: ids[0], sourceLeafId: ids.at(-1), ids };
}

interface Fixture {
  manager: SessionManager;
  targetId?: string | undefined;
  sourceLeafId?: string | undefined;
  ids?: string[];
}

interface HarnessOptions {
  fixture?: Fixture;
  targets?: Array<string | undefined>;
  choices?: Array<CarryMode | undefined>;
  mode?: string;
  idle?: boolean;
  changeSession?: boolean;
  navigationError?: boolean;
  cancelNavigation?: boolean;
  onTree?: (state: Harness) => void;
  onMode?: (state: Harness) => void;
}

interface Sent {
  value: { customType: string; content: unknown; display: boolean; details?: unknown };
  sendOptions: unknown;
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(options: HarnessOptions = {}) {
  const fixture: Fixture = options.fixture ?? conversation();
  const { manager } = fixture;
  const loaded = await discoverAndLoadExtensions([extensionPath], extensionDir, agentDir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!;
  const state = {
    ...fixture,
    extension,
    notifications: [] as Array<{ text: string; level: unknown }>,
    sent: [] as Sent[],
    navigations: [] as Array<{ targetId: string; navigateOptions: unknown }>,
    selections: [] as Array<{ title: string; labels: string[] }>,
    initialTreeSelections: [] as Array<string | undefined>,
    editor: "" as unknown,
    ctx: undefined as unknown as ExtensionCommandContext,
    run: undefined as unknown as () => Promise<void>,
  };
  const targets = [...(options.targets ?? [fixture.targetId])];
  const choices = [...(options.choices ?? ["all"])];
  let currentSessionId = manager.getSessionId();
  loaded.runtime.sendMessage = (value, sendOptions) => {
    state.sent.push({ value, sendOptions });
    manager.appendCustomMessageEntry(value.customType, value.content, value.display, value.details);
  };
  const ctx = {
    mode: options.mode ?? "tui",
    isIdle: () => options.idle !== false,
    sessionManager: {
      getSessionId: () => currentSessionId,
      getLeafId: () => manager.getLeafId(),
      getBranch: (id?: string) => manager.getBranch(id),
      getTree: () => manager.getTree(),
    },
    ui: {
      notify: (text: string, level: unknown) => state.notifications.push({ text, level }),
      custom: async (factory: (...args: unknown[]) => unknown) => {
        let selection: string | undefined;
        // Pi's real TreeSelectorComponent, rendered and driven through its public list API.
        const component = await factory({ terminal: { rows: 40 } }, theme, {}, (id: string) => { selection = id; }) as {
          getTreeList(): {
            getSelectedNode(): { entry: { id: string } } | undefined;
            onSelect(id: string): void;
            onCancel(): void;
          };
          render(width: number): string[];
        };
        const list = component.getTreeList();
        state.initialTreeSelections.push(list.getSelectedNode()?.entry.id);
        assert.ok(component.render(100).length > 0);
        const target = targets.shift();
        if (target === undefined) list.onCancel();
        else list.onSelect(target);
        options.onTree?.(state);
        return selection;
      },
      select: async (title: string, labels: string[]) => {
        state.selections.push({ title, labels });
        options.onMode?.(state);
        if (options.changeSession) currentSessionId = "different-session";
        const choice = choices.shift();
        return CARRY_MODES.find((mode) => mode.value === choice)?.label;
      },
    },
    navigateTree: async (targetId: string, navigateOptions: unknown) => {
      state.navigations.push({ targetId, navigateOptions });
      if (options.navigationError) throw new Error("Synthetic navigation failure.");
      if (options.cancelNavigation) return { cancelled: true };
      const target = manager.getEntry(targetId)!;
      const isUser = target.type === "message" && target.message.role === "user";
      const leafId = isUser ? target.parentId : targetId;
      if (target.type === "message" && target.message.role === "user") state.editor = target.message.content;
      if (leafId === null) manager.resetLeaf();
      else manager.branch(leafId);
      return { cancelled: false };
    },
  };
  state.ctx = ctx as unknown as ExtensionCommandContext;
  state.run = () => extension.commands.get("carry")!.handler("", state.ctx);
  return state;
}

for (const mode of CARRY_MODES) {
  test(`command offers all three modes and carries ${mode.value} without a model turn`, async () => {
    const h = await harness({ choices: [mode.value] });
    await h.run();
    assert.deepEqual(h.selections[0]!.labels, CARRY_MODES.map((entry) => entry.label));
    assert.deepEqual(h.navigations, [{ targetId: h.targetId, navigateOptions: { summarize: false } }]);
    assert.equal(h.sent.length, 1);
    const { value, sendOptions } = h.sent[0]!;
    const expected = mode.value === "last"
      ? "Assistant:\nEarlier responses omitted; final one preserved."
      : mode.value === "all" ? fullExample : usersExample;
    assert.equal(value.content, HEADER + expected);
    assert.deepEqual(value.details, { sourceLeafId: h.sourceLeafId, targetId: h.targetId, mode: mode.value });
    assert.equal(value.display, true);
    assert.deepEqual(sendOptions, { triggerTurn: false });
  });
}

test("clearing the prefilled target input does not remove it from carried context", async () => {
  const h = await harness({ choices: ["users"] });
  await h.run();
  assert.equal(h.editor, "Help me design the carry menu.");
  h.editor = "";
  const messages = h.manager.buildSessionContext().messages;
  const custom = messages.find((entry) => entry.role === "custom");
  assert.equal(custom && "content" in custom ? custom.content : undefined, HEADER + usersExample);
  assert.equal(messages.some((entry) => entry.role === "user" && entry.content === "Help me design the carry menu."), false);
});

test("full carry reads messages before compaction from the raw branch", async () => {
  const fixture = conversation();
  fixture.manager.appendCompaction("Synthetic compacted summary.", fixture.ids[2]!, 1000);
  const h = await harness({ fixture, choices: ["all"] });
  await h.run();
  assert.equal(h.sent[0]!.value.content, HEADER + fullExample);
});

test("escape from mode menu returns to the tree at the selected target", async () => {
  const fixture = conversation();
  const h = await harness({ fixture, targets: [fixture.targetId, fixture.targetId], choices: [undefined, "users"] });
  await h.run();
  assert.deepEqual(h.initialTreeSelections, [fixture.sourceLeafId, fixture.targetId]);
  assert.equal(h.sent.length, 1);
});

test("cancelling the tree is non-mutating and releases the running guard", async () => {
  const h = await harness({ targets: [undefined, undefined] });
  const before = h.manager.getLeafId();
  await h.run();
  await h.run();
  assert.equal(h.manager.getLeafId(), before);
  assert.equal(h.initialTreeSelections.length, 2);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.sent.length, 0);
});

test("cancelled navigation does not append carry context", async () => {
  const h = await harness({ cancelNavigation: true });
  await h.run();
  assert.equal(h.sent.length, 0);
  assert.equal(h.manager.getLeafId(), h.sourceLeafId);
});

test("navigation failure releases the running guard", async () => {
  const fixture = conversation();
  const h = await harness({ fixture, navigationError: true, targets: [fixture.targetId, undefined] });
  await assert.rejects(h.run(), /Synthetic navigation failure/);
  await h.run();
  assert.equal(h.initialTreeSelections.length, 2);
  assert.equal(h.sent.length, 0);
});

test("a session change in the mode dialog blocks stale navigation", async () => {
  const h = await harness({ changeSession: true });
  await assert.rejects(h.run(), /session changed/);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.sent.length, 0);
});

test("a leaf change in the mode dialog blocks stale navigation", async () => {
  const h = await harness({ onMode: (state) => { state.manager.appendMessage(user("Concurrent change.")); } });
  await assert.rejects(h.run(), /session changed/);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.sent.length, 0);
});

test("a leaf change in the tree dialog blocks the mode menu", async () => {
  const h = await harness({ onTree: (state) => { state.manager.appendMessage(user("Concurrent change.")); } });
  await assert.rejects(h.run(), /session changed/);
  assert.equal(h.selections.length, 0);
  assert.equal(h.navigations.length, 0);
});

test("selecting the current leaf is a non-mutating no-op", async () => {
  const fixture = conversation();
  const h = await harness({ fixture, targets: [fixture.sourceLeafId] });
  await h.run();
  assert.equal(h.selections.length, 0);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.sent.length, 0);
});

test("noninteractive and busy sessions are guarded", async () => {
  const noninteractive = await harness({ mode: "print" });
  await assert.rejects(noninteractive.run(), /interactive terminal mode/);
  const busy = await harness({ idle: false });
  await busy.run();
  assert.equal(busy.initialTreeSelections.length, 0);
  assert.match(busy.notifications[0]!.text, /current response/);
});

test("empty sessions warn without opening the tree", async () => {
  const fixture = { manager: SessionManager.inMemory(extensionDir) };
  const h = await harness({ fixture });
  await h.run();
  assert.equal(h.initialTreeSelections.length, 0);
  assert.match(h.notifications[0]!.text, /No user or assistant text/);
});

test("renderer hides the carry header", async () => {
  const h = await harness();
  const renderer = h.extension.messageRenderers.get("carry")!;
  const rendered = renderer(
    { content: HEADER + "Visible carried response." } as Parameters<typeof renderer>[0],
    { expanded: true, outputPad: 1 } as Parameters<typeof renderer>[1],
    theme,
  )!.render(100).join("\n");
  assert.match(rendered, /Visible carried response/);
  assert.doesNotMatch(rendered, /historical messages/);
});
