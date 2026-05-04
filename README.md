[README.md](https://github.com/user-attachments/files/27330665/README.md)
# Triage It!

**Mass-casualty triage training built around the START algorithm. For first responders, EMS, and instructors.**

A browser-based drill where you read patients, assess RPM (Respirations, Perfusion, Mental status), and tag them in real time. No install, no account, no app store — just open the URL and go.

---

## What it is

A focused training tool for the **START** (Simple Triage And Rapid Treatment) algorithm — the standard sorting system for mass-casualty incidents in fire and EMS. Built so first responders can drill anywhere: at the firehouse between calls, on a phone during downtime, or with a whole class via the instructor mode.

Patients are procedurally generated — every drill is different. Difficulty toggles change both *which* patients you see and *how* the cards are written.

---

## Modes

### Training
Calm, self-paced practice. One patient at a time, no pressure, no clock. Tap a tag, see the verdict, read the rationale. Pick a deck size from Sprint (10 cards) to Marathon (100). Letter grade and after-action report at the end. Review every miss with the full START reasoning.

### Game Mode
3-minute MCI scene. **Multiple patients on the board at once**, each deteriorating in real time. Untreated yellows convert to reds. Untreated reds die on your watch. Patients arrive in waves at random intervals (1–10s). Score for speed and accuracy; lose points for over-triage and missed reds.

| Action | Score |
|---|---|
| Correct RED | +10 |
| Correct YELLOW / GREEN / BLACK | +5 |
| Speed bonus (tag within 12s of arrival) | +5 |
| Wrong tag | −10 |
| RED left to deteriorate to BLACK | −15 |

After-action report flags your top mistakes with timestamps.

### Classroom
For instructors. Host a drill from your laptop, students join from their phones with a 4-letter / 4-digit lobby code. You watch a live dashboard of every player's progress without playing yourself. Optional per-card decision timer ratchets up the pressure. After the round, get a debrief showing which cards the crew missed most — tap any to expand the rationale and discuss as a group. Supports up to 50 students per lobby.

---

## Difficulty toggles

Available in Training and Game Mode. Independent — pick one or both.

- **HARD** — vitals parked at the algorithm threshold. RR 31 is RED, but it doesn't *look* RED at a glance. Cap refill 3s. Yellow patients at RR 30 that look almost tachypneic but aren't. Same algorithm, much tighter calls.
- **EXPERT** — narratives become red herrings. Scary-looking walking-wounded who are still GREEN per START. Calm-looking patients with hidden tachypnea. Forces you to follow the algorithm rather than gestalt.
- **HARD + EXPERT** — both stacked. Maximum difficulty.

---

## The START algorithm

```
Can the patient walk?              →  GREEN  (Minor)
Apneic? Reposition airway:
    still apneic                   →  BLACK  (Deceased)
    breathing returns              →  RED    (Immediate)
Respirations > 30 / min            →  RED    (Immediate)
No radial pulse / cap refill > 2s  →  RED    (Immediate)
Cannot follow simple commands      →  RED    (Immediate)
Otherwise                          →  YELLOW (Delayed)
```

---

## For instructors — running a classroom session

1. Open the app on a laptop or tablet you'll keep in front of you (this becomes your dashboard).
2. **CLASSROOM** → enter your name → **HOST DRILL**.
3. Note the lobby code (e.g. `ABCD-1234`). Share it with your students — verbally, on a slide, or with a QR code to the join URL.
4. Students go to the same URL on their phones, click **CLASSROOM** → **JOIN A DRILL**, type the code, enter their name.
5. When everyone's in, set deck size, difficulty, and (optional) per-card decision timer. Click **START GAME**.
6. Watch the live dashboard. When everyone finishes, the debrief screen shows the cards the crew missed most. Tap any flagged card to expand the rationale and review as a group.

Students see their own scores plus a final leaderboard. Their personal misses are reviewable from their AAR.

---

## Running locally / hosting your own copy

This is a static web app — no build step, no `npm install`.

```sh
# From the project directory:
python3 -m http.server 8765
# Open http://127.0.0.1:8765/
```

To host on **GitHub Pages**: enable Pages in your repo settings (Source: `main`, root directory). Site will be live at `https://andrewhuanglafd.github.io/TriageIT/`.

For Classroom mode you'll need your own [Firebase Realtime Database](https://firebase.google.com/) project (the free Spark tier handles up to 100 concurrent connections — enough for one 50-student lobby with margin):

1. Create a Firebase project, enable Realtime Database.
2. Open `index.html`, replace the `firebaseConfig` block with your own.
3. In the Firebase Console → Realtime Database → Rules, paste the contents of `firebase-rules.json` and click Publish.

Training and Game Mode work fully offline — no Firebase needed.

---

## Tech

- Vanilla HTML / CSS / JS — no bundler, no build step
- Firebase Realtime Database for Classroom mode (compat SDK loaded from CDN)
- No external libraries beyond Firebase
- Cache-busting via `?v=N` query strings — bump the number when you change `app.js`, `scenarios.js`, or `styles.css`

---

## License

**© 2026 Fire Fueled Education LLC. All rights reserved.**

This project is not currently licensed for redistribution. Forks for personal training and educational use are welcome. Commercial use, rebranding, or public re-hosting requires written permission.

---

## Disclaimer

This is a **training tool, not a protocol**. Real-world triage decisions involve clinical judgment, scope of practice, on-scene context, and incomplete information beyond what cards can capture. Use this as one piece of your training; do not use it as a substitute for certified MCI instruction or your agency's standing orders.
