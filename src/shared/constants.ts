/** プロトコル・入力制限の共通定数（要件 §9 / 設計 §4.2）。client/sw/worker で共有。 */

export const PROTOCOL_VERSION = 1;

/** 表示名 1〜20文字（FR-3.1） */
export const NAME_MIN = 1;
export const NAME_MAX = 20;

/** メッセージ本文 1〜400文字（FR-3.1） */
export const TEXT_MIN = 1;
export const TEXT_MAX = 400;

/** PIN 6〜12桁の数字（FR-1.1） */
export const PIN_MIN = 6;
export const PIN_MAX = 12;

/** 画像: base64変換前 96KB以下・長辺1280px・WebP（FR-7.4/7.5） */
export const IMAGE_MAX_BYTES = 96 * 1024;
export const IMAGE_MAX_EDGE = 1280;
export const IMAGE_MIME = "image/webp";
export const IMAGE_QUALITY_START = 0.8;
export const IMAGE_QUALITY_STEPS = 8;
export const FILENAME_MAX = 64;

/** ct（IV‖暗号文‖tag のバイト長）上限（設計 §4.2） */
export const CT_MAX_TEXT = 4096;
export const CT_MAX_IMAGE = 136 * 1024;

/** D1 ステートメント制限(100KB)回避用のチャンクサイズ */
export const CHUNK_SIZE = 48 * 1024;
export const CHUNK_MAX_COUNT = 32;

/** API */
export const ROOM_AUTH_HEADER = "x-room-auth";
export const PAGE_LIMIT_MAX = 50;
export const MAX_BODY_BYTES = 192 * 1024;
export const PUSH_SUBS_PER_ROOM = 20;
export const PUSH_PAYLOAD_MAX = 4096;
/** push ペイロードに ct を同梱できる raw ct 上限（JSON他分を差し引き） */
export const PUSH_CT_INLINE_MAX = 3900;
export const PUSH_TTL_SECONDS = 3600;

/** サーバ保持・削除（FR-8） */
export const MSG_TTL_DAYS = 7;
export const ROOM_TTL_DAYS = 30;

/** ts 受理幅: 未来は+24hまで（FR-3.5 の時計ずれ許容） */
export const TS_MIN = 1e12;
export const TS_FUTURE_SKEW_MS = 24 * 3600 * 1000;

/** 鍵導出 info 接頭辞（要件 SEC-1） */
export const HKDF_INFO_PREFIX = "tempchat-msg-v1:";

/** IV長（AES-GCM） */
export const IV_LEN = 12;

/** プッシュペイロードの自分送信除外用 sentIds 保持数 */
export const SENT_IDS_MAX = 200;

/** ポーリング間隔（FR-4.1） */
export const POLL_INTERVAL_MS = 5000;

/** IDB */
export const IDB_NAME = "tempchat";
export const IDB_VERSION = 1;

/** 検証用パターン */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
