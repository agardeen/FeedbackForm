-- Fresh-install schema (a brand-new D1 database). If you're upgrading an
-- already-deployed database that has data in it, do NOT just re-run this —
-- use the migrations/ folder instead, which reshapes the existing tables in
-- place and backfills a `user_id` for pre-existing rows. See
-- migrations/README.md.

-- Login accounts. No public sign-up: created by an admin via
-- POST /auth/admin/create-user. Passwords are stored as salted PBKDF2
-- hashes, never plaintext. `is_admin` accounts can additionally read (not
-- write or delete) every other account's synced data, for oversight/export.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,   -- stored lowercase; login is case-insensitive
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Synced records: one row per app entry (feedback, survey, contact, quick
-- capture, meeting note, todo), scoped to the account that created it.
-- `data` holds the full entry as JSON, the same shape the app already uses
-- locally and in its "Export All (JSON)" button — so the Worker never needs
-- to know the field layout of each entry type.
--
-- Deletes are soft (deleted_at set, row kept) so a `pull` can tell other
-- devices "this id was removed" instead of just silently no longer sending it.
CREATE TABLE IF NOT EXISTS records (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'feedback' | 'qa' | 'contacts' | 'quickCaptures' | 'meetingNotes' | 'todos' | 'events'
  id TEXT NOT NULL,
  data TEXT NOT NULL,        -- JSON-encoded entry
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, type, id)
);

CREATE INDEX IF NOT EXISTS idx_records_user_type_updated ON records(user_id, type, updated_at);

-- Synced media (photos, audio, scans), scoped to the account that uploaded
-- it. The actual bytes live in R2 under the key `${id}`; this table is just
-- enough metadata to list/pull without fetching every blob from R2.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- 'card' | 'meeting-notes' | ...
  content_type TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_media_user_updated ON media(user_id, updated_at);

-- Shared tag tree — NOT scoped per account, unlike every table above. One
-- hierarchy for the whole team, used to tag Contacts/Quick Captures/Meeting
-- Notes/Todos. parent_id = NULL means a top-level category (e.g. "People",
-- "Companies", "Products"); nesting under those is unlimited. `show_on` (a
-- JSON array of tab keys, only meaningful on a top-level category) controls
-- which of the four tabs' tag pickers offer that category. Any account can
-- add a node; only is_admin accounts can rename/move/reorder/delete one —
-- enforced in the Worker, not by this schema.
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  show_on TEXT,              -- JSON array, e.g. '["contacts","quickCaptures"]'
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
