import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * A tiny, dependency-free `which`: is `binary` an executable on `PATH`? Synchronous and side-effect
 * free beyond `fs.accessSync`. Used by the sandbox host probe (which is itself injectable, so this
 * is only ever the PRODUCTION default — tests pass a fake and never touch the real host).
 */
export function which(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // An explicit path (contains a separator) is checked directly.
  if (binary.includes('/') || binary.includes('\\')) return isExecutable(binary);
  const pathVar = env.PATH ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    if (isExecutable(join(dir, binary))) return true;
  }
  return false;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
