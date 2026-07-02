/**
 * Extract the first balanced JSON object from a string. Tolerant of surrounding prose or markdown
 * fences an LLM may emit despite instructions. Returns the substring, or undefined if no balanced
 * object is found. String-literal aware (ignores braces inside strings). Shared by the verification
 * compiler and the usage-shape classifier so both parse LLM output the same tolerant way.
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
