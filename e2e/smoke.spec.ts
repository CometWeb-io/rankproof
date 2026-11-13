import { expect, test } from "@playwright/test";

test.describe("RankProof UI smoke", () => {
  test("verify page loads with the pairs input", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/RankProof/i);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("exactly as agreed");
    await expect(page.getByLabel("Links to check, one pair per line")).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify link" })).toBeVisible();
    await expect(page.getByText("Every link ends in one of four results")).toBeVisible();
    // The preview build runs without RANKPROOF_RENDER: the option explains how to enable it.
    await expect(page.getByText(/Browser check is off/)).toBeVisible();
  });

  test("the offline example renders the ledger, filters and evidence", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Show an example" }).click();
    await expect(page.getByRole("heading", { name: "6 links checked" })).toBeVisible();
    const ledger = page.getByRole("list", { name: "Verified pairs" });
    await expect(ledger.getByRole("listitem")).toHaveCount(6);
    await page
      .getByRole("button", { name: /Deviates/ })
      .first()
      .click();
    await expect(ledger.getByRole("listitem")).toHaveCount(1);
    await ledger.getByRole("button").first().click();
    await expect(page.getByText("Observation receipt")).toBeVisible();
  });

  test("example receipts show placement, mentions, history and search", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Show an example" }).click();
    const ledger = page.getByRole("list", { name: "Verified pairs" });
    await expect(ledger.getByText("Mentioned, not linked")).toHaveCount(1);
    await ledger.getByRole("listitem").first().getByRole("button").first().click();
    await expect(page.getByText("History in this browser (2 runs)")).toBeVisible();
    await expect(page.getByText(/For tide tables we keep the/)).toBeVisible();
    await page.getByPlaceholder("Search source, target or anchor").fill("kayak");
    // Count rows only: an open receipt contains lists of its own.
    await expect(ledger.locator(":scope > li")).toHaveCount(1);
    await page.getByPlaceholder("Search source, target or anchor").fill("");
    await page.getByLabel("Sort").selectOption("problems");
    await expect(ledger.locator(":scope > li").first()).toContainText("Not in HTML");
  });

  test("results copy as a Markdown table", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.getByRole("button", { name: "Show an example" }).click();
    await page.getByRole("button", { name: "Copy as Markdown" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("### RankProof: 2/6 links meet their contract");
    expect(copied).toContain("| Result | Source | Target | Note |");
  });

  test("pasting a table reports ready and skipped lines", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel("Links to check, one pair per line")
      .fill("https://a.example/x,https://b.example/\nnot a url,https://b.example/");
    await expect(page.getByText(/1 pair ready/)).toBeVisible();
    await expect(page.getByText(/line 2/)).toBeVisible();
  });

  test("empty verify shows a validation message", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Verify link" }).click();
    await expect(page.getByRole("alert")).toContainText("Paste at least one row");
  });

  test("skip link reaches main content", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Skip to main content" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("domain audit keeps its scan form and market toggles", async ({ page }) => {
    await page.goto("/audit");
    // Buttons only respond after hydration; on a cold server that can take a moment.
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Audit a whole domain");
    await expect(page.getByRole("link", { name: "Domain audit" })).toHaveAttribute(
      "data-status",
      "active",
    );
    await expect(page.getByLabel("Site address")).toBeVisible();
    const us = page.getByRole("button", { name: "US, market: USA" });
    await us.click();
    await expect(us).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByRole("alert")).toContainText("Enter a domain");
  });

  test("saved lists: save from the verify page, check on the server, compare, delete", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const name = `E2E list ${Date.now()}`;
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page
      .getByLabel("Links to check, one pair per line")
      .fill("https://publisher.invalid/post,https://brand.example/guide,Brand guide");
    await page.getByRole("button", { name: "Verify link" }).click();
    await expect(page.getByRole("heading", { name: "1 link checked" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Save as a list" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Saved lists" })).toBeVisible();
    await expect(page.getByLabel("Links, one pair per line")).toHaveValue(/publisher\.invalid/);
    await page.getByLabel("Name").fill(name);
    // Replace the handed-over table with an uploaded CSV of two pairs.
    await page.locator('input[type="file"]').setInputFiles({
      name: "links.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "source_url,target_url\nhttps://publisher.invalid/post,https://brand.example/guide\nhttps://blog.invalid/review,https://brand.example/\n",
      ),
    });
    await expect(page.getByText("2 pairs (up to 200 per list)")).toBeVisible();
    await page.getByLabel("Check automatically").selectOption("daily");
    await page.getByLabel("Tell me about changes (optional)").fill("http://hooks.example/x");
    await page.getByRole("button", { name: "Save list" }).click();
    await expect(page.getByRole("alert")).toContainText("https://");
    await page
      .getByLabel("Tell me about changes (optional)")
      .fill("https://hooks.example/services/T/B/x");
    await page.getByRole("button", { name: "Save list" }).click();
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    await expect(page.getByText("Not checked yet.")).toBeVisible();
    await expect(page.getByText("Every day · changes go to hooks.example")).toBeVisible();

    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText(/the first run of this list/)).toBeVisible({ timeout: 30_000 });
    const ledger = page.getByRole("list", { name: "Verified pairs" });
    await expect(ledger.locator(":scope > li")).toHaveCount(2);
    await page.getByPlaceholder("Search source, target or anchor").fill("blog.invalid");
    await expect(ledger.locator(":scope > li")).toHaveCount(1);
    await page.getByPlaceholder("Search source, target or anchor").fill("");
    const [json] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "JSON" }).click(),
    ]);
    expect(json.suggestedFilename()).toMatch(/^e2e-list-\d+-\d{4}-\d{2}-\d{2}\.json$/);

    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText(/, compared with /)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("group", { name: "Pick a run" }).getByRole("button")).toHaveCount(
      2,
    );

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete list and its runs" }).click();
    await expect(page.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
  });
});
