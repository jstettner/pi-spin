# pi-spin

A [Pi](https://pi.dev) package with two extensions that can be installed separately:

- **`/carry`** moves conversation text to another position in the session tree.
- **`/spin`** repeats a task prompt from a fixed point in the conversation, carrying selected context between iterations, until a saved check script reports that the work is done.

## `/carry`

Run `/carry`, choose a destination in the session tree, then choose:

1. **Last message only**: the last user or assistant message with text.
2. **All user + assistant messages**: the selected target through the current branch head, inclusive.
3. **User messages + final assistant**: the same range, replacing earlier assistant responses with `[Response omitted]`.

Selecting a user message still prefills Pi's input normally. Its original text is included in modes 2 and 3, so clearing or replacing that input does not lose it.

Messages are carried verbatim with role labels. Tool calls and results, thinking, summaries and internal entries are excluded. Images are represented by `[Image omitted]`; tool-only and empty messages are skipped. Raw branch history is used, including messages before compaction.

When navigating to a different branch, modes 2 and 3 carry the abandoned source side after the nearest shared ancestor (or the entire source branch when the roots are unrelated).

No model call or automatic agent turn is triggered. Escape from the mode menu returns to the tree at the same selection; escape from the tree cancels.

## `/spin`

Run `/spin <what you want done>`, for example `/spin burn down all lint errors`, then choose what to carry between iterations (the same three modes as `/carry`).

A setup agent then works out with you the task prompt to repeat, a check script that decides when the work is done, what the check may do (run commands, call a classifier) and the limits. Setup happens on its own branch, so the task never sees it. When you approve, the agent submits the proposal and Pi asks you to confirm, summarizing what the check may do and the limits. The task prompt and check script are not repeated in that dialog: review them in the conversation.

Spin then runs the check once, and while it reports `continue`:

1. returns to the point where you ran `/spin`, without summarizing;
2. attaches the carried text and the check's last result;
3. submits the task prompt again;
4. runs the check when the task's response ends.

It stops when the check reports `done`, `blocked` or `uncertain`, when the check fails, when an iteration limit, time limit or no-progress limit is reached, or when a task run is aborted or ends with an error. It also stops if you send a message or move in the tree while it runs. `/spin stop` stops it; `/spin status` shows where it is. Iterations stay in the session tree as sibling branches. Files are not reset between iterations.

The check is a codemode script: the body of an async function that returns `{ verdict, reason, progressFingerprint? }`. Remaining work lives in the project (a plan file, a lint command), and the task prompt says where. [`examples/checks/markdown-checklist.js`](examples/checks/markdown-checklist.js) is a complete check for the plan-file pattern: the task ticks boxes in `PLAN.md`, and the check continues while any are open. It can read files and use Pi's `grep`, `find` and `ls`; `tools.bash` and `models.classify` exist only if you approved them. It runs outside Pi's tool pipeline, so permission extensions do not see its calls, and classifier costs are not added to Pi's session totals.

Spin's state is saved as entries in the session. A Spin interrupted by a reload or by closing Pi is reported when the session reopens, and is never resumed.

`/spin` needs an interactive UI for setup. It registers an internal `/spin-continue` command, which you can ignore.

## License

MIT
