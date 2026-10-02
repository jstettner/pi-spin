import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createFindTool, createGrepTool, createLsTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import { Schema } from "effect";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { CheckPermissions } from "./model.ts";

// The functions a check script can call. The approved script is the permission: it can read
// any file and use Pi's read-only grep, find and ls. `tools.bash` and the `models` global exist
// only when the approved permissions switch them on. These are ordinary callbacks the sandbox invokes, not
// a service. They run outside Pi's tool pipeline, so Pi's tool hooks and permission extensions
// do not see them. Tools registered by other extensions and MCP tools are unreachable: Pi only
// runs them through `ctx.executeTool()`, which command contexts do not have.

/** Largest file `tools.read` returns. Larger files fail rather than being truncated. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Per stream. Beyond it, `tools.bash` drops output and sets `truncated`. */
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export type ClassifierRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "getModelOfType" | "getModelsOfType" | "getAvailableOfType" | "classify"
>;

export interface CheckEnvironment {
  /** The session's working directory: relative paths and commands resolve against it. */
  readonly cwd: string;
  readonly models: ClassifierRegistry;
}

/** Classifier spending in one check run, in the shape EvaluationRecord and CheckFailed store. */
export interface ClassifierUsage {
  readonly classifierCalls: number;
  /** Absent when no classifier call reported usage. */
  readonly costUsd?: number;
}

export interface CommandResult {
  readonly exit_code: number | null;
  /** Set when the command was killed by a signal. */
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Some stdout or stderr was dropped. Never treat truncated output as complete evidence. */
  readonly truncated: boolean;
}

const ReadArgs = Schema.Struct({ path: Schema.String });
const BashArgs = Schema.Struct({ command: Schema.String });
const ModelRef = Schema.Struct({ provider: Schema.String, id: Schema.String });
const ModelType = Schema.Literals(["chat", "image", "classifier"]);
/** Argument errors are the script's bug, reported to it like any thrown error. */
const decodeArgs = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, name: string) => {
  const decode = Schema.decodeUnknownSync(schema);
  return (value: unknown): S["Type"] => {
    try {
      return decode(value);
    } catch (error) {
      throw new Error(`${name}: invalid arguments: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
};
const readArgs = decodeArgs(ReadArgs, "tools.read");
const bashArgs = decodeArgs(BashArgs, "tools.bash");
const modelRef = decodeArgs(ModelRef, "models.classify model");
const modelType = decodeArgs(ModelType, "model type");

/** Absolute, `~/`-relative, or relative to the working directory. */
const resolvePath = (cwd: string, path: string) =>
  path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);

type PiTool = ReturnType<typeof createLsTool>;

/**
 * One of Pi's built-in tools as a sandbox tool. Arguments are checked against its schema, as
 * Pi's agent would, and the result is its model-facing text, including Pi's truncation notes.
 */
function fromPiTool(tool: PiTool): CodemodeTool {
  const validator = Compile(tool.parameters as TSchema);
  let calls = 0;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
    outputSchema: { type: "string" },
    execute: async (args, { signal }) => {
      if (!validator.Check(args)) {
        const problems = [...validator.Errors(args)].map((error) => `${error.instancePath || "/"} ${error.message}`);
        throw new Error(`tools.${tool.name}: invalid arguments: ${problems.join("; ")}`);
      }
      const result = await tool.execute(`spin-check/${tool.name}/${++calls}`, args as never, signal);
      return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    },
  };
}

/**
 * Build the sandbox tools and globals for one check run. `usage()` reports classifier spending;
 * `failures()` lists classifier calls that did not stop normally, any of which fails the check.
 */
export function makeCheckTools(permissions: CheckPermissions, env: CheckEnvironment) {
  const classifierFailures: string[] = [];
  let classifierCalls = 0;
  let costUsd: number | undefined;

  const read: CodemodeTool = {
    name: "read",
    description: "Read a whole UTF-8 file (absolute, ~/, or relative to the working directory). Throws if it is missing or too large; never truncates.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    outputSchema: { type: "string" },
    execute: async (args) => {
      const { path } = readArgs(args);
      const target = resolvePath(env.cwd, path);
      const handle = await open(target, "r").catch(() => {
        throw new Error(`tools.read: ${path} does not exist or cannot be opened`);
      });
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`tools.read: ${path} is not a file`);
        if (stat.size > MAX_READ_BYTES) throw new Error(`tools.read: ${path} is larger than ${MAX_READ_BYTES} bytes`);
        return await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
    },
  };

  const bash: CodemodeTool = {
    name: "bash",
    description: "Run a shell command in the working directory. Returns its exit code and output; a nonzero exit does not throw.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    outputSchema: {
      type: "object",
      properties: {
        exit_code: { type: ["number", "null"] },
        signal: { type: ["string", "null"] },
        stdout: { type: "string" },
        stderr: { type: "string" },
        truncated: { type: "boolean" },
      },
    },
    execute: async (args, { signal }) => {
      const { command } = bashArgs(args);
      return runCommand(command, env.cwd, signal);
    },
  };

  const globals: CodemodeTool[] = [];
  if (permissions.classifier) {
    const registry = env.models;
    const model = (name: string, signature: string, execute: (args: ReadonlyArray<unknown>, signal: AbortSignal) => unknown) =>
      globals.push({ name: `models.${name}`, spread: true, signature, execute: (args, { signal }) => execute(args as unknown[], signal) });
    // Catalog entries without headers, which can carry credentials.
    const info = (entry: object) => {
      const { headers: _headers, ...rest } = entry as { headers?: unknown };
      return rest;
    };

    model("getModelsOfType", "(type: string, provider?: string): Promise<ModelInfo[]>", ([type, provider]) =>
      registry.getModelsOfType(modelType(type), typeof provider === "string" ? provider : undefined).map(info));
    model("getAvailableOfType", "(type: string, provider?: string): Promise<ModelInfo[]>", async ([type, provider], signal) =>
      (await registry.getAvailableOfType(modelType(type), typeof provider === "string" ? provider : undefined, { signal })).map(info));
    model("getModelOfType", "(type: string, provider: string, id: string): Promise<ModelInfo | undefined>", ([type, provider, id]) => {
      if (typeof provider !== "string" || typeof id !== "string") {
        throw new Error("models.getModelOfType(type, provider, id) expects three strings");
      }
      const found = registry.getModelOfType(modelType(type), provider, id);
      return found === undefined ? undefined : info(found);
    });
    model("classify", "(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>", async ([ref, context], signal) => {
      // Resolve by provider and id only, so a script-supplied baseUrl never receives credentials.
      const { provider, id } = modelRef(ref);
      const resolved = registry.getModelOfType("classifier", provider, id);
      if (!resolved) throw new Error(`Unknown classifier model "${provider}/${id}"`);
      classifierCalls += 1;
      // Passed through unchecked: Pi returns a malformed context as an error result, which
      // fails the check below like any other classifier failure.
      const result = await registry.classify(resolved, context as Parameters<ClassifierRegistry["classify"]>[1], { signal });
      if (result.usage) costUsd = (costUsd ?? 0) + result.usage.cost.total;
      if (result.stopReason !== "stop") {
        classifierFailures.push(`${provider}/${id}: ${result.errorMessage ?? `stopped with ${result.stopReason}`}`);
      }
      return result;
    });
  }

  const usage = (): ClassifierUsage => (costUsd === undefined ? { classifierCalls } : { classifierCalls, costUsd });
  const failures = (): ReadonlyArray<string> => [...classifierFailures];
  const tools = [read, ...[createGrepTool(env.cwd), createFindTool(env.cwd), createLsTool(env.cwd)].map(fromPiTool)];
  if (permissions.commands) tools.push(bash);
  return { tools, globals, usage, failures };
}

/**
 * Run a command line through the shell in its own process group, so aborting (deadline,
 * interruption, sandbox close) kills everything it started, not only the shell.
 */
export function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let truncated = false;
    const collect = () => {
      const chunks: Buffer[] = [];
      let size = 0;
      return {
        push: (chunk: Buffer) => {
          const room = MAX_COMMAND_OUTPUT_BYTES - size;
          if (chunk.length > room) truncated = true;
          if (room <= 0) return;
          const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(kept);
          size += kept.length;
        },
        text: () => Buffer.concat(chunks).toString("utf8"),
      };
    };
    const stdout = collect();
    const stderr = collect();
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    };
    const done = () => signal.removeEventListener("abort", kill);
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    child.on("error", (error) => {
      done();
      reject(new Error(`tools.bash: could not start command: ${error.message}`));
    });
    child.on("close", (code, killedBy) => {
      done();
      resolve({ exit_code: code, signal: killedBy, stdout: stdout.text(), stderr: stderr.text(), truncated });
    });
  });
}
