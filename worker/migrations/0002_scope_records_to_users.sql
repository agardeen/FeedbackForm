-- Run this ONLY after 0001_users_table.sql has been applied AND you've
-- created the account that should own all pre-existing (pre-login) data —
-- see migrations/README.md for the full sequence. Before running, replace
-- every occurrence of OWNER_USER_ID below with the "id" that
-- POST /auth/admin/create-user returned for that account.
--
-- This reshapes `records` and `media` to be scoped per user (adds user_id
-- to the primary key / as a required column) and backfills every existing
-- row as belonging to OWNER_USER_ID.

ALTER TABLE records RENAME TO records_old;

CREATE TABLE records (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, type, id)
);

INSERT INTO records (user_id, type, id, data, updated_at, deleted_at)
  SELECT 'OWNER_USER_ID', type, id, data, updated_at, deleted_at FROM records_old;

DROP TABLE records_old;

CREATE INDEX IF NOT EXISTS idx_records_user_type_updated ON records(user_id, type, updated_at);

ALTER TABLE media RENAME TO media_old;

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

INSERT INTO media (id, user_id, kind, content_type, updated_at, deleted_at)
  SELECT id, 'OWNER_USER_ID', kind, content_type, updated_at, deleted_at FROM media_old;

DROP TABLE media_old;

CREATE INDEX IF NOT EXISTS idx_media_user_updated ON media(user_id, updated_at);
