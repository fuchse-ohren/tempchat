-- tempchat D1 初期スキーマ（設計書 §4.1）
CREATE TABLE rooms (
  id           TEXT PRIMARY KEY,
  key_hash     BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  last_msg_at  INTEGER
);

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text','image')),
  ct           BLOB,
  received_at  INTEGER NOT NULL
);
CREATE INDEX idx_messages_room ON messages(room_id, id);

CREATE TABLE message_blobs (
  msg_id  INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  chunk   BLOB NOT NULL,
  PRIMARY KEY (msg_id, seq)
);

CREATE TABLE push_subs (
  endpoint   TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_push_room ON push_subs(room_id);
