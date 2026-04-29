# Triage It! 🚑

A rapid-decision card game for practicing **START triage** (Simple Triage And Rapid Treatment) on a phone. Single-player drills and peer-to-peer multiplayer with lobby codes — no backend, no accounts, no install.

![Color strip](https://img.shields.io/badge/RED-immediate-ef3b3b?style=flat-square) ![](https://img.shields.io/badge/YELLOW-delayed-f5b800?style=flat-square) ![](https://img.shields.io/badge/GREEN-minor-22c55e?style=flat-square) ![](https://img.shields.io/badge/BLACK-deceased-1c1c1c?style=flat-square)

---

## What it does

- **Solo Drill** — pick deck size (10, 25, 50, 100, or any custom number), beat the clock, see per-category accuracy.
- **Multiplayer** — host creates a lobby, shares a 4-letter code, players connect from any phone with internet.
- **Two modes** — head-to-head free-for-all, or two-team (A vs B).
- **Scoring** — most correct wins, total time is the tiebreaker (per the original rulebook).
- **~60 patient scenarios** built strictly on the START algorithm — easy to extend.

---

## Quick start (local)

```bash
git clone https://github.com/YOUR-USERNAME/triage-it.git
cd triage-it
# Any static-file server. Two easy options:
python3 -m http.server 8080
# or
npx serve
```

Open `http://localhost:8080` on your phone (same Wi-Fi). Multiplayer works because PeerJS uses WebRTC through a public broker — no server changes needed.

---

## Deploy to GitHub Pages

1. Create a new public repo on GitHub (e.g. `triage-it`).
2. Push these files to the `main` branch:
   ```
   index.html
   styles.css
   scenarios.js
   app.js
   README.md
   ```
3. **Settings → Pages → Source: `main` / `/ (root)`** → Save.
4. After ~1 minute, your game is live at:
   `https://YOUR-USERNAME.github.io/triage-it/`

That's it. No build step.

---

## How it works

### START algorithm (encoded in scenarios.js)

```
1. Walking?            → GREEN (Minor)
2. Not breathing?
     reposition airway
       still apneic    → BLACK (Deceased)
       breathing back  → RED   (Immediate)
3. RR > 30/min          → RED  (Immediate)
4. No radial pulse OR
   cap-refill > 2 sec   → RED  (Immediate)
5. Can't follow commands → RED (Immediate)
6. Otherwise            → YELLOW (Delayed)
```

### Multiplayer

Built on **PeerJS** (WebRTC). Architecture:

- **Host** registers a peer ID derived from the 4-letter lobby code (`triageit-app-v1-ABCD`).
- **Guests** connect to the host's peer ID by re-deriving it from the same code.
- **Host is authoritative** — maintains the player list, validates start, broadcasts state.
- Cards: host generates a deck and broadcasts the scenario IDs; everyone uses the matching local `SCENARIOS` records (so the only thing on the wire is integers + names + scores).

Message types: `HELLO`, `WELCOME`, `LOBBY_STATE`, `START`, `PROGRESS`, `GAME_END`.

---

## Adding more scenarios

Open **`scenarios.js`** and append objects to the `SCENARIOS` array. Each object needs:

```js
{
  id: 61,                                     // unique
  description: "Patient scenario narrative…", // 1-2 sentences
  walking: "Yes" | "No" | "No (immobilized)",
  respirations: "16/min, normal" | "Apneic" | "32/min" | …,
  perfusion: "Radial pulse +" | "No radial pulse" | "Cap refill > 2s" | …,
  mental: "Alert, follows commands" | "Unresponsive" | …,
  answer: "red" | "yellow" | "green" | "black",
  rationale: "Why this answer per START."
}
```

The game randomly picks `n` cards each game; if you ask for more cards than scenarios, it'll cycle (no back-to-back duplicates).

---

## Customization quick reference

| What | Where |
|---|---|
| Triage colors | `styles.css` → `:root` (`--red`, `--yellow`, `--green`, `--black`) |
| Card flip / hold time | `app.js` → `FLIP_HOLD_MS` |
| Deck-size presets | `index.html` → `.option-grid` (data-count attrs) |
| Brand text / version | `index.html` → `.brand` and footer |
| Scoring (currently correct + time) | `app.js` → `endGame()` and `showMpLeaderboard()` |

---

## Known limits / next steps

- **Public PeerJS broker** — fine for casual use; for classroom-scale deployments, run your own broker (free, Node.js).
- **Host disconnects** end the game for everyone (no host migration yet).
- Wide variety of START-style edge cases not yet covered (pediatric JumpSTART, SALT triage, etc.). The expansion ideas from the original rulebook (Pediatric pack, CERT version, ALS decisions) would each be a new scenario file.
- No persistent stats/profiles. Could be added with `localStorage`.

---

## Disclaimer

This is a **training game**, not a clinical reference. Real-world triage involves judgment, scope of practice, fatigue, and incomplete information that no card can capture. Use this to drill the algorithm's flow — not to replace certified instruction.

---

## License

Open-source. Build on it, fork it, share it.
