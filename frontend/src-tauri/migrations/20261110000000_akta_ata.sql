-- aKta: people roster (name + initials) and structured meeting minutes ("atas")
CREATE TABLE IF NOT EXISTS akta_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    initials TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS akta_meeting_reports (
    meeting_id TEXT PRIMARY KEY,
    meta TEXT NOT NULL DEFAULT '{}',
    report TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS akta_meeting_reports_cleanup
AFTER DELETE ON meetings
BEGIN
    DELETE FROM akta_meeting_reports WHERE meeting_id = OLD.id;
END;
