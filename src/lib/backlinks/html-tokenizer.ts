/** Bounded, forward-only HTML tokenization for observed links, not DOM repair. */
import { parseTagAttrs } from "./html.ts";

export type HtmlToken = {
  name: string;
  closing: boolean;
  attrs: Record<string, string>;
  index: number;
  end: number;
};
export type HtmlDocument = {
  tokens: HtmlToken[];
  visibleText: string;
  title: string | null;
  complete: boolean;
};
const RAW = new Set([
  "script",
  "style",
  "noscript",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);
const whitespace = (char: string) =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
const nameChar = (char: string) => /[a-z0-9:-]/i.test(char);

export function tokenizeHtml(html: string, strict = false): HtmlDocument {
  // HTML tag names are ASCII-insensitive. Unicode lowercasing can expand
  // characters (İ -> i + combining dot) and corrupt original UTF-16 offsets.
  const lower = html.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const tokens: HtmlToken[] = [];
  const text: string[] = [];
  let cursor = 0;
  let templateDepth = 0;
  let inHead = false;
  let raw: string | null = null;
  let title: string | null = null;
  let complete = true;
  const invalid = () => {
    complete = false;
    if (strict) throw new Error("Source HTML is incomplete or exceeds parser limits.");
  };
  while (cursor < html.length) {
    if (raw) {
      let close = lower.indexOf(`</${raw}`, cursor);
      while (close !== -1) {
        const next = lower[close + raw.length + 2] ?? "";
        if (next === ">" || whitespace(next)) break;
        close = lower.indexOf(`</${raw}`, close + raw.length + 2);
      }
      if (close === -1) {
        invalid();
        break;
      }
      if (raw === "title" && !templateDepth && title === null) title = html.slice(cursor, close);
      cursor = close;
      raw = null;
    }
    const start = html.indexOf("<", cursor);
    if (start === -1) {
      if (!templateDepth && !inHead) text.push(html.slice(cursor));
      break;
    }
    if (!templateDepth && !inHead) text.push(html.slice(cursor, start));
    if (html.startsWith("<!--", start)) {
      const close = html.indexOf("-->", start + 4);
      if (close === -1) {
        invalid();
        break;
      }
      cursor = close + 3;
      continue;
    }
    let position = start + 1;
    const closing = html[position] === "/";
    if (closing) position += 1;
    const nameStart = position;
    while (position < html.length && nameChar(html[position]!)) position += 1;
    const name = lower.slice(nameStart, position);
    const declaration = html[start + 1] === "!" || html[start + 1] === "?";
    if (!name && !declaration) {
      // A bare less-than in text is not a tag.
      if (!templateDepth && !inHead) text.push("<");
      cursor = start + 1;
      continue;
    }
    if (
      name &&
      position < html.length &&
      !whitespace(html[position]!) &&
      html[position] !== "/" &&
      html[position] !== ">"
    ) {
      invalid();
      break;
    }
    const attrsStart = position;
    let quote = "";
    for (; position < html.length; position += 1) {
      const char = html[position]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      else if (char === "<") {
        invalid();
        break;
      }
    }
    if (!complete || position >= html.length || quote) {
      invalid();
      break;
    }
    cursor = position + 1;
    if (declaration) continue;
    if (name === "template") {
      templateDepth = closing ? Math.max(0, templateDepth - 1) : templateDepth + 1;
      continue;
    }
    if (!closing && RAW.has(name)) {
      raw = name;
      continue;
    }
    if (!closing && name === "plaintext") {
      invalid();
      break;
    }
    if (templateDepth) continue;
    if (name === "head") inHead = !closing;
    if (tokens.length >= 100_000) {
      invalid();
      break;
    }
    tokens.push({
      name,
      closing,
      attrs: closing ? {} : parseTagAttrs(html.slice(attrsStart, position)),
      index: start,
      end: cursor,
    });
  }
  if (templateDepth || raw) invalid();
  return { tokens, visibleText: text.join(" "), title, complete };
}
