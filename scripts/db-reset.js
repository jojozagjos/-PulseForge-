// scripts/db-reset.js
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

// Enable TLS when using Render (sslmode=require) or any hosted PG
const ssl =
  /sslmode=require/i.test(url) || /render\.com/i.test(url)
    ? { rejectUnauthorized: false }
    : undefined;

const client = new Client({ connectionString: url, ssl });

const SQL = `
DROP TABLE IF EXISTS leaderboard;

CREATE TABLE leaderboard (
  track_id TEXT NOT NULL,
  diff SMALLINT NOT NULL DEFAULT 1,          -- 0=easy,1=normal,2=hard
  name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  acc REAL NOT NULL DEFAULT 0,               -- 0..1
  combo INTEGER NOT NULL DEFAULT 0,
  ts BIGINT NOT NULL DEFAULT (floor(extract(epoch from now())*1000))
);

ALTER TABLE leaderboard
  ADD PRIMARY KEY (track_id, diff, name);

CREATE INDEX leaderboard_rank_idx
  ON leaderboard (track_id, diff, score DESC, acc DESC, combo DESC, ts ASC);
`;

(async () => {
  try {
    await client.connect();
    await client.query(SQL);
    console.log('✅ leaderboard table reset');
  } catch (err) {
    console.error('❌ reset failed:', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
