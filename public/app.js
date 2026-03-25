const $ = (sel) => document.querySelector(sel);

function getClientId() {
  const key = "bg_client_id";
  let v = localStorage.getItem(key);
  if (!v) {
    v = `c_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
    localStorage.setItem(key, v);
  }
  return v;
}

const clientId = getClientId();
const socket = io({
  auth: { clientId },
});

let roomCode = null;
let roomState = null;
let me = null;
let wheelAnim = { lastNonce: 0, spinning: false, angle: 0 };
let lobbyEdit = { focusedIdx: null, selStart: null, selEnd: null, pendingByIdx: {} };
let wheelUi = { pendingNoticeId: null, showNotice: false };

function deciderRangeForSeat(seat) {
  if (seat === 1) return { start: 0, end: 1 };
  if (seat === 2) return { start: 2, end: 3 };
  if (seat === 3) return { start: 4, end: 5 };
  return null;
}

function buildDeciderPoolHtml(players, deciderPool, canEdit, deciderSeatRange, lobbyEdit, isPlayer) {
  const cols = [0, 1, 2].map((col) => {
    const start = col * 2;
    const ownerSeat = col + 1;
    const owner = players.find((p) => p.seat === ownerSeat) || null;
    const rows = Array.from({ length: 2 }, (_, i) => start + i)
      .map((idx) => {
        const serverLabel = deciderPool[idx]?.label ?? ("Decider Game " + (idx + 1));
        const focusKey = "d" + idx;
        const label =
          canEdit && lobbyEdit.focusedIdx === focusKey && typeof lobbyEdit.pendingByIdx[focusKey] === "string"
            ? lobbyEdit.pendingByIdx[focusKey]
            : serverLabel;
        const editable = canEdit && deciderSeatRange && idx >= deciderSeatRange.start && idx <= deciderSeatRange.end;
        return '<div class="item">'
          + '<div class="label">'
          + '<div class="mini muted">D' + (idx + 1) + '</div>'
          + '<input class="input mono" data-decider-idx="' + idx + '"'
          + ' value="' + escapeHtml(label) + '"'
          + (!editable ? ' disabled' : '') + '/>'
          + '</div>'
          + '<div class="badge">live</div>'
          + '</div>';
      })
      .join("");
    const dotColor = owner?.color || "rgba(255,255,255,0.3)";
    const nameStr = owner ? owner.name : ("Player " + ownerSeat);
    return '<div class="col">'
      + '<div class="colHeader">'
      + '<div class="name">'
      + '<span class="dot" style="background:' + dotColor + '"></span>'
      + nameStr
      + '</div>'
      + '<div class="badge">D' + (start + 1) + '\u2013D' + (start + 2) + '</div>'
      + '</div>'
      + '<div class="list">' + rows + '</div>'
      + '</div>';
  }).join("");

  const resetDisabled = !canEdit ? " disabled" : "";
  const pasteDisabled = !canEdit || !deciderSeatRange ? " disabled" : "";

  return '<div class="sep"></div>'
    + '<div class="sectionTitle"><h3>Decider pool (6)</h3><div class="pill">2 per player</div></div>'
    + '<div class="mini">Each player adds 2 decider games. The wheel will eliminate them one by one.</div>'
    + '<div class="sep"></div>'
    + '<div class="grid3" id="deciderPoolGrid">' + cols + '</div>'
    + '<div class="wheelRow" style="margin-top:12px">'
    + '<button class="btn" id="resetDeciderPoolBtn"' + resetDisabled + '>Reset decider pool</button>'
    + '<button class="btn primary" id="applyDeciderPasteBtn"' + pasteDisabled + '>Apply 2-line paste (your column)</button>'
    + '<div class="wheelState muted">Paste only updates your 2 decider games.</div>'
    + '</div>'
    + '<div style="margin-top:10px">'
    + '<textarea id="deciderPasteBox" class="input mono" rows="2" spellcheck="false" placeholder="Paste 2 lines for your decider games\u2026 (then click Apply)"></textarea>'
    + '</div>';
}

const connectCard = $("#connectCard");
const statusCard = $("#statusCard");
const gameCard = $("#gameCard");
const gameContent = $("#gameContent");
const roomPill = $("#roomPill");
const roomCodeText = $("#roomCodeText");
const copyRoomBtn = $("#copyRoomBtn");

const nameInput = $("#nameInput");
const roomInput = $("#roomInput");
const createBtn = $("#createBtn");
const joinBtn = $("#joinBtn");
const connectError = $("#connectError");

const whoamiEl = $("#whoami");
const phaseNameEl = $("#phaseName");
const playersEl = $("#players");
const resetBtn = $("#resetBtn");

const toastEl = $("#toast");

function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), ms);
}

function showError(msg) {
  connectError.textContent = msg;
  connectError.hidden = !msg;
}

function setRoomUI(code) {
  roomPill.hidden = !code;
  roomCodeText.textContent = code || "—";
}

copyRoomBtn.addEventListener("click", async () => {
  if (!roomCode) return;
  await navigator.clipboard.writeText(roomCode);
  toast("Room code copied");
});

createBtn.addEventListener("click", () => {
  showError("");
  socket.emit("room:create");
});

joinBtn.addEventListener("click", () => {
  showError("");
  const code = (roomInput.value || "").trim().toUpperCase();
  if (!code) return showError("Enter a room code.");
  joinRoom(code);
});

resetBtn.addEventListener("click", () => {
  if (!roomCode) return;
  socket.emit("room:reset", { code: roomCode });
});

function joinRoom(code) {
  const name = (nameInput.value || "").trim().slice(0, 24);
  socket.emit("room:join", { code, name });
  roomCode = code;
  setRoomUI(roomCode);
  connectCard.hidden = true;
  statusCard.hidden = false;
  gameCard.hidden = false;
  socket.emit("whoami", { code: roomCode });
}

function seatLabel(p) {
  return `P${p.seat}`;
}

function renderPlayers(players, currentTurnClientId) {
  playersEl.innerHTML = "";
  for (const p of players) {
    const row = document.createElement("div");
    row.className = "playerRow";
    const left = document.createElement("div");
    left.className = "playerLeft";
    const dot = document.createElement("div");
    dot.className = "dot";
    dot.style.background = p.color;
    const name = document.createElement("div");
    name.className = "pname";
    name.textContent = `${p.name}`;
    const meta = document.createElement("div");
    meta.className = "pmeta";
    meta.textContent = `${seatLabel(p)}${p.ready ? " · READY" : ""}${p.connected ? "" : " (offline)"}${p.clientId === currentTurnClientId ? " · TURN" : ""}`;
    left.append(dot, name, meta);
    row.append(left);
    playersEl.append(row);
  }
}

function playerById(players, cid) {
  return players.find((p) => p.clientId === cid) || null;
}

function displayName(players, cid) {
  const p = playerById(players, cid);
  return p ? `${p.name} (${seatLabel(p)})` : cid;
}

function renderLobby(state) {
  const players = state.players;
  const missing = 3 - players.length;
  const canEdit = state.phase === "lobby";
  const meReady = Boolean(players.find((p) => p.clientId === clientId)?.ready);
  const readyCount = state.lobby?.readyCount ?? players.filter((p) => p.ready).length;
  const pool = state.pool || [];
  const meSeat = players.find((p) => p.clientId === clientId)?.seat ?? null;
  const seatRange =
    meSeat === 1 ? { start: 0, end: 5 } : meSeat === 2 ? { start: 6, end: 11 } : meSeat === 3 ? { start: 12, end: 17 } : null;

  const mode = state.mode;
  const modeVotes = state.modeVotes || {};
  const myVote = modeVotes[clientId] || null;
  const isPlayer = Boolean(meSeat);
  const showDeciderPool = mode === "decider" || Object.values(modeVotes).some((v) => v === "decider");
  const deciderPool = state.deciderPool || [];

  const modeStatus = mode
    ? `${mode.charAt(0).toUpperCase() + mode.slice(1)} (unanimous)`
    : players.length < 3
    ? "Waiting for players"
    : "Vote below";

  const voteDots = players
    .map((p) => {
      const v = modeVotes[p.clientId];
      const vLabel = v === "decider" ? "D" : v === "standard" ? "S" : "?";
      return `<span class="modeVoteDot" style="border-color:${p.color}" title="${p.name}: ${v || "no vote"}">${vLabel}</span>`;
    })
    .join("");

  const active = document.activeElement;
  if (active && active.getAttribute) {
    const idxAttr = active.getAttribute("data-pool-idx") ?? active.getAttribute("data-decider-idx");
    if (idxAttr != null) {
      lobbyEdit.focusedIdx = active.getAttribute("data-pool-idx") != null ? Number(idxAttr) : `d${idxAttr}`;
      lobbyEdit.selStart = active.selectionStart ?? null;
      lobbyEdit.selEnd = active.selectionEnd ?? null;
      lobbyEdit.pendingByIdx[lobbyEdit.focusedIdx] = active.value;
    } else {
      lobbyEdit.focusedIdx = null;
      lobbyEdit.selStart = null;
      lobbyEdit.selEnd = null;
    }
  }

  const deciderSeatRange = meSeat ? deciderRangeForSeat(meSeat) : null;

  const deciderPoolHtml = showDeciderPool ? buildDeciderPoolHtml(players, deciderPool, canEdit, deciderSeatRange, lobbyEdit, isPlayer) : "";

  const readyDisabled = players.length < 3 || !mode;

  gameContent.innerHTML = `
    <div class="sectionTitle">
      <h3>Lobby</h3>
      <div class="pill">${players.length}/3 joined · ${readyCount}/3 ready</div>
    </div>
    <div class="mini">
      Once all 3 are in, choose a game mode, then click <b>Ready</b> to start the draft.
      ${missing > 0 ? `<div style="margin-top:8px">Need <b>${missing}</b> more.</div>` : ""}
    </div>
    <div class="sep"></div>
    <div class="sectionTitle">
      <h3>Game Mode</h3>
      <div class="pill">${modeStatus}</div>
    </div>
    <div class="mini">
      <b>Standard</b> — wheel eliminates players, then 2-hit wheel on the winner's bracket games.<br>
      <b>Decider</b> — each player adds 2 decider games (6 total). The wheel eliminates them one by one, play the last one standing to pick the bracket winner, then manually pick the champion game.
    </div>
    <div class="modeVoteRow">
      <button class="btn modeBtn ${myVote === "standard" ? "modeActive" : ""}" id="voteStandard" ${!isPlayer || mode ? "disabled" : ""}>Standard</button>
      <button class="btn modeBtn ${myVote === "decider" ? "modeActive" : ""}" id="voteDecider" ${!isPlayer || mode ? "disabled" : ""}>Decider</button>
      <div class="modeVoteDots">${voteDots}</div>
    </div>

    ${mode ? `
    ${deciderPoolHtml}
    <div class="sep"></div>
    <div class="wheelRow">
      <button class="btn ${meReady ? "" : "primary"}" id="readyBtn" ${readyDisabled ? "disabled" : ""}>
        ${meReady ? "Unready" : "Ready"}
      </button>
      <div class="wheelState muted">When the pool is saved, everyone is set to unready.</div>
    </div>
    <div class="sep"></div>
    <div class="sectionTitle">
      <h3>Game pool (18)</h3>
      <div class="pill">Live-collab</div>
    </div>
    <div class="mini">
      No overlaps: Player 1 edits 1\u20136, Player 2 edits 7\u201312, Player 3 edits 13\u201318. Changes sync instantly and unready the room.
    </div>
    <div class="sep"></div>
    <div class="grid3" id="poolGrid">
      ${[0, 1, 2]
        .map((col) => {
          const start = col * 6;
          const ownerSeat = col + 1;
          const owner = players.find((p) => p.seat === ownerSeat) || null;
          const rows = Array.from({ length: 6 }, (_, i) => start + i)
            .map((idx) => {
              const serverLabel = pool[idx]?.label ?? `Game ${idx + 1}`;
              const label =
                canEdit && lobbyEdit.focusedIdx === idx && typeof lobbyEdit.pendingByIdx[idx] === "string"
                  ? lobbyEdit.pendingByIdx[idx]
                  : serverLabel;
              const editable = canEdit && seatRange && idx >= seatRange.start && idx <= seatRange.end;
              return `
                <div class="item">
                  <div class="label">
                    <div class="mini muted">#${idx + 1}</div>
                    <input
                      class="input mono"
                      data-pool-idx="${idx}"
                      value="${escapeHtml(label)}"
                      ${!editable ? "disabled" : ""}
                    />
                  </div>
                  <div class="badge">live</div>
                </div>
              `;
            })
            .join("");
          return `
            <div class="col">
              <div class="colHeader">
                <div class="name">
                  <span class="dot" style="background:${owner?.color || "rgba(255,255,255,0.3)"}"></span>
                  ${owner ? owner.name : `Player ${ownerSeat}`}
                </div>
                <div class="badge">#${start + 1}\u2013${start + 6}</div>
              </div>
              <div class="list">${rows}</div>
            </div>
          `;
        })
        .join("")}
    </div>
    <div class="wheelRow" style="margin-top:12px">
      <button class="btn" id="resetPoolBtn" ${!canEdit ? "disabled" : ""}>Reset to defaults</button>
      <button class="btn primary" id="applyPasteBtn" ${!canEdit || !seatRange ? "disabled" : ""}>Apply 6-line paste (your column)</button>
      <div class="wheelState muted">Paste only updates your 6 items.</div>
    </div>
    <div style="margin-top:10px">
      <textarea id="pasteBox" class="input mono" rows="5" spellcheck="false" placeholder="Optional: paste 6 lines for your column\u2026 (then click Apply)"></textarea>
    </div>
    ` : `
    <div class="sep"></div>
    <div class="mini" style="text-align:center; padding:20px 0;">All 3 players must agree on a game mode before the pools appear.</div>
    `}
  `;

  const readyBtn = $("#readyBtn");
  const resetPoolBtn = $("#resetPoolBtn");
  const applyPasteBtn = $("#applyPasteBtn");
  const pasteBox = $("#pasteBox");
  const voteStandard = $("#voteStandard");
  const voteDecider = $("#voteDecider");

  if (voteStandard) {
    voteStandard.addEventListener("click", () => {
      socket.emit("room:voteMode", { code: roomCode, vote: "standard" });
    });
  }
  if (voteDecider) {
    voteDecider.addEventListener("click", () => {
      socket.emit("room:voteMode", { code: roomCode, vote: "decider" });
    });
  }

  if (readyBtn) {
    readyBtn.addEventListener("click", () => {
      const next = !meReady;
      socket.emit("room:ready", { code: roomCode, ready: next });
      toast(next ? "Ready" : "Not ready");
    });
  }

  if (resetPoolBtn) {
    resetPoolBtn.addEventListener("click", () => {
      socket.emit("room:resetPoolDefault", { code: roomCode });
      toast("Pool reset");
    });
  }

  gameContent.querySelectorAll("[data-pool-idx]").forEach((inp) => {
    let t = null;
    inp.addEventListener("input", () => {
      const idx = Number(inp.getAttribute("data-pool-idx"));
      const label = inp.value;
      lobbyEdit.pendingByIdx[idx] = label;
      clearTimeout(t);
      t = setTimeout(() => {
        socket.emit("room:setPoolLine", { code: roomCode, index: idx, label });
      }, 120);
    });
  });

  if (applyPasteBtn && pasteBox) {
    applyPasteBtn.addEventListener("click", () => {
      const lines = String(pasteBox.value || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!seatRange) {
        toast("Join as a player to paste.", 2600);
        return;
      }
      if (lines.length !== 6) {
        toast(`Need exactly 6 lines (got ${lines.length}).`, 2600);
        return;
      }
      socket.emit("room:setPoolSlice", { code: roomCode, startIndex: seatRange.start, labels: lines });
      toast("Column paste applied");
    });
  }

  // Decider pool event handlers
  gameContent.querySelectorAll("[data-decider-idx]").forEach((inp) => {
    let t = null;
    inp.addEventListener("input", () => {
      const idx = Number(inp.getAttribute("data-decider-idx"));
      const label = inp.value;
      lobbyEdit.pendingByIdx[`d${idx}`] = label;
      clearTimeout(t);
      t = setTimeout(() => {
        socket.emit("room:setDeciderLine", { code: roomCode, index: idx, label });
      }, 120);
    });
  });

  const resetDeciderPoolBtn = $("#resetDeciderPoolBtn");
  if (resetDeciderPoolBtn) {
    resetDeciderPoolBtn.addEventListener("click", () => {
      socket.emit("room:resetDeciderPool", { code: roomCode });
      toast("Decider pool reset");
    });
  }

  const applyDeciderPasteBtn = $("#applyDeciderPasteBtn");
  const deciderPasteBox = $("#deciderPasteBox");
  if (applyDeciderPasteBtn && deciderPasteBox) {
    applyDeciderPasteBtn.addEventListener("click", () => {
      const lines = String(deciderPasteBox.value || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length !== 2) {
        toast(`Need exactly 2 lines (got ${lines.length}).`, 2600);
        return;
      }
      socket.emit("room:setDeciderSlice", { code: roomCode, labels: lines });
      toast("Decider paste applied");
    });
  }

  // Restore focus/selection after re-render.
  if (canEdit && lobbyEdit.focusedIdx != null) {
    let el = null;
    if (typeof lobbyEdit.focusedIdx === "string" && lobbyEdit.focusedIdx.startsWith("d")) {
      el = gameContent.querySelector(`[data-decider-idx="${lobbyEdit.focusedIdx.slice(1)}"]`);
    } else if (Number.isFinite(lobbyEdit.focusedIdx)) {
      el = gameContent.querySelector(`[data-pool-idx="${lobbyEdit.focusedIdx}"]`);
    }
    if (el) {
      el.focus({ preventScroll: true });
      if (lobbyEdit.selStart != null && lobbyEdit.selEnd != null) {
        try {
          el.setSelectionRange(lobbyEdit.selStart, lobbyEdit.selEnd);
        } catch {
          // ignore
        }
      }
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDraft(state) {
  const { players, pool, draft } = state;
  const currentTurn = draft.currentTurnClientId;
  const isMyTurn = me?.clientId && me.clientId === currentTurn;

  const myPicks = (draft.picksByPlayer[me?.clientId] || []).length;
  const need = Math.max(0, draft.totalPicksPerPlayer - myPicks);

  const header = `
    <div class="sectionTitle">
      <h3>Draft (pick 3 each)</h3>
      <div class="pill">Turn: ${currentTurn ? displayName(players, currentTurn) : "—"}</div>
    </div>
    <div class="mini">
      Each turn, one player picks <b>one</b> item. When everyone has 3, you’ll build your bracket.
      <div style="margin-top:6px">
        You have <b>${myPicks}</b> / ${draft.totalPicksPerPlayer} picks ${need ? `(need ${need} more)` : ""}.
      </div>
    </div>
  `;

  const poolHtml = pool
    .map((g) => {
      const disabled = g.taken || !isMyTurn || need <= 0;
      return `
        <div class="item ${g.taken ? "taken" : ""}">
          <div class="label">${g.label}</div>
          <button class="btn small" data-pick="${g.id}" ${disabled ? "disabled" : ""}>
            ${g.taken ? "Taken" : isMyTurn ? "Pick" : "Wait"}
          </button>
        </div>
      `;
    })
    .join("");

  const draftedCols = players
    .map((p) => {
      const picks = draft.picksByPlayer[p.clientId] || [];
      const items = picks.map((x) => `<div class="item"><div class="label">${x.label}</div><div class="badge">picked</div></div>`).join("");
      return `
        <div class="col">
          <div class="colHeader">
            <div class="name"><span class="dot" style="background:${p.color}"></span>${p.name}</div>
            <div class="badge">${picks.length}/3</div>
          </div>
          <div class="list">${items || `<div class="mini muted">No picks yet.</div>`}</div>
        </div>
      `;
    })
    .join("");

  gameContent.innerHTML = `
    ${header}
    <div class="wheelRow" style="margin-top:10px">
      <button class="btn" id="draftAutoBtn" ${!isMyTurn || need <= 0 ? "disabled" : ""}>Autopick</button>
      <div class="wheelState muted">Autopick chooses a random available item (your turn only).</div>
    </div>
    <div class="sep"></div>
    <div class="grid3">${draftedCols}</div>
    <div class="sep"></div>
    <div class="sectionTitle">
      <h3>Pool (18)</h3>
      <div class="pill">${isMyTurn ? "Your turn" : "Waiting"}</div>
    </div>
    <div class="list">${poolHtml}</div>
  `;

  const draftAutoBtn = $("#draftAutoBtn");
  if (draftAutoBtn) {
    draftAutoBtn.addEventListener("click", () => {
      socket.emit("draft:autoPick", { code: roomCode });
    });
  }

  gameContent.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gid = btn.getAttribute("data-pick");
      socket.emit("draft:pick", { code: roomCode, gameId: gid });
    });
  });
}

function renderBracket(state) {
  const { players, draft, bracket } = state;
  const meId = me?.clientId;
  const allOwners = players.map((p) => p.clientId);

  const myPicks = bracket[meId] || {};
  const pickedOwners = new Set(Object.keys(myPicks).filter((k) => myPicks[k]));
  const done = pickedOwners.size === 3;

  // Build a global "taken by owner" map so no duplicates can be selected.
  /** @type {Record<string, Set<string>>} */
  const takenByOwner = {};
  for (const ownerCid of allOwners) takenByOwner[ownerCid] = new Set();
  for (const picker of players) {
    const picks = bracket[picker.clientId] || {};
    for (const [ownerCid, item] of Object.entries(picks)) {
      if (item?.id) takenByOwner[ownerCid]?.add(item.id);
    }
  }

  const header = `
    <div class="sectionTitle">
      <h3>Build your bracket</h3>
      <div class="pill">${done ? "Complete" : `Pick ${3 - pickedOwners.size} more`}</div>
    </div>
    <div class="mini">
      Choose <b>one item from each player</b> (including yourself). At the end you’ll have 3 total items: one per player.
    </div>
  `;

  const columns = players
    .map((owner) => {
      const ownerDraft = draft.picksByPlayer[owner.clientId] || [];
      const alreadyPicked = Boolean(myPicks[owner.clientId]);
      const items = ownerDraft
        .map((g) => {
          const taken = takenByOwner[owner.clientId]?.has(g.id);
          const disabled = alreadyPicked || taken;
          return `
            <div class="item ${taken ? "taken" : ""}">
              <div class="label">${g.label}</div>
              <button class="btn small" data-bracket-pick="${owner.clientId}|${g.id}" ${disabled ? "disabled" : ""}>
                ${alreadyPicked ? "Picked" : taken ? "Taken" : "Choose"}
              </button>
            </div>
          `;
        })
        .join("");

      const chosen = myPicks[owner.clientId];
      return `
        <div class="col">
          <div class="colHeader">
            <div class="name"><span class="dot" style="background:${owner.color}"></span>${owner.name}</div>
            <div class="badge">${alreadyPicked ? "chosen" : "choose 1"}</div>
          </div>
          ${chosen ? `<div class="mini">Your pick: <b>${chosen.label}</b></div><div class="sep"></div>` : ""}
          <div class="list">${items}</div>
        </div>
      `;
    })
    .join("");

  const completion = players
    .map((p) => {
      const pPicks = bracket[p.clientId] || {};
      const count = allOwners.filter((o) => pPicks[o]).length;
      return `<div class="pill" style="border-color:${p.color}55">${p.name}: ${count}/3</div>`;
    })
    .join(" ");

  gameContent.innerHTML = `
    ${header}
    <div class="wheelRow" style="margin-top:10px">
      <button class="btn" id="bracketAutoBtn" ${done ? "disabled" : ""}>Autopick</button>
      <div class="wheelState muted">Autopick fills one of your remaining owner slots.</div>
    </div>
    <div class="sep"></div>
    <div class="mini">Everyone’s progress: ${completion}</div>
    <div class="sep"></div>
    <div class="grid3">${columns}</div>
  `;

  const bracketAutoBtn = $("#bracketAutoBtn");
  if (bracketAutoBtn) {
    bracketAutoBtn.addEventListener("click", () => {
      socket.emit("bracket:autoPick", { code: roomCode });
    });
  }

  gameContent.querySelectorAll("[data-bracket-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [ownerClientId, gameId] = btn.getAttribute("data-bracket-pick").split("|");
      socket.emit("bracket:pick", { code: roomCode, ownerClientId, gameId });
    });
  });
}

function renderModeWheel(state) {
  const { players, phase, wheel } = state;
  const mw = wheel.modeWheel;
  const notice = wheel.notice;
  const spin = mw?.lastSpin || null;
  const suppressResult = wheelAnim.spinning || (spin?.nonce && spin.nonce !== wheelAnim.lastNonce);

  const modeColors = { standard: "#4d96ff", decider: "#ff6b6b" };

  function mwEntries() {
    if (!mw?.remaining?.length) return [];
    return mw.remaining.map((entry) => {
      const p = players.find((x) => x.clientId === entry.id);
      return {
        id: entry.id,
        label: (entry.vote === "decider" ? "Decider" : "Standard"),
        color: modeColors[entry.vote] || "#888",
        sub: p ? p.name : "",
      };
    });
  }

  const infoHtml = (() => {
    if (suppressResult) return '<div class="wheelState">Spinning\u2026</div>';
    if (phase === "modeWheel" && mw) {
      const rem = mw.remaining.map((e) => {
        const p = players.find((x) => x.clientId === e.id);
        return (p ? p.name : "?") + " (" + (e.vote === "decider" ? "D" : "S") + ")";
      }).join(" \u00b7 ");
      const elim = mw.eliminated.map((e) => {
        const p = players.find((x) => x.clientId === e.id);
        return (p ? p.name : "?") + " (" + (e.vote === "decider" ? "D" : "S") + ")";
      }).join(" \u00b7 ");
      return '<div class="wheelState">Remaining: ' + (rem || "\u2014") + '</div>'
        + '<div class="wheelState">Eliminated: ' + (elim || "\u2014") + '</div>';
    }
    if (phase === "modeWheelDone" && mw?.winnerVote) {
      const winLabel = mw.winnerVote === "decider" ? "Decider" : "Standard";
      return '<div class="wheelState">Winner: <b>' + winLabel + '</b></div>'
        + '<div class="wheelState">Click Continue to head back to the lobby.</div>';
    }
    return '<div class="wheelState">\u2014</div>';
  })();

  const spinLabel = phase === "modeWheelDone" ? "Continue" : "Spin the mode wheel!";

  const modalHtml = notice && !suppressResult
    ? '<div class="modalOverlay" id="wheelModalOverlay">'
      + '<div class="modal">'
      + '<div class="modalTitle">' + escapeHtml(notice.title || "") + '</div>'
      + '<div class="modalBody">' + (notice.bodyHtml || "") + '</div>'
      + '<div class="modalActions">'
      + '<button class="btn primary" id="noticeAckBtn">' + escapeHtml(notice.cta || "OK") + '</button>'
      + '</div></div></div>'
    : "";

  gameContent.innerHTML =
    '<div class="sectionTitle"><h3>Mode Tiebreaker!</h3><div class="pill">Wheel decides</div></div>'
    + '<div class="mini">Not unanimous \u2014 the wheel will eliminate votes one by one. Last vote standing picks the game mode!</div>'
    + '<div class="sep"></div>'
    + '<div class="wheelLayout">'
    + '<div class="wheelCanvasWrap">'
    + '<div class="wheelPointer"></div>'
    + '<canvas id="wheelCanvas" width="320" height="320"></canvas>'
    + '</div>'
    + '<div>'
    + '<div class="wheelRow">'
    + '<button class="btn primary" id="spinBtn" '
    + (phase === "done" || wheelAnim.spinning || Boolean(notice) || suppressResult ? "disabled" : "") + '>'
    + spinLabel + '</button>'
    + '<div class="wheelState muted">Anyone can spin.</div>'
    + '</div>'
    + '<div class="sep"></div>'
    + infoHtml
    + '</div></div>'
    + modalHtml;

  const spinBtn = $("#spinBtn");
  if (spinBtn) {
    spinBtn.addEventListener("click", () => {
      if (phase === "modeWheelDone") socket.emit("wheel:continue", { code: roomCode });
      else socket.emit("wheel:spin", { code: roomCode });
    });
  }

  const noticeAckBtn = $("#noticeAckBtn");
  if (noticeAckBtn && notice) {
    noticeAckBtn.addEventListener("click", () => {
      socket.emit("wheel:ackNotice", { code: roomCode, id: notice.id });
    });
  }
  const overlay = $("#wheelModalOverlay");
  if (overlay && notice) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) socket.emit("wheel:ackNotice", { code: roomCode, id: notice.id });
    });
  }

  const canvas = $("#wheelCanvas");
  if (canvas) {
    const entries = mwEntries();
    const hasNewSpin = spin && spin.nonce && spin.nonce !== wheelAnim.lastNonce;

    if (hasNewSpin && !wheelAnim.spinning && spin.entriesItemIds?.length) {
      const allMwEntries = [...(mw?.remaining || []), ...(mw?.eliminated || [])];
      const byId = new Map(allMwEntries.map((entry) => {
        const p = players.find((x) => x.clientId === entry.id);
        return [entry.id, {
          id: entry.id,
          label: entry.vote === "decider" ? "Decider" : "Standard",
          color: modeColors[entry.vote] || "#888",
          sub: p ? p.name : "",
        }];
      }));
      const snap = spin.entriesItemIds.map((id) => byId.get(id)).filter(Boolean);
      animateWheelTo(canvas, snap, spin.startAngle ?? 0, spin.endAngle ?? 0, spin.durationMs ?? 1700).then(() => {
        wheelAnim.angle = (mw?.visualAngle ?? wheelAnim.angle);
        wheelAnim.lastNonce = spin.nonce;
        render(state);
      });
      return;
    }

    if (!wheelAnim.spinning) {
      if (mw && Number.isFinite(mw.visualAngle)) {
        wheelAnim.angle = mw.visualAngle;
      }
      drawWheel(canvas, entries, wheelAnim.angle);
    }
  }
}

function renderWheel(state) {
  const { players, phase, wheel } = state;

  const spinLabel =
    phase === "wheel1"
      ? "Spin wheel (pick bracket winner)"
      : phase === "wheel1_done"
      ? "Continue"
      : phase === "wheelFinal"
      ? "Spin game wheel (2 hits to eliminate)"
      : phase === "deciderWheel"
      ? "Spin decider wheel (last game standing)"
      : phase === "deciderWheelDone"
      ? "Continue"
      : "Spin";

  const w1 = wheel.wheel1;
  const wf = wheel.wheelFinal;
  const wd = wheel.deciderWheel;
  const notice = wheel.notice;
  const spin = lastSpin();
  const suppressResult = wheelAnim.spinning || (spin?.nonce && spin.nonce !== wheelAnim.lastNonce);

  function deciderItemOwner(itemId) {
    const origIdx = parseInt(itemId.replace("decider-", ""), 10) - 1;
    const ownerSeat = Math.floor(origIdx / 2) + 1;
    return players.find((p) => p.seat === ownerSeat) || null;
  }

  function wheelEntries() {
    if (phase === "wheel1" && w1) {
      return w1.remaining.map((cid) => {
        const p = playerById(players, cid);
        return { id: cid, label: p ? p.name : cid, color: p?.color || "#ffffff", sub: seatLabel(p || { seat: "?" }) };
      });
    }
    if (wf?.remaining?.length) {
      return wf.remaining.map((it) => {
        const ownerP = playerById(players, it.ownerClientId);
        return {
          id: it.id,
          label: it.label,
          color: ownerP?.color || "#ffffff",
          sub: ownerP ? ownerP.name : "\u2014",
        };
      });
    }
    if ((phase === "deciderWheel" || phase === "deciderWheelDone") && wd?.remaining?.length) {
      return wd.remaining.map((it) => {
        const owner = deciderItemOwner(it.id);
        return {
          id: it.id,
          label: it.label,
          color: owner?.color || "#888",
          sub: owner ? owner.name : "",
        };
      });
    }
    return [];
  }

  function lastSpin() {
    if (phase === "wheel1" || phase === "wheel1_done") return w1?.lastSpin || null;
    if (phase === "wheelFinal" || phase === "done") return wf?.lastSpin || null;
    if (phase === "deciderWheel" || phase === "deciderWheelDone") return wd?.lastSpin || null;
    return null;
  }

  const wheelInfo = (() => {
    if (suppressResult) return '<div class="wheelState">Spinning\u2026</div>';
    if (phase === "wheel1" && w1) {
      return `
        <div class="wheelState">Remaining: ${w1.remaining.map((cid) => displayName(players, cid)).join(" · ") || "—"}</div>
        <div class="wheelState">Eliminated: ${w1.eliminated.map((cid) => displayName(players, cid)).join(" · ") || "—"}</div>
      `;
    }
    if (phase === "wheel1_done" && w1?.winnerClientId) {
      return `
        <div class="wheelState">Bracket winner: <b>${displayName(players, w1.winnerClientId)}</b></div>
        <div class="wheelState">Click Continue to start the final game wheel.</div>
      `;
    }
    if (phase === "wheelFinal" && wf) {
      const strikeText = Object.entries(wf.strikes || {})
        .map(([gid, n]) => `${gid}=${n}`)
        .join(" \u00b7 ");
      return `
        <div class="wheelState">Bracket winner: <b>${displayName(players, wf.bracketOwnerClientId)}</b></div>
        <div class="wheelState">Remaining games: ${wf.remaining.map((it) => it.label).join(" \u00b7 ") || "\u2014"}</div>
        <div class="wheelState">Strikes: ${strikeText || "\u2014"}</div>
        <div class="wheelState">Eliminated: ${wf.eliminated.map((it) => it.label).join(" \u00b7 ") || "\u2014"}</div>
      `;
    }
    if (phase === "deciderWheel" && wd) {
      return `
        <div class="wheelState">Remaining: ${wd.remaining.map((it) => it.label).join(" \u00b7 ") || "\u2014"}</div>
        <div class="wheelState">Eliminated: ${wd.eliminated.map((it) => it.label).join(" \u00b7 ") || "\u2014"}</div>
      `;
    }
    if (phase === "deciderWheelDone" && wd?.winnerItem) {
      return `
        <div class="wheelState">Decider game: <b>${wd.winnerItem.label}</b></div>
        <div class="wheelState">Click Continue to pick the bracket winner.</div>
      `;
    }
    return `<div class="wheelState">\u2014</div>`;
  })();

  const result = wheel.result;
  const resultHtml = result
    ? `
      <div class="sep"></div>
      <div class="sectionTitle">
        <h3>Result</h3>
        <div class="pill">Complete</div>
      </div>
      <div class="winCard">
        <div class="winTitle">Champion!</div>
        <div class="winRow">
          <div class="wheelState">Bracket winner: <b>${displayName(players, result.bracketWinnerClientId)}</b></div>
          <div class="wheelState">Winning game: <b>${result.finalWinningItem?.label ?? "—"}</b></div>
        </div>
        <div class="winRow">
          <div class="wheelState">Game owner: <b>${displayName(players, result.finalWinnerOwnerClientId)}</b></div>
        </div>
      </div>
    `
    : "";

  const modalHtml = notice && !suppressResult
    ? `
      <div class="modalOverlay" id="wheelModalOverlay">
        <div class="modal">
          <div class="modalTitle">${escapeHtml(notice.title || "")}</div>
          <div class="modalBody">${notice.bodyHtml || ""}</div>
          <div class="modalActions">
            <button class="btn primary" id="wheelModalOk">${escapeHtml(notice.cta || "OK")}</button>
          </div>
        </div>
      </div>
    `
    : "";

  gameContent.innerHTML = `
    <div class="sectionTitle">
      <h3>Wheel Time</h3>
      <div class="pill">${phase.toUpperCase()}</div>
    </div>
    <div class="mini">${
      phase === "deciderWheel" || phase === "deciderWheelDone"
        ? "Decider wheel eliminates games one by one. The <b>last game standing</b> is the decider game you'll play."
        : "Wheel 1 eliminates players until 1 remains (that player’s bracket wins). Final wheel spins the <b>3 games</b> in that bracket: you must land on a game <b>twice</b> before it’s eliminated."
    }</div>
    <div class="sep"></div>
    <div class="wheelBox">
      <div class="wheelWrap">
        <div class="wheelCanvasWrap">
          <div class="wheelPointer"></div>
          <canvas id="wheelCanvas" width="320" height="320"></canvas>
        </div>
        <div>
          <div class="wheelRow">
            <button class="btn primary" id="spinBtn" ${
              phase === "done" || wheelAnim.spinning || Boolean(notice) || suppressResult ? "disabled" : ""
            }>${spinLabel}</button>
            <div class="wheelState muted">Anyone can spin in the MVP.</div>
          </div>
          <div class="wheelHint" style="margin-top:10px">
            The wheel is synced by the server; everyone sees the same landing.
          </div>
          <div class="sep"></div>
          ${wheelInfo}
        </div>
      </div>
    </div>
    ${resultHtml}
    ${modalHtml}
  `;

  const spinBtn = $("#spinBtn");
  if (spinBtn) {
    spinBtn.addEventListener("click", () => {
      if (phase === "wheel1_done" || phase === "deciderWheelDone") socket.emit("wheel:continue", { code: roomCode });
      else socket.emit("wheel:spin", { code: roomCode });
    });
  }

  const canvas = $("#wheelCanvas");
  if (canvas) {
    const entries = wheelEntries();
    const hasNewSpin = spin && spin.nonce && spin.nonce !== wheelAnim.lastNonce;

    // If we just received a new spin result, animate it FIRST, then re-render with tallies / notices.
    if (hasNewSpin && !wheelAnim.spinning) {
      if ((phase === "wheel1" || phase === "wheel1_done") && spin.entriesClientIds?.length) {
        const snap = spin.entriesClientIds.map((cid) => {
          const p = playerById(players, cid);
          return { id: cid, label: p ? p.name : cid, color: p?.color || "#ffffff", sub: seatLabel(p || { seat: "?" }) };
        });
        animateWheelTo(canvas, snap, spin.startAngle ?? 0, spin.endAngle ?? 0, spin.durationMs ?? 1600).then(() => {
          wheelAnim.angle = (w1?.visualAngle ?? wheelAnim.angle);
          wheelAnim.lastNonce = spin.nonce;
          render(state);
        });
        return;
      }
      if ((phase === "wheelFinal" || phase === "done") && spin.entriesItemIds?.length) {
        const allWfItems = [...(wf?.remaining || []), ...(wf?.eliminated || [])];
        const byId = new Map(allWfItems.map((it) => {
          const ownerP = playerById(players, it.ownerClientId);
          return [it.id, { id: it.id, label: it.label, color: ownerP?.color || "#ffffff", sub: ownerP ? ownerP.name : "\u2014" }];
        }));
        const snap = spin.entriesItemIds.map((id) => byId.get(id)).filter(Boolean);
        animateWheelTo(canvas, snap, spin.startAngle ?? 0, spin.endAngle ?? 0, spin.durationMs ?? 1700).then(() => {
          wheelAnim.angle = (wf?.visualAngle ?? wheelAnim.angle);
          wheelAnim.lastNonce = spin.nonce;
          render(state);
        });
        return;
      }
      if ((phase === "deciderWheel" || phase === "deciderWheelDone") && spin.entriesItemIds?.length) {
        const allDwItems = [...(wd?.remaining || []), ...(wd?.eliminated || [])];
        const byId = new Map(allDwItems.map((it) => {
          const owner = deciderItemOwner(it.id);
          return [it.id, { id: it.id, label: it.label, color: owner?.color || "#888", sub: owner ? owner.name : "" }];
        }));
        const snap = spin.entriesItemIds.map((id) => byId.get(id)).filter(Boolean);
        animateWheelTo(canvas, snap, spin.startAngle ?? 0, spin.endAngle ?? 0, spin.durationMs ?? 1700).then(() => {
          wheelAnim.angle = (wd?.visualAngle ?? wheelAnim.angle);
          wheelAnim.lastNonce = spin.nonce;
          render(state);
        });
        return;
      }
    }

    // No new spin to animate: keep angle in sync with server and just draw static wheel.
    if (!wheelAnim.spinning) {
      if ((phase === "wheel1" || phase === "wheel1_done") && w1 && Number.isFinite(w1.visualAngle)) {
        wheelAnim.angle = w1.visualAngle;
      }
      if ((phase === "wheelFinal" || phase === "done") && wf && Number.isFinite(wf.visualAngle)) {
        wheelAnim.angle = wf.visualAngle;
      }
      if ((phase === "deciderWheel" || phase === "deciderWheelDone") && wd && Number.isFinite(wd.visualAngle)) {
        wheelAnim.angle = wd.visualAngle;
      }
    }

    drawWheel(canvas, entries, wheelAnim.angle);
  }

  const ok = $("#wheelModalOk");
  const ov = $("#wheelModalOverlay");
  if (ok && ov) {
    ok.addEventListener("click", () => {
      if (notice?.id) socket.emit("wheel:ackNotice", { code: roomCode, id: notice.id });
    });
    ov.addEventListener("click", (e) => {
      if (e.target === ov) {
        if (notice?.id) socket.emit("wheel:ackNotice", { code: roomCode, id: notice.id });
      }
    });
  }
}

function drawWheel(canvas, entries, angleRad) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 8;

  ctx.clearRect(0, 0, w, h);

  // base ring
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angleRad);

  const n = Math.max(1, entries.length);
  const step = (Math.PI * 2) / n;

  for (let i = 0; i < n; i++) {
    const e = entries[i] || { label: "—", color: "#888" };
    const a0 = i * step;
    const a1 = a0 + step;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = e.color || "#888";
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // label
    const mid = (a0 + a1) / 2;
    ctx.save();
    ctx.rotate(mid);
    ctx.translate(r * 0.62, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = "rgba(0,0,0,0.88)";
    ctx.font = "700 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    const text = String(e.label || "—");
    const clipped = text.length > 18 ? text.slice(0, 17) + "…" : text;
    ctx.fillText(clipped, -ctx.measureText(clipped).width / 2, -4);
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.font = "600 10px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    const sub = e.sub ? String(e.sub) : "";
    if (sub) ctx.fillText(sub, -ctx.measureText(sub).width / 2, 10);
    ctx.restore();
  }

  // inner circle
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}

function normalizeAngle(a) {
  const t = Math.PI * 2;
  let x = a % t;
  if (x < 0) x += t;
  return x;
}

function angleForEntryIndex(n, idx) {
  // Pointer is at "top" (canvas not rotated). We rotate wheel so the chosen segment center aligns to -PI/2.
  const step = (Math.PI * 2) / Math.max(1, n);
  const mid = (idx + 0.5) * step;
  return -Math.PI / 2 - mid;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function animateWheelTo(canvas, entries, startAngle, endAngle, durationMs) {
  if (!entries.length) return Promise.resolve();
  const t0 = performance.now();
  wheelAnim.spinning = true;
  wheelAnim.angle = normalizeAngle(startAngle);

  return new Promise((resolve) => {
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / Math.max(200, durationMs || 1600));
      const k = easeOutCubic(t);
      const a = startAngle + (endAngle - startAngle) * k;
      wheelAnim.angle = normalizeAngle(a);
      drawWheel(canvas, entries, wheelAnim.angle);
      if (t < 1) requestAnimationFrame(tick);
      else {
        wheelAnim.spinning = false;
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}

function renderDeciderPickWinner(state) {
  const { players, decider, bracket, draft } = state;
  const deciderGame = decider.winningDeciderGame;

  const playerCards = players
    .map((p) => {
      const bracketPicks = bracket[p.clientId] || {};
      const items = Object.values(bracketPicks)
        .filter(Boolean)
        .map((g) => {
          const ownerP = playerById(players, g.ownerClientId);
          return `<div class="item"><div class="label">${escapeHtml(g.label)}</div><div class="badge">${ownerP ? ownerP.name : "\u2014"}</div></div>`;
        })
        .join("");
      return `
        <div class="col pickCard">
          <div class="colHeader">
            <div class="name"><span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</div>
            <div class="badge">${seatLabel(p)}</div>
          </div>
          <div class="list">${items || '<div class="mini muted">No bracket items.</div>'}</div>
          <div style="margin-top:12px">
            <button class="btn primary pickWinnerBtn" data-winner-cid="${p.clientId}">Select Winner</button>
          </div>
        </div>
      `;
    })
    .join("");

  gameContent.innerHTML = `
    <div class="sectionTitle">
      <h3>Who won the decider?</h3>
      <div class="pill">${escapeHtml(deciderGame?.label || "\u2014")}</div>
    </div>
    <div class="mini">
      Play <b>${escapeHtml(deciderGame?.label || "the decider game")}</b> and select the winning player below. Their bracket will advance to the final pick.
    </div>
    <div class="sep"></div>
    <div class="grid3">${playerCards}</div>
  `;

  gameContent.querySelectorAll(".pickWinnerBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cid = btn.getAttribute("data-winner-cid");
      socket.emit("decider:pickWinner", { code: roomCode, winnerClientId: cid });
    });
  });
}

function renderDeciderPickGame(state) {
  const { players, decider, bracket, draft } = state;
  const winnerId = decider.winnerClientId;
  const winner = playerById(players, winnerId);
  const deciderGame = decider.winningDeciderGame;
  const bracketPicks = bracket[winnerId] || {};
  const allItems = Object.values(bracketPicks).filter(Boolean);

  const gameCards = allItems
    .map((g) => {
      const ownerP = playerById(players, g.ownerClientId);
      return `
        <div class="col pickCard">
          <div class="colHeader">
            <div class="name">${escapeHtml(g.label)}</div>
          </div>
          <div class="mini" style="margin-bottom:10px">
            From <b><span class="dot" style="background:${ownerP?.color || "#fff"}; display:inline-block; width:8px; height:8px; vertical-align:middle; margin-right:4px"></span>${escapeHtml(ownerP?.name || "\u2014")}</b>'s pool
          </div>
          <button class="btn primary pickGameBtn" data-game-id="${g.id}">Select Champion</button>
        </div>
      `;
    })
    .join("");

  gameContent.innerHTML = `
    <div class="sectionTitle">
      <h3>Pick the champion game</h3>
      <div class="pill">Winner: ${escapeHtml(winner?.name || "\u2014")}</div>
    </div>
    <div class="mini">
      <b>${escapeHtml(winner?.name || "The winner")}</b> won <b>${escapeHtml(deciderGame?.label || "the decider")}</b>.
      Now select which game from their bracket is the overall champion.
    </div>
    <div class="sep"></div>
    <div class="grid3">${gameCards}</div>
  `;

  gameContent.querySelectorAll(".pickGameBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gid = btn.getAttribute("data-game-id");
      socket.emit("decider:pickGame", { code: roomCode, gameId: gid });
    });
  });
}

function renderDeciderDone(state) {
  const { players, decider, wheel } = state;
  const result = wheel.result;
  if (!result) return;
  const winner = playerById(players, result.bracketWinnerClientId);
  const gameOwner = playerById(players, result.finalWinnerOwnerClientId);
  const deciderGame = decider.winningDeciderGame;

  gameContent.innerHTML = `
    <div class="sectionTitle">
      <h3>Game Over</h3>
      <div class="pill">Complete</div>
    </div>
    <div class="sep"></div>
    <div class="winCard">
      <div class="winTitle">Champion!</div>
      <div class="winRow">
        <div class="wheelState">Decider game: <b>${escapeHtml(deciderGame?.label || "\u2014")}</b></div>
        <div class="wheelState">Bracket winner: <b>${escapeHtml(winner?.name || "\u2014")}</b></div>
        <div class="wheelState">Winning game: <b>${escapeHtml(result.finalWinningItem?.label || "\u2014")}</b></div>
        <div class="wheelState">Game from: <b>${escapeHtml(gameOwner?.name || "\u2014")}</b>'s pool</div>
      </div>
    </div>
  `;
}

function render(state) {
  roomState = state;
  phaseNameEl.textContent = state.phase;

  renderPlayers(state.players, state.draft.currentTurnClientId);

  const myPlayer = state.players.find((p) => p.clientId === clientId) || null;
  me = myPlayer;
  whoamiEl.textContent = myPlayer ? `${myPlayer.name} (${seatLabel(myPlayer)})` : "Spectator";

  if (state.phase === "lobby") return renderLobby(state);
  if (state.phase === "modeWheel" || state.phase === "modeWheelDone") return renderModeWheel(state);
  if (state.phase === "draft") return renderDraft(state);
  if (state.phase === "bracket") return renderBracket(state);
  if (state.phase === "deciderPickWinner") return renderDeciderPickWinner(state);
  if (state.phase === "deciderPickGame") return renderDeciderPickGame(state);
  if (state.phase === "done" && state.mode === "decider") return renderDeciderDone(state);
  if (
    state.phase === "wheel1" ||
    state.phase === "wheel1_done" ||
    state.phase === "wheelFinal" ||
    state.phase === "deciderWheel" ||
    state.phase === "deciderWheelDone" ||
    state.phase === "done"
  ) {
    return renderWheel(state);
  }
  gameContent.innerHTML = `<div class="mini">Unknown phase: ${state.phase}</div>`;
}

socket.on("connect", () => {
  // Nice-to-have: auto rejoin last room
  const last = localStorage.getItem("bg_last_room");
  if (last) {
    roomInput.value = last;
  }
});

socket.on("room:created", ({ code }) => {
  roomInput.value = code;
  localStorage.setItem("bg_last_room", code);
  toast(`Room created: ${code}`);
  joinRoom(code);
});

socket.on("room:error", ({ message }) => {
  showError(message || "Error");
  toast(message || "Error");
});

socket.on("fatal", ({ message }) => {
  showError(message || "Fatal error");
});

socket.on("room:state", (state) => {
  if (!roomCode && state?.code) {
    roomCode = state.code;
    setRoomUI(roomCode);
    localStorage.setItem("bg_last_room", roomCode);
  }
  setRoomUI(state.code);
  connectCard.hidden = true;
  statusCard.hidden = false;
  gameCard.hidden = false;
  render(state);
});

socket.on("whoami", ({ me: serverMe }) => {
  // serverMe might be null before seat assignment
  if (serverMe?.clientId) me = serverMe;
});

