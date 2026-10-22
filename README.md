# tempchat

ブラウザ完結で使える、ルーム型の **エンドツーエンド暗号化（E2EE）一時チャット**。
アカウント登録もアプリインストールも不要で、**招待リンク（ルーム鍵入り）と PIN** だけで参加できます。

- クラウド（Cloudflare）は **暗号文と最小限のメタデータのみ** を中継・一時保管します。メッセージ本文・表示名・画像・ルーム鍵 `K_R`・PIN 平文をサーバが知り得ることはありません。
- サーバ側のメッセージは **受信から 7 日**、ルームは **最終メッセージから 30 日** で自動削除（Cron Triggers）。
- ページ表示中は 5 秒ポーリング、非表示・閉鎖中は **Web プッシュ通知**（テキストは鍵で復号して本文まで表示）。
- PWA 対応・ダークモード・画像（WebP）送受信。Cloudflare **Free プラン**で運用可能な規模が前提。

## 使い方（概要）

1. **ホスト**がブラウザで表示名・ルーム鍵 `K_R`（32 バイト乱数を自動生成）・PIN（6〜12 桁）を作成し、ルームを作成します。
2. 招待リンク `<URL>/<ルームID>#<K_R>` が生成されるので、ゲストに送ります（PIN はリンクとは別経路で共有）。
3. ゲストはリンクを開いて PIN を入力して参加します。`#` より後ろ（`K_R`）はブラウザからサーバに送信されません。
4. 参加後はメッセージを送受信。途中参加でも保持期間内の過去メッセージを遡及閲覧できます。同一ブラウザでは PIN 再入力は不要です。

## セキュリティ仕様（要約）

| 項目 | 仕様 |
| --- | --- |
| 対称暗号 | AES-256-GCM（IV 12 バイトランダム、改ざん検知込み） |
| 鍵導出 | HKDF-SHA-256: `IKM=K_R`, `salt=PIN`, `info="tempchat-msg-v1:"+ts` → メッセージごとに導出 |
| ルーム認証 | `X-Room-Auth: SHA-256(K_R‖PIN)`（hex64）。サーバは定数時間比較。セッション発行なし・毎回照合 |
| メッセージ形式 | CBOR（`v`/`id`/`kind`/`name`/`ts`/`body`）全体を暗号化。サーバは内部を一切参照できない |
| AAD | `String(ts)` を GCM AAD に含め、平文タイムスタンプと暗号文をバインド |

サーバが知り得るのは、ルーム ID・ルーム認証ハッシュ・タイムスタンプ・種別（text/image）・暗号文長・送受信時刻・プッシュエンドポイントURL のみです。
なりすまし抑止・PIN へのレート制限・前向きの秘匿性などは対象外です（免責事項を含む詳細は [docs/requirements.md](docs/requirements.md) §5）。

## アーキテクチャ

```
┌─ ブラウザ（ホスト/ゲスト共通） ─────────────────────────────┐
│ UI (Vanilla TS SPA)          Service Worker                │
│  ├ 作成 / 参加(PIN) / チャット  ├ push イベント受信・復号     │
│  ├ 暗号化/CBOR生成             ├ 通知表示・タップ遷移        │
│  ├ 5sポーリング(可視中)         └ WebPush購読                │
│  └ IndexedDB (鍵・PIN・メッセージ)                            │
└──────────────┬───────────────────────────▲─────────────────┘
               │ HTTPS (JSON)               │ Web Push (VAPID)
┌──────────────▼───────────────────────────┴─────────────────┐
│ Cloudflare Workers（単一Worker + Static Assets）            │
│  ├ /api/* ルータ（バインド: D1, VAPIDシークレット）          │
│  ├ メッセージ受信 → D1保存 → push配信(waitUntil)             │
│  └ Scheduled (cron */30m): 期限切れメッセージ・ルーム削除     │
│ D1: rooms / messages / message_blobs / push_subs            │
└─────────────────────────────────────────────────────────────┘
```

### API（ベースパス `/api`）

| Method/Path | 認証 | 用途 |
| --- | --- | --- |
| `GET /vapid` | 不要 | VAPID 公開鍵の取得 |
| `POST /rooms` | 不要 | ルーム作成（`{keyHash}` のみ送信、UUID 発行） |
| `POST /rooms/:id/join` | X-Room-Auth | PIN 照合（毎回） |
| `GET /POST /rooms/:id/messages` | X-Room-Auth | 差分取得（`after`/`limit=50`）／暗号文送信 |
| `GET /rooms/:id/messages/:mid/data` | X-Room-Auth | 画像暗号文の遅延取得（チャンク結合） |
| `PUT /DELETE /rooms/:id/subscription` | X-Room-Auth | プッシュ購読の upsert／削除 |

## 技術スタック

| 領域 | 採用 |
| --- | --- |
| ホスティング | Cloudflare Workers + D1 + Cron Triggers + Static Assets（`nodejs_compat`） |
| クライアント | Vanilla TypeScript + Vite 7（フレームワーク不使用）、CSS 変数によるライト/ダークテーマ |
| CBOR | [`cbor2`](https://www.npmjs.com/package/cbor2)（純 JS・クライアント/SW/Worker 共通コード） |
| 暗号 | WebCrypto のみ（`src/shared/crypto.ts`） |
| プッシュ配信 | VAPID 鍵 + `web-push`ライブラリ（Worker から `waitUntil` で配信） |
| テスト | Vitest（unit: node / worker: `@cloudflare/vitest-pool-workers` + Miniflare D1）+ Playwright（Chromium/Firefox E2E） |

## リポジトリ構成

```
tempchat/
├── index.html               # SPA エントリ
├── wrangler.toml            # Worker + Assets + D1 + cron 定義
├── migrations/0001_init.sql # D1 マイグレーション
├── public/                  # manifest・アイコン・_headers(CSP等)・robots.txt
├── src/
│   ├── shared/   constants / types / bytes / crypto / cbor   # クライアント・SW・Worker 共有
│   ├── client/   main / api / idb / image / notify / polling / theme / ui・views(作成/参加/チャット)
│   ├── sw/       sw.ts（プッシュ受信・通知表示）
│   └── worker/   index / routes / push / scheduled / util / env
├── test/
│   ├── unit/     暗号・CBOR・バイトユーティリティ（node）
│   ├── worker/   API 統合・認証・purge・push・平文混入監査（Miniflare）
│   └── e2e/      Playwright（2 コンテキストでホスト/ゲスト疎通）
└── docs/         要件定義 / 設計 / テスト報告 / 手動チェックリスト
```

## 動作要件

- Node.js 24 系 + npm 11 系での動作を確認（wrangler / vitest / Playwright は devDependencies 参照）
- Cloudflare アカウント（デプロイ時。ローカル開発は `wrangler dev --local` のみで可）
- 対応ブラウザ: 最新 2 バージョンの Chrome / Firefox / Edge / Safari、Android Chrome、iOS Safari 16.4+

## ローカル開発

```bash
npm install

# 1. VAPID 鍵を生成してローカル環境変数に登録
npm run vapid:gen            # 出力を .dev.vars に貼る
cp .dev.vars.example .dev.vars   # 未作成の場合（鍵のキー名は同ファイル参照）

# 2. ローカル D1 にマイグレーション適用
npm run db:migrate:local

# 3. 開発サーバ起動（API: :8787 / Web: :5173、/api は 8787 へプロキシ）
npm run build                # 静的資産 + Service Worker の 2 種ビルド
npm run dev
```

> `npm run dev` で API（`wrangler dev --local --port 8787`）と Web（Vite dev server）を並列起動します。
> Service Worker / プッシュの検証は `npm run preview`（:8787 で SPA+API を同一オリジン配信）で行ってください。

### コマンド一覧

| Command | 内容 |
| --- | --- |
| `npm run dev` | API + Web 開発サーバを並列起動 |
| `npm run dev:api` / `dev:web` | 個別起動 |
| `npm run build` | 本番ビルド（`dist/client` に SPA + `sw.js`） |
| `npm run preview` | `wrangler dev --local`（ビルド済み資産を同一オリジンで確認） |
| `npm run typecheck` | TypeScript 型検査（client / worker / sw の 3 設定） |
| `npm run db:migrate:local` / `db:migrate:remote` | D1 マイグレーション適用 |
| `npm test` | 単体 + Worker 統合テスト（Vitest） |
| `npm run test:e2e` | Playwright E2E（事前にビルド 2 種・マイグレーション・:8787 の dev サーバが必要） |
| `npm run vapid:gen` | VAPID 鍵ペア生成 |

### テスト

```bash
npm test                       # unit(61) + worker(79) — すべてローカル完結
npx vitest run --project unit  # 単体のみ
npx vitest run --project worker

# E2E はこの順番が必須（sw.js が 404 になるためビルドを省略しない）
npm run build
npm run db:migrate:local
npm run dev:api &              # :8787（Playwright の webServer は既存の 8787 を再利用）
npm run test:e2e
```

結果サマリは [docs/test-report.md](docs/test-report.md)（自動 192 件 / 失敗 0、実機プッシュのみ [手動チェックリスト](docs/manual-push-checklist.md)）。

## デプロイ（Cloudflare）

```bash
npm run build
npx wrangler d1 create tempchat            # 発行された database_id を wrangler.toml へ
npx wrangler d1 migrations apply tempchat --remote
npx web-push generate-vapid-keys --json
npx wrangler secret put VAPID_PUBLIC_KEY   # 残り VAPID_PRIVATE_KEY / VAPID_SUBJECT も同様に
npx wrangler deploy
```

`https://tempchat.<サブドメイン>.workers.dev` に配信されます（Free プラン想定）。

## 既知の制限

- iOS Safari のプッシュ通知は「ホーム画面に追加」（PWA インストール）時のみ（OS 制約）。
- 送信側デバイスの時計ずれにより、メッセージの表示順が前後することがあります（クライアントのタイムスタンプ基準のため意図した設計）。
- ルーム鍵・PIN は通知復号のため同一ブラウザ内に平文保存されます。端末紛失・マルウェア対策は対象外。
- 同一鍵・PIN 保持者によるなりすまし、PIN 総当たりへのレート制限は実装していません（免責事項）。

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [docs/requirements.md](docs/requirements.md) | 要件定義 v1.2（機能要件・暗号仕様・受け入れ基準） |
| [docs/design.md](docs/design.md) | 設計 v1.0（スキーマ・API・暗号フロー・テスト戦略） |
| [docs/test-report.md](docs/test-report.md) | テスト報告（受け入れ基準 10 項目の合否） |
| [docs/manual-push-checklist.md](docs/manual-push-checklist.md) | プッシュ通知 実機確認チェックリスト |
| [docs/handoff.md](docs/handoff.md) | 工程引き継ぎ（環境ハック含む） |

## ライセンス

[WTFPL 2.0](LICENSE) — Copyright (C) 2026 fuchse-ohren
