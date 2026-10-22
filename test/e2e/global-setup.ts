/** E2E 全体の準備: テスト用画像フィクスチャを生成する */
import { ensureFixtures } from "./fixtures.ts";

export default async function globalSetup(): Promise<void> {
  ensureFixtures();
}
