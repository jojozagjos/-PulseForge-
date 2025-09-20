// server/leaderboard.pg.js
import express from "express";
import pg from "pg";

const router = express.Router();

// Pool — enable SSL when using external URL or Render’s managed PG (most URLs require it)
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
      ? { rejectUnauthorized: false }
      : false,
});

// Ensure schema once at boot
async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS leaderboard (
      id         bigserial PRIMARY KEY,
      track_id   text NOT NULL,
      name       text NOT NULL,
      score      integer NOT NULL,
      acc        real NOT NULL,          -- 0..1
      combo      integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (track_id, name)
    );
    CREATE INDEX IF NOT EXISTS leaderboard_track_score
      ON leaderboard (track_id, score DESC, acc DESC, combo DESC, created_at ASC);
  `;
  await pool.query(sql);
}
ensureSchema().catch(err => {
  console.error("[LB] schema init failed:", err);
});

// GET top N
router.get("/:trackId", async (req, res) => {
  try {
    const trackId = String(req.params.trackId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const { rows } = await pool.query(
      `SELECT name, score, acc, combo, created_at
         FROM leaderboard
        WHERE track_id = $1
        ORDER BY score DESC, acc DESC, combo DESC, created_at ASC
        LIMIT $2`,
      [trackId, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error("[LB] get error:", e);
    res.status(500).json({ error: "leaderboard fetch failed" });
  }
});

// POST score (upsert best per player per track)
router.post("/submit", express.json(), async (req, res) => {
  const { trackId, name, score, acc, combo } = req.body || {};
  if (!trackId || !name) return res.status(400).json({ error: "missing trackId or name" });

  const clean = {
    trackId: String(trackId),
    name: String(name).slice(0, 24),
    score: Math.max(0, Number(score) || 0),
    acc: Math.max(0, Math.min(1, Number(acc) || 0)),
    combo: Math.max(0, Number(combo) || 0),
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // previous best (for PB detection)
    const prev = await client.query(
      "SELECT score, acc, combo FROM leaderboard WHERE track_id=$1 AND name=$2",
      [clean.trackId, clean.name]
    );
    const prevBest = prev.rows[0] || null;

    // upsert: keep higher score; update acc/combo when score improves; refresh created_at on improvement
    const upsert = `
      INSERT INTO leaderboard (track_id, name, score, acc, combo)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (track_id, name) DO UPDATE
      SET score = GREATEST(leaderboard.score, EXCLUDED.score),
          acc   = CASE WHEN EXCLUDED.score > leaderboard.score THEN EXCLUDED.acc ELSE leaderboard.acc END,
          combo = GREATEST(leaderboard.combo, EXCLUDED.combo),
          created_at = CASE WHEN EXCLUDED.score > leaderboard.score THEN now() ELSE leaderboard.created_at END
      RETURNING score, acc, combo
    `;
    const up = await client.query(upsert, [
      clean.trackId, clean.name, clean.score, clean.acc, clean.combo
    ]);
    const best = up.rows[0];

    // current rank
    const r = await client.query(
      `SELECT 1 + COUNT(*) AS rank
         FROM leaderboard
        WHERE track_id = $1
          AND (score > $2 OR (score = $2 AND acc >= $3 AND combo >= $4))`,
      [clean.trackId, best.score, best.acc, best.combo]
    );
    const rank = Number(r.rows?.[0]?.rank || 1);

    await client.query("COMMIT");

    const pb =
      !prevBest || best.score > prevBest.score || best.combo > prevBest.combo;

    res.json({ ok: true, rank, pb, best });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[LB] submit error:", e);
    res.status(500).json({ error: "leaderboard submit failed" });
  } finally {
    client.release();
  }
});

export default router;
