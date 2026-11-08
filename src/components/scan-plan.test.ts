import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The interface is English (`<html lang="en">`); there is no translation layer,
// so a Polish label in this tab is always a leftover.
const POLISH =
  /[ąćęłńóśźż]|\b(zadania|zadań|szybkie|wygrane|stan|realizacji|luki|ryzyko|tylko|stopka|lub|pobierz|brak|wszystkie|linki|domeny|strony)\b/i;

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

test("toxic links tab and its reasons follow the English UI", () => {
  const tab = readFileSync(new URL("./scan-toxic.tsx", import.meta.url), "utf8");
  const tabText = [...tab.matchAll(/>([^<>{}]*[a-z][^<>{}]*)</gi)].map((m) => m[1]!.trim());
  assert.ok(tabText.includes("Risk CSV"), "extracts rendered text");
  const scorer = readFileSync(new URL("../lib/backlinks/toxic.ts", import.meta.url), "utf8");
  const reasons = [...scorer.matchAll(/reasons\.push\(["`]([^"`]+)["`]\)/g)].map((m) => m[1]!);
  assert.ok(reasons.length >= 8, "extracts toxic reasons");
  assert.deepEqual(
    [...tabText.filter(Boolean), ...reasons].filter((text) => POLISH.test(text)),
    [],
  );
});
