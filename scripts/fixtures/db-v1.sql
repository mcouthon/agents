-- Schema 1 as it shipped: task.json projections, runs/reports/checkpoints, the
-- events and decisions of the first engine. Seed rows cover the shapes the
-- migration converts; the migration tests add repo- and landing-specific rows
-- on top. Apply to an empty file with node:sqlite's exec().
PRAGMA journal_mode=delete;
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (1);
CREATE TABLE repos (
  key TEXT PRIMARY KEY, ord INTEGER NOT NULL, main_root TEXT, doc TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, repo_key TEXT NOT NULL, dir_name TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'active' CHECK (disposition IN ('active','archived','deleted')),
  task_dir TEXT NOT NULL, files_dir TEXT NOT NULL,
  slug TEXT, number INTEGER, title TEXT, status TEXT, tier TEXT, mode TEXT,
  created TEXT, updated TEXT, doc TEXT NOT NULL,
  next_json TEXT, awaiting TEXT,
  UNIQUE (repo_key, dir_name));
CREATE TABLE phases (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, ord INTEGER NOT NULL,
  phase_id INTEGER, name TEXT, status TEXT, owner TEXT, branch TEXT, plan_path TEXT,
  landed_sha TEXT, started TEXT, completed TEXT, PRIMARY KEY (task_id, ord));
CREATE TABLE reports (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, phase_ord INTEGER NOT NULL,
  agent TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (task_id, phase_ord, agent));
CREATE TABLE checkpoints (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, ord INTEGER NOT NULL,
  checkpoint_id TEXT, phase INTEGER, type TEXT, chosen TEXT, doc TEXT NOT NULL,
  PRIMARY KEY (task_id, ord));
CREATE TABLE sessions (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT, terminal_id TEXT, repo_key TEXT, task_dir TEXT, agent TEXT, origin TEXT,
  cwd TEXT, pid INTEGER, created_at TEXT, updated_at TEXT, ended_at TEXT, doc TEXT NOT NULL);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
  repo_key TEXT, task_id INTEGER, session_id TEXT, detail TEXT);
CREATE TABLE runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  phase_id INTEGER NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
  session_id TEXT NOT NULL, session_dir TEXT NOT NULL, resumed_from INTEGER,
  pid INTEGER, model TEXT, requested_model TEXT, budget_usd REAL, cwd TEXT NOT NULL, brief TEXT NOT NULL,
  stream_path TEXT NOT NULL, err_path TEXT NOT NULL, exit_path TEXT NOT NULL,
  transcript_path TEXT, exit_code INTEGER, subtype TEXT, terminal_reason TEXT,
  cost_usd REAL, duration_ms INTEGER, num_turns INTEGER, permission_denials TEXT,
  result_text TEXT, error TEXT, git_status TEXT, transition TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, reaping_at TEXT);
CREATE TABLE decisions (
  decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  phase_id INTEGER NOT NULL, choice TEXT NOT NULL, quote TEXT NOT NULL,
  transition TEXT, error TEXT, recorded_by TEXT,
  decided_at TEXT NOT NULL, consumed_at TEXT, consumed_by TEXT);
CREATE INDEX IF NOT EXISTS decisions_task ON decisions (task_id, phase_id);
CREATE INDEX IF NOT EXISTS tasks_repo ON tasks (repo_key, disposition);
CREATE INDEX IF NOT EXISTS sessions_repo ON sessions (repo_key);
CREATE INDEX IF NOT EXISTS runs_task ON runs (task_id, phase_id);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);

-- A repo every seed task belongs to (its main_root points nowhere; the tests
-- that need git overwrite this row).
INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES
  ('github.com/acme/one', 0, '/nonexistent/acme/one',
   '{"main_root": "/nonexistent/acme/one", "last_seen": "2026-10-01T10:00:00.000Z"}', '2026-10-01T10:00:00.000Z');

-- Every stored phase status, one task each; knobs on the first; a files_dir fold
-- on the second; a skip decision on the skipped one's phase.
INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc, next_json, awaiting) VALUES
  (1, 'github.com/acme/one', '001-every-status', 'active', '$TASKS_ROOT/github.com/acme/one/001-every-status', '$TASKS_ROOT/github.com/acme/one/001-every-status',
   'every-status', 1, 'Every status', 'in_progress', 'standard', 'full', '2026-09-01', '2026-10-01T10:00:00.000Z',
   '{"schema":2,"slug":"every-status","number":1,"title":"Every status","status":"in_progress","mode":"full","tier":"standard","knobs":{"approvals":"ask","land":"per_phase"},"phases":[{"id":1,"name":"Committed","status":"committed","blocked_by":[],"checked_at":"2026-09-02T10:00:00.000Z"},{"id":2,"name":"Landed","status":"landed","blocked_by":[1],"branch":"wt/001","completed":"2026-09-03T10:00:00.000Z"},{"id":3,"name":"Done","status":"done","blocked_by":[2]},{"id":4,"name":"Skipped","status":"skipped","blocked_by":[]},{"id":5,"name":"Descoped","status":"descoped","blocked_by":[]},{"id":6,"name":"Failed","status":"failed","blocked_by":[]},{"id":7,"name":"Approved","status":"approved","blocked_by":[]},{"id":8,"name":"In progress","status":"in_progress","blocked_by":[]},{"id":9,"name":"Implemented","status":"implemented","blocked_by":[]},{"id":10,"name":"Not started","status":"not_started","blocked_by":[]}],"worktree_path":"","created":"2026-09-01","updated":"2026-10-01T10:00:00.000Z"}',
   NULL, NULL),
  (2, 'github.com/acme/one', '002-fold', 'active', '$TASKS_ROOT/github.com/acme/one/002-fold', '/work/acme/one/.tasks/002-fold',
   'fold', 2, 'A pending fold', 'planning', 'standard', 'full', '2026-09-01', '2026-10-01T11:00:00.000Z',
   '{"schema":2,"slug":"fold","number":2,"title":"A pending fold","status":"planning","mode":"full","tier":"standard","knobs":{},"phases":[{"id":1,"name":"Only","status":"planned","blocked_by":[],"note":"sits in the repo folder"}],"worktree_path":"","files_dir":"/work/acme/one/.tasks/002-fold","created":"2026-09-01","updated":"2026-10-01T11:00:00.000Z"}',
   NULL, NULL),
  (3, 'github.com/acme/one', '003-skipped-with-decision', 'active', '$TASKS_ROOT/github.com/acme/one/003-skipped-with-decision', '$TASKS_ROOT/github.com/acme/one/003-skipped-with-decision',
   'skipped-with-decision', 3, 'Skipped already decided', 'planning', 'standard', 'full', '2026-09-01', '2026-10-01T12:00:00.000Z',
   '{"schema":2,"slug":"skipped-with-decision","number":3,"title":"Skipped already decided","status":"planning","mode":"full","tier":"standard","knobs":{"land":"at_end"},"phases":[{"id":1,"name":"Only","status":"skipped","blocked_by":[]}],"worktree_path":"","created":"2026-09-01","updated":"2026-10-01T12:00:00.000Z"}',
   NULL, NULL);

INSERT INTO phases (task_id, ord, phase_id, name, status, owner, branch, plan_path, landed_sha, started, completed) VALUES
  (1, 0, 1, 'Committed', 'committed', NULL, NULL, NULL, NULL, '2026-09-02T10:00:00.000Z', NULL),
  (1, 1, 2, 'Landed', 'landed', NULL, 'wt/001', NULL, '0000000000000000000000000000000000000001', NULL, '2026-09-03T10:00:00.000Z'),
  (1, 2, 3, 'Done', 'done', NULL, NULL, NULL, NULL, NULL, NULL),
  (1, 3, 4, 'Skipped', 'skipped', NULL, NULL, NULL, NULL, NULL, NULL),
  (1, 4, 5, 'Descoped', 'descoped', NULL, NULL, NULL, NULL, NULL, NULL),
  (1, 5, 6, 'Failed', 'failed', NULL, NULL, NULL, NULL, NULL, NULL),
  (1, 6, 7, 'Approved', 'approved', NULL, NULL, NULL, NULL, NULL, NULL),
  (1, 7, 8, 'In progress', 'in_progress', NULL, NULL, NULL, NULL, NULL, NULL),
  (1, 8, 9, 'Implemented', 'implemented', NULL, NULL, NULL, NULL, NULL, NULL),
  (1, 9, 10, 'Not started', 'not_started', NULL, NULL, NULL, NULL, NULL, NULL),
  (2, 0, 1, 'Only', 'planned', NULL, NULL, NULL, NULL, NULL, NULL),
  (3, 0, 1, 'Only', 'skipped', NULL, NULL, NULL, NULL, NULL, NULL);

INSERT INTO decisions (decision_id, task_id, phase_id, choice, quote, recorded_by, decided_at) VALUES
  (1, 3, 1, 'skip', 'not doing this one', 'owner-session', '2026-09-05T10:00:00.000Z');

INSERT INTO events (id, at, kind, repo_key, task_id, session_id, detail) VALUES
  (1, '2026-09-01T10:00:00.000Z', 'task.write', 'github.com/acme/one', 1, NULL, '["planning"]'),
  (2, '2026-10-01T10:00:00.000Z', 'decide', 'github.com/acme/one', 3, 'owner-session', '{"decision_id":1,"phase_id":1,"choice":"skip"}');

INSERT INTO reports (task_id, phase_ord, agent, doc) VALUES (1, 0, 'builder', '{"v":1}');
INSERT INTO checkpoints (task_id, ord, checkpoint_id, phase, type, chosen, doc) VALUES (1, 0, 'cp-1', 1, 'approve_plan', NULL, '{"id":"cp-1"}');
INSERT INTO runs (run_id, task_id, phase_id, agent, status, session_id, session_dir, cwd, brief, stream_path, err_path, exit_path, started_at) VALUES
  (1, 1, 1, 'builder', 'done', 'r-s', '/work/sessions/r-s', '/work/repo', 'do it', '/work/s/r.jsonl', '/work/s/r.err', '/work/s/r.exit', '2026-09-02T10:00:00.000Z');
