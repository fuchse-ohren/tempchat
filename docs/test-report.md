# tempchat テスト報告書（テスト工程）

- 版数: 1.3（**2026-10-22 承認済み・テスト工程完了**。CSP を設計 §11 の文面へ統一、スクロール挙動と参加エラー文面の指摘を反映し、全テスト再実行して全件成功）
- 日付: 2026-10-22
- 対象: `docs/requirements.md` v1.2（受け入れ基準 §10）/ `docs/design.md` v1.0（テスト戦略 §10）/ `docs/handoff.md` §5
- 実行: Codex エージェント（テスト工程）
- **結論: 受け入れ基準 10 項目のうち 9 項目を自動テストで合格。**
  残り 1 項目（受け入れ基準 6 のプッシュ通知）は **サーバ側まで自動検証済み・実機への
  通知到達のみ手動**（`docs/manual-push-checklist.md` に起票）。
  仕様（3 文書）への変更は発生していない。実装側の不具合 3 件を修正した。

---

## 1. 実行サマリ

| 層 | コマンド | テスト数 | 結果 | 所要 |
| --- | --- | --- | --- | --- |
| 単体（node） | `npx vitest run --project unit` | 61 | 全件成功 | < 1s |
| Worker 統合（Miniflare / D1） | `npx vitest run --project worker` | 79 | 全件成功 | ~15s |
| E2E（Playwright / Chromium + Firefox） | `npx playwright test` | **52（26 × 2 ブラウザ）** | 全件成功 | 5m36s |
| 手動（Cron 削除の実運用経路） | `curl /cdn-cgi/local/scheduled` + D1 CLI | 2 シナリオ | 期待どおり（§6） | - |
| 手動（実機プッシュ） | `docs/manual-push-checklist.md` | 10 項目 | **未実施（要実機）** | - |

- 自動テスト合計 **192 件 / 失敗 0 件**（2026-10-22、クリーンなローカル D1 での最終全件実行。
  指摘反映後の再実行でも同様に全件成功）。
- 型検査 `npx tsc -p tsconfig.json|tsconfig.worker.json|tsconfig.sw.json --noEmit`：3 設定ともエラーなし。
- ビルド `npm run build`（アプリ + Service Worker の 2 種）成功。

## 2. 実行環境と必要な準備（`docs/handoff.md` §3 の追補）

```
node v24.19.0 / npm 11.19.0
wrangler 4.151.3 / vitest 4.1.11 / @cloudflare/vitest-pool-workers 0.23.0
@playwright/test 1.64.1（chromium-1248 / firefox-1555）
```

このサンドボックスでテストを流すには下記の環境ハックが必須だった
（`docs/handoff.md` §3 に加え、本テスト工程で確定したもの。仕様ではない）。

```bash
export HOME=$PWD/.home XDG_CONFIG_HOME=$PWD/.home/.config XDG_CACHE_HOME=$PWD/.home/.cache
npm install --cache $PWD/.npm-cache            # npm の既定キャッシュが使えない

# Worker 統合テスト: @cloudflare/vitest-pool-workers@0.23 同梱の workerd が 2026-08-15 版で、
# wrangler.toml の compatibility_date 2026-10-01 より古い。wrangler 側の新しい workerd を
# 使わせる（vitest.worker.config.ts に自動設定済み。環境変数で上書きも可能）。
export MINIFLARE_WORKERD_PATH=$PWD/node_modules/wrangler/node_modules/@cloudflare/workerd-linux-64/bin/workerd

# Playwright: ホストにブラウザのシステムライブラリ（libnss3 / libasound / libgtk 等）が無い。
# .deb を展開して .tmp/deb/extract に置き、LD_LIBRARY_PATH で差し出す。
export PLAYWRIGHT_BROWSERS_PATH=$PWD/.home/.cache/ms-playwright
export LD_LIBRARY_PATH=$PWD/.tmp/deb/extract/usr/lib/x86_64-linux-gnu
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
```

E2E の実行手順（**この順番が必須**。ビルド 2 種とマイグレーションを怠ると SW が 404 になる）:

```bash
npm run build                                              # index.html + assets
npx vite build --config vite.sw.config.ts                  # dist/client/sw.js
npx wrangler d1 migrations apply tempchat --local
npx wrangler dev --local --port 8787                       # E2E は同じ .wrangler/state を共有
npx playwright test
```

- `playwright.config.ts` の `webServer` は既存の 8787 を再利用する（`reuseExistingServer: true`）。
- D1 の検証も `wrangler d1 execute tempchat --local` 経由なので dev サーバと同じ DB を見る
  （1 コマンド 1 ステートメント制約には `test/e2e/d1.ts` が対応）。

## 3. テスト資産

### 3.1 単体テスト（`test/unit/` / node 環境・61 件）

| ファイル | 件数 | 主な検証 |
| --- | --- | --- |
| `bytes.test.ts` | 21 | base64 / base64url / hex の往復、**不正入力は必ず null**（余分な `=`、改行、`-1`、奇数長、非 16 進）、UTF-16 での文字数境界 |
| `crypto.test.ts` | 18 | 既知入力の回帰ベクタ（HKDF 鍵導出・`roomAuthHash`・AES-GCM の IV‖ct‖tag 長）、**AAD（`String(ts)`）改ざんの検知**、IV ランダム性（同一平文で IV 不一致・100 回生成で重複なし）、復号失敗時に null |
| `cbor.test.ts` | 22 | スキーマ検証（`v`・`id`・`kind`・`name` 1〜20・`ts`・`body` 400 文字）、400/401 文字境界、画像 body の型、encode→decode 往復、不正 CBOR は安全に失敗 |

### 3.2 Worker 統合テスト（`test/worker/` / Miniflare + ワーカー内 D1・79 件）

`migrations/0001_init.sql` を各テストの `beforeEach` で適用（プール側にマイグレーション自動適用
オプションが無いため `?raw` インポートで解決）。
`compatibilityDate: 2026-10-01` + `nodejs_compat` で本番と同じ設定にしている。

| ファイル | 件数 | 主な検証 |
| --- | --- | --- |
| `api.test.ts` | 32 | A1〜A8 のステータスコード、**413（JSON 192KB / text ct 4,096B / 画像 ct 136KiB / チャンク数上限）**、`ts`・`kind`・base64 の検証、ページネーション（`after`・`limit` clamp 50・不正 400）、画像の 48KiB チャンク往復（100KB→3 チャンク、48KiB ちょうどは 1 チャンク）、チャンクの 404 系、購読 upsert と 21 件目 eviction |
| `auth.test.ts` | 11 | 6 エンドポイント全て `x-room-auth` 無しで **403**、形式不正ヘッダ 403、join は PIN があれば 200、**誤 PIN 403**、既存ルームへの別鍵 403、幽霊ルーム 404、`constantTimeEqualHex` の一致/不一致表、`key_hash` が 32B BLOB |
| `purge.test.ts` | 12 | **7 日 / 30 日境界（時刻を注入）**、7 日ちょうどは保持・1ms 古ければ削除、FR-8.1 はメッセージのみ削除（ルームは保持）、30 日でルームと関連行（messages / message_blobs / push_subs）を一括削除、`worker.scheduled()` 経由でも同一動作 |
| `push.test.ts` | 12 | `web-push` をモックして **送信回数・TTL 3600・購読 1 件につき 1 送信**、404/410 の購読のみ削除・500 は保持、購読ゼロなら送信しない、配信エラーが送信 API の成功を妨げない、DELETE 後は対象外 |
| `push-payload.test.ts` | 6 | ペイロードが `{v,roomId,id,ts,kind,ct?}`、**生平文・表示名・PIN・K_R を載せない**、ct が 3,900B 超なら汎用化、UTF-8 で 4KB 以内、画像は汎用（FR-6.3） |
| `plaintext-audit.test.ts` | 5 | **受け入れ基準 3 の本体**。実 API 経由で書き込んだ後、D1 の全テーブル全カラムを走査し、平文・表示名・PIN・`K_R`（raw / hex / base64 / base64url）の混入がないことを検査（検出器の陽性対照つき） |
| `smoke.test.ts` | 1 | ワーカー起動・D1 バインディング確認のプリフライト |

### 3.3 E2E（`test/e2e/` / Playwright・26 件 × Chromium / Firefox）

| ファイル | 件数 | 主な検証 |
| --- | --- | --- |
| `room.spec.ts` | 7 | 作成→**UUID v4 発行**→招待リンク `<url>/<id>#<base64url(K_R)>`→PIN 表示、**サーバへは `keyHash` のみ送信**、D1 の `rooms` に `key_hash`(32B) のみ、**再訪後も招待リンクが K_R を保持**、PIN 再表示、PIN 桁数のクライアント検証、**セキュリティヘッダ（CSP・`Referrer-Policy: no-referrer`・`X-Robots-Tag: noindex`・robots.txt）**、**Service Worker の配信と登録** |
| `pin.spec.ts` | 5 | **誤 PIN 拒否（403 → 「招待リンクまたはPINが正しくありません」）／正 PIN で参加**、参加済みブラウザは再訪時に PIN 不要（IndexedDB に `K_R` 32B・PIN・表示名）、別コンテキストでは毎回 PIN 必須、フラグメント欠落は参加不可、存在しないルームはエラー表示、**URL・ボディに鍵と PIN を載せずヘッダはハッシュのみ** |
| `chat.spec.ts` | 7 | **双方向テキスト疎通（片方向の実測 < 9 秒）**、自分の送信の二重表示なし、並び順、**400 文字は送信可 / 401 文字はクライアントで送信を止める**、**途中参加が履歴を閲覧**、IndexedDB へ保存＋リロード後再表示、**送信失敗時に「送信失敗」表示＋下書き保持→再送可能（設計 §6.3）**、**可視中のみ 5 秒ポーリング／非可視で停止／復帰で即時同期**、**新着での自動スクロールなし（閲覧位置の維持）** |
| `image.spec.ts` | 4 | PNG 送信→**WebP 化（≤96KB・長辺 1280px 以下）して相手に表示**、D1 では `messages.ct = NULL` + 48KiB チャンク保存、**サーバ側行を消してもローカル IndexedDB で閲覧継続** |
| `theme.spec.ts` | 3 | **ダークモード切替・localStorage 保存・リロード後も維持**、OS の `prefers-color-scheme` 追従、全屏への適用 |

E2E の実装上の注記:
- ポーリングは可視中のみ。headless では別タブが非可視に切り替わらないため、FR-4.1 の検証は
  `document.visibilityState` を差し替える `addInitScript` で決定的に行った（`chat.spec.ts`）。
- 通知権限は付与しない（付与すると実配線を試みて不安定になる）。E2E はポーリング経路を検証し、
  プッシュは §4 の自動 + §7 の手動で担保する。
- 画像フィクスチャ（640×480 と 2560×1920 の PNG）は依存ゼロの PNG エンコーダで `globalSetup` が
  生成する（`test/e2e/fixtures.ts` → `test/e2e/.fixtures/`、git 無視）。
- 送信失敗の再現は `page.route` で `POST /messages` だけ abort（受信は通す）。

## 4. 受け入れ基準マトリクス（要件 §10）

| # | 受け入れ基準 | 判定 | 自動 / 手動 | 根拠 |
| --- | --- | --- | --- | --- |
| 1 | ルーム作成→UUID 発行→招待リンク生成 | **合格** | 自動 | E2E `room.spec.ts`（URL 形式・UUID v4・`keyHash` のみ送信・再訪後のリンク）+ Worker `api.test.ts` A2 |
| 2 | 誤 PIN は拒否／正 PIN は参加できる | **合格** | 自動 | E2E `pin.spec.ts` + Worker `auth.test.ts`（403 / 200）+ 単体 `crypto.test.ts`（`roomAuthHash` 回帰ベクタ） |
| 3 | サーバ D1 に平文・表示名・PIN・`K_R` が無い | **合格** | 自動 | Worker `plaintext-audit.test.ts`（全テーブル全カラム走査＋陽性対照）+ E2E `room.spec.ts`（`key_hash` のみ）・`pin.spec.ts`（転送内容の検査） |
| 4 | 双方向のテキスト・画像疎通／本文 400 文字・超過は送信不可 | **合格** | 自動 | E2E `chat.spec.ts`・`image.spec.ts`（Chromium・Firefox 両方）+ Worker `api.test.ts`（400 文字＝ct 4,096B 境界、超過は 413） |
| 5 | 途中参加が保持期間内の履歴を閲覧できる | **合格** | 自動 | E2E `chat.spec.ts`（3 件の履歴を一括取得して表示）+ Worker `api.test.ts`（A5 の `after` 挙動） |
| 6 | ブラウザを閉じた状態で数秒以内に通知（送信者名・本文／画像は汎用） | **部分合格（実機のみ未達）** | 自動＋手動 | 自動: Worker `push.test.ts`（即配信・TTL 3600・購読管理）・`push-payload.test.ts`（**text は ct 同梱＝SW が送信者名と本文へ復号可能、image は汎用**、平文・PIN・K_R を載せない）。**実機への到達は `docs/manual-push-checklist.md` で手動確認** |
| 7 | 7 日経過メッセージがサーバから消え、ローカルは閲覧継続 | **合格** | 自動＋実運用経路確認 | Worker `purge.test.ts`（時刻注入で 7 日境界・チャンク追随削除）+ §6 の Cron 実運用経路 + E2E `image.spec.ts`（サーバ行削除後もローカル表示） |
| 8 | 最終メッセージから 30 日経過したルームが削除される | **合格** | 自動＋実運用経路確認 | Worker `purge.test.ts`（30 日境界と関連行の連鎖削除）+ §6 の Cron 実運用経路 |
| 9 | ダークモード切替と設定の保存 | **合格** | 自動 | E2E `theme.spec.ts`（切替・保存・リロード維持・OS 追従、2 ブラウザ） |
| 10 | 対応ブラウザ（FR-9.2）で主要な閲覧・送信操作が可能 | **合格（自動カバー範囲で）** | 自動＋手動 | 自動: **Chromium と Firefox で 25 シナリオ × 2 = 50 件すべて成功**（Edge / Chrome は同一エンジン）。**Safari / iOS Safari / Android Chrome は未自動**（この環境にブラウザが存在しない）→ §7 に繰越し |

## 5. 発見した不具合と修正（実装側のみ／仕様は変更していない）

| ID | 深刻度 | 内容 | 影響 | 修正 | 回帰テスト |
| --- | --- | --- | --- | --- | --- |
| BUG-1 | 高（セキュリティ） | `shared/bytes.ts` の `hexToBytes` が `parseInt` 頼みで、**非 16 進文字列を正常として返していた**（例: `"-1"` → `[255]`、`" 1"` → `[1]`） | 64 桁 hex の検証をくぐり抜けると `x-room-auth` の比較や鍵生成が不正なバイト列で走る。設計 §11「検証不能リクエストを弾く」に反する | 16 進正規表現で検査し、奇数長・非 16 進は必ず `null` を返すよう修正 | 単体 `bytes.test.ts`（不正入力は全て null） |
| BUG-2 | 中（機能・FR-1.2） | 招待パネルのリンクを `location.href` から作っていた。IndexedDB 鍵保持による**再訪時（URL に `#K_R` が無い）は K_R なしのリンクが複製され、招待相手が参加できない** | 「2 日目に知人を招待する」という一次シナリオが壊れる | IndexedDB の `K_R` から常に `<origin>/<roomId>#<base64url(K_R)>` を組み立てるように修正 | E2E `room.spec.ts`「再訪でも招待リンクは K_R を保持」、`pin.spec.ts`「フラグメント欠落は参加不可」 |
| BUG-3 | 中（UX・設計 §6.3） | 送信失敗時に本文エディタをクリア済みで pending バブルも削除していた。設計 §6.3 の「失敗時は pending を『送信失敗』表示（自動再送せず、手で再送）」が効かず、**入力内容が失われて再送できない** | 通信断時に書き直しが必要。ユーザデータ損失 | pending を残して `failed` フラグで「送信失敗」表示、下書きは送信成功時のみ消す、再送時に古い失敗バブルを片付ける | E2E `chat.spec.ts`「送信失敗時は『送信失敗』表示で本文が残るので、そのまま再送できる」 |

いずれも仕様書の記述に合わせて実装を修正したもので、**設計の書き換えは不要**だった。

### 5.1 承認プロセスでの指摘による変更（2026-10-22 反映済み）

要件・設計いずれにも記述が無い挙動なので、**仕様変更を伴わず実装のみ**修正した。

| ID | 指摘内容 | 変更 | 検証 |
| --- | --- | --- | --- |
| UX-1 | ポーリング時に自動で最新メッセージまでスクロールする挙動を削除し、現在のスクロール位置を維持したい | `views/chat.ts` の `render(stick)` を追加。**初回の履歴描画と自分の送信時だけ**最下部へスクロールし、ポーリングでの新着は `scrollTop` をそのまま復元する | E2E `chat.spec.ts`「過去を遡っているときに新着が届いてもスクロール位置を維持する」（参加直後は最下部／先頭まで遡った状態で新着を受いても `scrollTop` 不変／自分の送信時は最下部） |
| UX-2 | 参加失敗時のエラー文を「招待リンクまたはPINが正しくありません」にしたい | `views/join.ts` の 403 時メッセージを置換（404・通信失敗時の文は据え置き） | E2E `pin.spec.ts`（誤 PIN 時に新しい文を完全一致で検証） |
| BUG-4 | （テスト作成中に見つけたもの）pending の一時IDが `-Date.now()` で、同一ミリ秒の連続送信だと一時バブルが上書きされ得る | 連番を混ぜた `nextTempId()` に変更 | E2E の連続 30 件送信でバブル数が正確に増えることを検証（`scrollInfo().count`） |

## 6. Cron 削除の実運用経路の確認（手動・`wrangler dev --local`）

単体／統合テストは `purgeExpired()` に時刻を注入して境界を検証しているが、
**実際の Cron 起動経路＋実時刻**でも削除が働くことを D1 CLI で確認した。

| シナリオ | 操作 | 結果 |
| --- | --- | --- |
| 画像 1 件（100KiB → 3 チャンク）を含むルームを 8 日前に設定 | `POST /api/rooms` → `POST /api/rooms/:id/messages` → `UPDATE messages SET received_at = now-8d` → `curl http://localhost:8787/cdn-cgi/local/scheduled`（200） | メッセージ 0 件、**チャンクも追随して 0 件（孤立 BLOB なし）**、ルームは保持（8 日 < 30 日） |
| 31 日無操作のルーム | 同上で `created_at` / `last_msg_at = now-31d` → cron 発火 | `rooms` から行が消えている（FR-8.2） |
| cron エンドポイント | `GET` / `POST /cdn-cgi/local/scheduled` | 200（ハンドラ異常なし） |

- 削除判定は `messages.received_at`（サーバ受信時刻）と `rooms.last_msg_at` が基準。
  クライアント送信の `ts` は無信用なので基準にしない（設計 §9 と一致）。
  ※ 検証中に `ts` だけを古くしても削除されないことを確認した＝実装が正しい。

## 7. 手動に回したもの

1. **実機プッシュ通知** — `docs/manual-push-checklist.md`（新規作成）。
   デプロイ（VAPID 3 シークレット）後の Android Chrome / iOS Safari / デスクトップで、
   ①本文付き通知 ②画像の汎用通知 ③自分の送信が通知されない ④タップ遷移 ⑤TTL 期限切れ、
   ⑥7 日削除後のローカル閲覧 を確認する。自動側はペイロード生成と購読管理まで検証済み。
2. **Safari / iOS Safari / Android Chrome** — この実行環境に対応ブラウザが無いため自動化できず。
   Chromium 系（Chrome / Edge）と Firefox で同等の主要シナリオを通している。
   レビュー時の目視、または実機での簡易確認を推奨。
3. **Service Worker の通知表示まわり** — E2E は SW の配信・登録と `push` ハンドラの存在までを確認。
   通知の実際の表示内容（アイコン・タップ遷移）は実機依存（設計 §8 / §10-4）。

## 8. 既知の制限・報告事項（仕様変更の申し出）

1. **CSP — 設計 §11 の文面に統一済み（2026-10-22 承認反映）** —
   テスト実施時の実装は `default-src 'none'` に `base-uri` / `form-action` /
   `frame-ancestors` / `object-src` を追加した設計文面より厳しい設定だった。
   承認プロセスでの判断により **設計 §11 の記述どおり**
   `default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'`
   へ統一した（`public/_headers`）。
   統一後に E2E 50 件（Chromium / Firefox）を再実行し、全件成功を再確認している
   （`blob:` / `data:` 画像・スタイル・接続・Service Worker はいずれも設計文面で許可される範囲で動作）。
   `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` / `X-Robots-Tag: noindex` は不変。
   検出は E2E `room.spec.ts`「セキュリティヘッダが設計 §11 の方針を満たす」。
2. **受け入れ基準 6 の「数秒以内」は実機計測していない** — サーバは `TTL: 3600` で即配信しており、
   実測は手動チェックリストに委ねる。
3. **E2E の片方向反映は「9 秒以内」で宣言** — 実測はポーリング 5 秒＋描画で通常 5 秒前後。
   遅い時間帯で 5 秒ちょうどに切ると不安定なため宣言側へ余裕を見た
   （FR-4.1 の 5 秒間隔そのものはリクエスト本数で検証している）。
4. **Free プランの D1 制限（1 ステートメント ≤100KB / 1 invocation 50 クエリ）の負荷検証は未実施** —
   48KiB チャンク化で送信側は上限内に収まることを確認済み（設計 §12 準拠）だが、
   実トラフィックでのクエリ数プロファイリングは行っていない。
5. **オフライン表示・a11y ツール・性能（NFR-2 の応答時間）は対象外**（設計 §10 のテスト戦略に無い）。
6. **`@cloudflare/vitest-pool-workers` は 0.23 が最新で、同梱 workerd と互換性日付が食い違う**
   （§2 のワークアラウンド参照。将来版で解消される見込み）。
7. **ローカル D1 のテストデータは実行のたびに増える** — E2E は毎回新規ルームを作るため、
   実施前に `DELETE FROM message_blobs / messages / push_subs / rooms` でクリーンにしている。

## 9. 追加・変更したファイル

新規（テスト工程。仕様の 3 文書は未変更）:

```
vitest.config.ts            Vitest プロジェクト定義（unit / worker）
vitest.unit.config.ts       node 環境の単体テスト
vitest.worker.config.ts     @cloudflare/vitest-pool-workers（workerd 経路の解消込み）
playwright.config.ts        E2E（Chromium + Firefox、webServer は 8787 を再利用）
test/unit/{bytes,crypto,cbor}.test.ts
test/worker/{helpers,smoke,api,auth,purge,push,push-payload,plaintext-audit}.test.ts
test/e2e/{global-setup,fixtures,app,d1}.ts
test/e2e/{room,pin,chat,image,theme}.spec.ts
docs/manual-push-checklist.md
```

実装側の変更（バグ修正のみ・3 件）:

```
src/shared/bytes.ts          hexToBytes の入力検証（BUG-1）
src/client/views/chat.ts     招待リンクの組み立て（BUG-2）、送信失敗表示と下書き保持（BUG-3）、
                             スクロール位置の維持（UX-1）、一時IDの衝突回避（BUG-4）
src/client/views/join.ts     参加失敗時のエラー文（UX-2）
src/client/idb.ts            StoredMessage.failed を追加（BUG-3）
src/client/style.css         .msg-flag-fail（送信失敗ラベル）（BUG-3）
public/_headers              CSP を設計 §11 の文面へ統一（承認時の判断。§8-1）
.gitignore                   .tmp/ と test/e2e/.fixtures/ を追加（テスト成果物）
```

## 10. 承認

上記のとおり自動テストは全件成功、受け入れ基準 10 項目は 9 項目が自動合格、
1 項目（実機プッシュ）はサーバ側まで自動合格・実機は手動チェックリストに起票した。

初回提示（v1.0）に対する承認結果（2026-10-22）:

- [x] **CSP の扱い** → 「設計文面へ緩める」を選択。`public/_headers` を設計 §11 の
  `default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'`
  に統一し、E2E 全件を再実行して全件成功を確認済み（§8-1）。
- [x] **UI の指摘 2 件** → 指摘を受けて実装へ反映し、回帰テストを追加して
  E2E 52 件・Vitest 140 件を再実行し全件成功（§5.1）。
- [x] **レポート内容の最終承認** → v1.2 の内容で **承認を入手（2026-10-22）。テスト工程は完了**。
  自動 192 件（Vitest 140 + E2E 52）全件成功、受け入れ基準は 9 項目自動合格 +
  受け入れ基準 6 の実機プッシュ到達のみ `docs/manual-push-checklist.md` で手動管理。
- [ ] 実機プッシュチェックリスト（`docs/manual-push-checklist.md`）の実施担当・期限
  ※ テスト工程の完了とは別に、デプロイ後の実機確認として運用側で実施する
