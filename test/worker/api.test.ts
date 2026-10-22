/**
 * Worker API 統合テスト A1・A2・A4〜A8（設計 §10-2 / §5）
 * ステータスコード・サイズ上限（413）・ページネーション・チャンク往復を検証する。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  applySchema,
  b64,
  call,
  DAY,
  db,
  fakeCt,
  insertMessage,
  seedRoom,
  UUID_A,
  UUID_B,
} from "./helpers.ts";

beforeEach(async () => {
  await applySchema();
});

describe("A1 GET /api/vapid", () => {
  it("VAPID 公開鍵を返す（認証不要）", async () => {
    const r = await call("GET", "/api/vapid");
    expect(r.status).toBe(200);
    expect(typeof r.body.publicKey).toBe("string");
    expect((r.body.publicKey as string).length).toBeGreaterThan(40);
  });
});

describe("A2 POST /api/rooms（FR-1.3 / FR-1.4）", () => {
  const KEY_HASH = "a".repeat(64);

  it("keyHash のみでルームを作成し、UUID v4 を返す", async () => {
    const r = await call("POST", "/api/rooms", { body: { keyHash: KEY_HASH } });
    expect(r.status).toBe(201);
    expect(r.body.roomId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const row = await db
      .prepare("SELECT id, key_hash, created_at, last_msg_at FROM rooms WHERE id = ?1")
      .bind(r.body.roomId)
      .first<{ id: string; key_hash: ArrayBuffer; created_at: number; last_msg_at: number | null }>();
    expect(row).not.toBeNull();
    expect(new Uint8Array(row!.key_hash)).toEqual(new Uint8Array(32).fill(0xaa));
    expect(row!.created_at).toBeGreaterThan(1e12);
    expect(row!.last_msg_at).toBeNull();
  });

  it("不正な keyHash は 400", async () => {
    for (const keyHash of [
      undefined,
      null,
      "",
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      "A".repeat(64), // 大文字は拒否（正規表現が小文字のみ）
      123,
      { keyHash: "x" },
    ]) {
      const r = await call("POST", "/api/rooms", { body: { keyHash } });
      expect(r.status, `keyHash=${JSON.stringify(keyHash)}`).toBe(400);
      expect(r.body.error).toBe("bad_request");
    }
  });

  it("JSON でないボディは 400（500 にしない）", async () => {
    const r = await call("POST", "/api/rooms", { raw: "not-json{{{" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_request");
  });

  it("ボディが 192KB を超えると 413（設計 §4.2）", async () => {
    const big = "A".repeat(200 * 1024);
    const r = await call("POST", "/api/rooms", { raw: JSON.stringify({ keyHash: "a".repeat(64), pad: big }) });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("too_large");
  });

  it("192KB ちょうどは受理する（境界の内側）", async () => {
    const pad = "A".repeat(192 * 1024 - 100);
    const r = await call("POST", "/api/rooms", { raw: JSON.stringify({ keyHash: "a".repeat(64), pad }) });
    expect(r.status).toBe(201);
  });

  it("ルーム作成は認証ヘッダ不要（無効なヘッダがあっても成功）", async () => {
    const r = await call("POST", "/api/rooms", {
      body: { keyHash: KEY_HASH },
      headers: { "x-room-auth": "deadbeef" },
    });
    expect(r.status).toBe(201);
  });

  it("未知の API パスは 404", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await call("DELETE", "/api/rooms")).status).toBe(404);
  });

  it("ルームID が UUID v4 でなければ 404（DB を引かない）", async () => {
    for (const id of ["not-a-uuid", "11111111-1111-1111-1111-111111111111", "1".repeat(36)]) {
      const r = await call("GET", `/api/rooms/${id}/messages`, { auth: "a".repeat(64) });
      expect(r.status, id).toBe(404);
      expect(r.body.error).toBe("not_found");
    }
  });
});

describe("A4 POST /api/rooms/:id/messages（設計 §4.2 サイズ上限）", () => {
  it("テキスト消息を保存し、行ID を返す", async () => {
    const { roomId, auth } = await seedRoom();
    const ct = fakeCt(300);
    const ts = Date.now();
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts, kind: "text", ct: b64(ct) },
    });
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe("number");
    expect(r.body.id).toBeGreaterThan(0);

    const row = await db
      .prepare("SELECT room_id, ts, kind, ct, received_at FROM messages WHERE id = ?1")
      .bind(r.body.id)
      .first<{ room_id: string; ts: number; kind: string; ct: ArrayBuffer; received_at: number }>();
    expect(row!.room_id).toBe(roomId);
    expect(row!.kind).toBe("text");
    expect(row!.ts).toBe(ts);
    expect(new Uint8Array(row!.ct)).toEqual(ct);
    expect(row!.received_at).toBeGreaterThan(1e12);

    // rooms.last_msg_at が更新される（FR-8.2 の 30日判定）
    const room = await db.prepare("SELECT last_msg_at FROM rooms WHERE id = ?1")
      .bind(roomId)
      .first<{ last_msg_at: number }>();
    expect(room!.last_msg_at).toBeGreaterThanOrEqual(ts - DAY);
  });

  it("ts の妥当性検査（1e12 以上・未来は+24h まで・整数）", async () => {
    const { roomId, auth } = await seedRoom();
    const now = Date.now();
    const cases: [unknown, number][] = [
      [999_999_999_999, 400], // < TS_MIN
      [1e12, 201],
      [now, 201],
      [now + 24 * 3_600_000 - 60_000, 201],
      [now + 25 * 3_600_000, 400],
      [1.5e12 + 0.5, 400],
      ["1766456400000", 400],
      [null, 400],
    ];
    for (const [ts, expected] of cases) {
      const r = await call("POST", `/api/rooms/${roomId}/messages`, {
        auth,
        body: { ts, kind: "text", ct: b64(fakeCt(64)) },
      });
      expect(r.status, `ts=${String(ts)}`).toBe(expected);
    }
  });

  it("kind は text / image のみ（免責3: 種別検査のみ行う）", async () => {
    const { roomId, auth } = await seedRoom();
    for (const kind of ["file", "TEXT", "", null, 1, "image/png"]) {
      const r = await call("POST", `/api/rooms/${roomId}/messages`, {
        auth,
        body: { ts: Date.now(), kind, ct: b64(fakeCt(64)) },
      });
      expect(r.status, `kind=${String(kind)}`).toBe(400);
    }
  });

  it("ct が base64 でない / 空 の場合は 400", async () => {
    const { roomId, auth } = await seedRoom();
    for (const ct of ["", "not base64!!", "a", "YWJjZw", "Y=" , "YWJjZw===", 123, null, ["YWJj"]]) {
      const r = await call("POST", `/api/rooms/${roomId}/messages`, {
        auth,
        body: { ts: Date.now(), kind: "text", ct },
      });
      expect(r.status, `ct=${JSON.stringify(ct)}`).toBe(400);
    }
  });

  it("テキスト ct が 4,096B を超えると 413（設計 §4.2）", async () => {
    const { roomId, auth } = await seedRoom();
    const ok = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(4096)) },
    });
    expect(ok.status).toBe(201);
    const over = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "text", ct: b64(fakeCt(4097)) },
    });
    expect(over.status).toBe(413);
    expect(over.body.error).toBe("too_large");
    const n = await db.prepare("SELECT COUNT(*) AS c FROM messages").first<{ c: number }>();
    expect(n!.c).toBe(1); // 413 の行は入っていない
  });

  it("画像 ct は 136KiB まで。超過は 413（画像96KB超生成で413 / handoff §5-2）", async () => {
    const { roomId, auth } = await seedRoom();
    const ok = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "image", ct: b64(fakeCt(136 * 1024)) },
    });
    expect(ok.status).toBe(201);
    const over = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "image", ct: b64(fakeCt(136 * 1024 + 1)) },
    });
    expect(over.status).toBe(413);
  });

  it("画像 ct は 48KiB チャンクに分割され、インライン ct は持たない（設計 §4.1）", async () => {
    const { roomId, auth } = await seedRoom();
    const ct = fakeCt(100 * 1024); // 102,400B → 3 chunk
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "image", ct: b64(ct) },
    });
    expect(r.status).toBe(201);
    const row = await db.prepare("SELECT ct FROM messages WHERE id = ?1")
      .bind(r.body.id).first<{ ct: ArrayBuffer | null }>();
    expect(row!.ct).toBeNull();
    const chunks = await db
      .prepare("SELECT seq, length(chunk) AS len FROM message_blobs WHERE msg_id = ?1 ORDER BY seq")
      .bind(r.body.id)
      .all<{ seq: number; len: number }>();
    expect(chunks.results.map((c) => c.len)).toEqual([49152, 49152, 4096]);
    expect(chunks.results.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it("チャンク数が上限 32 を超える送信は 413", async () => {
    const { roomId, auth } = await seedRoom();
    // CHUNK_MAX_COUNT(32) * 48KiB = 1.5MiB 相当は ct 上限で先に弾かれる
    const r = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "image", ct: b64(fakeCt(136 * 1024 + 1024)) },
    });
    expect(r.status).toBe(413);
  });
});

describe("A5 GET /api/rooms/:id/messages（ページネーション・FR-3.5）", () => {
  async function seedMessages(roomId: string, n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      ids.push(await insertMessage({ roomId, ts: 1_766_456_400_000 + i, ct: fakeCt(64, i) }));
    }
    return ids;
  }

  it("after 以降を id 昇順（=受信順）で返す", async () => {
    const { roomId, auth } = await seedRoom();
    const ids = await seedMessages(roomId, 5);
    const r = await call("GET", `/api/rooms/${roomId}/messages?after=${ids[1]}&limit=50`, { auth });
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: { id: number }) => m.id)).toEqual(ids.slice(2));
  });

  it("limit は 50 にclamp され、既定も 50（設計 §4.2）", async () => {
    const { roomId, auth } = await seedRoom();
    await seedMessages(roomId, 55);
    const def = await call("GET", `/api/rooms/${roomId}/messages`, { auth });
    expect(def.body.messages).toHaveLength(50);
    const big = await call("GET", `/api/rooms/${roomId}/messages?limit=1000`, { auth });
    expect(big.body.messages).toHaveLength(50);
    const small = await call("GET", `/api/rooms/${roomId}/messages?limit=3`, { auth });
    expect(small.body.messages).toHaveLength(3);
  });

  it("after/limit の不正値は 400", async () => {
    const { roomId, auth } = await seedRoom();
    for (const q of ["after=-1", "after=abc", "limit=0", "limit=abc", "after=1.5", "limit=-3"]) {
      const r = await call("GET", `/api/rooms/${roomId}/messages?${q}`, { auth });
      expect(r.status, q).toBe(400);
    }
  });

  it("text は ct をインライン、image は ct を返さない（設計 §5 A5）", async () => {
    const { roomId, auth } = await seedRoom();
    const textId = await insertMessage({ roomId, kind: "text", ct: fakeCt(80) });
    const imageId = await insertMessage({
      roomId,
      kind: "image",
      ct: null,
      blobs: [fakeCt(1000)],
    });
    const r = await call("GET", `/api/rooms/${roomId}/messages`, { auth });
    const text = r.body.messages.find((m: { id: number }) => m.id === textId);
    const image = r.body.messages.find((m: { id: number }) => m.id === imageId);
    expect(typeof text.ct).toBe("string");
    expect(text.kind).toBe("text");
    expect("ct" in image).toBe(false);
    expect(image.kind).toBe("image");
    expect(text.ts).toBeGreaterThan(1e12);
  });

  it("他ルームのメッセージは混入しない", async () => {
    const a = await seedRoom({ roomId: UUID_A });
    const b = await seedRoom({ roomId: UUID_B });
    await insertMessage({ roomId: b.roomId, ct: fakeCt(64) });
    const r = await call("GET", `/api/rooms/${a.roomId}/messages`, { auth: a.auth });
    expect(r.body.messages).toEqual([]);
  });
});

describe("A6 GET /api/rooms/:id/messages/:mid/data（チャンク往復）", () => {
  it("チャンクを結合して元の ct をそのまま返す（画像100KB往復）", async () => {
    const { roomId, auth } = await seedRoom();
    const ct = new Uint8Array(100 * 1024);
    for (let i = 0; i < ct.length; i++) ct[i] = (i * 7 + (i >> 8)) & 0xff;
    const post = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "image", ct: b64(ct) },
    });
    const r = await call("GET", `/api/rooms/${roomId}/messages/${post.body.id}/data`, { auth });
    expect(r.status).toBe(200);
    const got = new Uint8Array(Buffer.from(r.body.ct as string, "base64"));
    expect(got).toEqual(ct);
  });

  it("48KiB ちょうどの ct は 1チャンクで往復する（境界）", async () => {
    const { roomId, auth } = await seedRoom();
    const ct = fakeCt(49152, 3);
    const post = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: Date.now(), kind: "image", ct: b64(ct) },
    });
    const r = await call("GET", `/api/rooms/${roomId}/messages/${post.body.id}/data`, { auth });
    expect(new Uint8Array(Buffer.from(r.body.ct as string, "base64"))).toEqual(ct);
    const n = await db.prepare("SELECT COUNT(*) AS c FROM message_blobs WHERE msg_id = ?1")
      .bind(post.body.id).first<{ c: number }>();
    expect(n!.c).toBe(1);
  });

  it("text の data 取得は 404", async () => {
    const { roomId, auth } = await seedRoom();
    const id = await insertMessage({ roomId, kind: "text", ct: fakeCt(64) });
    const r = await call("GET", `/api/rooms/${roomId}/messages/${id}/data`, { auth });
    expect(r.status).toBe(404);
  });

  it("他ルームのメッセージID を指定すると 404", async () => {
    const a = await seedRoom({ roomId: UUID_A });
    const b = await seedRoom({ roomId: UUID_B });
    const id = await insertMessage({ roomId: b.roomId, kind: "image", ct: null, blobs: [fakeCt(64)] });
    const r = await call("GET", `/api/rooms/${a.roomId}/messages/${id}/data`, { auth: a.auth });
    expect(r.status).toBe(404);
  });

  it("存在しないメッセージID は 404", async () => {
    const { roomId, auth } = await seedRoom();
    const r = await call("GET", `/api/rooms/${roomId}/messages/999999/data`, { auth });
    expect(r.status).toBe(404);
  });
});

describe("A7/A8 購読（FR-6.1 の 20件上限）", () => {
  it("PUT で購読保存 → DELETE で削除", async () => {
    const { roomId, auth } = await seedRoom();
    const put = await call("PUT", `/api/rooms/${roomId}/subscription`, {
      auth,
      body: { endpoint: "https://push.example/1", p256dh: "pk", auth: "ak" },
    });
    expect(put.status).toBe(204);
    const row = await db.prepare("SELECT endpoint, room_id FROM push_subs WHERE endpoint = ?1")
      .bind("https://push.example/1").first<{ endpoint: string; room_id: string }>();
    expect(row!.room_id).toBe(roomId);

    const del = await call("DELETE", `/api/rooms/${roomId}/subscription`, {
      auth,
      body: { endpoint: "https://push.example/1" },
    });
    expect(del.status).toBe(204);
    const after = await db.prepare("SELECT COUNT(*) AS c FROM push_subs").first<{ c: number }>();
    expect(after!.c).toBe(0);
  });

  it("同一 endpoint の PUT は upsert（重複行を作らない）", async () => {
    const { roomId, auth } = await seedRoom();
    for (const p256dh of ["pk1", "pk2"]) {
      const r = await call("PUT", `/api/rooms/${roomId}/subscription`, {
        auth,
        body: { endpoint: "https://push.example/dup", p256dh, auth: "ak" },
      });
      expect(r.status).toBe(204);
    }
    const rows = await db.prepare("SELECT p256dh FROM push_subs").all<{ p256dh: string }>();
    expect(rows.results).toEqual([{ p256dh: "pk2" }]);
  });

  it("21件目の購読で最古が削除され、ルームあたり 20 件以内になる", async () => {
    const { roomId, auth } = await seedRoom();
    for (let i = 0; i < 21; i++) {
      const r = await call("PUT", `/api/rooms/${roomId}/subscription`, {
        auth,
        body: { endpoint: `https://push.example/s${i}`, p256dh: `pk${i}`, auth: `ak${i}` },
      });
      expect(r.status).toBe(204);
      await new Promise((res) => setTimeout(res, 2)); // created_at の順序を確実にする
    }
    const rows = await db.prepare("SELECT endpoint FROM push_subs WHERE room_id = ?1 ORDER BY created_at")
      .bind(roomId).all<{ endpoint: string }>();
    expect(rows.results).toHaveLength(20);
    expect(rows.results.map((r) => r.endpoint)).not.toContain("https://push.example/s0");
    expect(rows.results.map((r) => r.endpoint)).toContain("https://push.example/s20");
  });

  it("不正な購読ボディは 400", async () => {
    const { roomId, auth } = await seedRoom();
    const cases: unknown[] = [
      {},
      { endpoint: "", p256dh: "p", auth: "a" },
      { endpoint: "https://push.example/x", p256dh: "", auth: "a" },
      { endpoint: "https://push.example/x", p256dh: "p", auth: "" },
      { endpoint: 1, p256dh: "p", auth: "a" },
      { endpoint: "x".repeat(1501), p256dh: "p", auth: "a" },
      { endpoint: "https://push.example/x", p256dh: "p".repeat(201), auth: "a" },
    ];
    for (const body of cases) {
      const r = await call("PUT", `/api/rooms/${roomId}/subscription`, { auth, body });
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });

  it("DELETE は他ルームの購読を消さない", async () => {
    const a = await seedRoom({ roomId: UUID_A });
    const b = await seedRoom({ roomId: UUID_B });
    const ep = "https://push.example/shared";
    await call("PUT", `/api/rooms/${a.roomId}/subscription`, { auth: a.auth, body: { endpoint: ep, p256dh: "p", auth: "k" } });
    const r = await call("DELETE", `/api/rooms/${b.roomId}/subscription`, { auth: b.auth, body: { endpoint: ep } });
    expect(r.status).toBe(204);
    const n = await db.prepare("SELECT COUNT(*) AS c FROM push_subs WHERE endpoint = ?1").bind(ep)
      .first<{ c: number }>();
    expect(n!.c).toBe(1);
  });
});
