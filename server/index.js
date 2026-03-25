import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

/**
 * Room state is authoritative on the server.
 * In-memory only (MVP).
 */

const PLAYER_SEATS = [
  { seat: 1, name: "Player 1", color: "#ff4d4d" },
  { seat: 2, name: "Player 2", color: "#4d79ff" },
  { seat: 3, name: "Player 3", color: "#33cc66" },
];

const DEFAULT_POOL = Array.from({ length: 18 }, (_, i) => ({
  id: `game-${i + 1}`,
  label: `Game ${i + 1}`,
}));

const DEFAULT_DECIDER_POOL = Array.from({ length: 6 }, (_, i) => ({
  id: `decider-${i + 1}`,
  label: `Decider Game ${i + 1}`,
}));

function deciderRangeForSeat(seat) {
  if (seat === 1) return { start: 0, end: 1 };
  if (seat === 2) return { start: 2, end: 3 };
  if (seat === 3) return { start: 4, end: 5 };
  return null;
}

/** @type {Map<string, any>} */
const rooms = new Map();

function normalizeAngle(a) {
  const t = Math.PI * 2;
  let x = a % t;
  if (x < 0) x += t;
  return x;
}

function angleForEntryIndex(n, idx) {
  // Pointer is at top; rotate wheel so chosen segment center aligns to -PI/2.
  const step = (Math.PI * 2) / Math.max(1, n);
  const mid = (idx + 0.5) * step;
  return -Math.PI / 2 - mid;
}

function rangeForSeat(seat) {
  if (seat === 1) return { start: 0, end: 5 };
  if (seat === 2) return { start: 6, end: 11 };
  if (seat === 3) return { start: 12, end: 17 };
  return null;
}

function makeRoom() {
  return {
    code: nanoid(6).toUpperCase(),
    createdAt: Date.now(),
    phase: "lobby",
    mode: null, // null until unanimous vote, then "standard" | "decider"
    modeVotes: {}, // { [clientId]: "standard" | "decider" }
    players: {
      // clientId: { clientId, seat, name, color, ready, connectedSocketIds: Set<string> }
    },
    pool: structuredClone(DEFAULT_POOL),
    deciderPool: structuredClone(DEFAULT_DECIDER_POOL),
    draft: {
      picksByPlayer: {
        // clientId: [{id,label,ownerClientId}]
      },
      takenIds: new Set(),
      turnOrder: [],
      turnIndex: 0,
      totalPicksPerPlayer: 3,
    },
    bracket: {
      picksByPlayer: {
        // clientId: { [ownerClientId]: {id,label,ownerClientId} }
      },
    },
    wheel: {
      wheel1: null,
      wheelFinal: null,
      deciderWheel: null,
      modeWheel: null,
      result: null,
      notice: null,
      history: [],
    },
    decider: {
      winningDeciderGame: null,
      winnerClientId: null,
      winningBracketGame: null,
    },
  };
}

function allReady(room) {
  const ids = Object.keys(room.players);
  if (ids.length !== 3) return false;
  return ids.every((cid) => room.players[cid]?.ready);
}

function publicRoomState(room) {
  const playersArr = Object.values(room.players)
    .map((p) => ({
      clientId: p.clientId,
      seat: p.seat,
      name: p.name,
      color: p.color,
      ready: Boolean(p.ready),
      connected: p.connectedSocketIds.size > 0,
    }))
    .sort((a, b) => a.seat - b.seat);

  const pool = room.pool.map((g) => ({ ...g, taken: room.draft.takenIds.has(g.id) }));

  const drafted = {};
  for (const [cid, arr] of Object.entries(room.draft.picksByPlayer)) {
    drafted[cid] = arr.map((x) => ({ ...x }));
  }

  const bracket = {};
  for (const [cid, picks] of Object.entries(room.bracket.picksByPlayer)) {
    bracket[cid] = {};
    for (const [ownerCid, item] of Object.entries(picks)) {
      bracket[cid][ownerCid] = item ? { ...item } : null;
    }
  }

  return {
    code: room.code,
    phase: room.phase,
    mode: room.mode,
    modeVotes: { ...room.modeVotes },
    players: playersArr,
    lobby: {
      allReady: allReady(room),
      readyCount: playersArr.filter((p) => p.ready).length,
    },
    pool,
    deciderPool: room.deciderPool.map((g) => ({ ...g })),
    draft: {
      picksByPlayer: drafted,
      turnOrder: [...room.draft.turnOrder],
      turnIndex: room.draft.turnIndex,
      currentTurnClientId: room.draft.turnOrder[room.draft.turnIndex] ?? null,
      totalPicksPerPlayer: room.draft.totalPicksPerPlayer,
    },
    bracket,
    wheel: {
      ...room.wheel,
    },
    decider: { ...room.decider },
  };
}

function getOrCreateRoom(code) {
  if (code && rooms.has(code)) return rooms.get(code);
  const room = makeRoom();
  rooms.set(room.code, room);
  return room;
}

function roomBroadcast(room) {
  io.to(room.code).emit("room:state", publicRoomState(room));
}

function ensureDraftStarted(room) {
  if (room.phase !== "lobby") return;
  const playerIds = Object.keys(room.players);
  if (playerIds.length !== 3) return;
  if (!allReady(room)) return;
  room.phase = "draft";
  room.draft.turnOrder = playerIds
    .map((cid) => room.players[cid])
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.clientId);
  room.draft.turnIndex = 0;
  for (const cid of playerIds) {
    room.draft.picksByPlayer[cid] = room.draft.picksByPlayer[cid] ?? [];
  }
  roomBroadcast(room);
}

function draftComplete(room) {
  const ids = Object.keys(room.players);
  if (ids.length !== 3) return false;
  return ids.every((cid) => (room.draft.picksByPlayer[cid]?.length ?? 0) >= room.draft.totalPicksPerPlayer);
}

function ensureBracketStarted(room) {
  if (room.phase !== "draft") return;
  if (!draftComplete(room)) return;
  room.phase = "bracket";
  for (const cid of Object.keys(room.players)) {
    room.bracket.picksByPlayer[cid] = room.bracket.picksByPlayer[cid] ?? {};
  }
  roomBroadcast(room);
}

function bracketComplete(room) {
  const playerIds = Object.keys(room.players);
  if (playerIds.length !== 3) return false;
  return playerIds.every((pickerCid) => {
    const picks = room.bracket.picksByPlayer[pickerCid] ?? {};
    return playerIds.every((ownerCid) => Boolean(picks[ownerCid]));
  });
}

function ensurePostBracket(room) {
  if (room.phase !== "bracket") return;
  if (!bracketComplete(room)) return;
  if (room.mode === "decider") {
    ensureDeciderWheelStarted(room);
    return;
  }
  ensureWheel1Started(room);
}

function startModeWheel(room) {
  const playerIds = Object.keys(room.players);
  const entries = playerIds.map((cid) => ({
    id: cid,
    vote: room.modeVotes[cid] || "standard",
  }));
  room.phase = "modeWheel";
  room.wheel.modeWheel = {
    remaining: entries,
    eliminated: [],
    winnerVote: null,
    visualAngle: Math.random() * Math.PI * 2,
    lastSpin: null,
    spinNonce: 0,
  };
  room.wheel.history.push({ at: Date.now(), event: "modeWheel:start" });
}

function spinModeWheel(room) {
  const w = room.wheel.modeWheel;
  if (!w || room.phase !== "modeWheel") return;
  if (w.remaining.length <= 1) return;
  if (room.wheel.notice) return;
  const entriesItemIds = w.remaining.map((x) => x.id);
  const idx = Math.floor(Math.random() * w.remaining.length);
  const landed = w.remaining[idx];
  const startAngle = Number.isFinite(w.visualAngle) ? w.visualAngle : 0;
  const target = angleForEntryIndex(w.remaining.length, idx);
  const extraTurns = 5;
  const endAngle = target + extraTurns * Math.PI * 2;
  const durationMs = 1700;

  w.remaining.splice(idx, 1);
  w.eliminated.push(landed);
  w.spinNonce += 1;
  w.lastSpin = {
    nonce: w.spinNonce,
    at: Date.now(),
    entriesItemIds,
    landedItemId: landed.id,
    startAngle,
    endAngle,
    durationMs,
  };
  w.visualAngle = normalizeAngle(endAngle);
  room.wheel.history.push({ at: Date.now(), event: "modeWheel:land", landed: landed.id, vote: landed.vote });

  const landedPlayer = room.players[landed.id];
  const landedName = landedPlayer ? landedPlayer.name : landed.id;
  const voteLabel = landed.vote === "decider" ? "Decider" : "Standard";
  room.wheel.notice = {
    id: `modeWheel:${w.spinNonce}`,
    title: "Vote Eliminated!",
    bodyHtml: `<div class="modalBig">${landedName}'s vote (${voteLabel})</div>`,
    cta: "OK",
  };

  if (w.remaining.length === 1) {
    w.winnerVote = w.remaining[0].vote;
    room.mode = w.winnerVote;
    room.phase = "modeWheelDone";
    room.wheel.history.push({ at: Date.now(), event: "modeWheel:winner", vote: w.winnerVote });
    const winnerPlayer = room.players[w.remaining[0].id];
    const winnerName = winnerPlayer ? winnerPlayer.name : w.remaining[0].id;
    const winLabel = w.winnerVote === "decider" ? "Decider" : "Standard";
    room.wheel.notice = {
      id: `modeWheel:winner:${w.spinNonce}`,
      title: `${winLabel} Mode Wins!`,
      bodyHtml: `<div class="modalBig">${winLabel}</div><div>${winnerName}'s vote is the last one standing!</div>`,
      cta: "Let\u2019s Go",
    };
  }
}

function ensureDeciderWheelStarted(room) {
  room.phase = "deciderWheel";
  const items = room.deciderPool.map((g) => ({ ...g }));
  room.wheel.deciderWheel = {
    remaining: items,
    eliminated: [],
    winnerItem: null,
    visualAngle: Math.random() * Math.PI * 2,
    lastSpin: null,
    spinNonce: 0,
  };
  room.wheel.history.push({ at: Date.now(), event: "deciderWheel:start" });
  roomBroadcast(room);
}

function spinDeciderWheel(room) {
  const w = room.wheel.deciderWheel;
  if (!w || room.phase !== "deciderWheel") return;
  if (w.remaining.length <= 1) return;
  if (room.wheel.notice) return;
  const entriesItemIds = w.remaining.map((x) => x.id);
  const idx = Math.floor(Math.random() * w.remaining.length);
  const landed = w.remaining[idx];
  const startAngle = Number.isFinite(w.visualAngle) ? w.visualAngle : 0;
  const target = angleForEntryIndex(w.remaining.length, idx);
  const extraTurns = 5;
  const endAngle = target + extraTurns * Math.PI * 2;
  const durationMs = 1700;

  w.remaining.splice(idx, 1);
  w.eliminated.push(landed);
  w.spinNonce += 1;
  w.lastSpin = {
    nonce: w.spinNonce,
    at: Date.now(),
    entriesItemIds,
    landedItemId: landed.id,
    startAngle,
    endAngle,
    durationMs,
  };
  w.visualAngle = normalizeAngle(endAngle);
  room.wheel.history.push({ at: Date.now(), event: "deciderWheel:land", landed: landed.id });

  room.wheel.notice = {
    id: `deciderWheel:${w.spinNonce}`,
    title: "Eliminated!",
    bodyHtml: `<div class="modalBig">${landed.label}</div>`,
    cta: "OK",
  };

  if (w.remaining.length === 1) {
    w.winnerItem = w.remaining[0];
    room.decider.winningDeciderGame = { ...w.winnerItem };
    room.phase = "deciderWheelDone";
    room.wheel.history.push({ at: Date.now(), event: "deciderWheel:winner", winner: w.winnerItem.id });
    room.wheel.notice = {
      id: `deciderWheel:winner:${w.spinNonce}`,
      title: "Decider Game!",
      bodyHtml: `<div class="modalBig">${w.winnerItem.label}</div><div>This is the game you'll play to determine the bracket winner.</div>`,
      cta: "Let's Go",
    };
  }
}

function ensureWheel1Started(room) {
  room.phase = "wheel1";
  const playerIds = Object.keys(room.players)
    .map((cid) => room.players[cid])
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.clientId);
  room.wheel.wheel1 = {
    remaining: [...playerIds],
    eliminated: [],
    winnerClientId: null,
    visualAngle: Math.random() * Math.PI * 2,
    lastSpin: null, // { nonce, at, entriesClientIds, landedClientId, startAngle, endAngle, durationMs }
    spinNonce: 0,
  };
  room.wheel.history.push({ at: Date.now(), event: "wheel1:start" });
  roomBroadcast(room);
}

function spinWheel1(room) {
  const w = room.wheel.wheel1;
  if (!w || room.phase !== "wheel1") return;
  if (w.remaining.length <= 1) return;
  if (room.wheel.notice) return;
  const entriesClientIds = [...w.remaining];
  const idx = Math.floor(Math.random() * entriesClientIds.length);
  const landed = entriesClientIds[idx];
  const startAngle = Number.isFinite(w.visualAngle) ? w.visualAngle : 0;
  const target = angleForEntryIndex(entriesClientIds.length, idx);
  const extraTurns = 5;
  const endAngle = target + extraTurns * Math.PI * 2;
  const durationMs = 1700;

  w.remaining.splice(idx, 1);
  w.eliminated.push(landed);
  w.spinNonce += 1;
  w.lastSpin = {
    nonce: w.spinNonce,
    at: Date.now(),
    entriesClientIds,
    landedClientId: landed,
    startAngle,
    endAngle,
    durationMs,
  };
  w.visualAngle = normalizeAngle(endAngle);
  room.wheel.history.push({ at: Date.now(), event: "wheel1:land", landed });

  room.wheel.notice = {
    id: `wheel1:${w.spinNonce}`,
    title: "Eliminated!",
    bodyHtml: `<div class="modalBig">${room.players[landed]?.name ?? landed}</div>`,
    cta: "OK",
  };

  if (w.remaining.length === 1) {
    w.winnerClientId = w.remaining[0];
    room.wheel.history.push({ at: Date.now(), event: "wheel1:winner", winner: w.winnerClientId });
    room.phase = "wheel1_done";
    room.wheel.notice = {
      id: `wheel1:winner:${w.spinNonce}`,
      title: "Bracket Winner!",
      bodyHtml: `<div class="modalBig">${room.players[w.winnerClientId]?.name ?? w.winnerClientId}</div><div>Click Continue to start the game wheel.</div>`,
      cta: "Nice",
    };
  }
}

function startFinalWheel(room) {
  const bracketOwner = room.wheel.wheel1?.winnerClientId;
  if (!bracketOwner) return;
  const bracketPicks = room.bracket.picksByPlayer[bracketOwner] ?? {};
  const allItems = Object.values(bracketPicks).filter(Boolean);
  room.wheel.wheelFinal = {
    bracketOwnerClientId: bracketOwner,
    remaining: allItems.map((x) => ({ ...x })), // [{id,label,ownerClientId}]
    strikes: Object.fromEntries(allItems.map((it) => [it.id, 0])),
    eliminated: [],
    winnerItem: null,
    winningItem: null,
    visualAngle: Math.random() * Math.PI * 2,
    lastSpin: null, // { nonce, at, entriesItemIds, landedItemId, strikes, eliminatedThisSpin, startAngle, endAngle, durationMs }
    spinNonce: 0,
  };
  room.wheel.history.push({ at: Date.now(), event: "wheelFinal:start", bracketOwner });
}

function spinFinalWheel(room) {
  const w = room.wheel.wheelFinal;
  if (!w || room.phase !== "wheelFinal") return;
  if (w.remaining.length <= 1) return;
  if (room.wheel.notice) return;
  const entriesItemIds = w.remaining.map((x) => x.id);
  const idx = Math.floor(Math.random() * w.remaining.length);
  const landed = w.remaining[idx];
  const startAngle = Number.isFinite(w.visualAngle) ? w.visualAngle : 0;
  const target = angleForEntryIndex(w.remaining.length, idx);
  const extraTurns = 6;
  const endAngle = target + extraTurns * Math.PI * 2;
  const durationMs = 1850;

  w.strikes[landed.id] = (w.strikes[landed.id] ?? 0) + 1;
  w.spinNonce += 1;
  let eliminatedThisSpin = false;
  if (w.strikes[landed.id] >= 2) {
    w.remaining = w.remaining.filter((x) => x.id !== landed.id);
    w.eliminated.push(landed);
    eliminatedThisSpin = true;
    room.wheel.history.push({ at: Date.now(), event: "wheelFinal:eliminate", eliminated: landed.id });
  }
  w.lastSpin = {
    nonce: w.spinNonce,
    at: Date.now(),
    entriesItemIds,
    landedItemId: landed.id,
    strikes: w.strikes[landed.id],
    eliminatedThisSpin,
    startAngle,
    endAngle,
    durationMs,
  };
  w.visualAngle = normalizeAngle(endAngle);
  room.wheel.history.push({
    at: Date.now(),
    event: "wheelFinal:land",
    landed: landed.id,
    strikes: w.strikes[landed.id],
    eliminatedThisSpin,
  });

  // WheelFinal: only notify on elimination (or final win).
  if (eliminatedThisSpin) {
    room.wheel.notice = {
      id: `wheelFinal:eliminate:${w.spinNonce}`,
      title: "Eliminated!",
      bodyHtml: `<div class="modalBig">${landed.label}</div>`,
      cta: "OK",
    };
  }

  if (w.remaining.length === 1) {
    w.winnerItem = w.remaining[0];
    w.winningItem = w.winnerItem;
    room.wheel.result = {
      bracketWinnerClientId: room.wheel.wheel1?.winnerClientId ?? null,
      itemWinnerOwnerClientId: w.winningItem?.ownerClientId ?? null,
      finalWinnerOwnerClientId: w.winningItem?.ownerClientId ?? null,
      finalWinningItem: w.winningItem ?? null,
    };
    room.phase = "done";
    room.wheel.history.push({ at: Date.now(), event: "done", result: room.wheel.result });
    room.wheel.notice = {
      id: `done:${w.spinNonce}`,
      title: "Champion!",
      bodyHtml: `<div class="modalBig">${w.winningItem?.label ?? "—"}</div>`,
      cta: "GG",
    };
  }
}

function safeRoom(code) {
  const room = rooms.get(code);
  if (!room) return null;
  return room;
}

function seatTaken(room, seat) {
  return Object.values(room.players).some((p) => p.seat === seat);
}

function nextAvailableSeat(room) {
  for (const s of PLAYER_SEATS) {
    if (!seatTaken(room, s.seat)) return s;
  }
  return null;
}

function playerDisplay(room, clientId) {
  const p = room.players[clientId];
  if (!p) return null;
  return { clientId: p.clientId, seat: p.seat, name: p.name, color: p.color };
}

io.on("connection", (socket) => {
  const clientId = String(socket.handshake.auth?.clientId || "");
  if (!clientId) {
    socket.emit("fatal", { message: "Missing clientId" });
    socket.disconnect(true);
    return;
  }

  socket.on("room:create", () => {
    const room = getOrCreateRoom();
    socket.emit("room:created", { code: room.code });
  });

  socket.on("room:join", ({ code, name }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room) {
      socket.emit("room:error", { message: "Room not found." });
      return;
    }

    socket.join(room.code);

    // Rejoin support: if player exists, just attach socket
    if (room.players[clientId]) {
      room.players[clientId].connectedSocketIds.add(socket.id);
      if (name && typeof name === "string") room.players[clientId].name = name.slice(0, 24);
      roomBroadcast(room);
      return;
    }

    // New player: seat assignment
    if (Object.keys(room.players).length >= 3) {
      socket.emit("room:error", { message: "Room is full (3 players)." });
      return;
    }
    const seat = nextAvailableSeat(room);
    if (!seat) {
      socket.emit("room:error", { message: "No seats available." });
      return;
    }
    room.players[clientId] = {
      clientId,
      seat: seat.seat,
      name: (typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : seat.name),
      color: seat.color,
      ready: false,
      connectedSocketIds: new Set([socket.id]),
    };
    roomBroadcast(room);
  });

  socket.on("room:ready", ({ code, ready }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    const p = room.players[clientId];
    if (!p) return;
    if (Boolean(ready) && !room.mode) {
      socket.emit("room:error", { message: "All players must agree on a game mode first." });
      return;
    }
    p.ready = Boolean(ready);
    roomBroadcast(room);
    ensureDraftStarted(room);
  });

  socket.on("room:leave", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room) return;
    socket.leave(room.code);
    if (room.players[clientId]) {
      room.players[clientId].connectedSocketIds.delete(socket.id);
      roomBroadcast(room);
    }
  });

  socket.on("draft:pick", ({ code, gameId }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "draft") return;
    if (!room.players[clientId]) return;

    const currentTurn = room.draft.turnOrder[room.draft.turnIndex];
    if (currentTurn !== clientId) {
      socket.emit("room:error", { message: "Not your turn." });
      return;
    }

    const gid = String(gameId || "");
    if (!gid) return;
    if (room.draft.takenIds.has(gid)) {
      socket.emit("room:error", { message: "That item is already taken." });
      return;
    }

    const game = room.pool.find((g) => g.id === gid);
    if (!game) return;

    const picks = room.draft.picksByPlayer[clientId] ?? [];
    if (picks.length >= room.draft.totalPicksPerPlayer) {
      socket.emit("room:error", { message: "You already have 3 picks." });
      return;
    }

    room.draft.takenIds.add(gid);
    picks.push({ id: game.id, label: game.label, ownerClientId: clientId });
    room.draft.picksByPlayer[clientId] = picks;

    // advance turn to next player who still needs picks
    const order = room.draft.turnOrder;
    for (let i = 0; i < order.length; i++) {
      room.draft.turnIndex = (room.draft.turnIndex + 1) % order.length;
      const nextCid = order[room.draft.turnIndex];
      const nextPicks = room.draft.picksByPlayer[nextCid] ?? [];
      if (nextPicks.length < room.draft.totalPicksPerPlayer) break;
    }

    roomBroadcast(room);
    ensureBracketStarted(room);
  });

  socket.on("draft:autoPick", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "draft") return;
    if (!room.players[clientId]) return;
    const currentTurn = room.draft.turnOrder[room.draft.turnIndex];
    if (currentTurn !== clientId) {
      socket.emit("room:error", { message: "Not your turn." });
      return;
    }

    const picks = room.draft.picksByPlayer[clientId] ?? [];
    if (picks.length >= room.draft.totalPicksPerPlayer) {
      socket.emit("room:error", { message: "You already have 3 picks." });
      return;
    }

    const available = room.pool.filter((g) => !room.draft.takenIds.has(g.id));
    if (!available.length) return;
    const game = available[Math.floor(Math.random() * available.length)];

    // Inline the same logic as draft:pick, so autopick works even for the very first turn.
    room.draft.takenIds.add(game.id);
    picks.push({ id: game.id, label: game.label, ownerClientId: clientId });
    room.draft.picksByPlayer[clientId] = picks;

    // advance turn to next player who still needs picks
    const order = room.draft.turnOrder;
    for (let i = 0; i < order.length; i++) {
      room.draft.turnIndex = (room.draft.turnIndex + 1) % order.length;
      const nextCid = order[room.draft.turnIndex];
      const nextPicks = room.draft.picksByPlayer[nextCid] ?? [];
      if (nextPicks.length < room.draft.totalPicksPerPlayer) break;
    }

    roomBroadcast(room);
    ensureBracketStarted(room);
  });

  socket.on("bracket:pick", ({ code, ownerClientId, gameId }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "bracket") return;
    if (!room.players[clientId]) return;
    const ownerCid = String(ownerClientId || "");
    if (!room.players[ownerCid]) return;

    const draftedFromOwner = room.draft.picksByPlayer[ownerCid] ?? [];
    const gid = String(gameId || "");
    const game = draftedFromOwner.find((g) => g.id === gid);
    if (!game) {
      socket.emit("room:error", { message: "That item isn't in that player's drafted set." });
      return;
    }

    const myPicks = room.bracket.picksByPlayer[clientId] ?? {};
    if (myPicks[ownerCid]) {
      socket.emit("room:error", { message: "You already picked from that player's items." });
      return;
    }

    // prevent picking the same game twice within your bracket (shouldn't happen across owners, but safe)
    const alreadyPickedIds = new Set(Object.values(myPicks).map((x) => x?.id).filter(Boolean));
    if (alreadyPickedIds.has(gid)) {
      socket.emit("room:error", { message: "You already picked that item." });
      return;
    }

    // prevent duplicates across the whole room for the same owner's drafted games
    for (const pickerCid of Object.keys(room.players)) {
      const picks = room.bracket.picksByPlayer[pickerCid] ?? {};
      const picked = picks[ownerCid];
      if (picked?.id === gid) {
        socket.emit("room:error", { message: "That item was already chosen by someone else." });
        return;
      }
    }

    myPicks[ownerCid] = { ...game };
    room.bracket.picksByPlayer[clientId] = myPicks;
    roomBroadcast(room);
    ensurePostBracket(room);
  });

  socket.on("bracket:autoPick", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "bracket") return;
    if (!room.players[clientId]) return;

    const owners = Object.keys(room.players);
    const myPicks = room.bracket.picksByPlayer[clientId] ?? {};
    const remainingOwners = owners.filter((o) => !myPicks[o]);
    if (!remainingOwners.length) return;

    // Fill ALL remaining owners in one go, respecting "no duplicate game per owner" across players.
    for (const ownerCid of remainingOwners) {
      const draftedFromOwner = room.draft.picksByPlayer[ownerCid] ?? [];
      if (!draftedFromOwner.length) continue;

      const takenIds = new Set();
      for (const pickerCid of owners) {
        const picks = room.bracket.picksByPlayer[pickerCid] ?? {};
        const picked = picks[ownerCid];
        if (picked?.id) takenIds.add(picked.id);
      }

      const available = draftedFromOwner.filter((g) => !takenIds.has(g.id));
      if (!available.length) continue;

      const game = available[Math.floor(Math.random() * available.length)];
      myPicks[ownerCid] = { ...game };
    }

    room.bracket.picksByPlayer[clientId] = myPicks;
    roomBroadcast(room);
    ensurePostBracket(room);
  });

  socket.on("wheel:spin", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room) return;
    if (!room.players[clientId]) return;
    if (room.wheel.notice) return;

    if (room.phase === "modeWheel") spinModeWheel(room);
    else if (room.phase === "wheel1") spinWheel1(room);
    else if (room.phase === "wheelFinal") spinFinalWheel(room);
    else if (room.phase === "deciderWheel") spinDeciderWheel(room);

    roomBroadcast(room);
  });

  socket.on("wheel:continue", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room) return;
    if (!room.players[clientId]) return;
    if (room.wheel.notice) return;
    if (room.phase === "modeWheelDone") {
      room.phase = "lobby";
      for (const cid of Object.keys(room.players)) {
        room.players[cid].ready = false;
      }
      roomBroadcast(room);
    } else if (room.phase === "wheel1_done") {
      room.phase = "wheelFinal";
      startFinalWheel(room);
      roomBroadcast(room);
    } else if (room.phase === "deciderWheelDone") {
      room.phase = "deciderPickWinner";
      roomBroadcast(room);
    }
  });

  socket.on("wheel:ackNotice", ({ code, id }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room) return;
    if (!room.players[clientId]) return;
    const notice = room.wheel.notice;
    if (!notice) return;
    if (String(id || "") !== notice.id) return;
    room.wheel.notice = null;
    roomBroadcast(room);
  });

  socket.on("room:voteMode", ({ code, vote }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    if (room.mode) return;
    if (!room.players[clientId]) return;
    const v = vote === "decider" ? "decider" : "standard";
    room.modeVotes[clientId] = v;
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 3) {
      const votes = playerIds.map((cid) => room.modeVotes[cid]).filter(Boolean);
      if (votes.length === 3) {
        if (votes.every((x) => x === votes[0])) {
          room.mode = votes[0];
        } else {
          startModeWheel(room);
          roomBroadcast(room);
          return;
        }
      }
    }
    for (const cid of playerIds) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("room:setDeciderLine", ({ code, index, label }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    const p = room.players[clientId];
    if (!p) return;
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= 6) return;
    const dr = deciderRangeForSeat(p.seat);
    if (!dr || idx < dr.start || idx > dr.end) {
      socket.emit("room:error", { message: "You can only edit your own decider games." });
      return;
    }
    const text = String(label ?? "").trim().slice(0, 40);
    room.deciderPool[idx] = { id: `decider-${idx + 1}`, label: text || `Decider Game ${idx + 1}` };
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("room:setDeciderSlice", ({ code, labels }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    const p = room.players[clientId];
    if (!p) return;
    const dr = deciderRangeForSeat(p.seat);
    if (!dr) return;
    if (!Array.isArray(labels) || labels.length !== 2) {
      socket.emit("room:error", { message: "Need exactly 2 lines." });
      return;
    }
    for (let i = 0; i < 2; i++) {
      const idx = dr.start + i;
      const text = String(labels[i] ?? "").trim().slice(0, 40);
      room.deciderPool[idx] = { id: `decider-${idx + 1}`, label: text || `Decider Game ${idx + 1}` };
    }
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("room:resetDeciderPool", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    if (!room.players[clientId]) return;
    room.deciderPool = structuredClone(DEFAULT_DECIDER_POOL);
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("decider:pickWinner", ({ code, winnerClientId: wCid }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "deciderPickWinner") return;
    if (!room.players[clientId]) return;
    const winnerId = String(wCid || "");
    if (!room.players[winnerId]) {
      socket.emit("room:error", { message: "Invalid player." });
      return;
    }
    room.decider.winnerClientId = winnerId;
    room.phase = "deciderPickGame";
    room.wheel.history.push({ at: Date.now(), event: "decider:pickWinner", winner: winnerId });
    roomBroadcast(room);
  });

  socket.on("decider:pickGame", ({ code, gameId }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "deciderPickGame") return;
    if (!room.players[clientId]) return;
    const winnerId = room.decider.winnerClientId;
    if (!winnerId) return;
    const bracketPicks = room.bracket.picksByPlayer[winnerId] ?? {};
    const allItems = Object.values(bracketPicks).filter(Boolean);
    const gid = String(gameId || "");
    const game = allItems.find((g) => g.id === gid);
    if (!game) {
      socket.emit("room:error", { message: "Invalid game." });
      return;
    }
    room.decider.winningBracketGame = { ...game };
    room.wheel.result = {
      bracketWinnerClientId: winnerId,
      itemWinnerOwnerClientId: game.ownerClientId ?? null,
      finalWinnerOwnerClientId: game.ownerClientId ?? null,
      finalWinningItem: { ...game },
    };
    room.phase = "done";
    room.wheel.history.push({ at: Date.now(), event: "done", result: room.wheel.result });
    roomBroadcast(room);
  });

  socket.on("room:setPool", ({ code, items }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    // Only seat 1 can overwrite all 18 (safety).
    const p = room.players[clientId];
    if (!p || p.seat !== 1) {
      socket.emit("room:error", { message: "Only Player 1 can apply an 18-line overwrite." });
      return;
    }
    // MVP: any connected player can set pool pre-start
    if (!Array.isArray(items) || items.length !== 18) {
      socket.emit("room:error", { message: "Pool must be exactly 18 items." });
      return;
    }
    const cleaned = items
      .map((x, i) => ({
        id: `game-${i + 1}`,
        label: String(x?.label ?? x ?? `Game ${i + 1}`).slice(0, 40),
      }))
      .slice(0, 18);
    room.pool = cleaned;
    // Changing the pool un-readies everyone to prevent accidental starts.
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("room:setPoolLine", ({ code, index, label }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    const p = room.players[clientId];
    if (!p) return;
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= 18) return;
    const r = rangeForSeat(p.seat);
    if (!r || idx < r.start || idx > r.end) {
      socket.emit("room:error", { message: "You can only edit your own column." });
      return;
    }
    const text = String(label ?? "").trim().slice(0, 40);
    room.pool[idx] = { id: `game-${idx + 1}`, label: text || `Game ${idx + 1}` };
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("room:setPoolSlice", ({ code, startIndex, labels }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    const p = room.players[clientId];
    if (!p) return;
    const r = rangeForSeat(p.seat);
    if (!r) return;

    const start = Number(startIndex);
    if (!Number.isFinite(start) || start !== r.start) {
      socket.emit("room:error", { message: "Invalid slice start for your seat." });
      return;
    }
    if (!Array.isArray(labels) || labels.length !== 6) {
      socket.emit("room:error", { message: "Slice must be exactly 6 lines." });
      return;
    }
    for (let i = 0; i < 6; i++) {
      const idx = start + i;
      const text = String(labels[i] ?? "").trim().slice(0, 40);
      room.pool[idx] = { id: `game-${idx + 1}`, label: text || `Game ${idx + 1}` };
    }
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("room:resetPoolDefault", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room || room.phase !== "lobby") return;
    if (!room.players[clientId]) return;
    room.pool = structuredClone(DEFAULT_POOL);
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("room:reset", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room) return;
    room.phase = "lobby";
    room.mode = null;
    room.modeVotes = {};
    room.pool = structuredClone(DEFAULT_POOL);
    room.deciderPool = structuredClone(DEFAULT_DECIDER_POOL);
    room.draft = {
      picksByPlayer: {},
      takenIds: new Set(),
      turnOrder: [],
      turnIndex: 0,
      totalPicksPerPlayer: 3,
    };
    room.bracket = { picksByPlayer: {} };
    room.wheel = { wheel1: null, wheelFinal: null, deciderWheel: null, modeWheel: null, result: null, notice: null, history: [] };
    room.decider = { winningDeciderGame: null, winnerClientId: null, winningBracketGame: null };
    for (const cid of Object.keys(room.players)) {
      room.players[cid].ready = false;
    }
    roomBroadcast(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players[clientId];
      if (!p) continue;
      p.connectedSocketIds.delete(socket.id);
      roomBroadcast(room);
    }
  });

  socket.on("whoami", ({ code }) => {
    const roomCode = String(code || "").toUpperCase().trim();
    const room = safeRoom(roomCode);
    if (!room) return;
    socket.emit("whoami", { me: playerDisplay(room, clientId) });
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Bracket game running on http://localhost:${PORT}`);
});

