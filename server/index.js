// server/index.js
import express from "express";
import http from "http";
import path from "path";
import cors from "cors";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const TRACKS_DIR = path.join(__dirname, "..", "public", "tracks");
const DATA_DIR = path.join(__dirname, "..", "data");
const LB_PATH = path.join(DATA_DIR, "leaderboards.json");

// ---------------- tracks ----------------
function discoverTracks() {
  const out = [];
  if (!fs.existsSync(TRACKS_DIR)) return out;
  for (const dirEnt of fs.readdirSync(TRACKS_DIR, { withFileTypes: true })) {
    if (!dirEnt.isDirectory()) continue;
    const manifestPath = path.join(TRACKS_DIR, dirEnt.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!m.trackId || !m.title || !m.audio) continue;
      // add convenience cover path if missing
      if (!m.cover) {
        const jpg = path.join(TRACKS_DIR, dirEnt.name, "cover.jpg");
        const png = path.join(TRACKS_DIR, dirEnt.name, "cover.png");
        if (fs.existsSync(jpg)) m.cover = `/tracks/${dirEnt.name}/cover.jpg`;
        else if (fs.existsSync(png)) m.cover = `/tracks/${dirEnt.name}/cover.png`;
      }
      out.push(m);
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

app.get("/api/tracks", (req, res) => res.json(discoverTracks()));

// ---------------- leaderboards (JSON) ----------------

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LB_PATH)) fs.writeFileSync(LB_PATH, "{}");
}

/** Load and normalize the leaderboard DB object. */
function loadLB() {
  try {
    ensureDataFile();
    const obj = JSON.parse(fs.readFileSync(LB_PATH, "utf8") || "{}") || {};
    // migrate old format: db[trackId] === Array -> wrap under "normal"
    for (const tid of Object.keys(obj)) {
      if (Array.isArray(obj[tid])) {
        obj[tid] = { normal: obj[tid] };
      } else if (obj[tid] && typeof obj[tid] === "object") {
        // keep as-is
      } else {
        obj[tid] = { normal: [] };
      }
    }
    return obj;
  } catch {
    return {};
  }
}

function saveLB(obj) {
  try {
    ensureDataFile();
    fs.writeFileSync(LB_PATH, JSON.stringify(obj, null, 2));
  } catch {
    /* ignore write errors for now */
  }
}

/** Get board array for a track+diff, always returns an array (not cloned). */
function getBoard(db, trackId, diff) {
  if (!db[trackId]) db[trackId] = {};
  if (!db[trackId][diff]) db[trackId][diff] = [];
  return db[trackId][diff];
}

const MAX_PER_DIFF = 100;
const NAME_MAX = 16;

function sanitizeName(name) {
  const nmRaw = (name || "Player").slice(0, NAME_MAX);
  return nmRaw.replace(/[\n\r\t<>]/g, "");
}

function clampScore(n) { return Math.max(0, Math.min(10_000_000, Math.floor(n || 0))); }
function clampAcc(n)   { return Math.max(0, Math.min(1, Number(n) || 0)); }
function clampCombo(n) { return Math.max(0, Math.min(9_999, Math.floor(n || 0))); }

/**
 * Sort order:
 *   1) higher score
 *   2) higher accuracy
 *   3) higher combo
 *   4) earlier timestamp wins tie-break (stable)
 */
function sortBoard(arr) {
  arr.sort((a, b) =>
    (b.score - a.score) ||
    (b.acc - a.acc) ||
    (b.combo - a.combo) ||
    (a.ts - b.ts)
  );
}

// GET /api/leaderboard/:trackId?diff=hard&limit=100
app.get("/api/leaderboard/:trackId", (req, res) => {
  const { trackId } = req.params;
  const diff = (req.query.diff || "normal").toString();
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 200);

  const db = loadLB();
  const board = getBoard(db, trackId, diff);

  sortBoard(board);
  const rows = board.slice(0, limit).map(r => ({
    name: r.name,
    score: r.score,
    acc: r.acc,
    combo: r.combo,
    difficulty: diff,
    ts: r.ts
  }));

  res.json(rows);
});

// POST /api/leaderboard/submit
// body: { trackId, difficulty, name, score, acc, combo }
app.post("/api/leaderboard/submit", (req, res) => {
  const { trackId, difficulty = "normal", name, score, acc, combo } = req.body || {};
  const tid = (trackId || "").trim();
  const diff = difficulty.toString() || "normal";
  if (!tid) return res.status(400).json({ ok: false, error: "trackId required" });

  const row = {
    name: sanitizeName(name),
    score: clampScore(score),
    acc: clampAcc(acc),
    combo: clampCombo(combo),
    ts: Date.now()
  };

  const db = loadLB();
  const board = getBoard(db, tid, diff);

  // Upsert by player name within this difficulty
  const idx = board.findIndex(r => (r.name || "") === row.name);
  if (idx >= 0) {
    if (row.score > (board[idx].score || 0)) board[idx] = row;
  } else {
    board.push(row);
  }

  sortBoard(board);
  if (board.length > MAX_PER_DIFF) board.length = MAX_PER_DIFF;

  saveLB(db);

  const rank = board.findIndex(r => r === row || (r.name === row.name && r.score === row.score && r.ts === row.ts));
  res.json({ ok: true, rank: rank >= 0 ? rank + 1 : null, total: board.length });
});

// ---------------- server start ----------------
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("PulseForge server on", PORT));
