/** 暗号プリミティブ（要件 SEC-1 / 設計 §6.1）。WebCrypto のみ使用。 */

import { HKDF_INFO_PREFIX, IV_LEN } from "./constants.ts";
import {
  bytesToHex,
  concatBytes,
  randomBytes,
  toBytes,
  utf8,
} from "./bytes.ts";

/** H(K_R‖PIN) の hex64。サーバ照会専用（FR-1.4） */
export async function roomAuthHash(
  kr: Uint8Array,
  pin: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    concatBytes([kr, utf8(pin)]),
  );
  return bytesToHex(new Uint8Array(digest));
}

/** メッセージ鍵: HKDF-SHA-256(ikm=K_R, salt=PIN, info=PREFIX+ts) → AES-256-GCM */
export async function deriveMessageKey(
  kr: Uint8Array,
  pin: string,
  ts: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", toBuf(kr), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8(pin),
      info: utf8(`${HKDF_INFO_PREFIX}${ts}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aadFor(ts: number): Uint8Array<ArrayBuffer> {
  // 平文メタデータ ts と暗号文を結合（設計 §6.1）
  return utf8(String(ts));
}

/** 戻り値 = IV(12B) ‖ AES-GCM(暗号文+tag)。AAD = ts文字列 */
export async function encryptMessage(
  key: CryptoKey,
  ts: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_LEN);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBuf(iv), additionalData: aadFor(ts) },
    key,
    toBuf(plaintext),
  );
  return concatBytes([iv, new Uint8Array(ct)]);
}

/** 復号失敗（改ざん・ts不一致・短すぎる）は throw */
export async function decryptMessage(
  key: CryptoKey,
  ts: number,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < IV_LEN + 16) throw new Error("ciphertext too short");
  const iv = blob.slice(0, IV_LEN);
  const ct = blob.slice(IV_LEN);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(iv), additionalData: aadFor(ts) },
    key,
    toBuf(ct),
  );
  return new Uint8Array(plain);
}

/** ArrayBuffer は write 可変の要求があるため毎回コピーして渡す（型取り回し対策） */
function toBuf(b: Uint8Array): ArrayBuffer {
  const c = new Uint8Array(b.length);
  c.set(b);
  return c.buffer;
}
