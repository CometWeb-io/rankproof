import AxeBuilder from "@axe-core/playwright";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/** WCAG 2.1 A/AA rules; any violation fails with its rule id and targets. */
async function audit(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const summary = result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(" "))
        .slice(0, 5)
        .join(" | ")}`,
  );
  expect(summary, summary.join("\n")).toEqual([]);
}

test.describe("Accessibility (axe, WCAG 2.1 AA)", () => {
  test("verify page, empty and with example results and an open receipt", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await audit(page);
    await page.getByRole("button", { name: "Show an example" }).click();
    await expect(page.getByRole("heading", { name: "6 links checked" })).toBeVisible();
    await page.getByRole("list", { name: "Verified pairs" }).getByRole("button").first().click();
    await expect(page.getByText("Observation receipt")).toBeVisible();
    await audit(page);
  });

  test("saved lists page and its form", async ({ page }) => {
    await page.goto("/monitors");
    await page.waitForLoadState("networkidle");
    await audit(page);
    await page.getByRole("button", { name: "New list" }).click();
    await expect(page.getByLabel("Name")).toBeVisible();
    await audit(page);
  });

  test("domain audit page", async ({ page }) => {
    await page.goto("/audit");
    await page.waitForLoadState("networkidle");
    await audit(page);
  });

  test("landing page (site/index.html)", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(pathToFileURL(`${process.cwd()}/site/index.html`).href);
    // Content that scrolls into view is revealed by script; reveal all of it.
    await page.evaluate(() =>
      document
        .querySelectorAll(".reveal")
        .forEach((e) => e.classList.add("in", "visible", "is-visible")),
    );
    await audit(page);
    await context.close();
  });
});
