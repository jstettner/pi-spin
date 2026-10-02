import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// Shared by /carry and /spin, and stored in sessions: changing either breaks old carry entries.
export const CARRY_TYPE = "carry";
// What the model sees before the carried text; the renderer hides it.
export const CARRY_HEADER = "Carried from another branch of this conversation (historical messages):\n\n";

export const CARRY_MODES = [
  { value: "last", label: "Last message only" },
  { value: "all", label: "All user + assistant messages" },
  { value: "users", label: "User messages + final assistant (earlier responses omitted)" },
] as const;

export type CarryMode = typeof CARRY_MODES[number]["value"];
export type CarryModeOption = typeof CARRY_MODES[number];

// The carry mode picker shared by /carry and /spin. Takes Pi's ui.select so this module stays
// free of UI imports. Undefined means the user dismissed the menu.
export async function selectCarryMode(
  select: (title: string, options: string[]) => Promise<string | undefined>,
  title: string,
): Promise<CarryModeOption | undefined> {
  const choice = await select(title, CARRY_MODES.map((mode) => mode.label));
  return CARRY_MODES.find((mode) => mode.label === choice);
}

// On the current branch, include the target: selecting a user message rewinds
// BEFORE it and puts its text in the editor, where the user may clear it.
// For a target on another branch, carry the source side after the shared ancestor,
// just like /tree's branch summary; destination-only messages aren't source context.
export function collectCarryEntries(
  sourceBranch: readonly SessionEntry[],
  targetBranch: readonly SessionEntry[],
): SessionEntry[] {
  const target = targetBranch.at(-1);
  if (!target) throw new Error("The selected tree position no longer exists.");

  const targetIndex = sourceBranch.findIndex((entry) => entry.id === target.id);
  if (targetIndex !== -1) return sourceBranch.slice(targetIndex);

  const targetIds = new Set(targetBranch.map((entry) => entry.id));
  const ancestorIndex = sourceBranch.findLastIndex((entry) => targetIds.has(entry.id));
  return sourceBranch.slice(ancestorIndex + 1);
}

// Read raw branch entries, not compaction-aware context: carry must retain the
// actual user/assistant text even when earlier messages have been compacted.
export function buildCarryTranscript(
  entries: readonly SessionEntry[],
  mode: CarryMode,
): string | undefined {
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const { role, content } = message;

    const text = typeof content === "string" ? content : content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "\n[Image omitted]\n";
      return "";
    }).join("");
    // Skip tool-only/thinking-only messages and empty failed/aborted responses.
    if (!text.trim()) continue;
    messages.push({ role, text });
  }

  const selected = mode === "last" ? messages.slice(-1) : messages;
  if (selected.length === 0) return undefined;
  const finalAssistant = selected.findLast((message) => message.role === "assistant");
  return selected.map((message) => {
    const text = mode === "users" && message.role === "assistant" && message !== finalAssistant
      ? "[Response omitted]"
      : message.text;
    const role = message.role === "user" ? "User" : "Assistant";
    return `${role}:\n${text}`;
  }).join("\n\n");
}
