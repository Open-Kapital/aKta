-- aKta: per-person context learned across meetings (editable in Settings > Pessoas)
ALTER TABLE akta_people ADD COLUMN context TEXT NOT NULL DEFAULT '';
