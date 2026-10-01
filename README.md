# pi-spin

A [Pi](https://pi.dev) package with two extensions that can be installed separately:

- **`/carry`** moves conversation text to another position in the session tree.
- **`/spin`** (in development) repeats a task prompt from a fixed point in the conversation, carrying selected context between iterations, until a saved check script reports that the work is done.

## `/carry`

Run `/carry`, choose a destination in the session tree, then choose:

1. **Last message only**: the last user or assistant message with text.
2. **All user + assistant messages**: the selected target through the current branch head, inclusive.
3. **User messages + final assistant**: the same range, replacing earlier assistant responses with `[Response omitted]`.

Selecting a user message still prefills Pi's input normally. Its original text is included in modes 2 and 3, so clearing or replacing that input does not lose it.

Messages are carried verbatim with role labels. Tool calls and results, thinking, summaries and internal entries are excluded. Images are represented by `[Image omitted]`; tool-only and empty messages are skipped. Raw branch history is used, including messages before compaction.

When navigating to a different branch, modes 2 and 3 carry the abandoned source side after the nearest shared ancestor (or the entire source branch when the roots are unrelated).

No model call or automatic agent turn is triggered. Escape from the mode menu returns to the tree at the same selection; escape from the tree cancels.

## Install

From a local checkout:

```sh
pi install /path/to/pi-spin
```

To load only some of the extensions, use the object form in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "/path/to/pi-spin", "extensions": ["extensions/carry.ts"] }
  ]
}
```

Run `/reload` after changing the package.

## Development

Requires Node 22.19+.

```sh
npm install
npm run check   # typecheck + tests
```

Tests load the extensions through Pi's public extension loader with synthetic in-memory sessions.

## License

MIT
