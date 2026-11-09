-- aKta: local bookkeeping for syncing meeting text to Supabase.

CREATE TABLE IF NOT EXISTS akta_supabase_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    url TEXT NOT NULL,
    anon_key TEXT NOT NULL,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

-- Hash of the last payload pushed for each meeting, used to skip unchanged meetings.
CREATE TABLE IF NOT EXISTS akta_supabase_sync_state (
    meeting_id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL,
    synced_at TEXT NOT NULL
);

-- Meetings deleted locally that still have to be deleted in Supabase.
CREATE TABLE IF NOT EXISTS akta_supabase_pending_deletes (
    meeting_id TEXT PRIMARY KEY NOT NULL,
    deleted_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS akta_meeting_deleted
AFTER DELETE ON meetings
BEGIN
    INSERT OR REPLACE INTO akta_supabase_pending_deletes (meeting_id, deleted_at)
    VALUES (OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    DELETE FROM akta_supabase_sync_state WHERE meeting_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS akta_meeting_inserted
AFTER INSERT ON meetings
BEGIN
    DELETE FROM akta_supabase_pending_deletes WHERE meeting_id = NEW.id;
END;
