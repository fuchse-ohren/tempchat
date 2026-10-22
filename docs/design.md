# 一時チャットアプリ 設計書（Design）

- 版数: v1.0（承認待ち）
- 日付: 2026-10-22
- 準拠: `docs/requirements.md` v1.2
- 本書: 設計工程の成果物。根拠となるプラットフォーム調査は §12 に実測値として記録

---

## 1. アーキテクチャ概要

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
│  │    POST作成 / 参加照合 / 送信 / 差分取得 / 画像取得 / 購読 │
│  ├ メッセージ受信 → D1保存 → push配信(waitUntil)             │
│  └ Scheduled (cron */30m): 期限切れメッセージ・ルーム削除     │
│ D1: rooms / messages / message_blobs / push_subs            │
└─────────────────────────────────────────────────────────────┘
```

- サーバは暗号文・平文メタデータ（時刻・種別・長さ・購読先）のみ保持。鍵・PIN・平文本文・表示名に触れない（SEC-1/SEC-2）。
- 単一 Worker に API・push配信・cron を集約。静的資産（SPA・SW・manifest・アイコン）は同 Worker の Static Assets から配信（同一オリジン要件＝SW/push制約も満たす）。

## 2. 技術スタック（決定）

| 領域 | 選定 | 理由 |
| --- | --- | --- |
| 実行環境 | Cloudflare Workers（`compatibility_flags=["nodejs_compat"]`）+ D1 + Cron Triggers + Static Assets | 要件 NFR-2。push専用バインディングは無いため web-push を nodejs_compat で動作させる（§12） |
| API実装 | 依存なしの素の `fetch` ハンドラ＋自作マイクロルータ | 7エンドポイントのみ。フレームワーク非採用で監査面を最小化 |
| CBOR | `cbor2@2.x`（純JS・依存は wtf8 のみ・型定義同梱） | ブラウザ/SW/Worker 同一コードで動作。ブラウザ向けに `cbor` (Buffer依存) は避ける |
| クライアント | Vanilla TypeScript + Vite（`vite@7`系） | 承認済み方針。画面3種で状態管理は素の状態で十分 |
| CSS | 素のCSS + CSSカスタムプロパティでのlight/darkテーマ | 承認済み方針 |
| プッシュ送信 | `web-push` ライブラリ + VAPID鍵3種を wrangler secret | 現行公式手順（§12） |
| テスト | Vitest（unit: node環境 / worker: `@cloudflare/vitest-pool-workers`）＋ Playwright（Chromium/Firefox） | 承認済み方針。push実端末着信のみ手動チェックリスト（§10） |
| ビルド | `vite build`（アプリ＋SWの2ビルド）→ `dist/client`。Worker は wrangler が直接 `src/worker/index.ts` をバンドル | 実装簡素化 |

## 3. リポジトリ構成

```
tempchat/
├── package.json / tsconfig.json / vite.config.ts
├── wrangler.toml              # Worker+Assets+D1+cron 定義
├── migrations/0001_init.sql   # D1マイグレーション
├── public/                    # vite public（ビルドで dist/client に同梱）
│   ├── manifest.webmanifest / icon-192.png / icon-512.png
│   ├── _headers               # CSP等のレスポンスヘッダ（Assets機能）
│   └── robots.txt             # Disallow: /
├── src/
│   ├── index.html
│   ├── shared/    constants.ts types.ts cbor.ts crypto.ts   # クライアント/SW共有（Worker は constants のみ）
│   ├── client/    main.ts api.ts idb.ts notify.ts image.ts polling.ts theme.ts
│   │              views/create.ts views/join.ts views/chat.ts
│   ├── sw/        sw.ts
│   └── worker/    index.ts routes.ts db.ts push.ts validate.ts
└── test/
    ├── unit/      crypto.test.ts cbor.test.ts validate.test.ts   # node環境
    ├── worker/    api.test.ts auth.test.ts purge.test.ts push.test.ts  # vitest-pool-workers
    └── e2e/       room.spec.ts pin.spec.ts chat.spec.ts image.spec.ts theme.spec.ts
```

## 4. データ設計（D1）

### 4.1 スキーマ（`migrations/0001_init.sql`）

```sql
CREATE TABLE rooms (
  id           TEXT PRIMARY KEY,            -- UUID v4（サーバ発行）
  key_hash     BLOB NOT NULL,               -- SHA-256(K_R‖PIN) 32B。平文鍵・PINは一切保持しない（受入基準3）
  created_at   INTEGER NOT NULL,            -- epoch ms
  last_msg_at  INTEGER                      -- 最終メッセージ時刻（30日判定）
);

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 行ID（FR-3.6 の二重表示排除キー・pushのid）
  room_id      TEXT NOT NULL,
  ts           INTEGER NOT NULL,            -- 送信者タイムスタンプ（平文メタデータ・鍵導出）
  kind         TEXT NOT NULL CHECK (kind IN ('text','image')),  -- 平文メタデータ（FR-3.4）
  ct           BLOB,                        -- 平文メタデータなし: IV(12B)‖AES-GCM暗号文+tag。textのみインライン
  received_at  INTEGER NOT NULL             -- サーバ受信時刻（7日判定・内部管理用）
);
CREATE INDEX idx_messages_room ON messages(room_id, id);

CREATE TABLE message_blobs (                 -- 画像暗号文のチャンク（D1 100KBステートメント制限回避。§12）
  msg_id  INTEGER NOT NULL,
  seq     INTEGER NOT NULL,                  -- 0..N（チャンク48KiB）
  chunk   BLOB NOT NULL,
  PRIMARY KEY (msg_id, seq)
);

CREATE TABLE push_subs (
  endpoint   TEXT PRIMARY KEY,               -- プッシュエンドポイント（プッシュプロバイダURL）
  room_id    TEXT NOT NULL,
  p256dh     TEXT NOT NULL,                  -- base64（P-256公開鍵）
  auth       TEXT NOT NULL,                  -- base64（認証シークレット）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_push_room ON push_subs(room_id);
```

- 外部キー制約は使わない（D1のデフォルトforeign_keys OFFに依存せず、削除はcronの明示SQLで整合させる）。
- `ct` にIV/タグを含めるため追加列なし。暗号文の長さは `length(ct)` でメタデータ要件（暗号文長）に該当するが、列としては持たない。

### 4.2 サイズ上限（サーバ強制値）

| 項目 | 上限 | 根拠 |
| --- | --- | --- |
| API JSONボディ全体 | 192KB | 画像b64 136KB＋余裕 |
| text の `ct`（base64前のバイト長） | 4,096B | 本文400文字(UTF-8×3)+name+UUID+CBOR/IV/tag 実測約1.5KB＋余裕 |
| image の `ct`（同） | 139,264B (136KiB) | 画像バイナリ96KB→b64 128KiB＋CBOR/IV/tag 余裕 |
| `message_blobs` チャンク | 49,152B (48KiB) | b64化で約64KiB → 100KBステートメント制限内 |
| 1ルーム購読数 | 20（超過は最古を削除） | push数Free枠保護 |
| 一覧ページサイズ | 50件（既定50・最大50） | 応答≈50×1.5KB≒75KB |

### 4.3 クライアント IndexedDB

DB名 `tempchat`（version 1）。

| store | keyPath | 内容 |
| --- | --- | --- |
| `rooms` | `roomId` | `{ roomId, kr: ArrayBuffer(32B), pin: string, name: string, createdAt, lastId: number, sentIds: number[](直近200), pushEndpoint?: string }` |
| `messages` | `["roomId","rowid"]` | `{ roomId, rowid, ts, kind, name, text?, image?: { mime:"image/webp", bytes: ArrayBuffer, fileName }, receivedAt }`（復号成功分のみ＝FR-4.2） |

- ダークモード選択のみ `localStorage.theme`（`light|dark|auto` 既定 auto）。その他は全件 IndexedDB（FR-7.1）。
- `rooms.kr/pin` は通知復号のための平文保存（SEC制約3・前提4）。

## 5. API仕様

- ベースパス `/api`。リクエスト/レスポンス JSON（UTF-8）。
- ルーム認証: 作成/購読系以外すべてヘッダ **`X-Room-Auth: <hex64>`**（= `H(K_R‖PIN)`）を要求し、サーバは `rooms.key_hash` と**定数時間比較**（FR-1.4/FR-4.3）。不一致 403、ルーム消滅 404。
- 共通エラー: `{"error": "<code>"}`（`bad_request` / `unauthorized_room` / `not_found` / `too_large` / `internal`）。ステータス 400/403/404/413/500。成功は下表。
- サーバの入力検査はエンベロープのみ（鍵を持たないためCBOR内部は検査不能。免責3の「CBOR形式チェック」は「受信した暗号文の中身には一切干渉しない」の等価解釈として、フィールド型・列挙・長さの検査で実現する）。

| # | Method/Path | 認証 | リクエスト | 成功 | 備考 |
| --- | --- | --- | --- | --- | --- |
| A1 | `GET /api/vapid` | 不要 | – | 200 `{publicKey}` | VAPID公開鍵 |
| A2 | `POST /api/rooms` | 不要 | `{keyHash: hex64}` | 201 `{roomId}` | FR-1.3。UUID v4発行 |
| A3 | `POST /api/rooms/:id/join` | X-Room-Auth | `{}` | 200 `{ok:true}` | FR-2.2。毎回照合（セッション発行なし） |
| A4 | `POST /api/rooms/:id/messages` | X-Room-Auth | `{ts:int, kind:"text"\|"image", ct: base64string}` | 201 `{id}` | ts は `1e12 ≤ ts ≤ now+86400s`、ct は §4.2 上限内。画像はチャンク分割INSERTを`db.batch()`で実行。`rooms.last_msg_at` も同batchで更新。§6.4 のpushを `waitUntil` |
| A5 | `GET /api/rooms/:id/messages?after=<rowid>&limit=50` | X-Room-Auth | – | 200 `{messages:[{id, ts, kind, ct?}]}` | `id > after` 昇順（=受信順。同一tsの並べ替え＝FR-3.5）。text のみ `ct`(b64) インライン、image は ct なし（A6で遅延取得） |
| A6 | `GET /api/rooms/:id/messages/:mid/data` | X-Room-Auth | – | 200 `{ct}` (b64) | 画像暗号文のチャンク結合。text/他ルームは 404 |
| A7 | `PUT /api/rooms/:id/subscription` | X-Room-Auth | `{endpoint, p256dh, auth}` | 204 | upsert（endpoint主キー）。ルーム購読20件超過で最古削除（FR-6.1） |
| A8 | `DELETE /api/rooms/:id/subscription` | X-Room-Auth | `{endpoint}` | 204 | 旧endpoint失効時のクライアント主導削除 |

## 6. 暗号・メッセージフロー（詳細）

### 6.1 共通プリミティブ（`shared/crypto.ts`、WebCrypto のみ使用）

```ts
roomAuthHash(kr: ArrayBuffer, pin: string): Promise<string>   // hex64 = SHA-256(kr ‖ utf8(pin))
deriveMsgKey(kr: ArrayBuffer, pin: string, ts: number): Promise<CryptoKey>
// HKDF-SHA-256: importKey(kr) → deriveKey {salt: utf8(pin), info: utf8("tempchat-msg-v1:" + ts), length: 256, AES-GCM}
encryptMsg(key, cbor: Uint8Array): Promise<Uint8Array>        // iv=random12B; 戻り値 = iv ‖ GCM密文‖tag; AAD = utf8(String(ts))
decryptMsg(key, blob: Uint8Array, ts): Promise<Uint8Array>    // 逆。GCMタグ不一致・CBORスキーマ不整合は throw（FR-4.2）
```

- AAD に `ts` を含め、平文メタデータ `ts` と暗号文の結合（バインディング）を担保（ts 入れ替え改ざんを GCM で検知）。
- 鍵導出の info は要件 SEC-1 の `"tempchat-msg-v1" ‖ ts` と一致。IVは1メッセージ1乱数（FR・SEC-1）。
- 双方のブラウザが同一実装（共有モジュール）のため相互運用リスクなし。テストは §10-1 で既知ベクタ＋ラウンドトリップを検証。

### 6.2 CBOR スキーマ v1（`shared/cbor.ts`。全体を暗号化する対象＝FR-3.2/3.3）

```cbor
{
  "v": 1,                       ; uint   プロトコルバージョン
  "id": "0193...uuid-v4",       ; tstring メッセージUUID（サーバには渡らない）
  "kind": "text" | "image",     ; tstring
  "name": "さくら",              ; tstring 1〜20文字（符号付き長制限はクライアント検証＋デコード時検証）
  "ts": 1766456400000,          ; uint   送信者タイムスタンプ（ms）
  "body": ...                   ; kind=text  → tstring（1〜400文字）
                                ; kind=image → { "d": tstring(base64画像), "m": "image/webp", "n": tstring(ファイル名1..64文字) }
}
```

- デコード時に型・長・文字数（20/400）を検証。違反は例外→そのメッセージは破棄（FR-4.2）。
- `encode` はデフォルトマップエンコーディング（決定性は要求しない。受信側が任意順デコード対応）。

### 6.3 送信（ブラウザ→サーバ）

1. CBOR生成（`cbor.ts`）→ `ts = Date.now()` → 鍵導出 → 暗号化（6.1）。
2. `POST A4 {ts, kind, ct: base64(iv‖密文‖tag)}`。
3. 201 応答 `{id}` → 楽観表示中のpendingメッセージを行IDで確定し、`sentIds` に `id` を追記（FR-3.6 送信側二重表示防止）。
4. 失敗時は pending を「送信失敗」表示（自動再送せず、手で再送＝再送重複はFR-3.6で許容済み）。

### 6.4 受信（ポーリング・初期取得共通）

1. 可視中のみ5秒間隔（`document.visibilityState`。復帰時に即時実行）（FR-4.1）。
2. `GET A5 after=lastId limit=50` を1件未満になるまで反復（ページネーション規約＝残存課題6の解）。
3. 各行: `id ∈ sentIds` なら表示済みとしてスキップ → 鍵導出(ts)→復号→CBOR検証→IndexedDBへ upsert → `lastId = max(id)`。
4. 画像は `ct` 不在のため、表示時に `GET A6` で遅延取得し復号（取得失敗時は再取得ボタン）。
5. 並び表示は `(ts 昇順, id 昇順)`（FR-3.5: 同一tsは受信順）。

### 6.5 プッシュ通知

**送信（Worker, A4 成功後 ctx.waitUntil）:**
1. `SELECT * FROM push_subs WHERE room_id=? LIMIT 20`。
2. ペイロード生成（4KB制限対策。要件 制約2）:
   `p = JSON {v:1, roomId, id, ts, kind, ct?}`（`ct` は text かつ **raw ct ≤ 3,900B** のときのみ。超過は `ct` を落として汎用化）
3. `web-push` で各購読へ送信（TTL 3600秒、`vapid` はシークレット3種）。
4. 404/410 レスポンスの購読は `DELETE`（FR-6.6）。その他エラーは握りつぶす（ログはステータスコードのみ。平文・鍵を出さない＝NFR-8）。

**受信（Service Worker）:**
1. `push` イベント → payload JSON パース失敗/フィールド欠損時は何もしない。
2. IndexedDB `rooms[roomId]` 取得不能（このブラウザが参加していない/消去済み）→ 通知せず終了。
3. `id ∈ rooms.sentIds`（自分自身の送信）→ 通知しない。
4. `kind=="text" && ct` → `ct` を鍵導出(ts)で復号・CBOR検証 → `showNotification(送信者名, { body: 本文 })`（FR-6.2）。復号検証失敗は「メッセージが届きました」の汎用通知にフォールバック（送信者名も復号出来ていないためタイトルはアプリ名）。
5. `kind=="image"`（ct無し）→ 「📷 画像メッセージが届きました」（FR-6.3）。
6. `notificationclick` → 該当ルームのタブがあれば focus、なければ `openWindow("/"+roomId+"#"+KRフラグメントは通知から失くせない→IDBの鍵のみで参加済み扱い)`（FR-6.5）。`tag` で同一メッセージの重複通知を防ぐ。

### 6.6 鍵・PINのライフサイクル（FR-1.5 / FR-2.2「招待時は毎回」）

| 局面 | 動作 |
| --- | --- |
| 作成成功 | `K_R/PIN/表示名` をIDB `rooms` に保存し以後不要（ホスト） |
| 招待リンクを**新しいコンテキスト**で開く | フラグメントから `K_R` 復元。IDBに当該roomIdの鍵なし → **毎回PIN入力要求**。入力→A3照合→保存→以後そのブラウザは不要 |
| 参加済みブラウザの再訪 | IDBの鍵で即チャット表示（PIN不要） |
| サイトデータ削除 | 全消失→参加画面からPIN再入力 |

## 7. クライアントUI設計

### 7.1 画面とルーティング（History API なしの簡素ルータ）

| URL | 画面 |
| --- | --- |
| `/` | 作成画面: 表示名 / `K_R`自動生成（base64url表示・再生成可）/ PIN自動生成6桁（6〜12手入力可・再生成可）/ 作成ボタン |
| `/<uuid>`（鍵なし） | 参加画面: ルーム名（なし）/ PIN入力 / 参加ボタン（A3）/ エラー表示（403=PIN誤、404=ルーム無） |
| `/<uuid>`（鍵あり・作成者/参加者） | チャット画面 |
| 不正パス | エラー画面（「無効なリンクです」） |

- 作成成功時 `history.replaceState(null,"", "/"+roomId+"#"+b64url(KR))` に更新し、招待リンク（`<URL>/<ルームID>#<K_R>`）とPINを大きく表示、コピーボタン（FR-1.2）。
- 初回チャット画面入力のユーザジェスチャで通知許可を要求（FR-2.4）。拒否時は設定シートに「通知を許可」リクエストボタン。

### 7.2 チャット画面

- 上部: ルームリンク/PIN再表示（招待用）・通知状態・テーマトグル（ライト/ダーク/自動）。
- 一覧: 送信者名・ローカル時刻表示・テキスト/画像サムネイル（タップでフル表示・Long Press/ダウンロード可）。
- 送信欄: テキスト入力（文字数カウント 0/400、超過で送信ボタン無効）＋画像ボタン（`accept="image/jpeg,image/png,image/webp"`）。
- 送信者表示名はIDB `rooms.name`（初期=作成/参加時入力値）。変更は設定から（次回送信分から）。

### 7.3 画像パイプライン（FR-7.4/7.5）

1. File → `createImageBitmap` → 長辺1280px以下へ縮小描画（canvas）。
2. `canvas.toBlob("image/webp", q)` を q=0.8 から 0.9倍ずつ下げて**96KB以下**（最大8回、それでも超過ならエラー表示）。
3. ArrayBuffer → base64 → CBOR `body.d`。
4. 受信側: base64 → ArrayBuffer → `Blob(type:"image/webp")` → `URL.createObjectURL`（表示破棄時にrevoke）。CSP `img-src 'self' blob: data:`。

### 7.4 テーマ（FR-7.6）

- CSS変数2セット（`:root` と `[data-theme="dark"]`）。初回は `matchMedia("(prefers-color-scheme: dark)")` に追従（auto）。手動切替で `localStorage.theme` に保存。`<meta name="color-scheme">` も追従。

## 8. Service Worker / PWA

- `sw.js` はルートをスコープに登録（静的配信）。`skipWaiting`＋`clients.claim`。fetch横取りなし（キャッシュはCloudflare CDNに委譲＝要件制約6「静的リソースのみ」の範囲で追加キャッシュを持たない）。
- `manifest.webmanifest`: name/short_name=tempchat、display: standalone、icon 192/512、theme_color 追従。iOSの「ホーム画面に追加」対応（FR-6.4）。
- 購読同期（A7）: 通知許可取得時／チャット画面を開くたびに `pushManager.subscribe` を取得→差分（endpoint/p256dh/auth）があればPUT。
- VAPID公開鍵は A1 から取得。

## 9. Cron（期限削除・FR-8）

- `wrangler.toml`: `crons = ["*/30 * * * *"]`（削除遅延 ≤30分 ≤ 要件1時間）。Freeプランのパターン数制限（5）内。
- 実行内容（`env.DB.batch()`、トランザクションの一貫性は不要＝冪等DELETEのみ）:

```sql
-- ① 受信7日超のメッセージと付随blob（FR-8.1）
DELETE FROM message_blobs WHERE msg_id IN (SELECT id FROM messages WHERE received_at < :now7d);
DELETE FROM messages      WHERE received_at < :now7d;
-- ② 最終メッセージ30日超のルームと付随データ（FR-8.2）
DELETE FROM message_blobs WHERE msg_id IN (SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id WHERE COALESCE(r.last_msg_at,r.created_at) < :now30d);
DELETE FROM messages      WHERE room_id IN (SELECT id FROM rooms WHERE COALESCE(last_msg_at,created_at) < :now30d);
DELETE FROM push_subs     WHERE room_id IN (SELECT id FROM rooms WHERE COALESCE(last_msg_at,created_at) < :now30d);
DELETE FROM rooms         WHERE COALESCE(last_msg_at,created_at) < :now30d;
```

## 10. テスト戦略（詳細はテスト工程で起票。設計段階の方針）

1. **unit（node, Vitest）**: 暗号プリミティブ（既知入力の回帰ベクタ・AAD改ざん検知・IV一意性）、CBORスキーマ検証（長・型・kind・400文字境界）、入力バリデータ（hex64・b64・サイズ）。
2. **worker統合（@cloudflare/vitest-pool-workers / Miniflare D1）**: A2〜A8 のステータスコード・認証拒否・ページネーション・チャンク往復（画像96KB超生成で413）purge SQL（時刻注入で7日/30日境界）、push送信は `web-push` をモックして呼び出し・404/410削除を検証、**D1に平文が混入しないこと**（受信→DBダンプ検索）。
3. **E2E（Playwright, `wrangler dev --local` に対して）**: 2ブラウザコンテキストでホスト作成→招待リンク→誤PIN拒否→正PIN参加→双方向テキスト/画像疎通→リロード後もIndexedDB閲覧可→ダークモード維持。D1検証はローカルSQLiteファイルへCLIクエリ。
4. **手動チェックリスト（実機）**: ①Chromeデスクトップ/Android・Firefox デバイスを閉じた状態での本文付き通知 ②iOS Safari 16.4+ PWAインストール時の通知 ③通知タップ遷移 ④自分自身の送信が通知されないこと ⑤画像の汎用通知。

## 11. セキュリティ実装チェックリスト

- [ ] 全DOM描画は `textContent` / `value`（`innerHTML` 禁止。Lint/レビュー）— 表示名・本文・ファイル名はユーザ入力
- [ ] CSP `default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'`（`public/_headers`）。`Referrer-Policy: no-referrer`（フラグメントの漏出防止）
- [ ] `X-Room-Auth` はハッシュのみ。鍵・PINをヘッダ・ボディ・URLクエリに載せない。サーバ側定数時間比較
- [ ] Worker側ログ出力はステータス・サイズ等のメトリクスのみ（平文・鍵・PIN・エンドポイントURLのconsole出力禁止＝NFR-8）
- [ ] JSONボディ192KB・ct上限・limit上限など全入力に上限（§4.2）
- [ ] `robots.txt` Disallow + `X-Robots-Tag: noindex`
- [ ] Service Worker登録は `location.protocol === "https:" || hostname === "localhost"` のときのみ
- [ ] 認証ヘッダの検証不能リクエスト（CORSプリフライ）: 同一オリジンのみ・CORSヘッダ不发行

## 12. プラットフォーム調査結果（2026-10-22 実測。設計根拠）

| 事実 | 確認方法 | 設計への反映 |
| --- | --- | --- |
| D2 バインディング廃止（docs 404 / wrangler 4.151.3 config-schema に `d2_databases` 無し / workers-types 5.20261022.1 に `D2Database` 無し） | registry tarball + config-schema.json grep | **D1へ置換**（要件v1.2承認済み） |
| D1制約: 1ステートメント ≤100KB（`db.batch()`内も個別に適用）、BLOB/行 ≤2MB、Free読50クエリ/invocation・DB500MB | developers.cloudflare.com/d1/platform/limits/ | 画像暗号文は48KiBチャンク保存（§4.1）。1リクエストのクエリ数は最大でも auth+data 前後＋batch で個数制限内 |
| WorkersにWeb Push専用バインディング無し。公式手順は VAPID鍵＋`web-push` ライブラリ | workers-types/wrangler schema グrep、/agents/.../push-notifications/ | §6.5。シークレット3種（`VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`）。`nodejs_compat` 有効 |
| Cron Triggers・Static Assets（SPAフォールバック `not_found_handling`、`run_worker_first=["/api/*"]`、`_headers`）は現行サポート | /workers/configuration/cron-triggers/ 等 | §9・ルーティング |
| `cbor2@2.4.0` 純JS（依存@cto.af/wtf8のみ）、Viteブラウザバンドル可 | registry metadata | §2 |
| `@cloudflare/vitest-pool-workers@0.23.0`、`playwright@1.64.1` 現行 | registry | §10 |

### 12.1 静的資産ルーティング（wrangler.toml 主要部）

```toml
name = "tempchat"
main = "src/worker/index.ts"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "dist/client"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]

[[d1_databases]]
binding = "DB"
database_name = "tempchat"
database_id = "<デプロイ時に発行>"

[triggers]
crons = ["*/30 * * * *"]
```

## 13. トレース表（要件→設計）

| 要件 | 設計上の実装箇所 |
| --- | --- |
| FR-1 作成/鍵配布 | §7.1、A2、§6.1 |
| FR-2 参加/PIN毎回 | §6.6、A3 |
| FR-3 メッセージング/CBOR/上限 | §6.2、A4/A5、§4.2 |
| FR-4 ポーリング | §6.4 |
| FR-5 履歴遡及 | §6.4（初回 after=0） |
| FR-6 プッシュ通知 | §6.5、§8、A1/A7/A8 |
| FR-7 ローカル永続化/画像/テーマ | §4.3、§7.2〜7.4 |
| FR-8 自動削除 | §9 |
| FR-9 ブラウザ対応/UI | §2（モダンブラウザ前提のES2022ターゲット）、§7 |
| SEC-1〜3 | §6.1、§11、§4.1 |
| NFR-1〜8 | §2、§12、§12.1、§11 |

## 14. デプロイ手順（概要）

1. `npm run build`（client+sw ビルド）
2. `wrangler d1 create tempchat` → database_id を wrangler.toml へ
3. `wrangler d1 migrations apply tempchat --remote`
4. `npx web-push generate-vapid-keys` → `wrangler secret put` ×3
5. `wrangler deploy`
6. 動作確認後、テスト工程の受け入れ基準（要件§10）へ
