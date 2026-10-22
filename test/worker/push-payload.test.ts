/**
 * プッシュペイロードの中身と、配信経路上の秘密漏えいを検証する（設計 §6.5・NFR-8）
 * 平文は渡っていないので ct は復号できるが、「平文をそのまま入れていない」こと、
 * 4KB 制限、K_R/PIN がペイロードに出ないことを確認する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySchema,
  b64,
  call,
  containsBytes,
  insertSub,
  randomBytes,
  seedRoom,
  settle,
  utf8,
} from "./helpers.ts";
import { PUSH_CT_INLINE_MAX, PUSH_PAYLOAD_MAX, PUSH_TTL_SECONDS } from "../../src/shared/constants.ts";
import { deriveMessageKey, encryptMessage } from "../../src/shared/crypto.ts";
import { encodeMessage } from "../../src/shared/cbor.ts";
import type { WireMessage } from "../../src/shared/types.ts";

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

beforeEach(async () => {
  await applySchema();
  sendNotification.mockReset();
});

async function sendWire(
  roomId: string,
  auth: string,
  kr: Uint8Array,
  pin: string,
  wire: WireMessage,
) {
  const key = await deriveMessageKey(kr, pin, wire.ts);
  const ct = await encryptMessage(key, wire.ts, encodeMessage(wire));
  const r = await call("POST", `/api/rooms/${roomId}/messages`, {
    auth,
    body: { ts: wire.ts, kind: wire.kind, ct: b64(ct) },
  });
  await settle(r.ctx);
  return { r, ct };
}

function payload(): Record<string, unknown> {
  const callArgs = sendNotification.mock.calls[0] as unknown as [unknown, string, unknown];
  return JSON.parse(callArgs[1] as string);
}

function rawPayload(): string {
  const callArgs = sendNotification.mock.calls[0] as unknown as [unknown, string, unknown];
  return callArgs[1] as string;
}

describe("push ペイロード仕様（設計 §6.5）", () => {
  it("TTL は 3600 秒（PUSH_TTL_SECONDS）で配信する", async () => {
    const { roomId, auth, kr, pin } = await seedRoom();
    await insertSub({ roomId });
    await sendWire(roomId, auth, kr, pin, {
      v: 1,
      id: crypto.randomUUID(),
      kind: "text",
      name: "さくら",
      ts: Date.now(),
      body: "TTL確認",
    });
    const opts = (sendNotification.mock.calls[0] as unknown as [unknown, string, { TTL?: number }])[2];
    expect(opts.TTL).toBe(PUSH_TTL_SECONDS);
    expect(opts.TTL).toBe(3600);
  });

  it("ペイロードは購読1件につき1回・同一の送信で1度だけ", async () => {
    const { roomId, auth, kr, pin } = await seedRoom();
    const e1 = await insertSub({ roomId, endpoint: "https://push.example/p1" });
    const e2 = await insertSub({ roomId, endpoint: "https://push.example/p2" });
    await sendWire(roomId, auth, kr, pin, {
      v: 1,
      id: crypto.randomUUID(),
      kind: "text",
      name: "さくら",
      ts: Date.now(),
      body: "一通り",
    });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const eps = sendNotification.mock.calls.map(
      (c) => (c[0] as { endpoint: string }).endpoint,
    );
    expect(eps.sort()).toEqual([e1, e2].sort());
  });

  it("text は ct を同梱し、平文・表示名・PIN をペイロードに載せない（FR-6.2・NFR-8）", async () => {
    const pin = "424242";
    const kr = randomBytes(32);
    const { roomId, auth } = await seedRoom({ kr, pin });
    await insertSub({ roomId });
    const body = "ひみつの本文-PAYLOAD-MARKER";
    const name = "秘密の表示名";
    const wire: WireMessage = {
      v: 1,
      id: crypto.randomUUID(),
      kind: "text",
      name,
      ts: 1_766_456_400_000,
      body,
    };
    const { ct } = await sendWire(roomId, auth, kr, pin, wire);

    const p = payload();
    expect(p.v).toBe(1);
    expect(p.kind).toBe("text");
    expect(p.ts).toBe(wire.ts);
    expect(typeof p.id).toBe("number");
    expect(new Uint8Array(Buffer.from(String(p.ct), "base64"))).toEqual(ct);

    const raw = rawPayload();
    expect(raw).not.toContain(body);
    expect(raw).not.toContain(name);
    expect(raw).not.toContain(pin);
    expect(raw).not.toContain(Buffer.from(kr).toString("base64"));
    // Service Worker 側で鍵導出できるよう IV‖ct‖tag がそのまま入っている
    const inline = new Uint8Array(Buffer.from(String(p.ct), "base64"));
    expect(inline.length).toBe(ct.length);
  });

  it("raw ct が 3,900B を超えると ct を落として汎用化する（4KB 対策）", async () => {
    const { roomId, auth, kr, pin } = await seedRoom();
    await insertSub({ roomId });
    const justOver = PUSH_CT_INLINE_MAX + 1;
    const wire: WireMessage = {
      v: 1,
      id: crypto.randomUUID(),
      kind: "text",
      name: "さくら",
      ts: Date.now(),
      body: "境界をまたぐ送信",
    };
    // サーバは暗号文長しか見ていないので、3,900B 超かつ 4,096B 以内の ct を作って送る
    const key = await deriveMessageKey(kr, pin, wire.ts);
    const ct = await encryptMessage(key, wire.ts, new Uint8Array(justOver - 28).fill(0x33));
    void encodeMessage(wire);
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: wire.ts, kind: "text", ct: b64(ct) },
    });
    await settle(r.ctx);
    expect(r.status).toBe(201);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const p = payload();
    expect("ct" in p).toBe(false);
    expect(new TextEncoder().encode(rawPayload()).byteLength).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX);
  });

  it("image は汎用ペイロード（ct なし・kind のみ）で FR-6.3 を支える", async () => {
    const { roomId, auth, kr, pin } = await seedRoom();
    await insertSub({ roomId });
    const wire: WireMessage = {
      v: 1,
      id: crypto.randomUUID(),
      kind: "image",
      name: "さくら",
      ts: Date.now(),
      body: { d: "QUJD", m: "image/webp", n: "p.webp" },
    };
    await sendWire(roomId, auth, kr, pin, wire);
    const p = payload();
    expect(p.kind).toBe("image");
    expect("ct" in p).toBe(false);
    expect(rawPayload()).not.toContain("QUJD");
  });

  it("大きなテキスト（4,096B ちょうど）でもペイロードは 4KB 以内", async () => {
    const { roomId, auth, kr, pin } = await seedRoom();
    await insertSub({ roomId });
    const wire: WireMessage = {
      v: 1,
      id: crypto.randomUUID(),
      kind: "text",
      name: "さくら",
      ts: Date.now(),
      body: "大".repeat(1000), // UTF-8 で 3,000B 級の CBOR
    };
    const { r } = await sendWire(roomId, auth, kr, pin, wire);
    expect(r.status).toBe(201);
    const bytes = new TextEncoder().encode(rawPayload());
    expect(bytes.byteLength).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX);
    if (bytes.byteLength > PUSH_CT_INLINE_MAX) {
      expect("ct" in payload()).toBe(false);
    }
    expect(containsBytes(bytes, utf8("aaa"))).toBe(false);
  });
});
