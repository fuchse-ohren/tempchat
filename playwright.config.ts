import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * E2E テスト設定（設計 §10-3 / handoff §5-3）
 *
 * 前提（handoff §3 の環境ハック。`npx playwright test` 前に必ず実施する）:
 *   1. `npm run build && npx vite build --config vite.sw.config.ts`（dist/client に index.html と sw.js の両方）
 *   2. `npx wrangler d1 migrations apply tempchat --local`
 *   3. wrangler は HOME 退避（.home）が必須
 * dev サーバは 8787 を使い、E2E の D1 検証も同じ .wrangler/state を共有する。
 */
const HOME = resolve(process.cwd(), ".home");
const PW_BROWSERS = resolve(HOME, ".cache/ms-playwright");
const LIBS = resolve(process.cwd(), ".tmp/deb/extract/usr/lib/x86_64-linux-gnu");

const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: process.env.HOME ?? HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? resolve(HOME, ".config"),
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? resolve(HOME, ".cache"),
  // このサンドボックスにはブラウザのシステムライブラリが無いため、
  // ワークスペースに展開した .so とブラウザ一式を明示する（docs/test-report.md 参照）
  ...(existsSync(PW_BROWSERS)
    ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? PW_BROWSERS }
    : {}),
  ...(existsSync(LIBS)
    ? { LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
    : {}),
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS:
    process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ?? "1",
};

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:8787",
    trace: "retain-on-failure",
    video: "off",
    launchOptions: { env },
  },
  webServer: {
    command: "npx wrangler dev --local --port 8787",
    url: "http://localhost:8787/api/vapid",
    env,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // FR-9.2 の対応ブラウザ確認用に Firefox も同じシナリオを流す
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
