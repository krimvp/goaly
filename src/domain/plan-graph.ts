import type { SubGoal } from './plan';

/**
 * The plan's DEPENDENCY GRAPH (issue #123) — pure, synchronous, zero-IO. A decomposition plan is a
 * DAG over sub-goals, not a linear list: `dependsOn` declares the edges, and the legacy `group`
 * field is SUGAR that lowers to the same edges (a contiguous band ⇒ every member depends on
 * everything before the band), so pre-#123 frozen plans keep byte-identical semantics.
 *
 * The phase list must be a TOPOLOGICAL ORDER of that DAG (a phase may only depend on phases before
 * it). That keeps the sequential walk — and the sequential downgrade of an unmerged wave member —
 * sound by construction: by the time a phase runs, every prerequisite has already completed, so
 * "a phase whose dependencies can never complete" is unreachable rather than a hang. A forward
 * edge is a typed, fail-closed parse failure, exactly like a cycle.
 */

/** A typed, fail-closed reason a plan's dependency graph is unusable. Never a linearization. */
export type PlanGraphViolation =
  | { readonly kind: 'duplicate-id'; readonly index: number; readonly id: string }
  | { readonly kind: 'self-dependency'; readonly index: number; readonly id: string }
  | { readonly kind: 'unknown-dependency'; readonly index: number; readonly dependency: string }
  | { readonly kind: 'cycle'; readonly cycle: readonly string[] }
  | { readonly kind: 'forward-dependency'; readonly index: number; readonly dependency: string };

/** How a phase is named in a violation message: its plan-local id, or its 1-based position. */
export function phaseLabel(phases: readonly SubGoal[], index: number): string {
  return phases[index]?.id ?? `phase #${index + 1}`;
}

/** One actionable line describing a violation — the message the fail-closed parse carries. */
export function describePlanGraphViolation(v: PlanGraphViolation): string {
  const at = (index: number): string => `phase #${index + 1}`;
  switch (v.kind) {
    case 'duplicate-id':
      return `plan graph: duplicate phase id '${v.id}' at ${at(v.index)} — ids must be unique within a plan`;
    case 'self-dependency':
      return `plan graph: ${at(v.index)} ('${v.id}') depends on itself`;
    case 'unknown-dependency':
      return `plan graph: ${at(v.index)} depends on unknown phase id '${v.dependency}'`;
    case 'cycle':
      return `plan graph: dependency cycle ${v.cycle.join(' -> ')}`;
    case 'forward-dependency':
      return (
        `plan graph: ${at(v.index)} depends on '${v.dependency}', a later phase — ` +
        'the phase list must be a topological order (dependencies come first)'
      );
  }
}

/**
 * Validate the graph, fail-closed. Returns the FIRST violation (checked in the order that gives the
 * most actionable message: ids, then edges, then structure) or `undefined` when the plan is a DAG
 * in topological order. Pure and total — safe to call from a Zod refinement at every plan seam.
 */
export function validatePlanGraph(phases: readonly SubGoal[]): PlanGraphViolation | undefined {
  const byId = new Map<string, number>();
  for (let index = 0; index < phases.length; index += 1) {
    const id = phases[index]?.id;
    if (id === undefined) continue;
    if (byId.has(id)) return { kind: 'duplicate-id', index, id };
    byId.set(id, index);
  }
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index]!;
    for (const dependency of phase.dependsOn ?? []) {
      if (dependency === phase.id) return { kind: 'self-dependency', index, id: dependency };
      if (!byId.has(dependency)) return { kind: 'unknown-dependency', index, dependency };
    }
  }
  const deps = planDependencies(phases);
  const cycle = findCycle(deps);
  if (cycle !== undefined) return { kind: 'cycle', cycle: cycle.map((i) => phaseLabel(phases, i)) };
  for (let index = 0; index < deps.length; index += 1) {
    const forward = deps[index]!.find((d) => d > index);
    if (forward !== undefined) {
      return { kind: 'forward-dependency', index, dependency: phaseLabel(phases, forward) };
    }
  }
  return undefined;
}

/**
 * The lowered dependency edges: `deps[i]` is the ascending, deduplicated set of phase INDICES that
 * must complete before phase `i` may run.
 *
 *  - `dependsOn` present ⇒ exactly those phases (an empty array means "no prerequisites").
 *  - otherwise ⇒ the POSITIONAL default: everything before this phase's `group` band (or before the
 *    phase itself when it has no group). That is the pre-#123 semantics, verbatim.
 *
 * Total by design: an id that cannot be resolved (only reachable if something bypassed the parse
 * seam) degrades to the CONSERVATIVE positional default unioned with whatever did resolve, so an
 * unvalidated plan can never schedule a phase EARLIER than the linear plan would have.
 */
export function planDependencies(phases: readonly SubGoal[]): readonly (readonly number[])[] {
  const byId = new Map<string, number>();
  phases.forEach((phase, index) => {
    if (phase.id !== undefined && !byId.has(phase.id)) byId.set(phase.id, index);
  });
  return phases.map((phase, index) => {
    if (phase.dependsOn === undefined) return positionalPrerequisites(phases, index);
    const resolved = phase.dependsOn.map((id) => byId.get(id)).filter(isIndex);
    const fallback =
      resolved.length === phase.dependsOn.length ? [] : positionalPrerequisites(phases, index);
    return ascendingUnique([...resolved, ...fallback]);
  });
}

/**
 * THE SCHEDULER: the ready frontier of a frozen plan given the set of completed phase indices — the
 * phases whose every prerequisite has completed and which have not completed themselves, in plan
 * order. Pure, total, and allocation-only: `(plan, completed) -> indices`. This is what the wave
 * machinery fans out (the frontier may be a contiguous band, a scattered set, or a singleton), and
 * what a `--resume` recomputes from the replayed completed set — so no completed phase is repeated.
 */
export function readyFrontier(
  plan: { readonly phases: readonly SubGoal[] },
  completed: Iterable<number>,
): readonly number[] {
  const done = new Set(completed);
  const deps = planDependencies(plan.phases);
  const frontier: number[] = [];
  for (let index = 0; index < plan.phases.length; index += 1) {
    if (done.has(index)) continue;
    if (deps[index]!.every((d) => done.has(d))) frontier.push(index);
  }
  return frontier;
}

/** Everything before phase `index`'s contiguous `group` band — the pre-#123 positional semantics. */
function positionalPrerequisites(phases: readonly SubGoal[], index: number): readonly number[] {
  const group = phases[index]?.group;
  let start = index;
  if (group !== undefined) {
    while (start > 0 && phases[start - 1]?.group === group) start -= 1;
  }
  return Array.from({ length: start }, (_, i) => i);
}

function isIndex(value: number | undefined): value is number {
  return value !== undefined;
}

function ascendingUnique(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * The first dependency cycle, as indices (`[a, …, a]`), or `undefined` for a DAG. Iterative
 * three-colour DFS — no recursion, so a pathological plan file can't blow the stack.
 */
function findCycle(deps: readonly (readonly number[])[]): readonly number[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = deps.map(() => WHITE);
  for (let start = 0; start < deps.length; start += 1) {
    if (color[start] !== WHITE) continue;
    const path: number[] = [start];
    const cursor: number[] = [0];
    color[start] = GRAY;
    while (path.length > 0) {
      const node = path[path.length - 1]!;
      const edges = deps[node]!;
      const next = edges[cursor[cursor.length - 1]!];
      cursor[cursor.length - 1] = cursor[cursor.length - 1]! + 1;
      if (next === undefined) {
        color[node] = BLACK;
        path.pop();
        cursor.pop();
        continue;
      }
      if (color[next] === GRAY) return [...path.slice(path.indexOf(next)), next];
      if (color[next] === WHITE) {
        color[next] = GRAY;
        path.push(next);
        cursor.push(0);
      }
    }
  }
  return undefined;
}
