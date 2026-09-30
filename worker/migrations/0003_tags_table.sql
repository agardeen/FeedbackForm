-- Safe to run any time, including against the already-deployed database:
-- only adds a new table, touches nothing existing.
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  show_on TEXT,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
