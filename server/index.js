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

// ---------- tracks ----------
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
      out.push(m);
    } catch { /* ignore malformed */ }
  }
  return out;
}

app.get("/api/tracks", (req, res) => res.json(discoverTracks()));

// ---------- leaderboards ----------
function loadLB() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LB_PATH)) fs.writeFileSync(LB_PATH, "{}");
    return JSON.parse(fs.readFileSync(LB_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveLB(obj) {
  try {
    fs.writeFileSync(LB_PATH, JSON.stringify(obj, null, 2));
  } catch {}
}

const MAX_PER_TRACK = 100;   // keep top 100 per song
const NAME_MAX = 16;

app.get("/api/leaderboard/:trackId", (req, res) => {
  const trackId = (req.params.trackId || "").trim();
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 50));
  const db = loadLB();
  const rows = Array.isArray(db[trackId]) ? db[trackId].slice(0, limit) : [];
  res.json(rows);
});

app.post("/api/leaderboard/submit", (req, res) => {
  const { trackId, name, score, acc, combo } = req.body || {};
  const tid = (trackId || "").trim();
  const nmRaw = (name || "Player").slice(0, NAME_MAX);
  const nm = nmRaw.replace(/[\n\r\t<>]/g, ""); // very simple sanitize

  // very light sanity checks to deter accidental garbage
  const sc = Math.max(0, Math.min(10_000_000, Math.floor(score || 0)));
  const ac = Math.max(0, Math.min(1, Number(acc) || 0));
  const cb = Math.max(0, Math.min(9_999, Math.floor(combo || 0)));
  if (!tid) return res.status(400).json({ ok: false, error: "trackId required" });

  const db = loadLB();
  if (!Array.isArray(db[tid])) db[tid] = [];

  // If same name already on board, keep the better score
  const existingIdx = db[tid].findIndex(r => (r.name || "") === nm);
  const row = { name: nm, score: sc, acc: ac, combo: cb, ts: Date.now() };

  if (existingIdx >= 0) {
    if (sc > (db[tid][existingIdx].score || 0)) db[tid][existingIdx] = row;
    // else ignore worse submission
  } else {
    db[tid].push(row);
  }

  // Sort & clamp
  db[tid].sort((a, b) => (b.score - a.score) || (b.acc - a.acc) || (b.combo - a.combo) || (a.ts - b.ts));
  db[tid] = db[tid].slice(0, MAX_PER_TRACK);

  saveLB(db);
  res.json({ ok: true, rank: db[tid].findIndex(r => r === row) + 1, total: db[tid].length });
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("PulseForge server on", PORT));
