// server/index.js
import "dotenv/config"; // load .env first

import express from "express";
import http from "http";
import path from "path";
import cors from "cors";
import fs from "fs";
import { fileURLToPath } from "url";
import leaderboardRouter from "./leaderboard.pg.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

// static
app.use(express.static(path.join(__dirname, "..", "public")));

// API
app.use("/api/leaderboard", leaderboardRouter);

// ---------------- tracks ----------------
const TRACKS_DIR = path.join(__dirname, "..", "public", "tracks");

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

      if (!m.cover) {
        const jpg = path.join(TRACKS_DIR, dirEnt.name, "cover.jpg");
        const png = path.join(TRACKS_DIR, dirEnt.name, "cover.png");
        if (fs.existsSync(jpg)) m.cover = `/tracks/${dirEnt.name}/cover.jpg`;
        else if (fs.existsSync(png)) m.cover = `/tracks/${dirEnt.name}/cover.png`;
      }
      out.push(m);
    } catch {}
  }
  return out;
}

app.get("/api/tracks", (_req, res) => res.json(discoverTracks()));

const PORT = process.env.PORT || 3000;
http.createServer(app).listen(PORT, () =>
  console.log("PulseForge server on", PORT)
);
