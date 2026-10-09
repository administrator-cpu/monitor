-- 008_github: which repository, branch and folder belong to a service, and the last GitHub check.
-- Read-only feature: nothing here is ever written back to GitHub.

ALTER TABLE services ADD COLUMN git_repo   TEXT;                      -- 'owner/name'
ALTER TABLE services ADD COLUMN git_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE services ADD COLUMN git_path   TEXT;                      -- folder on this server

CREATE TABLE service_git (
  service_id  INTEGER PRIMARY KEY,
  checked_at  INTEGER NOT NULL,
  state       TEXT    NOT NULL,                                       -- see GitState in @cc/shared
  data        TEXT    NOT NULL                                        -- JSON GitStatusDto
);
