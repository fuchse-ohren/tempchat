/**
 * Cron 削除（purgeExpired）の境界テスト（設計 §10-2「purge SQL（時刻注入で7日/30日境界）」/ FR-8）
 * 時刻は purgeExpired(env, now) の注入引数で制御する（real clock を進めない）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DAY,
  applySchema,
  db,
  fakeCt,
  insertMessage,
  insertSub,
  seedRoom,
  testEnv,
  UUID_A,
  UUID_B,
} from "./helpers.ts";
import { purgeExpired } from "../../src/worker/scheduled.ts";
import worker from "../../src/worker/index.ts";
import { createExecutionContext, settle } from "./helpers.ts";

const NOW = 1_766_456_400_000; // 2025-12-23T13:00:00Z 相当の固定時刻

async function counts() {
  const out: Record<string, number> = {};
  for (const t of ["rooms", "messages", "message_blobs", "push_subs"]) {
    const r = await db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first<{ c: number }>();
    out[t] = r!.c;
  }
  return out;
}

beforeEach(async () => {
  await applySchema();
});

describe("FR-8.1 メッセージは受信から7日で削除", () => {
  it("受信8日前は削除／6日前は保持", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW });
    const oldId = await insertMessage({ roomId, ct: fakeCt(64), receivedAt: NOW - 8 * DAY });
    const newId = await insertMessage({ roomId, ct: fakeCt(64), receivedAt: NOW - 6 * DAY });
    await purgeExpired(testEnv, NOW);
    const rows = await db.prepare("SELECT id FROM messages ORDER BY id").all<{ id: number }>();
    expect(rows.results.map((r) => r.id)).toEqual([newId]);
    expect(rows.results.map((r) => r.id)).not.toContain(oldId);
  });

  it("ちょうど7日前（境界値）は保持し、7日+1ms で削除する", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW });
    const exact = await insertMessage({ roomId, ct: fakeCt(32), receivedAt: NOW - 7 * DAY });
    const justOver = await insertMessage({ roomId, ct: fakeCt(32), receivedAt: NOW - 7 * DAY - 1 });
    await purgeExpired(testEnv, NOW);
    const ids = (await db.prepare("SELECT id FROM messages ORDER BY id").all<{ id: number }>())
      .results.map((r) => r.id);
    expect(ids).toContain(exact); // received_at < now-7d が条件（同一時刻は保持）
    expect(ids).not.toContain(justOver);
  });

  it("画像チャンク（message_blobs）も従属削除される", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW });
    const oldId = await insertMessage({
      roomId,
      kind: "image",
      ct: null,
      receivedAt: NOW - 8 * DAY,
      blobs: [fakeCt(1000), fakeCt(1000)],
    });
    const newId = await insertMessage({
      roomId,
      kind: "image",
      ct: null,
      receivedAt: NOW - 1 * DAY,
      blobs: [fakeCt(1000)],
    });
    await purgeExpired(testEnv, NOW);
    const blobs = await db
      .prepare("SELECT DISTINCT msg_id FROM message_blobs ORDER BY msg_id")
      .all<{ msg_id: number }>();
    expect(blobs.results.map((b) => b.msg_id)).toEqual([newId]);
    expect(blobs.results.map((b) => b.msg_id)).not.toContain(oldId);
  });

  it("他ルームの期限前メッセージは影響を受けない", async () => {
    const a = await seedRoom({ roomId: UUID_A, createdAt: NOW });
    const b = await seedRoom({ roomId: UUID_B, createdAt: NOW });
    await insertMessage({ roomId: a.roomId, ct: fakeCt(8), receivedAt: NOW - 8 * DAY });
    const keep = await insertMessage({ roomId: b.roomId, ct: fakeCt(8), receivedAt: NOW - 2 * DAY });
    await purgeExpired(testEnv, NOW);
    const ids = (await db.prepare("SELECT id, room_id FROM messages").all<{ id: number; room_id: string }>()).results;
    expect(ids.map((i) => i.room_id)).toEqual([b.roomId]);
    expect(ids[0]!.id).toBe(keep);
  });
});

describe("FR-8.2 ルームは最終メッセージから30日でまるごと削除", () => {
  it("最終メッセージ31日前 → ルーム・メッセージ・blob・購読が消える", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW - 40 * DAY, lastMsgAt: NOW - 31 * DAY });
    await insertMessage({
      roomId,
      kind: "image",
      ct: null,
      receivedAt: NOW - 31 * DAY,
      blobs: [fakeCt(500)],
    });
    await insertSub({ roomId });
    await purgeExpired(testEnv, NOW);
    expect(await counts()).toEqual({
      rooms: 0,
      messages: 0,
      message_blobs: 0,
      push_subs: 0,
    });
  });

  it("最終メッセージから29日（境界の内側）ならルーム・購読は保持される", async () => {
    // 30日判定は rooms.last_msg_at、7日判定は messages.received_at で独立に働く（FR-8.1/8.2）。
    // ここでは「29日前に最終メッセージのあったルーム」を表すため
    // last_msg_at=29日前、保持対象となる7日以内のメッセージを1件入れる。
    const { roomId } = await seedRoom({ createdAt: NOW - 40 * DAY, lastMsgAt: NOW - 29 * DAY });
    const keep = await insertMessage({
      roomId,
      kind: "image",
      ct: null,
      receivedAt: NOW - 6 * DAY,
      blobs: [fakeCt(500)],
    });
    await insertSub({ roomId });
    await purgeExpired(testEnv, NOW);
    expect(await counts()).toEqual({
      rooms: 1,
      messages: 1,
      message_blobs: 1,
      push_subs: 1,
    });
    const ids = (await db.prepare("SELECT id FROM messages").all<{ id: number }>()).results.map((r) => r.id);
    expect(ids).toEqual([keep]);
  });

  it("作成から40日たっても新しいメッセージがあればルームは残る", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW - 40 * DAY, lastMsgAt: NOW - 1000 });
    const fresh = await insertMessage({ roomId, ct: fakeCt(16), receivedAt: NOW - 1000 });
    await purgeExpired(testEnv, NOW);
    const room = await db.prepare("SELECT id FROM rooms WHERE id = ?1").bind(roomId)
      .first<{ id: string }>();
    expect(room).not.toBeNull();
    const n = await db.prepare("SELECT COUNT(*) AS c FROM messages").first<{ c: number }>();
    expect(n!.c).toBe(1);
    void fresh;
  });

  it("メッセージが一度もないルームは created_at で30日判定する（last_msg_at NULL）", async () => {
    const dead = await seedRoom({ roomId: UUID_A, createdAt: NOW - 31 * DAY, lastMsgAt: null });
    const alive = await seedRoom({ roomId: UUID_B, createdAt: NOW - 29 * DAY, lastMsgAt: null });
    await insertSub({ roomId: dead.roomId });
    await insertSub({ roomId: alive.roomId });
    await purgeExpired(testEnv, NOW);
    const rooms = (await db.prepare("SELECT id FROM rooms ORDER BY id").all<{ id: string }>()).results
      .map((r) => r.id);
    expect(rooms).toEqual([alive.roomId]);
    const subs = await db.prepare("SELECT room_id FROM push_subs").all<{ room_id: string }>();
    expect(subs.results.map((s) => s.room_id)).toEqual([alive.roomId]);
  });

  it("30日超ルームの購読だけが消え、他ルームの購読は残る", async () => {
    const dead = await seedRoom({ roomId: UUID_A, createdAt: NOW - 60 * DAY, lastMsgAt: NOW - 40 * DAY });
    const alive = await seedRoom({ roomId: UUID_B, createdAt: NOW - 5 * DAY, lastMsgAt: NOW - DAY });
    await insertSub({ roomId: dead.roomId, endpoint: "https://push.example/dead" });
    await insertSub({ roomId: alive.roomId, endpoint: "https://push.example/alive" });
    await purgeExpired(testEnv, NOW);
    const eps = (await db.prepare("SELECT endpoint FROM push_subs ORDER BY endpoint").all<{ endpoint: string }>())
      .results.map((e) => e.endpoint);
    expect(eps).toEqual(["https://push.example/alive"]);
  });
});

describe("削除の冪等性と cron 経路", () => {
  it("2回実行しても結果は同じ（FR-8.3 冪等 DELETE）", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW - 40 * DAY, lastMsgAt: NOW - 35 * DAY });
    await insertMessage({ roomId, ct: fakeCt(10), receivedAt: NOW - 35 * DAY });
    await purgeExpired(testEnv, NOW);
    const first = await counts();
    await purgeExpired(testEnv, NOW);
    await purgeExpired(testEnv, NOW);
    expect(await counts()).toEqual(first);
    expect(first.rooms).toBe(0);
  });

  it("対象が無い実行は noop（削除数 0・エラーなし）", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW });
    await insertMessage({ roomId, ct: fakeCt(10), receivedAt: NOW });
    await purgeExpired(testEnv, NOW);
    expect((await counts()).messages).toBe(1);
  });

  it("scheduled ハンドラ経由でも purge が走る（cron 経路）", async () => {
    const { roomId } = await seedRoom({ createdAt: NOW, lastMsgAt: NOW });
    await insertMessage({ roomId, ct: fakeCt(10), receivedAt: NOW - 8 * DAY });
    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: NOW, cron: "*/30 * * * *" } as unknown as ScheduledController,
      testEnv,
      ctx,
    );
    await settle(ctx);
    expect((await counts()).messages).toBe(0);
  });
});
