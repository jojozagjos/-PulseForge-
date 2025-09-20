import pg from "pg";
const { Client } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false } // Render requires TLS
});

const sql = `
DROP TABLE IF EXISTS leaderboard;
CREATE TABLE leaderboard (
  track_id TEXT NOT NULL,
  diff SMALLINT NOT NULL,
  name VARCHAR(16) NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  acc SMALLINT NOT NULL CHECK (acc BETWEEN 0 AND 10000),
  combo SMALLINT NOT NULL CHECK (combo BETWEEN 0 AND 9999),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (track_id, diff, name)
);
CREATE INDEX leaderboard_rank_idx
  ON leaderboard (track_id, diff, score DESC, acc DESC, combo DESC, ts ASC);
`;

(async () => {
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log("DB reset complete");
})();
