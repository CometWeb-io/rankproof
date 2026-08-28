/**
 * Small text helpers shared by the report, the CLI and the UI.
 *
 * Counts appear all over the output ("1 keywords in the top 10" reads as a
 * bug even when the number is right), so the plural form is worth the helper.
 */

/** `plural(1, "link")` → `"1 link"`, `plural(3, "link")` → `"3 links"`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
