import { defineConfig, devices } from "@playwright/test";

const webServerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      key !== "INNGEST_EVENT_KEY" &&
      key !== "INNGEST_SIGNING_KEY" &&
      value !== undefined,
  ),
) as Record<string, string>;
webServerEnv.INNGEST_DEV = "1";

export default defineConfig({
  testDir: "./tests/journeys",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: process.env.CI ? "pnpm build && pnpm start" : "pnpm dev",
    env: webServerEnv,
    url: "http://localhost:3000/login",
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 180_000 : 60_000,
  },
});
