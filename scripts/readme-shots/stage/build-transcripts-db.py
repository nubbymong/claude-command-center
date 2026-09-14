"""Build the Logs viewer's transcripts.db from the seed's transcripts-seed.json.

    python build-transcripts-db.py <transcripts-seed.json> <transcripts.db>

The Logs page reads SQLite, never JSONL (the worker only ingests transcripts
of runs the app itself registered at spawn), so history has to be written as
rows. The DDL is the app's own (src/main/logging/transcripts-db.ts, schema v1)
so the app opens the file as its own; every statement there is IF NOT EXISTS.
Stock python — its sqlite3 ships FTS5.
"""
import json
import os
import sqlite3
import sys

DDL = """
CREATE TABLE IF NOT EXISTS runs (
  runId        INTEGER PRIMARY KEY,
  sessionId    TEXT NOT NULL,
  configId     TEXT,
  configLabel  TEXT NOT NULL,
  projectCwd   TEXT,
  accountEmail TEXT,
  profileId    TEXT,
  provider     TEXT NOT NULL,
  startedAt    INTEGER NOT NULL,
  endedAt      INTEGER,
  status       TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS idx_runs_config_started ON runs(configId, startedAt);
CREATE INDEX IF NOT EXISTS idx_runs_session_started ON runs(sessionId, startedAt);
CREATE TABLE IF NOT EXISTS transcripts (
  id            INTEGER PRIMARY KEY,
  runId         INTEGER NOT NULL REFERENCES runs(runId) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  ord           INTEGER NOT NULL,
  sourceFormat  TEXT NOT NULL DEFAULT 'claude-jsonl',
  sourceVersion TEXT,
  parserVersion INTEGER NOT NULL,
  ingestCursor  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  confidence    TEXT NOT NULL DEFAULT 'exact',
  UNIQUE(runId, path)
);
CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY,
  runId    INTEGER NOT NULL REFERENCES runs(runId) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  role     TEXT NOT NULL,
  kind     TEXT NOT NULL,
  content  TEXT NOT NULL,
  toolName TEXT,
  toolMeta TEXT,
  raw      TEXT,
  UNIQUE(runId, idx)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schemaVersion', '1');
"""


def main(seed_path: str, db_path: str) -> None:
    with open(seed_path, encoding="utf-8") as f:
        seed = json.load(f)
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(db_path + suffix)
        except FileNotFoundError:
            pass
    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(DDL)
    n_msgs = 0
    for run in seed["runs"]:
        cur = db.execute(
            "INSERT INTO runs(sessionId, configId, configLabel, projectCwd, accountEmail, profileId, provider, startedAt, endedAt, status)"
            " VALUES (?,?,?,?,?,?,?,?,?,'complete')",
            (run["sessionId"], run["configId"], run["configLabel"], run["projectCwd"], run["accountEmail"], run["profileId"], run["provider"], int(run["startedAt"]), int(run["endedAt"])),
        )
        run_id = cur.lastrowid
        size = os.path.getsize(run["path"]) if os.path.exists(run["path"]) else 0
        db.execute(
            "INSERT INTO transcripts(runId, path, ord, sourceFormat, sourceVersion, parserVersion, ingestCursor, status, confidence)"
            " VALUES (?,?,0,'claude-jsonl','2.1.198',1,?,'complete','exact')",
            (run_id, run["path"], size),
        )
        for idx, row in enumerate(run["rows"]):
            db.execute(
                "INSERT INTO messages(runId, idx, ts, role, kind, content, toolName, toolMeta, raw) VALUES (?,?,?,?,?,?,?,?,NULL)",
                (run_id, idx, int(row["ts"]), row["role"], row["kind"], row.get("content", ""), row.get("toolName"), row.get("toolMeta")),
            )
            n_msgs += 1
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()
    print(f"transcripts.db: {len(seed['runs'])} runs, {n_msgs} messages -> {db_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
