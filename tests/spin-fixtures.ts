// Synthetic Spin data shared by the tests.

export const checkSource = `// @options: {"timeout_ms": 30000}
const run = await tools.bash({ command: "npm run lint -- --format json" });
return { verdict: run.exit_code === 0 ? "done" : "continue", reason: "Synthetic check." };`;

export const proposal = () => ({
  task: "Fix a batch of lint errors without adding suppressions.",
  checkSource,
  permissions: {
    commands: true,
    classifier: false,
  },
  limits: { maxIterations: 10, maxDurationMs: 3_600_000 },
});
