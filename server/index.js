
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import cors from "cors";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/tracks", (req, res) => {
  res.json([
    {
      trackId: "training-beat",
      title: "Training Beat",
      artist: "PulseForge",
      bpm: 120,
      durationMs: 20000,
      audio: { wav: "/assets/music/training-beat.wav" },
      charts: {
        easy: "/charts/training-beat.easy.json",
        normal: "/charts/training-beat.normal.json",
        hard: "/charts/training-beat.hard.json"
      },
      cover: "/assets/images/cover-training.jpg"
    }
  ]);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i=0;i<4;i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
}

const rooms = new Map();

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }) => {
    const code = genRoomCode();
    const secret = Math.random().toString(36).slice(2);
    const room = {
      code,
      hostId: socket.id,
      players: new Map(),
      phase: "lobby",
      track: null,
      difficulty: "normal",
      startAt: 0,
      secret
    };
    rooms.set(code, room);
    room.players.set(socket.id, { name: name?.slice(0,16) || "Host", ready: false, score: 0, accuracy: 0, combo: 0 });
    socket.join(code);
    socket.emit("roomState", serializeRoom(room, socket.id));
  });

  socket.on("joinRoom", ({ code, name }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (room.phase !== "lobby") return socket.emit("errorMsg", "Game already started.");
    socket.join(room.code);
    room.players.set(socket.id, { name: name?.slice(0,16) || "Player", ready: false, score: 0, accuracy: 0, combo: 0 });
    io.to(room.code).emit("roomState", serializeRoom(room));
  });

  socket.on("setName", ({ code, name }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.name = (name||"").slice(0,16);
    io.to(room.code).emit("roomState", serializeRoom(room));
  });

  socket.on("selectTrack", ({ code, track, difficulty }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    if (room.hostId !== socket.id) return;
    room.track = track;
    if (difficulty) room.difficulty = difficulty;
    io.to(room.code).emit("roomState", serializeRoom(room));
  });

  socket.on("ready", ({ code, ready }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!ready;
    io.to(room.code).emit("roomState", serializeRoom(room));
  });

  socket.on("start", ({ code }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (!room.track) return socket.emit("errorMsg", "Select a track first.");
    room.phase = "playing";
    room.startAt = Date.now() + 3500;
    for (const p of room.players.values()) { p.score = 0; p.accuracy = 0; p.combo = 0; p.ready = false; }
    io.to(room.code).emit("countdown", { startAt: room.startAt, track: room.track, difficulty: room.difficulty, secret: room.secret });
  });

  socket.on("playEvent", ({ code, bundle }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (!bundle || typeof bundle !== "object" || !room.secret) return;
    const mac = pseudoHmac(JSON.stringify({t:bundle.t,acc:bundle.acc,score:bundle.score,combo:bundle.combo}), room.secret);
    if (mac !== bundle.mac) return;
    p.score = Math.max(p.score || 0, bundle.score|0);
    p.accuracy = Math.max(p.accuracy || 0, bundle.acc||0);
    p.combo = Math.max(p.combo || 0, bundle.combo|0);
    const board = [...room.players.entries()].map(([id,pl])=>({name:pl.name, score:pl.score||0, acc:pl.accuracy||0, combo:pl.combo||0})).sort((a,b)=>b.score-a.score);
    io.to(room.code).emit("liveScoreboard", board);
  });

  socket.on("complete", ({ code }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    if (socket.id === room.hostId) {
      room.phase = "results";
      const results = [...room.players.values()].map(p=>({name:p.name, score:p.score, acc:p.accuracy, combo:p.combo})).sort((a,b)=>b.score-a.score);
      io.to(room.code).emit("results", results);
    }
  });

  socket.on("leaveRoom", ({ code }) => {
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(room.code);
    if (room.players.size === 0) rooms.delete(room.code);
    else io.to(room.code).emit("roomState", serializeRoom(room));
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.players.size === 0) rooms.delete(code);
        else io.to(room.code).emit("roomState", serializeRoom(room));
      }
    }
  });
});

function serializeRoom(room, requesterId = null) {
  return {
    code: room.code,
    hostId: room.hostId,
    youAreHost: requesterId ? (room.hostId === requesterId) : undefined,
    phase: room.phase,
    track: room.track,
    difficulty: room.difficulty,
    players: [...room.players.values()].map(p=>({name:p.name, ready:p.ready, score:p.score, acc:p.accuracy, combo:p.combo}))
  };
}

function pseudoHmac(message, secret){
  const data = message + "|" + secret;
  let h = 2166136261>>>0;
  for (let i=0;i<data.length;i++){
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ("0000000"+(h>>>0).toString(16)).slice(-8);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("PulseForge server listening on", PORT);
});
