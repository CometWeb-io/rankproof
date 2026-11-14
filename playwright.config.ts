import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.RANKPROOF_E2E_URL ?? "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  // Locally the preview server starts on its own too (run `npm run build` first);
  // an already running one on 4173 is reused. RANKPROOF_E2E_URL skips it.
  webServer: process.env.RANKPROOF_E2E_URL
    ? undefined
    : {
        command: "npm run preview -- --port 4173 --host 127.0.0.1",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
