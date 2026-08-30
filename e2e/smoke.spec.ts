import { expect, test } from "@playwright/test";

test.describe("RankProof UI smoke", () => {
  test("landing page loads with scan form and guide", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/RankProof/i);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "What you rank for",
    );
    await expect(page.getByLabel("Site address")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan" })).toBeVisible();
    await expect(page.getByLabel("How RankProof works")).toBeVisible();
    await expect(page.getByText("Thirteen open sources")).toBeVisible();
  });

  test("skip link reaches main content", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Skip to main content" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("market toggles update aria-pressed", async ({ page }) => {
    await page.goto("/");
    const us = page.getByRole("button", { name: "Market: USA" });
    await us.click();
    await expect(us).toHaveAttribute("aria-pressed", "true");
  });

  test("empty submit shows validation message", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByRole("alert")).toContainText("Enter a domain");
  });
});
