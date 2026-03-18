# Bracket Game (Rooms + Draft + Wheels)

Multiplayer (3 players) interactive bracket + wheel game.

## Prerequisites

- Install **Node.js LTS** (comes with `npm`). After install, reopen Cursor/terminal.

## Run

From the project root:

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in **three separate browsers/devices**, create a room, and have each player join.

## What’s implemented

- Rooms (create + join by code)
- Exactly 3 player seats with fixed colors
- **Draft phase**: 18-item pool → each player drafts **3** items, **1 per turn**
- **Bracket build phase**: each player chooses **1 item from each player’s drafted set** (3 picks total)
- **Wheel phases**:
  1. Wheel of players, single-hit elimination → selects the **winning bracket owner**
  2. Wheel of item owners from that bracket → selects the **winning item**
  3. Final wheel with **2-hit elimination** (must land on someone twice to eliminate) → selects final winner

## Notes / limits (MVP)

- Room state is stored **in-memory** on the server (restart wipes rooms).
- Not hardened for production or malicious clients yet.

