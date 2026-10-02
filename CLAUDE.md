# pi-spin

- A Pi package: `/carry` (`extensions/carry.ts`) and `/spin` (planned; service interfaces and Pi adapters in `src/spin/`). Pi loads the TypeScript in `extensions/` directly; there is no build step.
- Shared code lives in `src/`. Carry selection and formatting (`src/carry-core.ts`) stays pure TypeScript with no Effect dependency. One extension never invokes the other's slash command.
- Host-provided Pi packages (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `pi-agent-core`, `typebox`) that extension code imports are `peerDependencies` with `"*"`; pin them in `devDependencies` for tests, including ones only tests import. Never put them in `dependencies` or deep-import their `dist/` files; use the package root exports.
- The `carry` custom message type and `CARRY_HEADER` are stored in users' sessions. Changing them breaks rendering of existing carry entries.
- Effect 4 (`effect`), TypeScript 7, vitest 5 with `@effect/vitest`. Effect packages are pinned to the same version and bumped together.
- `npm install` patches `tsc` with `@effect/tsgo` (the `prepare` script), so the typecheck also reports Effect's diagnostics. Effect warnings fail it; suggestions don't. TypeScript and `@effect/tsgo` are pinned and bumped together.
- Functions that return an Effect use `Effect.fn("name")`, or `Effect.fnUntraced` for helpers called in loops, never a function that only wraps `Effect.gen`. The typecheck enforces it (`effectFnOpportunity` at warning level).
- Relative imports use `.ts` extensions. Only erasable TS syntax is allowed (no enums, namespaces or parameter properties).
- Verify with `npm run check`.
- Plans and research live in the gitignored `.local/` directory (`PLAN.md`, `research/`). Update the plan's milestone checkboxes and Log when finishing a step.
- Test fixtures are synthetic. Never commit real session content.

## Reference source

- `repos/effect/` is a gitignored clone of Effect's source at the installed version. Read it; never edit it or import from it. If it's missing or `effect` was bumped, run `npm run repos`.
- Read `repos/effect/LLMS.md` before writing Effect code. Prefer the patterns in its source and tests over memory, which leans toward Effect 3.
- Pi's docs and declarations are in `node_modules/@earendil-works/pi-coding-agent/` (`docs/`, `dist/**/*.d.ts`, `examples/`).
