/**
 * The minimal viable tool set for the goaly-code harness (spec §2.4). Every tool validates its arguments
 * with Zod at the seam (invariant #6) and delegates the actual effect to a {@link ToolHost} — the
 * path-guarded filesystem + the sandboxed shell — so the loop, the tools, and their dispatch are all
 * testable with a fake host (zero real shell, zero real fs in unit tests).
 *
 * {@link dispatchTool} owns the never-crash guarantee (spec §2.3): an unknown tool, malformed
 * arguments, or a throwing handler all become a tool-RESULT STRING fed back to the model, never an
 * exception that propagates out of the loop. A weak agent thus burns a turn recovering, it never
 * crashes the run.
 */

import { z } from 'zod';
import { errorMessage } from '../util/errors';

/** The path-guarded workspace operations a tool may perform. Each returns a model-ready result string. */
export interface ToolHost {
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<string>;
  listDir(path: string): Promise<string>;
  grep(pattern: string, path: string | undefined): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  editFile(path: string, oldString: string, newString: string): Promise<string>;
  runShell(command: string): Promise<string>;
}

/** One tool the model may call. `terminal` marks {@link finishTool}, which ends the loop. */
export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  /** JSON-Schema for the function's parameters, advertised to the model. */
  readonly parameters: Record<string, unknown>;
  readonly terminal?: boolean;
  run(rawArgs: unknown, host: ToolHost): Promise<string>;
};

/** Build a JSON-Schema object node from a property map + required list. */
function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = (description: string) => ({ type: 'string', description });
const INT = (description: string) => ({ type: 'integer', description });

const readArgs = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});

const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file in the workspace. Optionally pass start_line/end_line (1-based, inclusive) to read a slice.',
  parameters: objectSchema(
    {
      path: STRING('Workspace-relative path to the file.'),
      start_line: INT('First line to read (1-based, inclusive). Optional.'),
      end_line: INT('Last line to read (1-based, inclusive). Optional.'),
    },
    ['path'],
  ),
  async run(rawArgs, host) {
    const a = readArgs.parse(rawArgs);
    const range =
      a.start_line !== undefined || a.end_line !== undefined
        ? {
            ...(a.start_line !== undefined ? { startLine: a.start_line } : {}),
            ...(a.end_line !== undefined ? { endLine: a.end_line } : {}),
          }
        : undefined;
    return host.readFile(a.path, range);
  },
};

const listArgs = z.object({ path: z.string().default('.') });

const listDirTool: ToolSpec = {
  name: 'list_dir',
  description: 'List the entries of a workspace directory (directories are suffixed with "/").',
  parameters: objectSchema({ path: STRING('Workspace-relative directory (default ".").') }, []),
  async run(rawArgs, host) {
    return host.listDir(listArgs.parse(rawArgs ?? {}).path);
  },
};

const grepArgs = z.object({ pattern: z.string().min(1), path: z.string().optional() });

const grepTool: ToolSpec = {
  name: 'grep',
  description:
    'Search the workspace for a JavaScript regular expression. Returns matching "file:line: text" rows (bounded).',
  parameters: objectSchema(
    {
      pattern: STRING('A JavaScript regular expression.'),
      path: STRING('Restrict the search to this workspace-relative file or directory. Optional.'),
    },
    ['pattern'],
  ),
  async run(rawArgs, host) {
    const a = grepArgs.parse(rawArgs);
    return host.grep(a.pattern, a.path);
  },
};

const writeArgs = z.object({ path: z.string().min(1), content: z.string() });

const writeFileTool: ToolSpec = {
  name: 'write_file',
  description: 'Create a file or replace its entire contents. Use for new files or wholesale rewrites.',
  parameters: objectSchema(
    { path: STRING('Workspace-relative path.'), content: STRING('The full file content to write.') },
    ['path', 'content'],
  ),
  async run(rawArgs, host) {
    const a = writeArgs.parse(rawArgs);
    return host.writeFile(a.path, a.content);
  },
};

const editArgs = z.object({
  path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
});

const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    'Replace an exact, unique snippet (old_string) in a file with new_string. Include enough surrounding context for old_string to match exactly one location.',
  parameters: objectSchema(
    {
      path: STRING('Workspace-relative path to the file to edit.'),
      old_string: STRING('The exact text to replace (must be unique in the file).'),
      new_string: STRING('The replacement text.'),
    },
    ['path', 'old_string', 'new_string'],
  ),
  async run(rawArgs, host) {
    const a = editArgs.parse(rawArgs);
    return host.editFile(a.path, a.old_string, a.new_string);
  },
};

const shellArgs = z.object({ command: z.string().min(1) });

const runShellTool: ToolSpec = {
  name: 'run_shell',
  description:
    'Run a shell command in the workspace (e.g. build, run tests, inspect). Do NOT use git commit/add/reset.',
  parameters: objectSchema({ command: STRING('The shell command line to run.') }, ['command']),
  async run(rawArgs, host) {
    return host.runShell(shellArgs.parse(rawArgs).command);
  },
};

const finishArgs = z.object({ summary: z.string() });

const finishTool: ToolSpec = {
  name: 'finish',
  description: 'Declare the task complete. Pass a one-paragraph summary of the change you made.',
  parameters: objectSchema({ summary: STRING('A summary of what you changed and why.') }, ['summary']),
  terminal: true,
  async run(rawArgs) {
    return finishArgs.parse(rawArgs).summary;
  },
};

/** The default, minimal tool set (spec §2.4). Order is the order advertised to the model. */
export const DEFAULT_TOOLS: ToolSpec[] = [
  readFileTool,
  listDirTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runShellTool,
  finishTool,
];

/** The outcome of one tool call: the result string to feed back, and whether it ends the loop. */
export type ToolOutcome = { output: string; terminal: boolean };

/**
 * Dispatch one model-requested tool call, fail-closed (spec §2.3): resolve the tool by name, parse
 * the raw JSON argument STRING, Zod-validate the shape inside `run`, and run the handler — turning
 * EVERY failure (unknown tool, non-JSON args, invalid args, a throwing handler) into a result string
 * the model can read and recover from. Never throws.
 */
export async function dispatchTool(
  tools: ToolSpec[],
  name: string,
  rawArgsJson: string,
  host: ToolHost,
): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) {
    return { output: `Error: unknown tool "${name}"`, terminal: false };
  }
  let parsed: unknown;
  try {
    parsed = rawArgsJson.trim().length === 0 ? {} : JSON.parse(rawArgsJson);
  } catch {
    return { output: `Error: arguments for "${name}" were not valid JSON`, terminal: false };
  }
  try {
    const output = await tool.run(parsed, host);
    return { output, terminal: tool.terminal === true };
  } catch (e) {
    return { output: `Error: ${errorMessage(e)}`, terminal: false };
  }
}

/** Map the tool specs to the chat-completions `tools` array advertised on each request. */
export function toApiTools(tools: ToolSpec[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
