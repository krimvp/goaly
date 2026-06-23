import { readFile as fsReadFile } from 'node:fs/promises';
import type { RunConfig } from '../domain/config';
import { Plan, type PhasePlan } from '../domain/plan';
import { freezePlan } from '../util/hash';
import { errorMessage } from '../util/errors';
import type { Planner } from './planner';

/** Reads a plan file's text. Injectable so tests never touch disk. */
export type PlanFileReader = (filePath: string) => Promise<string>;

const defaultReader: PlanFileReader = (filePath) => fsReadFile(filePath, 'utf8');

/**
 * StaticPlanner — the `--plan-file` {@link Planner} (issue #48). Instead of authoring with an LLM it
 * reads a user-supplied structured plan and freezes it. The file is an external seam, so it is parsed
 * fail-closed with the `Plan` schema (invariant #6): a missing file, bad JSON, or a bad shape throws,
 * which the Driver turns into a typed `PLAN_FAILED` — never a silently empty or malformed plan.
 *
 * `feedback` (a plan-Seal revise note) is ignored: a fixed file can't be re-authored, so a human who
 * wants a different plan edits the file and re-runs, or rejects at the plan Seal. The plan is read
 * fresh on each call so an edited file is picked up on a revise round.
 */
export class StaticPlanner implements Planner {
  readonly #path: string;
  readonly #read: PlanFileReader;

  constructor(opts: { path: string; read?: PlanFileReader }) {
    this.#path = opts.path;
    this.#read = opts.read ?? defaultReader;
  }

  async plan(_config: RunConfig): Promise<PhasePlan> {
    let text: string;
    try {
      text = await this.#read(this.#path);
    } catch (e) {
      throw new Error(`StaticPlanner: could not read --plan-file '${this.#path}': ${errorMessage(e)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`StaticPlanner: --plan-file '${this.#path}' is not valid JSON: ${errorMessage(e)}`);
    }
    return freezePlan(Plan.parse(json));
  }
}
