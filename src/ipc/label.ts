/**
 * Helpers to annotate IPC generators with human-readable labels. The bridge
 * extracts the leading block comment before passing code to `__mcpEval`;
 * the extension UI displays it as the main log body and leaves raw JS under
 * a collapsible <details>. The PT Script Engine completely ignores the comment.
 *
 * Editorial convention — so the log reads like a recipe:
 *   - Gerund verb at the start: "Creating ...", "Reading ...".
 *   - Name(s) of affected resource after the verb.
 *   - Detail in parentheses when helpful (model, IP, format).
 *   - Unicode arrows "→" for directional flows and "↔" for links.
 *   - No trailing period.
 *
 * Keep it concise: the panel has limited width. For arbitrary length text
 * (CLI, raw JS, canvas notes) use `truncateForLabel`, which cleanly cuts
 * at the last space before the limit.
 */
export function withLabel(label: string, js: string): string {
  return `/* ${label} */ ${js}`;
}

/**
 * Flattens whitespace and truncates to `max` characters. If cutting mid-word
 * and there is a nearby space, rewinds to that space so tokens aren't broken
 * awkwardly in the UI. Unicode ellipsis "…" saves characters.
 */
export function truncateForLabel(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace >= max - 15) return head.slice(0, lastSpace) + "…";
  return head + "…";
}
