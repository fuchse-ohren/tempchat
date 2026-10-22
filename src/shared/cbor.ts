/** CBOR メッセージの生成・検証（設計 §6.2。暗号化対象のスキーマをここで強制） */

import { decode, encode } from "cbor2";
import {
  FILENAME_MAX,
  NAME_MAX,
  NAME_MIN,
  PROTOCOL_VERSION,
  TEXT_MAX,
  TEXT_MIN,
} from "./constants.ts";
import type { ImageWireMessage, TextWireMessage, WireMessage } from "./types.ts";

export function encodeMessage(msg: WireMessage): Uint8Array {
  return encode(msg) as Uint8Array;
}

/** 不正スキーマは throw（受信側で復号成功後も必ず通す。FR-4.2） */
export function decodeMessage(bytes: Uint8Array): WireMessage {
  const raw: unknown = decode(bytes);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("cbor: not a map");
  }
  const o = raw as Record<string, unknown>;
  if (o["v"] !== PROTOCOL_VERSION) throw new Error("cbor: version");
  if (typeof o["id"] !== "string" || o["id"].length === 0 || o["id"].length > 36) {
    throw new Error("cbor: id");
  }
  if (typeof o["ts"] !== "number" || !Number.isInteger(o["ts"]) || o["ts"] < 1) {
    throw new Error("cbor: ts");
  }
  if (typeof o["name"] !== "string" || !isName(o["name"])) {
    throw new Error("cbor: name");
  }
  const kind = o["kind"];
  const base = {
    v: PROTOCOL_VERSION as 1,
    id: o["id"],
    ts: o["ts"],
    name: o["name"],
  };
  if (kind === "text") {
    const body = o["body"];
    if (typeof body !== "string" || !isText(body)) throw new Error("cbor: body");
    const msg: TextWireMessage = { ...base, kind: "text", body };
    return msg;
  }
  if (kind === "image") {
    const b = o["body"];
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      throw new Error("cbor: image body");
    }
    const img = b as Record<string, unknown>;
    if (typeof img["d"] !== "string" || img["d"].length === 0) {
      throw new Error("cbor: image data");
    }
    if (img["m"] !== "image/webp") throw new Error("cbor: image mime");
    if (
      typeof img["n"] !== "string" ||
      img["n"].length < 1 ||
      img["n"].length > FILENAME_MAX
    ) {
      throw new Error("cbor: image name");
    }
    const msg: ImageWireMessage = {
      ...base,
      kind: "image",
      body: { d: img["d"], m: "image/webp", n: img["n"] },
    };
    return msg;
  }
  throw new Error("cbor: kind");
}

export function isName(name: string): boolean {
  // 文字数はコードポイント数（FR-3.1 の「文字」）
  const n = [...name].length;
  return n >= NAME_MIN && n <= NAME_MAX;
}

export function isText(body: string): boolean {
  const n = [...body].length;
  return n >= TEXT_MIN && n <= TEXT_MAX;
}
