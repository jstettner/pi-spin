// Spin check: done when every checkbox in PLAN.md is ticked.
//
// Progress lives in the file, not in Spin. Pair it with a task prompt such as:
//   Read PLAN.md. Do the first unchecked "- [ ]" item, verify it, change it to
//   "- [x]", and report what changed.
//
// Permissions: none (reads only). Change PLAN to track a different file.
const PLAN = "PLAN.md";

// A missing file is a failed check, never "nothing left to do".
const text = await tools.read({ path: PLAN });
const items = [...text.matchAll(/^\s*[-*] \[( |x|X)\] (.+)$/gm)].map((match) => ({
  done: match[1] !== " ",
  title: match[2].trim(),
}));
if (items.length === 0) throw new Error(`${PLAN} has no checklist items`);

const open = items.filter((item) => !item.done);
if (open.length === 0) {
  return { verdict: "done", reason: `All ${items.length} items in ${PLAN} are checked.` };
}
return {
  verdict: "continue",
  reason: `${open.length} of ${items.length} items in ${PLAN} are open; next: ${open[0].title}`.slice(0, 2000),
  // The open items themselves, so an iteration that ticks nothing leaves it unchanged. The
  // count comes first so that cutting it to 512 characters never hides a ticked item.
  progressFingerprint: `${open.length}\n${open.map((item) => item.title).sort().join("\n")}`.slice(0, 512),
};
