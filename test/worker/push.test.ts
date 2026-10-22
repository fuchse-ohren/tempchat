/**
 * Webプッシュ配信の統合テスト（設計 §10-2「push 送信は web-push をモックして
 * 呼び出し・404/410削除を検証」/ FR-6.1・FR-6.3・FR-6.6・設計 §6.5）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySchema,
  b64,
  call,
  db,
  fakeCt,
  insertSub,
  seedRoom,
  settle,
  UUID_A,
  UUID_B,
} from "./helpers.ts";

const { sendNotification, setVapidDetails } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

beforeEach(async () => {
  await applySchema();
  sendNotification.mockReset();
  setVapidDetails.mockReset();
});

interface SendCall {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  payload: string;
  options: { TTL?: number } | undefined;
}

/** sendNotification の呼び出し引数は [subscription, payload, options] */
function sent(): SendCall[] {
  return sendNotification.mock.calls.map((c) => {
    const [sub, payload, options] =
      c as unknown as [
        { endpoint: string; keys: { p256dh: string; auth: string } },
        string,
        { TTL?: number } | undefined,
      ];
    return { endpoint: sub.endpoint, keys: sub.keys, payload, options };
  });
}

function payloadOf(endpoint: string): SendCall | undefined {
  return sent().find((c) => c.endpoint === endpoint);
}

describe("メッセージ送信時の push 配信（設計 §6.5）", () => {
  it("購読がゼロなら web-push を一切呼ばない", async () => {
    const { roomId, auth } = await seedRoom();
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    expect(r.status).toBe(201);
    await settle(r.ctx);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(setVapidDetails).not.toHaveBeenCalled();
  });

  it("そのルームの購読数ぶんだけ送信し、TTL は 3600 秒", async () => {
    const { roomId, auth } = await seedRoom();
    const e1 = await insertSub({ roomId, endpoint: "https://push.example/a", p256dh: "p1", auth: "k1" });
    const e2 = await insertSub({ roomId, endpoint: "https://push.example/b", p256dh: "p2", auth: "k2" });
    const other = await seedRoom({ roomId: UUID_B });
    await insertSub({ roomId: other.roomId, endpoint: "https://push.example/other" });

    const ct = fakeCt(120);
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: 1_766_456_400_000, kind: "text", ct: b64(ct) },
    });
    await settle(r.ctx);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const c of sent()) {
      expect(c.options).toEqual({ TTL: 3600 });
      expect(c.keys).toMatchObject({ p256dh: expect.any(String), auth: expect.any(String) });
    }
    expect(sent().map((c) => c.endpoint).sort()).toEqual([e1, e2].sort());
    expect(payloadOf("https://push.example/other")).toBeUndefined();
  });

  it("テキストは ct を同梱した JSON ペイロード（FR-6.2 の復号材料）", async () => {
    const { roomId, auth } = await seedRoom();
    const ep = await insertSub({ roomId });
    const ct = fakeCt(200);
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: 1_766_456_400_000, kind: "text", ct: b64(ct) },
    });
    await settle(r.ctx);
    const c = payloadOf(ep)!;
    const p = JSON.parse(c.payload);
    expect(p).toMatchObject({
      v: 1,
      roomId,
      id: r.body.id,
      ts: 1_766_456_400_000,
      kind: "text",
    });
    expect(new Uint8Array(Buffer.from(p.ct as string, "base64"))).toEqual(ct);
    // ペイロードは 4KB 以内（設計 §6.5・要件 制約2）
    expect(new TextEncoder().encode(c.payload).byteLength).toBeLessThanOrEqual(4096);
  });

  it("画像は ct を入れない汎用ペイロード（FR-6.3）", async () => {
    const { roomId, auth } = await seedRoom();
    const ep = await insertSub({ roomId });
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: 1_766_456_400_000, kind: "image", ct: b64(fakeCt(5000)) },
    });
    await settle(r.ctx);
    const p = JSON.parse(payloadOf(ep)!.payload);
    expect(p.kind).toBe("image");
    expect("ct" in p).toBe(false);
  });

  it("ct が 3,900B を超えるテキストは ct を落として汎用化する（4KB 制限対策）", async () => {
    const { roomId, auth } = await seedRoom();
    const ep = await insertSub({ roomId });
    const big = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(3_901)) },
    });
    await settle(big.ctx);
    expect(big.status).toBe(201);
    const p = JSON.parse(payloadOf(ep)!.payload);
    expect("ct" in p).toBe(false);
    expect(p.kind).toBe("text");
  });

  it("1ルームあたり最大 20 購読まで送る（設計 §4.2 の購読数上限）", async () => {
    const { roomId, auth } = await seedRoom();
    for (let i = 0; i < 25; i++) {
      await insertSub({ roomId, endpoint: `https://push.example/n${i}` });
    }
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    await settle(r.ctx);
    expect(sendNotification).toHaveBeenCalledTimes(20);
  });

  it("配信エラー（500）は握りつぶし、API 応答と購読はそのまま", async () => {
    const { roomId, auth } = await seedRoom();
    const ep = await insertSub({ roomId });
    sendNotification.mockRejectedValue({ statusCode: 500, message: "boom" });
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    expect(r.status).toBe(201);
    await settle(r.ctx);
    const n = await db.prepare("SELECT COUNT(*) AS c FROM push_subs WHERE endpoint = ?1").bind(ep)
      .first<{ c: number }>();
    expect(n!.c).toBe(1);
  });

  it("1件の配信失敗が他の購読を止めない", async () => {
    const { roomId, auth } = await seedRoom();
    const bad = await insertSub({ roomId, endpoint: "https://push.example/bad" });
    const good = await insertSub({ roomId, endpoint: "https://push.example/good" });
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === bad) throw { statusCode: 500 };
      return { statusCode: 201 };
    });
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    await settle(r.ctx);
    const eps = sent().map((c) => c.endpoint);
    expect(eps).toContain(bad);
    expect(eps).toContain(good);
  });

  it("404 / 410 が返った購読は DB から除去する（FR-6.6）", async () => {
    const { roomId, auth } = await seedRoom();
    const gone404 = await insertSub({ roomId, endpoint: "https://push.example/404" });
    const gone410 = await insertSub({ roomId, endpoint: "https://push.example/410" });
    const kept = await insertSub({ roomId, endpoint: "https://push.example/200" });
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === gone404) throw { statusCode: 404 };
      if (sub.endpoint === gone410) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    await settle(r.ctx);
    const eps = (await db.prepare("SELECT endpoint FROM push_subs ORDER BY endpoint").all<{ endpoint: string }>())
      .results.map((e) => e.endpoint);
    expect(eps).toEqual([kept]);
  });

  it("sendPush は VAPID 詳細を設定する（3種のシークレット利用）", async () => {
    const { roomId, auth } = await seedRoom();
    await insertSub({ roomId });
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    await settle(r.ctx);
    expect(setVapidDetails).toHaveBeenCalledTimes(1);
    const args = setVapidDetails.mock.calls[0] as unknown as [string, string, string];
    expect(args[0]).toMatch(/^mailto:/);
    expect(typeof args[1]).toBe("string");
    expect(typeof args[2]).toBe("string");
    // 秘密鍵の値そのものはレスポンスにも DB にも出さない
    expect(JSON.stringify(r.body)).not.toContain(args[2]);
  });

  it("別ルームの購読には配信しない（ルーム単位購読 FR-6.1）", async () => {
    const a = await seedRoom({ roomId: UUID_A });
    const b = await seedRoom({ roomId: UUID_B });
    await insertSub({ roomId: b.roomId, endpoint: "https://push.example/only-b" });
    const r = await call("POST", `/api/rooms/${a.roomId}/messages`, {
      auth: a.auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    await settle(r.ctx);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("DELETE /subscription 後は配信対象から外れる（A8 との連携）", async () => {
    const { roomId, auth } = await seedRoom();
    const ep = await insertSub({ roomId });
    const del = await call("DELETE", `/api/rooms/${roomId}/subscription`, { auth, body: { endpoint: ep } });
    expect(del.status).toBe(204);
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(64)) },
    });
    await settle(r.ctx);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
