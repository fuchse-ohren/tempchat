# HANDOFF: テスト工程への引き継ぎ（プログラミング工程完了時点）

作成: 2026-10-22（プログラミング工程担当エージェント）
このファイルの目的: 新規セッションで **テスト工程** を実施するために必要な情報のみを凝縮する。

## 1. プロジェクト状況

- 工程: ①要件定義 ✅承認 ②設計 ✅承認 ③プログラミング ✅完了 ④**テスト ← これを実施**
- 各工程完了時はユーザ承認ゲートあり。テスト完了後も承認を得るまで工程完了としない。
- 仕様は `docs/requirements.md` **v1.2**（承認済み・変更禁止）と `docs/design.md` **v1.0**（承認済み）に準拠。
  - 重点箇所: 要件 §10 受け入れ基準10項目／設計 §10 テスト戦略／設計 §13 トレース表
- リポジトリ: /home/kali/Dev/tempchat（git 初期化済み。コミットは `-c user.email=dev@local -c user.name=dev`）

## 2. コードマップ（実装済み・型チェック3構成クリーン・ビルド成功済み）

```
src/shared/   constants.ts types.ts bytes.ts crypto.ts cbor.ts   ← client/sw/worker 共有
src/worker/   index.ts routes.ts dbなし(push.ts scheduled.ts util.ts env.ts)
src/client/   main.ts api.ts idb.ts image.ts notify.ts polling.ts theme.ts ui.ts
              views/create.ts views/join.ts views/chat.ts style.css
src/sw/       sw.ts
migrations/0001_init.sql / index.html(ルート) / public/(manifest,_headers,icons,theme-init.js)
tsconfig.json(client) tsconfig.worker.json tsconfig.sw.json
```

- API: `POST /api/rooms` `POST /api/rooms/:id/join` `GET|POST /api/rooms/:id/messages`
  `GET /api/rooms/:id/messages/:mid/data` `PUT|DELETE /api/rooms/:id/subscription` `GET /api/vapid`
- 認証ヘッダ `x-room-auth: hex64`（=SHA-256(K_R‖PIN)、定数時間比較）
- 暗号: HKDF-SHA-256(ikm=K_R, salt=PIN, info="tempchat-msg-v1:"+ts)→AES-256-GCM、ct=IV(12B)‖密文‖tag、**AAD=String(ts)**（src/shared/crypto.ts）
- CBOR: cbor2（plain object↔map。decode は object になる）。スキーマは src/shared/cbor.ts（v/id/kind/name/ts/body）
- DB: rooms/messages/messages_blobs(画像を48KiBチャンク)/push_subs

## 3. この環境の実運用ハック（必須知識）

- **npm**: `~/.npm` が読み取り専用。`npm install --cache /home/kali/Dev/tempchat/.npm-cache` を使う。
  esbuild/workerd は postinstall 承認済み（未承認時は `npm install-scripts approve esbuild workerd && npm rebuild`）。
- **wrangler は HOME 退避が必須**（既定の ~/.config 書込で ENOENT 落ちする）:
  `HOME=$PWD/.home XDG_CONFIG_HOME=$PWD/.home/.config XDG_CACHE_HOME=$PWD/.home/.cache npx wrangler ...`
  （.home/ は gitignore 済み、作成済み）
- `.dev.vars` に VAPID 開発鍵あり（push 実配信の検証は対象外）。
- **/tmp は呼び出しごとに消える**。永続化はワークスペース内のみ。
- 開発サーバ: `wrangler dev --local --port 8787` を run_in_background で起動（起動に数秒）。
- ローカルD1: `wrangler d1 migrations apply tempchat --local`（適用済み）。
  クエリは `wrangler d1 execute tempchat --local --json --command "..."`（**1コマンド1ステートメントが無劣化**。複数文は失敗が握り潰されることがある）。
- **cron 手動発火**: `curl http://localhost:8787/cdn-cgi/local/scheduled`
- ビルド: `npx vite build`（app）→ **必ず続けて** `npx vite build --config vite.sw.config.ts`（1段目が dist を空にするため sw.js が消える）。
  wrangler dev は dist/client を assets にする。**E2E 前に両ビルドが必要**。

## 4. プログラミング工程でスモーク検証済み（再検証は不要、回帰確認程度）

- A1〜A8 のステータスコード（201/400/403/404/413/204）、ct上限・body192KB上限
- 画像100KB → チャンク保存 → data API でバイト一致（D1の100KBステートメント制限回避設計は実働確認済）
- Cron境界: 受信8日経過メッセージ削除／最終メッセージ31日経過ルームまるごと削除／正常データ保持
- CSP・Referrer-Policy ヘッダ、SPAフォールバック（`/<uuid>`→index.html）
- PWAアイコンは生成バグ修正済み（不透明率0.82）

## 5. テスト工程の依頼事項（設計 §10 準拠）

1. **単体（node環境 Vitest）**: shared/crypto（既知ベクター回帰・AAD改ざん検知・IV一意性）、shared/cbor（スキーマ境界: 名前20字・本文400字・kind・mime）、shared/bytes（base64/b64url/hex の往復と不正入力 null）
2. **Worker統合（@cloudflare/vitest-pool-workers 0.23 + vitest 4）**: 認証境界（403/404）、サイズ413、ページネーション(after/limit)、チャンク往復、purge境界（時刻注入）、**DBに平文・K_R・PINが混入しない監査（受け入れ基準3）**、push は `web-push` を vi.mock して送信件数・TTL・404/410削除を验证
3. **E2E（@playwright/test 1.64。`npx playwright install chromium firefox` 必要かも。ブラウザ未導入なら要確認）**:
   - webServer: `wrangler dev --local --port 8787`（E2E前にビルド2種＋マイグレーション＋初期D1クリーン）
   - 2コンテキストで: ルーム作成→招待リンク表示→誤PIN拒否→正PIN参加→双方向テキスト疎通(≤5s+余裕)→画像送信(実PNG注入→webp化受信)→リロード後IndexedDBから再表示→ダークモード維持
   - D1検証は上記の wrangler d1 execute（--local。dev サーバと同じ `.wrangler/state` を共有すること。`--persist-to` をずらすと別DBになる罠）
4. **プッシュ実機のみ手動**: `docs/manual-push-checklist.md` を起票（Chrome desktop/Android、iOS Safari 16.4+ PWA、自送信スキップ、画像汎用通知、タップ遷移）
5. 結果は **`docs/test-report.md`**（受け入れ基準10項目×合否×自動/手動、発見バグと修正、既知の制限）にまとめ、テスト後にユーザ承認を得る。
6. テストで見つかったバグは実装を修正してよいが、**仕様（要件v1.2/設計v1.0）から逸脱しない**こと。逸脱が必要な場合はユーザに確認する。

## 6. 実装時の既知の注意点（テスト作成の助けに）

- TS 5.9 + WebCrypto: `Uint8Array<ArrayBuffer>` 汎用に統一済み（bytes.ts 参照）。テストでも `TextEncoder().encode` を直接 WebCrypto に渡すと型エラーになり得る（utf8() を使うこと）
- `views/` からの共有モジュール相対パスは `../../shared/...`
- D1 の BLOB 読み出しは ArrayBuffer/Uint8Array 混在 → 常に `toBytes()` 経由
- `sendPush` は購読ゼロなら即 return（E2Eで network 試行なし。購読PUT済みにすると web-push がネットワーク試行するのでE2Eでは購読を作らない or fetchモック）
- ポーリングは `document.visibilityState==="visible"` のみ（Playwright のバックグラウンドタブは非可視扱い）
- 通知許可は `context.grantPermissions(["notifications"])` 可能だが Push 実配信は行われない（設計上、通知ロジックは手動検証で確定済み。E2Eでは「アプリが壊れないこと」まで）
- Free枠・コストの検証は不要（ローカル）
- ポート: dev 8787（E2E webServer にも同じポートを使うこと）

## 7. コマンド早見

```bash
export HOME=$PWD/.home XDG_CONFIG_HOME=$PWD/.home/.config XDG_CACHE_HOME=$PWD/.home/.cache
npm run build && npx vite build --config vite.sw.config.ts   # dist/client に index.html と sw.js の両方
npx wrangler d1 migrations apply tempchat --local
npx wrangler dev --local --port 8787                          # 別セッション/background
npx vitest run                                                # 単体+worker（vitest プロジェクト設定を新規作成すること）
npx playwright test
```

（vitest のプロジェクト分割: `vitest.config.ts` に node project と cloudflare project。cloudflare 側は `@cloudflare/vitest-pool-workers` preset + `wrangler.toml` を読む設定。D1バインディングは Miniflare 起動オプションで migrations を自動適用可能）
