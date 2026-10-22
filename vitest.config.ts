import { defineConfig } from "vitest/config";

/**
 * Vitest ルート設定（設計 §10-1/-2、handoff §5-1/-2）
 * 2つのプロジェクトに分割する:
 *  - unit  : node 環境（shared/crypto・cbor・bytes の単体テスト）
 *  - worker: @cloudflare/vitest-pool-workers（Worker API 統合テスト / Miniflare D1）
 * E2E（Playwright）は vitest では実行しない（playwright.config.ts 参照）。
 */
export default defineConfig({
  test: {
    projects: ["./vitest.unit.config.ts", "./vitest.worker.config.ts"],
    reporters: process.env.CI ? ["default"] : ["default"],
    silent: "passed-only",
  },
});
