/** Ask for one goal when the CLI starts without an instruction. */
export async function promptForGoal(
  ask: (prompt: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    const goal = (await ask('What should goaly work on? ')).trim();
    return goal.length > 0 ? goal : undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        ('code' in error && error.code === 'ERR_USE_AFTER_CLOSE'))
    ) return undefined;
    throw error;
  }
}
