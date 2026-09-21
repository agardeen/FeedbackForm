-- Synced records: one row per app entry (feedback, survey, contact, quick
-- capture, meeting note, todo). `data` holds the full entry as JSON, the same
-- shape the app already uses locally and in its "Export All (JSON)" button —
-- so the Worker never needs to know the field layout of each entry type.
--
-- Deletes are soft (deleted_at set, row kept) so a `pull` can tell other
-- devices "this id was removed" instead of just silently no longer sending it.
CREATE TABLE IF NOT EXISTS records (
  type TEXT NOT NULL,        -- 'feedback' | 'qa' | 'contacts' | 'quickCaptures' | 'meetingNotes' | 'todos'
  id TEXT NOT NULL,
  data TEXT NOT NULL,        -- JSON-encoded entry
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (type, id)
);

CREATE INDEX IF NOT EXISTS idx_records_type_updated ON records(type, updated_at);

-- Synced media (photos, audio, scans). The actual bytes live in R2 under the
-- key `${kind}/${id}`; this table is just enough metadata to list/pull without
-- fetching every blob from R2.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,        -- 'card' | 'meeting-notes' | ...
  content_type TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_media_updated ON media(updated_at);
