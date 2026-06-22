import type { GeneratedFile } from '../domain/contract';
import type { Verdict } from '../domain/verdict';
import type { Verifier } from './verifier';
import type { Workspace } from '../workspace/workspace';

/**
 * Integrity guard for compiler-authored verification files. The frozen contract pins
 * each generated file by content hash; this rung re-hashes them before the deterministic command
 * runs and FAILS closed if any was modified or removed since the contract was frozen. It closes the
 * gap where the frozen command (`vitest run authored.test.ts`) stays fixed while the worker — which
 * has workspace-write — rewrites the test the command measures, moving the bar without moving the
 * contract.
 *
 * Placed FIRST in the ladder so a tampered bar short-circuits to a hard red before the (now
 * meaningless) command is even run. A guard with no pinned files is vacuously green.
 */
export class GeneratedFilesGuard implements Verifier {
  readonly #files: readonly GeneratedFile[];

  constructor(files: readonly GeneratedFile[]) {
    this.#files = [...files];
  }

  async verify(workspace: Workspace, _goal: string, _rubric: string): Promise<Verdict> {
    for (const file of this.#files) {
      const actual = await workspace.fileHash(file.path);
      if (actual === null) {
        return {
          pass: false,
          confidence: 1,
          detail: `generated verification file is missing or unreadable: ${file.path}`,
        };
      }
      if (actual !== file.sha256) {
        return {
          pass: false,
          confidence: 1,
          detail:
            `generated verification file was modified since the contract was frozen: ${file.path} ` +
            '(the frozen bar cannot move — restore the authored verification or re-run the compile)',
        };
      }
    }
    return { pass: true, confidence: 1, detail: `generated files intact (${this.#files.length})` };
  }
}
