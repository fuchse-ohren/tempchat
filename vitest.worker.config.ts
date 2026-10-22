import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * ワーカー統合テスト（設計 §10-2）
 *
 * 注意（docs/test-report.md 環境ハックに同じ）:
 *  @cloudflare/vitest-pool-workers@0.23 が同梱する workerd は 2026-08-15 版で、
 *  wrangler.toml の compatibility_date 2026-10-01 より古い。そのまま起動すると
 *  「requires compatibility date "2026-10-01"」で失敗するため、wrangler 側の
 *  新しめ workerd バイナリを明示して本番と同じ互換性日付で実行する。
 */
const NEWER_WORKERD = resolve(
  "node_modules/wrangler/node_modules/@cloudflare/workerd-linux-64/bin/workerd",
);
if (!process.env.MINIFLARE_WORKERD_PATH && existsSync(NEWER_WORKERD)) {
  process.env.MINIFLARE_WORKERD_PATH = NEWER_WORKERD;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: {
          DB: { id: "00000000-0000-0000-0000-000000000000" },
        },
        bindings: {
          // 開発用ダミー VAPID 鍵（push は web-push をモックして検証するため
          // 実配信は行わない。送信経路の分岐を通すため値自体は設定する）
          VAPID_PUBLIC_KEY:
            "BK91HME1rndpKJ5lPxqY6DpLhcVKj2ExzXfr3S0mJBGv_ZDcV" +
            "M0cK0J0XWDLfV1hK2Wj7H0EQbBBQG9ZK0AbcDE",
          VAPID_PRIVATE_KEY: "dev-only-private-key",
          VAPID_SUBJECT: "mailto:test@example.com",
        },
      },
    }),
  ],
  test: {
    name: "worker",
    include: ["test/worker/**/*.test.ts"],
    // Miniflare ワーカーを共有するためファイルを直列実行する
    fileParallelism: false,
  },
});
