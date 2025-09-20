// server/leaderboard.pg.js
import express from "express";
import pkg from "pg";

const { Pool } = pkg;

const router = express.Router();

const DATABASE_URL = process.env.DATABASE_URL || "";
const MAX_PER_DIFF = Number(process.env.LB_MAX_PER_DIFF || 100);

// tiny diff codes to save space
const DIFF_MAP = { easy: 0, normal: 1, hard: 2 };
const DIFF_NAME = ["easy", "normal", "hard"];
const toDiffCode = (d) => (d in DIFF_MAP ? DIFF_MAP[d] : DIFF_MAP.normal);
const toDiffName = (code) => DIFF_NAME[Number(code)] ?? "normal";

// connect
if (!DATABASE_URL) {
  console.warn("[LB] DATABASE_URL missing — this router expects Postgres.");
}
export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") || /ssl=true|sslmode=require/i.test(DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});

// schema — SMALLINTs + single composite index
async function ensureSchema() {
  // Create table if missing (new schema)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      track_id TEXT NOT NULL,
      diff SMALLINT NOT NULL,                  -- 0 easy, 1 normal, 2 hard
      name VARCHAR(16) NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0),
      acc SMALLINT NOT NULL CHECK (acc BETWEEN 0 AND 10000), -- basis points
      combo SMALLINT NOT NULL CHECK (combo BETWEEN 0 AND 9999),
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (track_id, diff, name)
    );
  `);

  // --- MIGRATE OLD TABLES ---

  // Add diff if missing, backfill to 1 ("normal"), enforce NOT NULL
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='leaderboard' AND column_name='diff'
      ) THEN
        ALTER TABLE leaderboard ADD COLUMN diff SMALLINT;
        UPDATE leaderboard SET diff = 1 WHERE diff IS NULL;
        ALTER TABLE leaderboard ALTER COLUMN diff SET NOT NULL;
      END IF;
    END $$;
  `);

  // Ensure composite ranking index exists
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'i' AND c.relname = 'leaderboard_rank_idx'
      ) THEN
        CREATE INDEX leaderboard_rank_idx
          ON leaderboard (track_id, diff, score DESC, acc DESC, combo DESC, ts ASC);
      END IF;
    END $$;
  `);
}
ensureSchema().catch(e => console.error("[LB] schema init failed:", e));

// helpers
const clamp = (x, lo, hi, def = 0) => {
  x = Number(x);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : def;
};
const sanitizeName = (s) => String(s || "Player").slice(0, 16).replace(/[\n\r\t<>]/g, "");

// prune to top-N per (track,diff) using a window function
async function pruneTopN(n = MAX_PER_DIFF) {
  await pool.query(`
    WITH ranked AS (
      SELECT ctid,
             row_number() OVER (PARTITION BY track_id, diff
                                ORDER BY score DESC, acc DESC, combo DESC, ts ASC) AS rn
      FROM leaderboard
    )
    DELETE FROM leaderboard
    WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > $1);
  `, [n]);

  // optional: help autovacuum; harmless if it can't run
  try { await pool.query(`VACUUM (ANALYZE) leaderboard;`); } catch {}
}

// ---------- routes ----------

// GET /api/leaderboard/:trackId?diff=hard&limit=50
router.get("/:trackId", async (req, res) => {
  try {
    const { trackId } = req.params;
    const diffStr = String(req.query.diff || "normal");
    const diff = toDiffCode(diffStr);
    const limit = clamp(req.query.limit, 1, 200, 100);

    const { rows } = await pool.query(
      `SELECT name, score, acc, combo, ts
         FROM leaderboard
        WHERE track_id = $1 AND diff = $2
        ORDER BY score DESC, acc DESC, combo DESC, ts ASC
        LIMIT $3;`,
      [trackId, diff, limit]
    );

    // convert acc basis points → 0..1 for the client
    const out = rows.map(r => ({
      name: r.name,
      score: Number(r.score) || 0,
      acc: (Number(r.acc) || 0) / 10000,
      combo: Number(r.combo) || 0,
      difficulty: diffStr,
      ts: r.ts
    }));

    res.json(out);
  } catch (e) {
    console.error("[LB] GET failed:", e);
    res.status(500).json({ ok: false });
  }
});

// POST /api/leaderboard/submit
// body: { trackId, difficulty, name, score, acc, combo }
// - acc is expected as 0..1 from client; we store 0..10000 (SMALLINT)
router.post("/submit", async (req, res) => {
  try {
    const { trackId, difficulty = "normal", name, score, acc, combo } = req.body || {};
    const diff = toDiffCode(String(difficulty));
    const nm = sanitizeName(name);
    const sc = clamp(score, 0, 10_000_000, 0);
    const accBps = clamp(Math.round((Number(acc) || 0) * 10000), 0, 10000, 0);
    const cb = clamp(combo, 0, 9999, 0);

    if (!trackId) return res.status(400).json({ ok: false, error: "trackId required" });

    // Upsert: keep the *better* score only
    await pool.query(
      `INSERT INTO leaderboard (track_id, diff, name, score, acc, combo, ts)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (track_id, diff, name) DO UPDATE
       SET score = GREATEST(leaderboard.score, EXCLUDED.score),
           acc   = CASE WHEN EXCLUDED.score > leaderboard.score THEN EXCLUDED.acc ELSE leaderboard.acc END,
           combo = CASE WHEN EXCLUDED.score > leaderboard.score THEN EXCLUDED.combo ELSE leaderboard.combo END,
           ts    = CASE WHEN EXCLUDED.score > leaderboard.score THEN EXCLUDED.ts ELSE leaderboard.ts END;`,
      [trackId, diff, nm, sc, accBps, cb]
    );

    // Prune to Top-N to keep the table tiny
    await pruneTopN(MAX_PER_DIFF);

    // Return your (1-based) rank
    const { rows } = await pool.query(
      `SELECT name
         FROM leaderboard
        WHERE track_id = $1 AND diff = $2
        ORDER BY score DESC, acc DESC, combo DESC, ts ASC
        LIMIT $3;`,
      [trackId, diff, MAX_PER_DIFF]
    );
    const rank = rows.findIndex(r => r.name === nm) + 1 || null;

    res.json({ ok: true, rank, total: rows.length });
  } catch (e) {
    console.error("[LB] submit failed:", e);
    res.status(500).json({ ok: false });
  }
});

export default router;
