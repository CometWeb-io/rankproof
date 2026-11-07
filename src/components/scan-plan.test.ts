import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The interface is English (`<html lang="en">`); there is no translation layer,
// so a Polish label in this tab is always a leftover.
const POLISH =
  /[ąćęłńóśźż]|\b(zadania|zadań|szybkie|wygrane|stan|realizacji|luki|ryzyko|pobierz|brak|wszystkie|linki|domeny|strony)\b/i;

test("action plan labels follow the English UI", () => {
  const source = readFileSync(new URL("./scan-plan.tsx", import.meta.url), "utf8");
  const jsxText = [...source.matchAll(/>([^<>{}]*[a-z][^<>{}]*)</gi)].map((m) => m[1]!.trim());
  const labels = [...source.matchAll(/^\s+"?[\w-]+"?: "([^"]+)",$/gm)].map((m) => m[1]!);
  const visible = [...jsxText, ...labels].filter(Boolean);
  assert.ok(visible.includes("What to do, in this order"), "extracts rendered text");
  assert.deepEqual(
    visible.filter((text) => POLISH.test(text)),
    [],
  );
});
