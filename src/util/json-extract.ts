/**
 * Extract the first balanced JSON object from a string. Tolerant of surrounding prose or markdown
 * fences an LLM may emit despite instructions. Returns the substring, or undefined if no balanced
 * object is found. String-literal aware (ignores braces inside strings). The ONE shared tolerant
 * scanner for every LLM-output seam (compiler, planner, judge, approver, usage-shape classifier),
 * so they all parse the same way — hoisted here instead of a per-step copy.
 */
export function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/**
 * Extract + parse the first balanced JSON object from arbitrary text. Tolerates ```json fences,
 * surrounding log lines, and prose. Returns the parsed value, or null when no balanced `{...}`
 * object yields valid JSON.
 */
export function extractJson(text: string): unknown | null {
  const candidate = extractBalancedJson(text);
  if (candidate === undefined) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

/**
 * Substring marker for a truncated-JSON failure reason (see {@link isTruncatedJson}). Shared between
 * whichever seam throws the error (e.g. the compiler) and the orchestrator's retry-feedback / resume
 * decision, so both recognise the SAME failure mode by checking one constant instead of each
 * re-deriving it from raw reason text. A truncation-shaped failure warrants a fresh session + a
 * stop-exploring nudge on retry — resuming the exhausted session tends to just re-hit the same
 * ceiling.
 */
export const TRUNCATED_JSON_MARKER = 'truncated mid-JSON';

/**
 * Distinguish "the response never contained JSON" from "the response STARTED a JSON object but got
 * cut off before the closing brace" (an opening `{` whose depth never returns to 0 by EOF). This is
 * the common failure mode when an authoring LLM call runs out of turns/output budget mid-answer — a
 * caller that sees this should retry with a FRESH session and a stop-exploring nudge, not resume the
 * exhausted one (resuming tends to just re-hit the same ceiling). Same string-literal-aware scan as
 * {@link extractBalancedJson}; only the depth-at-EOF check differs, so kept as a small sibling rather
 * than complicating that function's return shape for every existing caller.
 */
export function isTruncatedJson(text: string): boolean {
  const start = text.indexOf('{');
  if (start === -1) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return false; // balanced — not truncated
    }
  }
  return depth > 0; // ended mid-object
}
