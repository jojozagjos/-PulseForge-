// server/leaderboard.pg.js
import "dotenv/config";
import express from "express";
import pgPkg from "pg";

const router = express.Router();
const RAW_URL = process.env.DATABASE_URL;
const DATABASE_URL = typeof RAW_URL === "string" ? RAW_URL.trim() : "";
const HAS_DB = !!DATABASE_URL;

if (!HAS_DB) {
  console.warn("[LB] DATABASE_URL not set; leaderboard endpoints return 503.");
  router.all("*", (_req, res) =>
    res.status(503).json({ ok: false, error: "Leaderboard DB not configured" })
  );
} else {
  const { Pool } = pgPkg;
  const ssl =
    DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false };

  const pool = new Pool({ connectionString: DATABASE_URL, ssl });
  console.log("[LB] Using Postgres leaderboard via DATABASE_URL");

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        track_id TEXT NOT NULL,
        diff SMALLINT NOT NULL,                 -- 0 easy, 1 normal, 2 hard
        name VARCHAR(16) NOT NULL,              -- display name
        score INTEGER NOT NULL CHECK (score >= 0),
        acc SMALLINT NOT NULL CHECK (acc BETWEEN 0 AND 10000), -- basis points
        combo SMALLINT NOT NULL CHECK (combo BETWEEN 0 AND 9999),
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (track_id, diff, name)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS leaderboard_rank_idx
        ON leaderboard (track_id, diff, score DESC, acc DESC, combo DESC, ts ASC);
    `);
  }

  ensureSchema().catch((e) => console.error("[LB] schema init failed:", e));

  const DIFF_MAP = { easy: 0, normal: 1, hard: 2 };
  const toDiffId = (s) => DIFF_MAP[String(s ?? "normal").toLowerCase()] ?? 1;

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const NAME_MAX = 16;
  const sanitizeName = (n) =>
    (String(n || "Player").slice(0, NAME_MAX)).replace(/[\n\r\t<>]/g, "");

  // GET /api/leaderboard/:trackId?diff=normal&limit=100
  router.get("/:trackId", async (req, res) => {
    try {
      const trackId = String(req.params.trackId || "").trim();
      const diffId = toDiffId(req.query.diff || "normal");
      const limit = clamp(parseInt(req.query.limit || "100", 10) || 100, 1, 200);
      if (!trackId) return res.status(400).json({ ok: false, error: "trackId required" });

      const { rows } = await pool.query(
        `
        SELECT name,
               score,
               (acc::float / 10000.0) AS acc,  -- return as 0..1
               combo,
               ts
        FROM leaderboard
        WHERE track_id = $1 AND diff = $2
        ORDER BY score DESC, acc DESC, combo DESC, ts ASC
        LIMIT $3
        `,
        [trackId, diffId, limit]
      );

      res.json(rows);
    } catch (e) {
      console.error("[LB] GET failed:", e);
      res.status(500).json({ ok: false, error: "query_failed" });
    }
  });

  // POST /api/leaderboard/submit
  // body: { trackId, difficulty, name, score, acc (0..1), combo }
  router.post("/submit", async (req, res) => {
    try {
      const tid = String(req.body?.trackId || "").trim();
      const diffId = toDiffId(req.body?.difficulty || "normal");
      if (!tid) return res.status(400).json({ ok: false, error: "trackId required" });

      const name = sanitizeName(req.body?.name);
      const score = clamp(Math.floor(Number(req.body?.score) || 0), 0, 10_000_000);
      const accBps = clamp(Math.round((Number(req.body?.acc) || 0) * 10000), 0, 10000);
      const combo = clamp(Math.floor(Number(req.body?.combo) || 0), 0, 9999);

      await pool.query(
        `
        INSERT INTO leaderboard (track_id, diff, name, score, acc, combo)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (track_id, diff, name)
        DO UPDATE SET
          score = GREATEST(EXCLUDED.score, leaderboard.score),
          acc   = CASE
                    WHEN EXCLUDED.score > leaderboard.score THEN EXCLUDED.acc
                    WHEN EXCLUDED.score = leaderboard.score THEN GREATEST(EXCLUDED.acc, leaderboard.acc)
                    ELSE leaderboard.acc
                  END,
          combo = CASE
                    WHEN EXCLUDED.score > leaderboard.score THEN EXCLUDED.combo
                    WHEN EXCLUDED.score = leaderboard.score AND EXCLUDED.acc > leaderboard.acc THEN EXCLUDED.combo
                    WHEN EXCLUDED.score = leaderboard.score AND EXCLUDED.acc = leaderboard.acc THEN GREATEST(EXCLUDED.combo, leaderboard.combo)
                    ELSE leaderboard.combo
                  END,
          ts = CASE
                 WHEN EXCLUDED.score > leaderboard.score
                   OR (EXCLUDED.score = leaderboard.score AND EXCLUDED.acc > leaderboard.acc)
                   OR (EXCLUDED.score = leaderboard.score AND EXCLUDED.acc = leaderboard.acc AND EXCLUDED.combo > leaderboard.combo)
                 THEN now()
                 ELSE leaderboard.ts
               END
        `,
        [tid, diffId, name, score, accBps, combo]
      );

      // rank
      const rankRow = await pool.query(
        `
        SELECT r.rank
        FROM (
          SELECT name,
                 RANK() OVER (ORDER BY score DESC, acc DESC, combo DESC, ts ASC) AS rank
          FROM leaderboard
          WHERE track_id = $1 AND diff = $2
        ) r
        WHERE r.name = $3
        LIMIT 1
        `,
        [tid, diffId, name]
      );
      const rank = rankRow.rows?.[0]?.rank ?? null;

      const totalRow = await pool.query(
        `SELECT COUNT(*)::int AS c FROM leaderboard WHERE track_id=$1 AND diff=$2`,
        [tid, diffId]
      );

      res.json({ ok: true, rank, total: totalRow.rows?.[0]?.c ?? null });
    } catch (e) {
      console.error("[LB] POST failed:", e);
      res.status(500).json({ ok: false, error: "submit_failed" });
    }
  });
}

export default router;
