//! The durability contract (ARCHITECTURE.md §5): a `started` row is committed
//! before anything executes; `completed` + result written after. Resume
//! rebuilds state from completed steps and re-runs only what's safe.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};

pub struct Journal {
    conn: Connection,
}

#[derive(Debug)]
pub struct RunRow {
    pub id: String,
    pub agent: String,
    pub status: String,
    pub input: String,
    pub created_at: i64,
}

#[derive(Debug)]
pub struct StepRow {
    pub seq: i64,
    pub kind: String,   // llm_call | tool_call
    pub status: String, // started | completed | failed
    pub request: serde_json::Value,
    pub result: Option<serde_json::Value>,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    pub attempt: i64,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Journal {
    pub fn open(app_dir: &Path) -> Result<Self> {
        let dir = app_dir.join(".beater");
        std::fs::create_dir_all(&dir)?;
        let conn = Connection::open(dir.join("journal.db"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS runs(
               id TEXT PRIMARY KEY, agent TEXT NOT NULL, status TEXT NOT NULL,
               input TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS steps(
               run_id TEXT NOT NULL, seq INTEGER NOT NULL,
               kind TEXT NOT NULL, status TEXT NOT NULL,
               request TEXT NOT NULL, result TEXT,
               tool_name TEXT, tool_use_id TEXT,
               attempt INTEGER NOT NULL DEFAULT 1,
               started_at INTEGER NOT NULL, finished_at INTEGER,
               PRIMARY KEY(run_id, seq));",
        )?;
        Ok(Self { conn })
    }

    pub fn create_run(&self, id: &str, agent: &str, input: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO runs(id, agent, status, input, created_at, updated_at)
             VALUES(?1, ?2, 'running', ?3, ?4, ?4)",
            params![id, agent, input, now()],
        )?;
        Ok(())
    }

    pub fn set_run_status(&self, id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status, now()],
        )?;
        Ok(())
    }

    pub fn run(&self, id: &str) -> Result<RunRow> {
        self.conn
            .query_row(
                "SELECT id, agent, status, input, created_at FROM runs WHERE id = ?1",
                params![id],
                |r| {
                    Ok(RunRow {
                        id: r.get(0)?,
                        agent: r.get(1)?,
                        status: r.get(2)?,
                        input: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                },
            )
            .optional()?
            .with_context(|| format!("no run {id} in journal"))
    }

    pub fn list_runs(&self) -> Result<Vec<(RunRow, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT r.id, r.agent, r.status, r.input, r.created_at,
                    (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id)
             FROM runs r ORDER BY r.created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    RunRow {
                        id: r.get(0)?,
                        agent: r.get(1)?,
                        status: r.get(2)?,
                        input: r.get(3)?,
                        created_at: r.get(4)?,
                    },
                    r.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Committed BEFORE the step executes — the crash-safety anchor.
    pub fn start_step(
        &self,
        run_id: &str,
        kind: &str,
        request: &serde_json::Value,
        tool_name: Option<&str>,
        tool_use_id: Option<&str>,
        attempt: i64,
    ) -> Result<i64> {
        let seq: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE run_id = ?1",
            params![run_id],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO steps(run_id, seq, kind, status, request, tool_name, tool_use_id, attempt, started_at)
             VALUES(?1, ?2, ?3, 'started', ?4, ?5, ?6, ?7, ?8)",
            params![run_id, seq, kind, request.to_string(), tool_name, tool_use_id, attempt, now()],
        )?;
        Ok(seq)
    }

    pub fn complete_step(&self, run_id: &str, seq: i64, result: &serde_json::Value) -> Result<()> {
        self.conn.execute(
            "UPDATE steps SET status = 'completed', result = ?3, finished_at = ?4
             WHERE run_id = ?1 AND seq = ?2",
            params![run_id, seq, result.to_string(), now()],
        )?;
        Ok(())
    }

    pub fn fail_step(&self, run_id: &str, seq: i64, error: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE steps SET status = 'failed', result = ?3, finished_at = ?4
             WHERE run_id = ?1 AND seq = ?2",
            params![run_id, seq, serde_json::json!({"error": error}).to_string(), now()],
        )?;
        Ok(())
    }

    pub fn steps(&self, run_id: &str) -> Result<Vec<StepRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, kind, status, request, result, tool_name, tool_use_id, attempt
             FROM steps WHERE run_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt
            .query_map(params![run_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(seq, kind, status, request, result, tool_name, tool_use_id, attempt)| {
                Ok(StepRow {
                    seq,
                    kind,
                    status,
                    request: serde_json::from_str(&request)?,
                    result: result.map(|r| serde_json::from_str(&r)).transpose()?,
                    tool_name,
                    tool_use_id,
                    attempt,
                })
            })
            .collect()
    }
}
