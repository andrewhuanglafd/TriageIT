/* =====================================================================
   TRIAGE IT — main app logic
   ---------------------------------------------------------------------
   Sections:
     1. State + utilities
     2. Screen routing
     3. Home / Setup wiring
     4. Single-player game loop
     5. Card rendering & answer handling
     6. Results
     7. Multiplayer — Firebase Realtime DB lobby + sync
   ===================================================================== */

const $ = (id) => document.getElementById(id);
const qsa = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const FLIP_HOLD_MS = 1500; // ms reveal stays before auto-advance

// ----------------------------------------------------------------
// Feature flags
// ----------------------------------------------------------------
// Flip MULTIPLAYER to true when ready to expose the public-lobby
// flow. While false, the menu item and the field-manual section
// for Multiplayer are hidden — the underlying code stays in place
// so re-enabling is a one-character change. Classroom is unaffected
// (it uses the same Firebase plumbing but is its own surface).
const FEATURE_MULTIPLAYER_ENABLED = false;

const state = {
  currentScreen: 'screen-home',
  history: ['screen-home'],

  // Solo
  spDeckCount: 25,
  spDifficulty: 'normal',  // 'normal' | 'hard' | 'expert'

  // Multiplayer (Firebase Realtime DB)
  mpName: '',
  mpRole: null,           // 'host' | 'guest' | 'instructor'
  mpCode: null,
  mpMode: 'ffa',          // 'ffa' | 'team'
  mpDeckCount: 25,
  mpDifficulty: 'normal', // 'normal' | 'hard' | 'expert' | 'hard-expert'
  mpPlayers: [],          // [{id,name,team,isHost,correct,wrong,totalTime,progress,finished}]
  mpMyId: null,
  mpListener: null,       // active firebase .on('value') callback ref
  mpListenerRef: null,    // database ref the listener is attached to
  mpDeck: null,           // cached current/last deck for misses-review
  mpRoundStartedAt: null, // server timestamp when host started the round
  mpRoundEndedAt: null,   // server timestamp when round ended (or null if active)
  dashTickHandle: null,   // setInterval handle for the instructor's elapsed clock
  decisionTimerSec: 0,    // 0 = off; otherwise seconds-per-card the instructor has set
  decisionTickHandle: null, // per-card countdown interval handle (player side)
  decisionDeadline: 0,    // wall-clock ms when the current card expires
  mpLobbyType: 'multiplayer', // 'multiplayer' | 'classroom'

  // Active game
  game: null              // { deck, idx, correct, wrong, totalTime, perCard, cardStartTs, mode }
};

/* ============================================================
   1. UTILITIES
   ============================================================ */

function rand4Letters() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // skip I, O for clarity
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Lobby code = 4 letters + dash + 4 digits, e.g. "ABCD-1234".
// Search space is 24^4 * 10^4 ≈ 3.3B combinations — brute-forcing
// random codes from a public client is infeasible. The full code
// is the only access credential, so it must be shared in person
// (verbal, slide, QR) rather than just posted publicly.
function randLobbyCode() {
  const letters = rand4Letters();
  let digits = "";
  for (let i = 0; i < 4; i++) digits += Math.floor(Math.random() * 10);
  return `${letters}-${digits}`;
}

function fmtTime(seconds) {
  if (seconds < 60) return seconds.toFixed(1) + "s";
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(1);
  return `${m}m ${s}s`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(count, difficulty) {
  // Procedural generation: every call produces a fresh, unique deck.
  // Difficulty values map directly onto scenarios.js DIFFICULTY_PRESETS:
  //   'normal'      — standard MCI mix; vitals + narratives both easy
  //   'hard'        — drops greens; vitals parked at algorithm thresholds
  //                   (RR=31, cap-refill=3s, RR=30 yellow, etc.)
  //   'expert'      — standard mix + sudden-death scoring; narratives
  //                   become red herrings (scary-looking GREENs, hidden
  //                   tachypnea on calm-looking patients)
  //   'hard-expert' — borderline vitals AND red-herring narratives AND
  //                   sudden death — max difficulty
  // Sudden-death is enforced separately by isExpertDeath() — generateDeck
  // only controls what the cards LOOK like, not the scoring rules.
  return generateDeck(count, difficulty);
}

// True when the player should die on a wrong answer (Expert is active)
function isExpertDeath(difficulty) {
  return difficulty === 'expert' || difficulty === 'hard-expert';
}

// Combine the two checkbox states into a single difficulty value
function combinedDifficulty(hard, expert) {
  if (hard && expert) return 'hard-expert';
  if (hard) return 'hard';
  if (expert) return 'expert';
  return 'normal';
}

// Reverse: split a combined value into checkbox states
function splitDifficulty(d) {
  return {
    hard:   d === 'hard'   || d === 'hard-expert',
    expert: d === 'expert' || d === 'hard-expert'
  };
}

function toast(msg, ms = 1800) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Set a HUD readout's text and trigger the LCD-flicker animation,
// but only when the value actually changed. Skips the flicker on
// re-render so unchanged cells stay calm.
function setHudValue(id, value) {
  const el = $(id);
  if (!el) return;
  const next = String(value);
  if (el.textContent === next) return;
  el.textContent = next;
  el.classList.remove('tick');
  void el.offsetWidth;
  el.classList.add('tick');
}

/* ============================================================
   2. SCREEN ROUTING
   ============================================================ */

function showScreen(id, pushHistory = true) {
  qsa('.screen').forEach(el => el.classList.remove('active'));
  $(id).classList.add('active');

  if (pushHistory && state.currentScreen !== id) {
    state.history.push(id);
  }
  state.currentScreen = id;

  // Back button visibility — show on every screen except home
  $('back-btn').style.display = (id === 'screen-home') ? 'none' : 'inline-block';

  // Side-effects per screen
  if (id === 'screen-mp-lobby') renderLobby();
  if (id === 'screen-mp-choice') {
    $('mp-name-err') && ($('mp-name-err').style.display = 'none');
  }
  if (id === 'screen-cls-choice') {
    $('cls-name-err') && ($('cls-name-err').style.display = 'none');
  }
  if (id === 'screen-cls-dashboard') {
    renderDashboard();
    startDashTicker();
  } else {
    stopDashTicker();
  }
  if (id === 'screen-cls-debrief') renderDebrief();
  if (id === 'screen-game') {/* renderCard called externally */ }
}

function goBack() {
  // If we were in a live game/lobby, clean up MP first
  if (state.currentScreen === 'screen-game' && state.game) {
    if (!confirm('Quit this drill?')) return;
  }
  if (['screen-mp-lobby', 'screen-mp-host', 'screen-mp-join'].includes(state.currentScreen)) {
    teardownMp();
  }

  state.history.pop();
  const prev = state.history[state.history.length - 1] || 'screen-home';
  showScreen(prev, false);
}

/* ============================================================
   3. HOME / SETUP / MENU
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // Home menu
  qsa('[data-go]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.go));
  });

  $('back-btn').addEventListener('click', goBack);

  // ---- Solo setup ----
  qsa('#sp-deck-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#sp-deck-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      state.spDeckCount = parseInt(opt.dataset.count, 10);
      $('sp-custom').value = '';
    });
  });
  $('sp-custom').addEventListener('input', (e) => {
    const n = parseInt(e.target.value, 10);
    if (n > 0) {
      qsa('#sp-deck-options .option').forEach(o => o.classList.remove('selected'));
      state.spDeckCount = n;
    }
  });
  $('sp-start').addEventListener('click', () => {
    const n = state.spDeckCount;
    if (!n || n < 1) { toast('Pick a deck size'); return; }
    const hard   = $('sp-difficulty-hard')?.dataset.active === 'true';
    const expert = $('sp-difficulty-expert')?.dataset.active === 'true';
    const difficulty = combinedDifficulty(hard, expert);
    state.spDifficulty = difficulty;
    startGame({ deck: buildDeck(n, difficulty), mode: 'solo', difficulty });
  });

  // Solo difficulty buttons — click to toggle independent active state
  ['sp-difficulty-hard', 'sp-difficulty-expert'].forEach(id => {
    $(id)?.addEventListener('click', () => {
      const btn = $(id);
      const next = btn.dataset.active !== 'true';
      btn.dataset.active = next ? 'true' : 'false';
      btn.classList.toggle('active', next);
    });
  });

  // ---- Multiplayer entry ----
  // Validate on click. Any non-empty name is accepted.
  $('mp-name').addEventListener('input', () => {
    if ($('mp-name').value.trim().length >= 1) {
      $('mp-name-err').style.display = 'none';
    }
  });

  $('mp-create-go').addEventListener('click', () => {
    const name = $('mp-name').value.trim();
    if (name.length < 1) {
      $('mp-name-err').style.display = 'block';
      $('mp-name').focus();
      return;
    }
    state.mpName = name.slice(0, 20);
    createLobby();
  });
  $('mp-join-go').addEventListener('click', () => {
    const name = $('mp-name').value.trim();
    if (name.length < 1) {
      $('mp-name-err').style.display = 'block';
      $('mp-name').focus();
      return;
    }
    state.mpName = name.slice(0, 20);
    showScreen('screen-mp-join');
  });
  // Auto-format the join code as the user types: 4 uppercase letters,
  // dash, then 4 digits. Accepts pasted codes with or without the dash.
  const joinInput = $('mp-join-code');
  if (joinInput) {
    joinInput.addEventListener('input', () => {
      const raw = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const letters = raw.slice(0, 4).replace(/[^A-Z]/g, '');
      const digits  = raw.slice(4).replace(/[^0-9]/g, '').slice(0, 4);
      joinInput.value = digits.length ? `${letters}-${digits}` : letters;
    });
  }
  $('mp-join-confirm').addEventListener('click', () => {
    const code = $('mp-join-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}-[0-9]{4}$/.test(code)) {
      toast('Enter the full code (e.g. ABCD-1234)');
      return;
    }
    joinLobby(code);
  });

  // ---- Classroom entry ----
  // Mirror the multiplayer flow but route to instructor-mode lobby creation.
  $('cls-name')?.addEventListener('input', () => {
    if ($('cls-name').value.trim().length >= 1) {
      $('cls-name-err').style.display = 'none';
    }
  });
  $('cls-create-go')?.addEventListener('click', () => {
    const name = $('cls-name').value.trim();
    if (name.length < 1) {
      $('cls-name-err').style.display = 'block';
      $('cls-name').focus();
      return;
    }
    state.mpName = name.slice(0, 20);
    createLobby({ asInstructor: true });
  });
  $('cls-join-go')?.addEventListener('click', () => {
    // Joining a classroom drill uses the same code-entry screen as MP join.
    // The lobby itself tells the joining player whether it's a classroom session.
    const name = $('cls-name').value.trim();
    if (name.length < 1) {
      $('cls-name-err').style.display = 'block';
      $('cls-name').focus();
      return;
    }
    state.mpName = name.slice(0, 20);
    showScreen('screen-mp-join');
  });

  // Dashboard: end round early
  // Decision speed control. Two independent inputs:
  //   - The slider sets the desired DURATION (5-30s). Local-only; doesn't
  //     write to Firebase by itself. Stays put as the instructor preps.
  //   - The toggle button is the ON/OFF for the timer. Tapping it writes
  //     either the slider's current value (ON) or 0 (OFF) to Firebase.
  // This way the instructor can pick a duration with the timer off, then
  // flip it on at the moment they want pressure — and the slider position
  // never auto-resets behind their back.
  const speedSlider = $('dash-speed-slider');
  const speedValue = $('dash-speed-value');
  const speedToggle = $('dash-speed-toggle');

  function updateSpeedValueLabel() {
    if (!speedValue || !speedSlider) return;
    speedValue.textContent = speedSlider.value + 's';
  }

  speedSlider?.addEventListener('input', () => {
    updateSpeedValueLabel();
    // If the timer is currently active, propagate the new duration live so
    // players' next card uses the new value (and any mid-card reset logic
    // in the subscribe handler kicks in for a fresh countdown).
    if (state.mpRole !== 'instructor' || !state.mpCode) return;
    if ((state.decisionTimerSec || 0) > 0) {
      const secs = parseInt(speedSlider.value, 10);
      // Throttle: write only on `change` (slider released), not every `input`,
      // to avoid hammering Firebase. We update the label live but defer the
      // Firebase write to release.
    }
  });

  speedSlider?.addEventListener('change', () => {
    updateSpeedValueLabel();
    // Slider released. If the timer is active, push the new value now.
    // If it's off, just leave the slider where it is — no Firebase write.
    if (state.mpRole !== 'instructor' || !state.mpCode) return;
    if ((state.decisionTimerSec || 0) > 0) {
      const secs = parseInt(speedSlider.value, 10);
      fbLobbyRef(state.mpCode).child('decisionTimerSec').set(secs).catch(err => {
        console.error('decisionTimerSec slider write failed', err);
        toast('Timer change rejected — republish Firebase rules');
      });
    }
  });

  speedToggle?.addEventListener('click', () => {
    if (state.mpRole !== 'instructor' || !state.mpCode) return;
    const isOn = (state.decisionTimerSec || 0) > 0;
    const nextSecs = isOn ? 0 : parseInt(speedSlider?.value || '15', 10);

    // Optimistic UI: flip the visual immediately so the instructor gets
    // instant feedback. The subscribe handler will sync the real value
    // when Firebase confirms the write.
    speedToggle.classList.toggle('on', !isOn);
    speedToggle.setAttribute('aria-pressed', !isOn ? 'true' : 'false');
    const stateLabel = speedToggle.querySelector('.dash-speed-toggle-state');
    if (stateLabel) stateLabel.textContent = !isOn ? 'ON' : 'OFF';

    // Push the new value to Firebase. Surface errors to the instructor
    // so they know if the write got rejected (e.g. by stale security rules).
    fbLobbyRef(state.mpCode).child('decisionTimerSec').set(nextSecs).catch(err => {
      console.error('decisionTimerSec write failed', err);
      toast('Timer change rejected — republish Firebase rules');
      // Roll back the visual since the write didn't take
      speedToggle.classList.toggle('on', isOn);
      speedToggle.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      if (stateLabel) stateLabel.textContent = isOn ? 'ON' : 'OFF';
    });
  });

  $('dash-end-round')?.addEventListener('click', () => {
    if (state.mpRole !== 'instructor') return;
    if (!confirm('End the round now? Players will see their results based on what they\'ve completed.')) return;
    fbLobbyRef(state.mpCode).update({
      status: 'ended',
      roundEndedAt: firebase.database.ServerValue.TIMESTAMP
    }).catch(err => {
      console.error('End round failed', err);
    });
  });

  // Debrief: run another drill (back to lobby) or home
  $('debrief-new-drill')?.addEventListener('click', () => {
    if (state.mpRole !== 'instructor' || !state.mpCode) {
      showScreen('screen-home', false);
      return;
    }
    // Reset all player records and the lobby state, keep everyone in the lobby
    const updates = {};
    state.mpPlayers.forEach(p => {
      updates[`players/${p.id}/correct`] = 0;
      updates[`players/${p.id}/wrong`] = 0;
      updates[`players/${p.id}/totalTime`] = 0;
      updates[`players/${p.id}/progress`] = 0;
      updates[`players/${p.id}/finished`] = false;
      updates[`players/${p.id}/misses`] = null;
    });
    updates.deck = null;
    updates.status = 'lobby';
    updates.lastActivity = firebase.database.ServerValue.TIMESTAMP;
    fbLobbyRef(state.mpCode).update(updates).catch(err => {
      console.error('Reset failed', err);
    });
    showScreen('screen-mp-lobby');
  });
  $('debrief-home')?.addEventListener('click', () => {
    teardownMp();
    state.history = ['screen-home'];
    showScreen('screen-home', false);
  });
  // (legacy 4-letter-only input listener removed — the LLLL-NNNN
  //  auto-formatter at the top of mpInitWiring is the canonical one)

  // ---- Lobby controls ----
  $('lobby-copy').addEventListener('click', () => {
    if (state.mpCode) {
      navigator.clipboard?.writeText(state.mpCode).catch(() => {});
      toast(`Code ${state.mpCode} copied`);
    }
  });

  qsa('.team-toggle button').forEach(b => {
    b.addEventListener('click', () => {
      qsa('.team-toggle button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      setMpMode(b.dataset.mode);
      renderLobby();
    });
  });
  qsa('#mp-deck-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#mp-deck-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      setMpDeckCount(parseInt(opt.dataset.count, 10));
      $('mp-custom').value = '';  // clear custom when a preset is chosen
    });
  });
  // Custom-number input — host can override deck size with any value 1-500
  $('mp-custom')?.addEventListener('input', (e) => {
    const n = parseInt(e.target.value, 10);
    if (!isNaN(n) && n >= 1 && n <= 500) {
      qsa('#mp-deck-options .option').forEach(o => o.classList.remove('selected'));
      setMpDeckCount(n);
    }
  });
  // Difficulty buttons (host only) — independent toggles. Combined value
  // is written to the lobby so guests see whichever modes are active.
  function syncMpDifficultyFromButtons() {
    const hard   = $('mp-difficulty-hard')?.dataset.active === 'true';
    const expert = $('mp-difficulty-expert')?.dataset.active === 'true';
    setMpDifficulty(combinedDifficulty(hard, expert));
  }
  ['mp-difficulty-hard', 'mp-difficulty-expert'].forEach(id => {
    $(id)?.addEventListener('click', () => {
      const btn = $(id);
      const next = btn.dataset.active !== 'true';
      btn.dataset.active = next ? 'true' : 'false';
      btn.classList.toggle('active', next);
      syncMpDifficultyFromButtons();
    });
  });
  $('mp-start').addEventListener('click', hostStartGame);

  // ---- Game answer buttons ----
  qsa('.t-btn').forEach(b => {
    b.addEventListener('click', () => onTagPick(b.dataset.tag));
  });

  // ---- Results ----
  $('play-again').addEventListener('click', () => {
    if (state.game?.mode === 'mp-host') {
      // Host returns to lobby; reset stats via Firebase
      // First, figure out the winner(s) and bump their persistent win counter
      const sorted = state.mpPlayers.slice().sort((a, b) => {
        if (b.correct !== a.correct) return b.correct - a.correct;
        return a.totalTime - b.totalTime;
      });
      // Winner = top score; allow ties (everyone tied for first gets a win)
      const topCorrect = sorted[0]?.correct ?? 0;
      const topTime = sorted[0]?.totalTime ?? 0;
      const winners = sorted.filter(p => p.correct === topCorrect && p.totalTime === topTime);

      const updates = {};
      state.mpPlayers.forEach(p => {
        const newWins = (p.wins || 0) + (winners.find(w => w.id === p.id) ? 1 : 0);
        updates[`players/${p.id}/wins`] = newWins;
        updates[`players/${p.id}/correct`] = 0;
        updates[`players/${p.id}/wrong`] = 0;
        updates[`players/${p.id}/totalTime`] = 0;
        updates[`players/${p.id}/progress`] = 0;
        updates[`players/${p.id}/finished`] = false;
        updates[`players/${p.id}/misses`] = null;
      });
      updates.deck = null;
      updates.status = 'lobby';
      updates.lastActivity = firebase.database.ServerValue.TIMESTAMP;
      if (state.mpCode) {
        fbLobbyRef(state.mpCode).update(updates).catch(err => {
          console.error('Reset failed', err);
        });
      }
      state.game = null;
      showScreen('screen-mp-lobby');
    } else if (state.game?.mode === 'mp-guest') {
      state.game = null;
      showScreen('screen-mp-lobby');
    } else {
      startGame({ deck: buildDeck(state.spDeckCount, state.spDifficulty), mode: 'solo', difficulty: state.spDifficulty });
    }
  });
  $('result-home').addEventListener('click', () => {
    teardownMp();
    state.history = ['screen-home'];
    showScreen('screen-home', false);
  });
  $('solo-review-btn').addEventListener('click', () => {
    showReviewScreen('solo');
  });

  // Expert-fail screen
  $('expert-retry')?.addEventListener('click', () => {
    if (state.game?.mode === 'mp-host' || state.game?.mode === 'mp-guest') {
      // In multiplayer, retry sends back to the lobby for host to start a new round
      state.game = null;
      showScreen('screen-mp-lobby', false);
      return;
    }
    // Solo: same difficulty + deck size, fresh deck
    const n = state.spDeckCount;
    const difficulty = state.spDifficulty || 'expert';
    startGame({ deck: buildDeck(n, difficulty), mode: 'solo', difficulty });
  });
  $('expert-go-home')?.addEventListener('click', () => {
    teardownMp();
    state.history = ['screen-home'];
    showScreen('screen-home', false);
  });
});

/* ============================================================
   4. GAME ENGINE
   ============================================================ */

function startGame({ deck, mode, difficulty }) {
  state.game = {
    deck,
    idx: 0,
    correct: 0,
    wrong: 0,
    totalTime: 0,
    streak: 0,
    bestStreak: 0,
    perCard: [],         // {id, answer, picked, correct, time}
    cardStartTs: 0,
    mode,                 // 'solo' | 'mp-host' | 'mp-guest'
    difficulty: difficulty || 'normal',
    expertFailed: false,
    fatalIncident: null
  };

  // HUD: show or hide live board for multiplayer.
  // Classroom mode: never show. Students should focus on their own card,
  // and at 30+ players the live board is unreadable anyway.
  const isClassroomDrill = state.mpLobbyType === 'classroom';
  const showLiveBoard = (mode === 'mp-host' || mode === 'mp-guest') && !isClassroomDrill;
  $('live-board-wrap').style.display = showLiveBoard ? 'block' : 'none';

  showScreen('screen-game');
  // Reset card flip
  $('card').classList.remove('flipped');
  // Reset HUD streak indicator
  $('hud-streak-cell').classList.remove('live');
  $('hud-timer-cell').classList.remove('urgent');
  renderCard();
  startGameTicker();
}

let gameTicker = null;
function startGameTicker() {
  if (gameTicker) clearInterval(gameTicker);
  gameTicker = setInterval(() => {
    if (!state.game || !state.game.cardStartTs) return;
    const elapsed = (Date.now() - state.game.cardStartTs) / 1000;
    $('hud-timer').textContent = elapsed.toFixed(1) + 's';
    // Urgency: red pulse after 10s on this card
    const cell = $('hud-timer-cell');
    if (elapsed >= 10) cell.classList.add('urgent');
    else cell.classList.remove('urgent');
  }, 100);
}
function stopGameTicker() {
  if (gameTicker) { clearInterval(gameTicker); gameTicker = null; }
}

/* ============================================================
   5. CARD RENDERING + ANSWER HANDLING
   ============================================================ */

function renderCard() {
  const g = state.game;
  if (!g) return;

  const card = g.deck[g.idx];

  setHudValue('hud-card',    `${g.idx + 1}/${g.deck.length}`);
  setHudValue('hud-correct', g.correct);
  setHudValue('hud-wrong',   g.wrong);
  setHudValue('hud-streak',  g.streak);
  // Light up streak indicator at 3+ consecutive correct
  $('hud-streak-cell').classList.toggle('live', g.streak >= 3);
  // Reset urgency when a new card lands
  $('hud-timer-cell').classList.remove('urgent');

  $('card-scenario').textContent = card.description;
  $('rpm-r').textContent = card.respirations;
  $('rpm-p').textContent = card.perfusion;
  $('rpm-m').textContent = card.mental;

  $('card').classList.remove('flipped');
  // Hide the tap-to-continue hint until next answer
  const hint = $('tap-hint');
  if (hint) hint.style.opacity = '0';
  // Trigger card entrance animation
  const cardEl = $('card');
  cardEl.classList.remove('entering');
  // force reflow so the animation re-plays even on the same element
  void cardEl.offsetWidth;
  cardEl.classList.add('entering');

  qsa('.t-btn').forEach(b => b.disabled = false);

  g.cardStartTs = Date.now();

  // Render live board for multiplayer (NOT classroom — students focus on their card)
  if ((g.mode === 'mp-host' || g.mode === 'mp-guest') && state.mpLobbyType !== 'classroom') {
    renderLiveBoard();
  }

  // If the instructor has set a per-card timer, kick it off for this card.
  // Solo and instructor-self never run the decision timer (instructors don't play).
  startDecisionTimer();
}

/* ============================================================
   PER-CARD DECISION TIMER (instructor-controlled in classroom mode)
   ============================================================ */
function startDecisionTimer() {
  stopDecisionTimer();
  const g = state.game;
  if (!g) return;
  // Only enforce in multiplayer/classroom contexts where the instructor sets it
  if (g.mode !== 'mp-host' && g.mode !== 'mp-guest') return;
  const secs = state.decisionTimerSec || 0;
  const wrap = $('decision-timer-wrap');
  if (!wrap) return;
  if (secs <= 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  state.decisionDeadline = Date.now() + secs * 1000;
  // Reset the fill bar to 100% then animate it down
  const fill = $('decision-timer-fill');
  const secsEl = $('decision-timer-secs');
  if (fill) {
    fill.style.transition = 'none';
    fill.style.width = '100%';
    // force reflow so the next transition animates from 100% → 0%
    void fill.offsetWidth;
    fill.style.transition = `width ${secs}s linear`;
    fill.style.width = '0%';
  }
  if (secsEl) secsEl.textContent = secs + 's';

  state.decisionTickHandle = setInterval(() => {
    const remainMs = state.decisionDeadline - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
    if (secsEl) secsEl.textContent = remainSec + 's';
    // Color shifts as time pressure increases
    if (wrap) {
      wrap.classList.toggle('warn', remainSec <= 5 && remainSec > 2);
      wrap.classList.toggle('crit', remainSec <= 2);
    }
    if (remainMs <= 0) {
      // Time's up — auto-submit as wrong
      stopDecisionTimer();
      handleDecisionTimeout();
    }
  }, 100);
}

function stopDecisionTimer() {
  if (state.decisionTickHandle) {
    clearInterval(state.decisionTickHandle);
    state.decisionTickHandle = null;
  }
  const wrap = $('decision-timer-wrap');
  if (wrap) wrap.classList.remove('warn', 'crit');
}

/**
 * Called when the lobby's decisionTimerSec value changes mid-round.
 * Acts only if this player is actively on a card (game screen, answer
 * buttons still live). On other screens it's a no-op — the value is
 * cached on state and the next renderCard() will use it naturally.
 *
 * @param {number} newSecs - New timer value in seconds, 0 = off
 */
function handleDecisionTimerChange(newSecs) {
  // Only meaningful while a player is mid-game with answer buttons live.
  // Solo and instructor screens never run this timer.
  const g = state.game;
  if (!g) return;
  if (g.mode !== 'mp-host' && g.mode !== 'mp-guest') return;
  // If the answer buttons are already disabled, the player has already
  // tagged this card and is reading the verdict. Don't restart anything;
  // the next card will pick up the new value.
  const buttonsLive = qsa('.t-btn').some(b => !b.disabled);
  if (!buttonsLive) return;
  // Make sure we're actually on the game screen (not results, not lobby).
  if (state.currentScreen !== 'screen-game') return;

  if (newSecs > 0) {
    // Fresh full countdown starting now. Player gets the entire window
    // even if they've been reading the card for a while — they didn't
    // know there was a timer before, so no retroactive penalty.
    startDecisionTimer();
  } else {
    // Timer was turned off mid-card. Kill the countdown and hide the bar.
    stopDecisionTimer();
    const wrap = $('decision-timer-wrap');
    if (wrap) wrap.style.display = 'none';
  }
}

function handleDecisionTimeout() {
  // Same path as a wrong tag pick — pick a tag that's guaranteed not the answer.
  const g = state.game;
  if (!g || !g.cardStartTs) return;
  // Only fire if the player hasn't already answered (buttons still enabled)
  const buttonsLive = qsa('.t-btn').some(b => !b.disabled);
  if (!buttonsLive) return;
  const card = g.deck[g.idx];
  // Pick a deliberately wrong tag (whichever isn't the right answer)
  const allTags = ['red', 'yellow', 'green', 'black'];
  const wrongTag = allTags.find(t => t !== card.answer) || 'green';
  // Flash the screen red so the player gets a visceral signal that
  // they ran out of time. Auto-clears after the animation.
  flashTimeoutWarning();
  onTagPick(wrongTag);
}

function flashTimeoutWarning() {
  // Add a short-lived overlay to the game screen so the red flash is
  // contained and doesn't leak to other screens. Self-removes after 800ms.
  const screen = $('screen-game');
  if (!screen) return;
  // Remove any prior flash instance (in case rapid timeouts fire back-to-back)
  const prior = screen.querySelector('.timeout-flash');
  if (prior) prior.remove();
  const flash = document.createElement('div');
  flash.className = 'timeout-flash';
  screen.appendChild(flash);
  // Pull it off after the animation finishes
  setTimeout(() => flash.remove(), 900);
}

function onTagPick(tag) {
  const g = state.game;
  if (!g || !g.cardStartTs) return;

  // Tag submitted — kill the per-card decision timer (manual or auto)
  stopDecisionTimer();

  qsa('.t-btn').forEach(b => b.disabled = true);

  const card = g.deck[g.idx];
  const correct = (card.answer === tag);
  const t = (Date.now() - g.cardStartTs) / 1000;

  if (correct) {
    g.correct++;
    g.streak++;
    if (g.streak > g.bestStreak) g.bestStreak = g.streak;
  } else {
    g.wrong++;
    g.streak = 0;
  }
  g.totalTime += t;
  g.perCard.push({
    id: card.id, answer: card.answer, picked: tag, correct, time: t
  });
  g.cardStartTs = 0;

  // Classroom mode: students skip the verdict screen so the round
  // stays fluid — they review their misses on the AAR after the
  // round ends, not card-by-card. Everyone else still flips to the
  // verdict and rationale.
  const isClassroomGuest = (g.mode === 'mp-guest' && state.mpLobbyType === 'classroom');

  if (!isClassroomGuest) {
    // Render verdict on card back. Card-back is a neutral dark
    // surface; the triage answer color shows up only inside the
    // .verdict-label badge, driven by the answer-{color} class.
    const info = TRIAGE_INFO[card.answer];
    const back = $('card-back');
    back.classList.remove('answer-red', 'answer-yellow', 'answer-green', 'answer-black');
    back.classList.add('answer-' + card.answer);

    $('verdict-label').textContent = info.label;

    const vc = $('verdict-correct');
    if (correct) {
      vc.textContent = "CORRECT";
      vc.classList.remove('no'); vc.classList.add('ok');
    } else {
      // innerHTML is safe here: TRIAGE_INFO.short is a hardcoded
      // constant, not user input.
      vc.innerHTML = `WRONG <span class="verdict-pick">you picked ${TRIAGE_INFO[tag].short}</span>`;
      vc.classList.remove('ok'); vc.classList.add('no');
    }

    $('verdict-rationale').textContent = card.rationale;

    $('card').classList.add('flipped');
  }

  // Update HUD with streak feedback
  setHudValue('hud-correct', g.correct);
  setHudValue('hud-wrong',   g.wrong);
  setHudValue('hud-streak',  g.streak);
  const streakCell = $('hud-streak-cell');
  streakCell.classList.toggle('live', g.streak >= 3);
  // Replay pop animation on every correct
  if (correct) {
    streakCell.classList.remove('live');
    void streakCell.offsetWidth;
    streakCell.classList.add('live');
    if (g.streak < 3) {
      // Brief pop even at low streaks, then drop the live class
      setTimeout(() => streakCell.classList.toggle('live', g.streak >= 3), 500);
    }
  }

  // Send progress in multiplayer (write directly to Firebase).
  // CLASSROOM PERFORMANCE: at 30+ players the per-card writes overwhelm
  // Firebase free-tier and the instructor's browser. Throttle to every
  // 3rd card, plus always on misses (so debrief is correct) and on the
  // last card (so finished-state propagates immediately).
  if ((g.mode === 'mp-host' || g.mode === 'mp-guest') && state.mpCode && state.mpMyId) {
    const isClassroomMode = state.mpLobbyType === 'classroom';
    const isLastCard = (g.idx + 1 >= g.deck.length);
    const expertFail = (!correct && isExpertDeath(g.difficulty));
    // Always write on: misses, expert-fail, last card. Otherwise write
    // only every 3 cards in classroom; every card in normal multiplayer.
    const mustWrite = !correct || expertFail || isLastCard;
    const shouldWrite = mustWrite || !isClassroomMode || (g.idx % 3 === 0);

    if (shouldWrite) {
      const updates = {};
      updates[`players/${state.mpMyId}/correct`] = g.correct;
      updates[`players/${state.mpMyId}/wrong`] = g.wrong;
      updates[`players/${state.mpMyId}/totalTime`] = g.totalTime;
      updates[`players/${state.mpMyId}/progress`] = g.idx + 1;
      updates[`players/${state.mpMyId}/finished`] = expertFail || isLastCard;
      updates['lastActivity'] = firebase.database.ServerValue.TIMESTAMP;
      // If this card was missed, append to player's misses list so anyone can review
      if (!correct) {
        const missEntry = {
          idx: g.idx,
          cardId: card.id,
          picked: tag,
          answer: card.answer,
          time: t
        };
        const missKey = `m_${g.idx}`;
        updates[`players/${state.mpMyId}/misses/${missKey}`] = missEntry;
      }
      fbLobbyRef(state.mpCode).update(updates).catch(err => {
        console.error('Progress update failed', err);
      });
    }

    // If everyone is now finished, flip lobby status to 'ended'.
    // - Multiplayer: only the host triggers this (classic behavior).
    // - Classroom: the instructor never plays, so any guest finishing
    //   their last card needs to be allowed to flip the status. (The
    //   instructor also has a safety-net check in subscribeLobby.)
    const meDone = expertFail || isLastCard;
    const isClassroom = state.mpLobbyType === 'classroom';
    const canTriggerEnd = (g.mode === 'mp-host') || (isClassroom && g.mode === 'mp-guest');
    if (canTriggerEnd && meDone) {
      // Instructors are stored with finished=true at game start, so they don't
      // block this check. We only need real players to be done.
      const allDone = state.mpPlayers.every(p => {
        if (p.id === state.mpMyId) return true;
        return p.finished;
      });
      if (allDone) {
        fbLobbyRef(state.mpCode).update({
          status: 'ended',
          roundEndedAt: firebase.database.ServerValue.TIMESTAMP
        }).catch(() => {});
      }
    }
  }

  // CLASSROOM MODE: auto-advance with a brief feedback flash on the
  // card. No verdict screen, no tap to continue. Misses are still
  // recorded in g.perCard so the post-round AAR can show them.
  if (isClassroomGuest) {
    const cardEl = $('card');
    cardEl.classList.add(correct ? 'card-flash-ok' : 'card-flash-bad');
    setTimeout(() => {
      cardEl.classList.remove('card-flash-ok', 'card-flash-bad');
      g.idx++;
      if (g.idx >= g.deck.length) {
        endGame();
      } else {
        renderCard();
      }
    }, 320);
    return;
  }

  // Tap-to-continue: wait for the user to tap the flipped card.
  // No timer — players control their own pace.
  // The 700ms delay before attaching the listener is critical: it ensures
  // the user's finger has fully lifted from the triage button BEFORE we
  // start listening for taps. Otherwise the touchend from the button
  // press bubbles up and instantly advances the card.
  const cardEl = $('card');
  let armed = false;
  const advance = (e) => {
    if (!armed) return;
    if (e) { e.stopPropagation(); e.preventDefault(); }
    armed = false;
    cardEl.removeEventListener('click', advance);
    cardEl.removeEventListener('touchend', advance);
    // EXPERT MODE: a wrong answer ends the game immediately with a fatal
    // incident. Defensive fallback: if scenarios.js failed to expose
    // generateFatalIncident the player still gets ended cleanly instead of
    // stranded on a flipped card with no listeners attached.
    if (!correct && isExpertDeath(g.difficulty)) {
      g.expertFailed = true;
      try {
        g.fatalIncident = (typeof window.generateFatalIncident === 'function')
          ? window.generateFatalIncident()
          : { head: 'WRONG CALL', body: 'In Expert mode, every call counts. That one cost you the round.' };
      } catch (err) {
        console.error('generateFatalIncident threw', err);
        g.fatalIncident = { head: 'WRONG CALL', body: 'In Expert mode, every call counts. That one cost you the round.' };
      }
      endGame();
      return;
    }
    g.idx++;
    if (g.idx >= g.deck.length) {
      endGame();
    } else {
      renderCard();
    }
  };
  setTimeout(() => {
    armed = true;
    cardEl.addEventListener('click', advance);
    cardEl.addEventListener('touchend', advance);
    // Show the tap-to-continue hint on the back face
    const hint = $('tap-hint');
    if (hint) hint.style.opacity = '1';
  }, 700);
}

/* ============================================================
   6. RESULTS
   ============================================================ */

function gradeFor(accuracy, avgSec) {
  // Accuracy is the dominant signal; speed adjusts within a band.
  // Rough rubric:
  //   ≥95% accuracy AND avg ≤6s  -> S
  //   ≥90% accuracy              -> A
  //   ≥80%                       -> B
  //   ≥70%                       -> C
  //   ≥60%                       -> D
  //   <60%                       -> F
  if (accuracy >= 95 && avgSec <= 6) return 'S';
  if (accuracy >= 90) return 'A';
  if (accuracy >= 80) return 'B';
  if (accuracy >= 70) return 'C';
  if (accuracy >= 60) return 'D';
  return 'F';
}

function rankFor(grade) {
  return ({
    S: 'TRIAGE COMMANDER',
    A: 'SENIOR FIELD OFFICER',
    B: 'TRIAGE SPECIALIST',
    C: 'COMPETENT RESPONDER',
    D: 'NEEDS DRILL',
    F: 'RETURN TO TRAINING',
  })[grade] || 'TRAINEE';
}

// Per-grade quips shown under the AAR score. Tone shifts by tier:
//   S = over-the-top praise + jealousy
//   A = backhanded compliments
//   B = quietly approving, dry
//   C = "passed, technically"
//   D = barely-cleared-the-bar ribbing
//   F = locker-room corrective heat
// All firefighter/EMS-flavored, all light-hearted.
const GRADE_QUIPS = {
  S: [
    'Showed up. Sorted the chaos. Made it look easy. Annoying.',
    'Top of the pile. Either you\'ve done this before or you should be teaching it.',
    'Nothing to debrief. Frankly disappointing for the instructor.',
    'Speed AND accuracy. Pick a flaw — you\'re not allowed both.',
    'The kind of run that makes the rest of the shift feel slow.',
    'Whoever trained you should put in for a raise.',
    'If this were real, you\'d be the reason it ended quietly.',
    'Triage commander tier. Try to look humble at the debrief.',
  ],
  A: [
    'Almost a clean sweep. We\'ll find something to nitpick later.',
    'Solid. The kind of run that doesn\'t make a story — and doesn\'t need to.',
    'You\'re the calm one in the room. Annoying, but useful.',
    'One slip from perfect. We\'ll allow it.',
    'Great accuracy. Now do it 30% faster and we\'ll really talk.',
    'Probies will study your scoresheet. Don\'t let it go to your head.',
    'If this is your B-game, please stop holding out on the rest of us.',
  ],
  B: [
    'Solid B. The kind of run nobody talks about — which is a compliment around here.',
    'Got the job done. The yellows are still alive. The reds are too.',
    'Workmanlike. Nothing flashy. The patient board doesn\'t care about flashy.',
    'The deck didn\'t beat you. You also didn\'t beat the deck. Honorable tie.',
    'Reliable. The captain likes reliable.',
    'Above average. The bar\'s not on the floor, but it\'s not in the rafters either.',
  ],
  C: [
    'Passed. Just.',
    'Showed up. Did the work. Made a few calls we\'ll talk about in debrief.',
    'Not bad. Not great. The platonic ideal of \'okay.\'',
    'C-grade triage means C-grade outcomes. Math is unfair like that.',
    'The kind of score that gets you a "we\'ll work on it" from the BC.',
    'Middle of the pack. The pack is unimpressed but not concerned.',
  ],
  D: [
    'Cleared the bar. Knocked the bar over getting there.',
    'D for done. A few patients were also D, by your call.',
    'Not great. Not technically a fail. The distinction matters less than you think.',
    'Almost an F. Take the win, then take the lesson.',
    'The bar has been lowered to compensate. Try not to limbo.',
    'You\'re the reason refresher courses exist.',
    'Passing grade, losing patients. Fix the second part.',
  ],
  F: [
    'Good news — this was a drill. Bad news — that was still rough.',
    'Dispatch is asking, very politely, who taught you triage.',
    'By the time you decided, the patient self-triaged.',
    'Probies have done worse. Not many. But some.',
    'Captain wants to see you. Bring donuts.',
    'If this were the real thing, the after-action report would just be a sigh.',
    'S.T.A.R.T. is an acronym, not a suggestion.',
    'Strong start. Strong middle. Then it became a haunted house.',
    'Your patients sent flowers. To each other.',
    "We've issued you a participation ribbon. It's beige.",
    "On the bright side, you're now great at picking the wrong color.",
    'The walking wounded started directing themselves. You\'re welcome.',
    'Recommendation: more drills, fewer guesses.',
    'BC says don\'t take it personally. He didn\'t read the room.',
    'You\'re one drill away from being a really good cautionary tale.',
  ],
};

function endGame() {
  stopGameTicker();
  const g = state.game;
  if (!g) return;

  // EXPERT MODE FAIL — show the dramatic death screen instead of the normal AAR.
  // Multiplayer expert players still see this (they "died" in their own run);
  // they then watch the lobby for the final leaderboard from this same screen.
  if (g.expertFailed && g.fatalIncident) {
    const inc = g.fatalIncident;
    $('expert-fail-head').textContent = inc.head;
    $('expert-fail-body').textContent = inc.body;
    $('expert-fail-stats').textContent = `CARDS CLEARED: ${g.correct} · TIME: ${fmtTime(g.totalTime)}`;
    showScreen('screen-expert-fail');
    return;
  }

  const total = g.deck.length;
  const acc = total > 0 ? Math.round((g.correct / total) * 100) : 0;
  const avg = total > 0 ? (g.totalTime / total) : 0;
  const grade = gradeFor(acc, avg);
  const rank = rankFor(grade);

  $('result-tag').textContent = (g.mode === 'solo') ? 'AFTER-ACTION REPORT' : 'YOUR DRILL · AAR';
  const gradeEl = $('result-grade');
  gradeEl.textContent = grade;
  gradeEl.className = 'grade-badge g-' + (grade === 'S' ? 'A' : grade); // S shares gold treatment with A
  $('result-rank').textContent = rank;
  $('result-score').textContent = `${g.correct}/${total}`;
  $('result-time').textContent = `${fmtTime(g.totalTime)} · ${avg.toFixed(1)}s avg`;

  // Per-grade quip — pick one line at random from the matching pool.
  // The grade-X class drives bracket prefix + color treatment in CSS.
  const roastEl = $('result-roast');
  if (roastEl) {
    const pool = GRADE_QUIPS[grade];
    if (pool && pool.length) {
      roastEl.textContent = pool[Math.floor(Math.random() * pool.length)];
      roastEl.className = 'result-roast grade-' + grade;
      roastEl.style.display = '';
    } else {
      roastEl.style.display = 'none';
    }
  }
  $('stat-acc').textContent = `${acc}%`;
  $('stat-avg').textContent = `${avg.toFixed(1)}s`;
  $('stat-streak').textContent = g.bestStreak;

  // Configure the Play Again button based on role
  const btn = $('play-again');
  const help = $('play-again-help');
  if (g.mode === 'mp-host') {
    btn.textContent = 'PLAY AGAIN — RESET LOBBY';
    btn.style.display = '';
    help.style.display = 'none';
  } else if (g.mode === 'mp-guest') {
    btn.textContent = 'BACK TO LOBBY';
    btn.style.display = '';
    help.style.display = 'block';
  } else {
    btn.textContent = 'PLAY AGAIN';
    btn.style.display = '';
    help.style.display = 'none';
  }

  // Category breakdown
  const cats = ['red', 'yellow', 'green', 'black'];
  const breakdown = {};
  cats.forEach(c => breakdown[c] = { total: 0, correct: 0 });
  g.perCard.forEach(c => {
    breakdown[c.answer].total++;
    if (c.correct) breakdown[c.answer].correct++;
  });

  const rowsHtml = cats.map(c => {
    const b = breakdown[c];
    const pct = b.total > 0 ? Math.round((b.correct / b.total) * 100) : 0;
    const color = TRIAGE_INFO[c].color;
    return `<div class="cat-row ${c}">
      <span class="pill">${TRIAGE_INFO[c].short}</span>
      <div class="bar"><div class="bar-fill" style="width:${pct}%; background:${color};"></div></div>
      <span class="v">${b.correct}/${b.total}</span>
    </div>`;
  }).join('');
  $('cat-rows').innerHTML = rowsHtml;

  // Multiplayer leaderboard
  if (g.mode === 'mp-host' || g.mode === 'mp-guest') {
    showMpLeaderboard();
  } else {
    $('mp-leaderboard').style.display = 'none';
  }

  // Misses-review button — available to anyone whose own perCard
  // history was recorded. That's solo, plus classroom guests (who
  // skipped the per-card verdict and review their misses here).
  const soloReviewBtn = $('solo-review-btn');
  const canReviewMisses = (g.mode === 'solo')
    || (g.mode === 'mp-guest' && state.mpLobbyType === 'classroom');
  if (canReviewMisses) {
    const myMisses = g.perCard.filter(c => !c.correct);
    if (myMisses.length > 0) {
      soloReviewBtn.style.display = '';
      soloReviewBtn.textContent = `REVIEW ${myMisses.length} MISSED CARD${myMisses.length > 1 ? 'S' : ''}`;
    } else {
      soloReviewBtn.style.display = 'none';
    }
  } else {
    soloReviewBtn.style.display = 'none';
  }

  showScreen('screen-results');
}

function showMpLeaderboard() {
  // Filter out the instructor — in classroom mode they're stored as
  // a player record (with isInstructor=true) but never play, so they
  // must not appear on the leaderboard or skew the "N finished" counts.
  const realPlayers = state.mpPlayers.filter(p => !p.isInstructor);
  // Sort: most correct first, fastest time as tiebreaker
  const players = realPlayers.slice();
  players.sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    return a.totalTime - b.totalTime;
  });

  const allDone = realPlayers.length > 0 && realPlayers.every(p => p.finished);
  let html = '';

  if (allDone) {
    // Big completion banner
    html += `
      <div class="mp-complete-banner">
        <div class="mp-complete-tag">DRILL COMPLETE</div>
        <div class="mp-complete-title">ALL PLAYERS FINISHED</div>
        <div class="mp-complete-sub">${realPlayers.length} ${realPlayers.length === 1 ? 'player' : 'players'} · final results below</div>
      </div>
    `;

    // Team summary (if applicable)
    if (state.mpMode === 'team') {
      const teamA = players.filter(p => p.team === 'A');
      const teamB = players.filter(p => p.team === 'B');
      const sumA = teamA.reduce((a, p) => a + p.correct, 0);
      const sumB = teamB.reduce((a, p) => a + p.correct, 0);
      const tA = teamA.reduce((a, p) => a + p.totalTime, 0);
      const tB = teamB.reduce((a, p) => a + p.totalTime, 0);
      let bannerCls = '', bannerText = '';
      if (sumA > sumB || (sumA === sumB && tA < tB)) {
        bannerCls = 'team-a-win'; bannerText = `TEAM A WINS · ${sumA} – ${sumB}`;
      } else if (sumB > sumA || (sumA === sumB && tB < tA)) {
        bannerCls = 'team-b-win'; bannerText = `TEAM B WINS · ${sumB} – ${sumA}`;
      } else {
        bannerCls = 'team-draw'; bannerText = `DRAW · ${sumA} – ${sumB}`;
      }
      html += `<div class="team-banner ${bannerCls}">${bannerText}</div>`;
    }
  } else {
    // Still in progress
    const finishedCount = realPlayers.filter(p => p.finished).length;
    html += `
      <div class="mp-progress-banner">
        <div class="mp-progress-spinner"></div>
        <div class="mp-progress-text">
          <div class="mp-progress-title">WAITING FOR OTHER PLAYERS</div>
          <div class="mp-progress-sub">${finishedCount} of ${realPlayers.length} finished</div>
        </div>
      </div>
    `;
  }

  html += `<h2 class="section-title">${allDone ? 'FINAL LEADERBOARD' : 'CURRENT STANDINGS'}</h2>`;

  html += `<div class="leaderboard">`;
  html += players.map((p, i) => {
    const rank = i + 1;
    const teamTxt = p.team ? `<span class="lb-team">TEAM ${p.team}</span>` : '';
    const meTxt = (p.id === state.mpMyId) ? `<span class="lb-you">YOU</span>` : '';
    const finishMark = p.finished ? '' : `<span class="lb-status">in-progress</span>`;

    let medal = '', rowCls = '';
    if (allDone && rank === 1) { medal = '<span class="medal gold">🏆</span>'; rowCls = 'first'; }
    else if (allDone && rank === 2) { medal = '<span class="medal silver">🥈</span>'; rowCls = 'second'; }
    else if (allDone && rank === 3) { medal = '<span class="medal bronze">🥉</span>'; rowCls = 'third'; }

    const total = state.game ? state.game.deck.length : (p.correct + p.wrong);
    const accuracy = total > 0 ? Math.round((p.correct / total) * 100) : 0;

    return `<div class="lb-row ${rowCls}">
      <span class="rk">${medal || `<span class="rk-num">${rank}</span>`}</span>
      <span class="nm">
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-meta">${teamTxt}${meTxt}${winsBadge(p)}${finishMark}</span>
      </span>
      <span class="sc">
        <span class="sc-main">${p.correct}<span class="sc-of">/${total}</span></span>
        <span class="sc-acc">${accuracy}%</span>
      </span>
      <span class="tm">${fmtTime(p.totalTime)}</span>
    </div>`;
  }).join('');
  html += `</div>`;

  // Review-misses button:
  //  - While the round is still in progress, finished players can review THEIR
  //    OWN misses without waiting for others. Shows only their own cards.
  //  - When everyone is done, the full cross-player review unlocks.
  const me = state.mpPlayers.find(p => p.id === state.mpMyId);
  const myMissCount = me ? (me.misses || []).length : 0;
  // Use realPlayers — instructor never plays so they have 0 misses
  // anyway, but keep counts consistent with the rest of the leaderboard.
  const totalMissCount = realPlayers.reduce((s, p) => s + (p.misses || []).length, 0);
  const iAmFinished = !!me?.finished;

  if (allDone && totalMissCount > 0) {
    // Full debrief — review across all players
    html += `<button class="btn-ghost" id="review-misses-btn" style="margin-top:6px">REVIEW MISSED CARDS (${myMissCount} YOURS · ${totalMissCount} TOTAL)</button>`;
  } else if (!allDone && iAmFinished && myMissCount > 0) {
    // Mid-round, my run is done — let me review my own misses while waiting
    html += `<button class="btn-ghost" id="review-misses-btn" style="margin-top:6px">REVIEW MY MISSED CARDS (${myMissCount})</button>`;
  }

  $('mp-leaderboard').innerHTML = html;
  $('mp-leaderboard').style.display = 'block';

  // Wire up the review button after innerHTML is set.
  // If we're still waiting, force "self-only" mode so we only see our own misses
  // (other players might still be answering — their data is incomplete).
  const rb = document.getElementById('review-misses-btn');
  if (rb) {
    rb.addEventListener('click', () => {
      const selfOnly = !allDone;
      showReviewScreen(selfOnly ? 'mp-self' : null);
    });
  }
}

function winsBadge(p) {
  const w = p.wins || 0;
  if (w < 1) return '';
  if (w === 1) return `<span class="lb-wins">WINNER</span>`;
  return `<span class="lb-wins lb-wins-multi">${w}× WINNER</span>`;
}

/* ============================================================
   CLASSROOM DASHBOARD — instructor's live view during a drill
   ============================================================ */
function fmtElapsed(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateDashElapsed() {
  const el = $('dash-elapsed');
  if (!el) return;
  if (!state.mpRoundStartedAt) {
    el.textContent = '0:00';
    return;
  }
  // If the round ended, freeze the displayed time at the final value.
  const end = state.mpRoundEndedAt || Date.now();
  const elapsedSec = (end - state.mpRoundStartedAt) / 1000;
  el.textContent = fmtElapsed(elapsedSec);
}

function startDashTicker() {
  // Tick once a second. Only one ticker at a time.
  stopDashTicker();
  state.dashTickHandle = setInterval(updateDashElapsed, 1000);
  updateDashElapsed();
}
function stopDashTicker() {
  if (state.dashTickHandle) {
    clearInterval(state.dashTickHandle);
    state.dashTickHandle = null;
  }
}

/**
 * Throttled dashboard renderer — batches Firebase update events so the
 * instructor's grid re-renders at most every DASH_RENDER_MIN_MS, regardless
 * of how many writes come in. Critical at 30+ players where naive
 * per-event rendering will freeze the browser.
 */
const DASH_RENDER_MIN_MS = 400;
let dashRenderPending = false;
let dashRenderLastAt = 0;
function scheduleDashboardRender() {
  if (dashRenderPending) return;
  const sinceLast = Date.now() - dashRenderLastAt;
  if (sinceLast >= DASH_RENDER_MIN_MS) {
    // Enough time has passed — render immediately
    dashRenderLastAt = Date.now();
    renderDashboard();
  } else {
    // Schedule a single render at the next allowed slot
    dashRenderPending = true;
    setTimeout(() => {
      dashRenderPending = false;
      dashRenderLastAt = Date.now();
      renderDashboard();
    }, DASH_RENDER_MIN_MS - sinceLast);
  }
}

function renderDashboard() {
  $('dash-code-v').textContent = state.mpCode || '----';
  // Real players only (exclude instructor)
  const players = state.mpPlayers.filter(p => !p.isInstructor);
  const total = players.length;
  const finished = players.filter(p => p.finished).length;
  const active = total - finished;

  $('dash-players-count').textContent = total;
  $('dash-active-count').textContent = active;
  $('dash-finished-count').textContent = finished;
  // Always update elapsed once (the interval handles continuous ticking)
  updateDashElapsed();

  // Sync the speed control to current lobby state.
  // Slider: keeps the instructor's chosen position. Only auto-updates if the
  //   timer is on AND the value differs from the slider — meaning another
  //   instance changed it. Avoids fighting the user's drag.
  // Toggle: reflects whether the timer is currently active for everyone.
  // Value label: shows the slider's current intent (always 5-30s, no "OFF"),
  //   since the toggle button itself communicates the on/off state.
  const speedSlider = $('dash-speed-slider');
  const speedValue = $('dash-speed-value');
  const speedToggle = $('dash-speed-toggle');
  if (speedSlider && speedValue) {
    const cur = state.decisionTimerSec || 0;
    // If the timer is active and the slider doesn't match the broadcast value,
    // pull the slider to match. (Handles cross-device sync without overwriting
    // a local drag in progress: we don't update during user input events.)
    if (cur > 0 && parseInt(speedSlider.value, 10) !== cur) {
      speedSlider.value = Math.max(5, Math.min(30, cur));
    }
    speedValue.textContent = speedSlider.value + 's';
  }
  if (speedToggle) {
    const isOn = (state.decisionTimerSec || 0) > 0;
    speedToggle.classList.toggle('on', isOn);
    speedToggle.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    const stateLabel = speedToggle.querySelector('.dash-speed-toggle-state');
    if (stateLabel) stateLabel.textContent = isOn ? 'ON' : 'OFF';
  }

  const deckSize = (state.mpDeck && state.mpDeck.length) || state.mpDeckCount || 1;

  // One row per player. Show score, pace, current card.
  const rows = players.map(p => {
    const pct = Math.min(100, Math.round((p.progress / deckSize) * 100));
    const totalAns = p.correct + p.wrong;
    const accuracy = totalAns > 0 ? Math.round((p.correct / totalAns) * 100) : 0;
    const teamTxt = p.team ? `<span class="dash-team team-${p.team.toLowerCase()}">${p.team}</span>` : '';
    // Status: disconnected > finished > still going
    let statusTxt;
    let rowExtraCls = '';
    if (p.disconnected) {
      statusTxt = `<span class="dash-status disconnected">⚠ DISCONNECTED · CARD ${p.progress}/${deckSize}</span>`;
      rowExtraCls = 'disconnected';
    } else if (p.finished) {
      statusTxt = `<span class="dash-status done">✓ FINISHED</span>`;
      rowExtraCls = 'finished';
    } else {
      statusTxt = `<span class="dash-status active">CARD ${p.progress + 1}/${deckSize}</span>`;
    }
    return `<div class="dash-row ${rowExtraCls}">
      <div class="dash-row-name">${escapeHtml(p.name)}${teamTxt}</div>
      <div class="dash-row-bar"><div class="dash-row-bar-fill" style="width:${pct}%"></div></div>
      <div class="dash-row-stats">
        <span class="dash-stat-cell"><span class="ds-l">CORRECT</span><span class="ds-v ok">${p.correct}</span></span>
        <span class="dash-stat-cell"><span class="ds-l">WRONG</span><span class="ds-v bad">${p.wrong}</span></span>
        <span class="dash-stat-cell"><span class="ds-l">ACC</span><span class="ds-v">${accuracy}%</span></span>
        <span class="dash-stat-cell"><span class="ds-l">TIME</span><span class="ds-v">${fmtTime(p.totalTime)}</span></span>
      </div>
      <div class="dash-row-foot">${statusTxt}</div>
    </div>`;
  }).join('');

  $('dash-grid').innerHTML = rows || '<div class="dash-empty">NO PLAYERS — WAITING TO JOIN</div>';
}

/* ============================================================
   CLASSROOM DEBRIEF — final leaderboard + commonly missed cards
   ============================================================ */
function renderDebrief() {
  const players = state.mpPlayers.filter(p => !p.isInstructor);

  // === FINAL LEADERBOARD ===
  // Sort: most correct first, fastest time as tiebreaker
  const sorted = players.slice().sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    return a.totalTime - b.totalTime;
  });

  const deckSize = (state.mpDeck && state.mpDeck.length) || state.mpDeckCount || 1;

  let html = `
    <div class="debrief-header">
      <div class="debrief-tag">DRILL DEBRIEF</div>
      <div class="debrief-title">${players.length} PLAYER${players.length !== 1 ? 'S' : ''} · ${deckSize} CARD${deckSize !== 1 ? 'S' : ''}</div>
      <div class="debrief-sub">CODE ${state.mpCode || '----'}${
        state.mpRoundStartedAt && state.mpRoundEndedAt
          ? ` · DRILL TIME ${fmtElapsed((state.mpRoundEndedAt - state.mpRoundStartedAt) / 1000)}`
          : ''
      }</div>
    </div>
  `;

  // Team summary (if classroom + team mode)
  if (state.mpMode === 'team') {
    const teamA = sorted.filter(p => p.team === 'A');
    const teamB = sorted.filter(p => p.team === 'B');
    const sumA = teamA.reduce((a, p) => a + p.correct, 0);
    const sumB = teamB.reduce((a, p) => a + p.correct, 0);
    let bannerCls = '', bannerText = '';
    if (sumA > sumB) {
      bannerCls = 'team-a-win'; bannerText = `TEAM A WINS · ${sumA} – ${sumB}`;
    } else if (sumB > sumA) {
      bannerCls = 'team-b-win'; bannerText = `TEAM B WINS · ${sumB} – ${sumA}`;
    } else {
      bannerCls = 'team-draw'; bannerText = `DRAW · ${sumA} – ${sumB}`;
    }
    html += `<div class="team-banner ${bannerCls}">${bannerText}</div>`;
  }

  // Leaderboard
  html += `<h2 class="section-title">FINAL LEADERBOARD</h2><div class="leaderboard">`;
  html += sorted.map((p, i) => {
    const rank = i + 1;
    const teamTxt = p.team ? `<span class="lb-team">TEAM ${p.team}</span>` : '';
    const total = p.correct + p.wrong;
    const accuracy = total > 0 ? Math.round((p.correct / total) * 100) : 0;
    let medal = '', rowCls = '';
    if (rank === 1) { medal = '<span class="medal gold">🏆</span>'; rowCls = 'first'; }
    else if (rank === 2) { medal = '<span class="medal silver">🥈</span>'; rowCls = 'second'; }
    else if (rank === 3) { medal = '<span class="medal bronze">🥉</span>'; rowCls = 'third'; }
    return `<div class="lb-row ${rowCls}">
      <span class="rk">${medal || `<span class="rk-num">${rank}</span>`}</span>
      <span class="nm">
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-meta">${teamTxt}</span>
      </span>
      <span class="sc">
        <span class="sc-main">${p.correct}<span class="sc-of">/${deckSize}</span></span>
        <span class="sc-acc">${accuracy}%</span>
      </span>
      <span class="tm">${fmtTime(p.totalTime)}</span>
    </div>`;
  }).join('');
  html += `</div>`;

  // === COMMONLY MISSED QUESTIONS ===
  // Aggregate misses across all players, group by card index, count occurrences.
  const missesByCard = {};
  players.forEach(p => {
    (p.misses || []).forEach(m => {
      if (!missesByCard[m.idx]) missesByCard[m.idx] = [];
      missesByCard[m.idx].push({ name: p.name, picked: m.picked });
    });
  });
  const flaggedIndices = Object.keys(missesByCard)
    .map(Number)
    .sort((a, b) => missesByCard[b].length - missesByCard[a].length);

  if (flaggedIndices.length > 0 && state.mpDeck) {
    const totalPlayers = players.length || 1;
    html += `<h2 class="section-title">COMMONLY MISSED · ${flaggedIndices.length} CARD${flaggedIndices.length !== 1 ? 'S' : ''}</h2>`;
    html += `<div class="debrief-misses">`;
    html += flaggedIndices.map(idx => {
      const card = state.mpDeck[idx];
      if (!card) return '';
      const correctInfo = TRIAGE_INFO[card.answer];
      const missList = missesByCard[idx];
      const missCount = missList.length;
      const missPct = Math.round((missCount / totalPlayers) * 100);
      // Build mini-bar showing how many missed
      const barCells = Array.from({ length: totalPlayers }, (_, i) =>
        i < missCount ? '<span class="miss-cell filled"></span>' : '<span class="miss-cell"></span>'
      ).join('');

      const missedHtml = missList.map(m =>
        `<span class="review-miss-pill">${escapeHtml(m.name)}: ${m.picked.toUpperCase()}</span>`
      ).join('');

      return `<details class="review-card debrief-miss-card">
        <summary class="review-summary">
          <span class="review-num">#${idx + 1}</span>
          <span class="review-tagchip review-tagchip-${card.answer}">${correctInfo.label}</span>
          <span class="debrief-missbar">${barCells}</span>
          <span class="debrief-missfrac">${missCount}/${totalPlayers} (${missPct}%)</span>
          <span class="review-arrow">▼</span>
        </summary>
        <div class="review-body">
          <div class="review-narrative">${escapeHtml(card.description)}</div>
          <div class="review-vitals">
            <div><span class="review-vk">RESPIRATIONS</span><span class="review-vv">${escapeHtml(card.respirations)}</span></div>
            <div><span class="review-vk">PERFUSION</span><span class="review-vv">${escapeHtml(card.perfusion)}</span></div>
            <div><span class="review-vk">MENTAL STATUS</span><span class="review-vv">${escapeHtml(card.mental)}</span></div>
          </div>
          <div class="review-misses-list">${missedHtml}</div>
          <div class="review-correct">
            <div class="review-correct-label">CORRECT ANSWER · ${correctInfo.label}</div>
            <div class="review-correct-rationale">${escapeHtml(card.rationale)}</div>
          </div>
        </div>
      </details>`;
    }).join('');
    html += `</div>`;
  } else if (flaggedIndices.length === 0) {
    html += `<div class="debrief-clean">PERFECT ROUND · NO MISSED CARDS</div>`;
  }

  $('debrief-body').innerHTML = html;
}

/* ============================================================
   REVIEW MISSED CARDS — multiplayer post-game
   Shows every missed card across all players with the patient
   narrative, the correct tag, what was picked, and the rationale.
   ============================================================ */

function showReviewScreen(modeOverride) {
  const isSolo = modeOverride === 'solo' || (state.game && state.game.mode === 'solo');
  // 'mp-self' = mid-round review of only my own misses
  const selfOnly = modeOverride === 'mp-self';
  let deck, byCard;

  if (isSolo) {
    // Solo: deck lives on the local game state; misses come from g.perCard
    if (!state.game || !state.game.deck) {
      toast('No deck data to review');
      return;
    }
    deck = state.game.deck;
    byCard = {};
    state.game.perCard.forEach((c, i) => {
      if (!c.correct) {
        byCard[i] = [{ name: 'You', picked: c.picked, isMe: true }];
      }
    });
  } else {
    // Multiplayer: aggregate misses (everyone, or just self if mid-round)
    if (!state.mpDeck || !state.mpDeck.length) {
      toast('No deck data to review');
      return;
    }
    deck = state.mpDeck;
    byCard = {};
    const sourcePlayers = selfOnly
      ? state.mpPlayers.filter(p => p.id === state.mpMyId)
      : state.mpPlayers;
    sourcePlayers.forEach(p => {
      (p.misses || []).forEach(m => {
        if (!byCard[m.idx]) byCard[m.idx] = [];
        byCard[m.idx].push({ name: p.name, picked: m.picked, isMe: p.id === state.mpMyId });
      });
    });
  }

  const indices = Object.keys(byCard).map(Number).sort((a, b) => a - b);

  if (indices.length === 0) {
    toast('No missed cards to review — perfect round!');
    return;
  }

  let html = `
    <div class="review-header">
      <div class="review-tag">${selfOnly ? 'REVIEW · YOUR MISSES' : 'REVIEW · MISSED CARDS'}</div>
      <div class="review-title">${indices.length} CARD${indices.length > 1 ? 'S' : ''} TO REVIEW</div>
      <div class="review-sub">${selfOnly ? 'Read up while others finish · tap to expand' : 'Tap any card to expand the explanation'}</div>
    </div>
  `;

  indices.forEach(idx => {
    const card = deck[idx];
    if (!card) return;
    const correctInfo = TRIAGE_INFO[card.answer];
    const missedBy = byCard[idx];
    const myMiss = missedBy.find(m => m.isMe);
    const others = missedBy.filter(m => !m.isMe);

    const missedHtml = `
      ${myMiss ? `<span class="review-miss-pill review-miss-pill-me">YOU PICKED ${myMiss.picked.toUpperCase()}</span>` : ''}
      ${others.map(m =>
        `<span class="review-miss-pill">${escapeHtml(m.name)}: ${m.picked.toUpperCase()}</span>`
      ).join('')}
    `;

    html += `
      <details class="review-card">
        <summary class="review-summary">
          <span class="review-num">#${idx + 1}</span>
          <span class="review-tagchip review-tagchip-${card.answer}">${correctInfo.label}</span>
          <span class="review-misscount">${isSolo ? 'missed' : `${missedBy.length} miss${missedBy.length > 1 ? 'es' : ''}`}</span>
          <span class="review-arrow">▼</span>
        </summary>
        <div class="review-body">
          <div class="review-narrative">${escapeHtml(card.description)}</div>
          <div class="review-vitals">
            <div><span class="review-vk">RESPIRATIONS</span><span class="review-vv">${escapeHtml(card.respirations)}</span></div>
            <div><span class="review-vk">PERFUSION</span><span class="review-vv">${escapeHtml(card.perfusion)}</span></div>
            <div><span class="review-vk">MENTAL STATUS</span><span class="review-vv">${escapeHtml(card.mental)}</span></div>
          </div>
          <div class="review-misses-list">${missedHtml}</div>
          <div class="review-correct">
            <div class="review-correct-label">CORRECT ANSWER · ${correctInfo.label}</div>
            <div class="review-correct-rationale">${escapeHtml(card.rationale)}</div>
          </div>
        </div>
      </details>
    `;
  });

  html += `
    <button class="btn-ghost" id="review-back-btn" style="margin-top:14px">← BACK TO LEADERBOARD</button>
  `;

  $('review-body').innerHTML = html;
  showScreen('screen-review');
  document.getElementById('review-back-btn')?.addEventListener('click', () => {
    showScreen('screen-results', false);
  });
}

function renderLiveBoard() {
  const g = state.game;
  if (!g) return;
  const players = state.mpPlayers.slice().sort((a, b) => b.correct - a.correct);
  const html = players.map(p => {
    const teamCls = p.team ? `team-${p.team}` : '';
    const me = (p.id === state.mpMyId) ? ' (you)' : '';
    return `<div class="live-row">
      <span class="name ${teamCls}">${escapeHtml(p.name)}${me}</span>
      <span class="prog">${p.progress}/${g.deck.length}</span>
      <span class="pct">${p.correct} ✓</span>
    </div>`;
  }).join('');
  $('live-board-body').innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ============================================================
   7. MULTIPLAYER  (Firebase)
   ============================================================ */

/* ============================================================
   MULTIPLAYER (Firebase Realtime Database edition)
   ============================================================
   Architecture:
     - Each lobby is a single object at /lobbies/{CODE}
     - All clients .on('value') subscribe to that path
     - Anyone can write to their own player record + the shared
       game-control fields. No "host messages" travel separately.
     - The host is the player with isHost=true. Only the host
       writes the deck and toggles status.
     - This routes through standard HTTPS, so it works through
       Zscaler and other corporate proxies that block WebRTC.

   Lobby document shape:
     /lobbies/{CODE}
       hostName: string
       mode: 'ffa' | 'team'
       deckCount: number
       status: 'lobby' | 'playing' | 'ended'
       deck: [scenario...]              (set by host on START)
       lastActivity: <serverTimestamp>
       players/
         {playerId}/
           name, team, isHost, correct, wrong, totalTime, progress, finished
   ============================================================ */

const LOBBY_TTL_MS = 4 * 60 * 60 * 1000; // ignore lobbies older than 4h

function fbLobbyRef(code) {
  return window.fbDb.ref('lobbies/' + code);
}

function fbPlayerRef(code, playerId) {
  return window.fbDb.ref('lobbies/' + code + '/players/' + playerId);
}

function newPlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

function teardownMp() {
  // Detach Firebase listener
  if (state.mpListener && state.mpListenerRef) {
    state.mpListenerRef.off('value', state.mpListener);
  }
  state.mpListener = null;
  state.mpListenerRef = null;

  // If we were in a lobby, remove our player record
  if (state.mpCode && state.mpMyId) {
    fbPlayerRef(state.mpCode, state.mpMyId).remove().catch(() => {});
  }
  // If we were the host and lobby still exists, remove the whole lobby
  if (state.mpRole === 'host' && state.mpCode) {
    fbLobbyRef(state.mpCode).remove().catch(() => {});
  }

  state.mpRole = null;
  state.mpCode = null;
  state.mpMyId = null;
  state.mpPlayers = [];
}

/* Friendly error mapping for Firebase failures (network, rules, etc.) */
function fbErrorText(err) {
  const code = err && err.code ? err.code : 'unknown';
  if (code === 'PERMISSION_DENIED') return `BLOCKED BY RULES (${code})`;
  if (code === 'NETWORK_ERROR') return `NETWORK BLOCKED (${code}) · CHECK FIREWALL`;
  if (code === 'DISCONNECTED') return `DISCONNECTED · TRYING TO RECONNECT`;
  return `ERROR (${code}) · SEE CONSOLE`;
}

/* ---------- HOST ---------- */

async function createLobby(opts = {}) {
  const asInstructor = !!opts.asInstructor;
  teardownMp();
  state.mpRole = asInstructor ? 'instructor' : 'host';
  state.mpLobbyType = asInstructor ? 'classroom' : 'multiplayer';
  state.mpMyId = newPlayerId();

  showScreen('screen-mp-lobby');
  $('lobby-status').textContent = 'STARTING LOBBY…';
  $('lobby-status').className = 'status-line connecting';

  // Try up to 5 times to find a free code. With ~3.3B-code space
  // collisions are vanishingly rare; loop is here to handle the
  // also-rare "stale lobby still occupies this code" case.
  let code, ok = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = randLobbyCode();
    try {
      const snap = await fbLobbyRef(code).once('value');
      if (!snap.exists()) {
        ok = true;
        break;
      }
      const v = snap.val();
      if (!v.lastActivity || Date.now() - v.lastActivity > LOBBY_TTL_MS) {
        ok = true;
        break;
      }
    } catch (err) {
      console.error('Lobby lookup failed', err);
      $('lobby-status').textContent = fbErrorText(err) + ' — TRY AGAIN';
      $('lobby-status').className = 'status-line error';
      return;
    }
  }
  if (!ok) {
    $('lobby-status').textContent = 'COULD NOT RESERVE A CODE — TRY AGAIN';
    $('lobby-status').className = 'status-line error';
    return;
  }

  state.mpCode = code;

  // Build initial lobby document.
  // - In multiplayer: host is added as a regular player.
  // - In classroom: instructor is added as a special isInstructor record
  //   that does NOT play, and is hidden from regular players' lists.
  const initial = {
    hostName: state.mpName,
    mode: state.mpMode || 'ffa',
    deckCount: state.mpDeckCount || 25,
    status: 'lobby',
    lobbyType: state.mpLobbyType,
    lastActivity: firebase.database.ServerValue.TIMESTAMP,
    players: {
      [state.mpMyId]: {
        name: state.mpName,
        team: null,
        isHost: true,
        isInstructor: asInstructor,
        correct: 0, wrong: 0, totalTime: 0, progress: 0, finished: asInstructor
      }
    }
  };

  try {
    await fbLobbyRef(code).set(initial);
  } catch (err) {
    console.error('Could not create lobby', err);
    $('lobby-status').textContent = fbErrorText(err);
    $('lobby-status').className = 'status-line error';
    return;
  }

  $('lobby-code-v').textContent = code;
  $('lobby-status').textContent = 'CONNECTED · WAITING FOR PLAYERS';
  $('lobby-status').className = 'status-line connected';

  // Start subscribing to lobby updates (this is the source of truth)
  subscribeLobby(code);

  // Auto-cleanup: if host disconnects, remove lobby
  fbLobbyRef(code).onDisconnect().remove();
}

/* ---------- GUEST ---------- */

async function joinLobby(code) {
  teardownMp();
  state.mpRole = 'guest';
  state.mpCode = code;
  state.mpMyId = newPlayerId();

  $('mp-join-status').style.display = 'block';
  $('mp-join-status').className = 'status-line connecting';
  $('mp-join-status').textContent = 'CONNECTING…';

  let snap;
  try {
    snap = await fbLobbyRef(code).once('value');
  } catch (err) {
    console.error('Lobby fetch failed', err);
    $('mp-join-status').textContent = fbErrorText(err);
    $('mp-join-status').className = 'status-line error';
    state.mpCode = null;
    return;
  }

  if (!snap.exists()) {
    $('mp-join-status').textContent = `LOBBY NOT FOUND · CHECK CODE`;
    $('mp-join-status').className = 'status-line error';
    state.mpCode = null;
    return;
  }
  const lobby = snap.val();
  if (lobby.lastActivity && Date.now() - lobby.lastActivity > LOBBY_TTL_MS) {
    $('mp-join-status').textContent = `LOBBY EXPIRED · ASK HOST TO RESTART`;
    $('mp-join-status').className = 'status-line error';
    state.mpCode = null;
    return;
  }
  if (lobby.status !== 'lobby') {
    $('mp-join-status').textContent = `GAME ALREADY IN PROGRESS · WAIT FOR NEXT ROUND`;
    $('mp-join-status').className = 'status-line error';
    state.mpCode = null;
    return;
  }

  // Compose player record. In classroom lobbies the instructor is also
  // present in `players` but flagged isInstructor=true — exclude them
  // from the count when assigning teams so teams stay balanced.
  state.mpLobbyType = lobby.lobbyType || 'multiplayer';
  const realPlayers = lobby.players
    ? Object.values(lobby.players).filter(p => !p.isInstructor)
    : [];
  const playerCount = realPlayers.length;

  // Lobby cap: 50 real players. Above this the architecture starts to
  // break down (Firebase write contention, dashboard render cost). For
  // larger classes, instructors should split into multiple rooms.
  const MAX_PLAYERS = 50;
  if (playerCount >= MAX_PLAYERS) {
    $('mp-join-status').textContent = `LOBBY FULL (${MAX_PLAYERS} MAX) · ASK INSTRUCTOR TO START A SECOND ROOM`;
    $('mp-join-status').className = 'status-line error';
    state.mpCode = null;
    return;
  }

  const team = (lobby.mode === 'team') ? (playerCount % 2 === 0 ? 'A' : 'B') : null;
  const playerRecord = {
    name: state.mpName,
    team: team,
    isHost: false,
    isInstructor: false,
    correct: 0, wrong: 0, totalTime: 0, progress: 0, finished: false
  };

  try {
    await fbPlayerRef(code, state.mpMyId).set(playerRecord);
    // bump activity
    await fbLobbyRef(code).child('lastActivity').set(firebase.database.ServerValue.TIMESTAMP);
  } catch (err) {
    console.error('Could not join lobby', err);
    $('mp-join-status').textContent = fbErrorText(err);
    $('mp-join-status').className = 'status-line error';
    state.mpCode = null;
    return;
  }

  // Auto-cleanup on disconnect.
  // Initial setup: in waiting room, just remove the player record.
  // Once the round starts, this gets reconfigured (see updateDisconnectAction)
  // so a student who drops mid-drill is preserved as finished+disconnected.
  fbPlayerRef(code, state.mpMyId).onDisconnect().remove();

  $('mp-join-status').textContent = 'CONNECTED · IN LOBBY';
  $('mp-join-status').className = 'status-line connected';

  showScreen('screen-mp-lobby');
  subscribeLobby(code);
}

/**
 * Reconfigure what Firebase does to this player's record on disconnect,
 * based on the current round status.
 *
 * - In the lobby: remove the player record entirely (clean exit).
 * - During the round: keep their record but mark them finished + disconnected,
 *   freezing whatever score they had at the moment they dropped. Means a
 *   student whose phone dies still appears in the debrief with their last
 *   known totals, and the all-done check fires correctly.
 *
 * Called from the lobby subscribe handler whenever status changes.
 */
function updateDisconnectAction(status) {
  if (state.mpRole !== 'guest' || !state.mpCode || !state.mpMyId) return;
  const ref = fbPlayerRef(state.mpCode, state.mpMyId);
  // Cancel any prior onDisconnect registration before setting a new one
  ref.onDisconnect().cancel().catch(() => {});
  if (status === 'playing') {
    // Mid-round drop → preserve their score, mark them done
    ref.onDisconnect().update({
      finished: true,
      disconnected: true
    }).catch(err => console.error('onDisconnect update setup failed', err));
  } else {
    // In lobby or post-round → just remove the record
    ref.onDisconnect().remove().catch(err => console.error('onDisconnect remove setup failed', err));
  }
}

/* ---------- SHARED: subscribe to lobby updates ---------- */

function subscribeLobby(code) {
  const ref = fbLobbyRef(code);
  state.mpListenerRef = ref;

  state.mpListener = ref.on('value', (snap) => {
    if (!snap.exists()) {
      // Host left or lobby removed
      if (state.mpRole === 'guest') {
        toast('Host ended the lobby');
        teardownMp();
        showScreen('screen-home', false);
      }
      return;
    }
    const lobby = snap.val();
    state.mpMode = lobby.mode || 'ffa';
    state.mpDeckCount = lobby.deckCount || 25;
    state.mpDifficulty = lobby.difficulty || 'normal';
    state.mpLobbyType = lobby.lobbyType || 'multiplayer';
    state.mpRoundStartedAt = lobby.roundStartedAt || null;
    state.mpRoundEndedAt = lobby.roundEndedAt || null;
    // Detect a change to the decision timer so we can react mid-card.
    // - Going from OFF → N seconds: start a fresh countdown right now for the
    //   player's current card, not at the next one. Gives instructors live
    //   control over pace without waiting for cards to advance.
    // - Going from N → 0: stop any running timer immediately. Player keeps
    //   their card with no time pressure.
    // - Changing N → M (both nonzero): reset to a fresh M-second countdown
    //   so the new value takes effect immediately.
    const prevTimerSec = state.decisionTimerSec || 0;
    const nextTimerSec = lobby.decisionTimerSec || 0;
    state.decisionTimerSec = nextTimerSec;
    if (prevTimerSec !== nextTimerSec) {
      handleDecisionTimerChange(nextTimerSec);
    }
    // Cache the current/last deck so the misses-review screen can look up cards.
    // Firebase Realtime Database stores arrays but may return them as objects
    // with numeric string keys depending on sparseness / how they were written.
    // Normalize to a plain array so downstream code (Array.isArray checks,
    // .length, indexed access) works consistently in both lobbyTypes.
    const rawDeck = lobby.deck;
    let normalizedDeck = null;
    if (Array.isArray(rawDeck) && rawDeck.length > 0) {
      normalizedDeck = rawDeck;
    } else if (rawDeck && typeof rawDeck === 'object') {
      // Convert {0:..., 1:..., 2:...} → [..., ..., ...] sorted by numeric key
      const keys = Object.keys(rawDeck).filter(k => /^\d+$/.test(k)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      if (keys.length > 0) {
        normalizedDeck = keys.map(k => rawDeck[k]);
      }
    }
    if (normalizedDeck && normalizedDeck.length > 0) {
      state.mpDeck = normalizedDeck;
    }

    // Convert players object → ordered array. Track isInstructor.
    const players = lobby.players ? Object.entries(lobby.players).map(([id, p]) => ({
      id, name: p.name, team: p.team, isHost: !!p.isHost,
      isInstructor: !!p.isInstructor,
      correct: p.correct || 0, wrong: p.wrong || 0,
      totalTime: p.totalTime || 0, progress: p.progress || 0,
      finished: !!p.finished,
      disconnected: !!p.disconnected,
      wins: p.wins || 0,
      misses: p.misses ? Object.values(p.misses) : []
    })) : [];
    players.sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    state.mpPlayers = players;

    // INSTRUCTOR PATH: Don't start a game; flip to dashboard or debrief.
    if (state.mpRole === 'instructor') {
      if (lobby.status === 'playing') {
        // Show dashboard if not already
        if (state.currentScreen !== 'screen-cls-dashboard') {
          showScreen('screen-cls-dashboard');
        }
        scheduleDashboardRender();

        // SAFETY NET: If all real players (excluding instructor) are finished,
        // flip the round to 'ended'. The player-side trigger can fail at scale
        // because of stale snapshot races; the instructor sees fresh data and
        // is never racing their own write. This guarantees the debrief shows.
        const realPlayers = (state.mpPlayers || []).filter(p => !p.isInstructor);
        if (realPlayers.length > 0 && realPlayers.every(p => p.finished)) {
          fbLobbyRef(state.mpCode).update({
            status: 'ended',
            roundEndedAt: firebase.database.ServerValue.TIMESTAMP
          }).catch(err => console.error('Auto-end failed', err));
        }
      } else if (lobby.status === 'ended') {
        if (state.currentScreen !== 'screen-cls-debrief') {
          showScreen('screen-cls-debrief');
        }
        renderDebrief();
      } else if (lobby.status === 'lobby') {
        if (state.currentScreen === 'screen-cls-dashboard' || state.currentScreen === 'screen-cls-debrief') {
          showScreen('screen-mp-lobby', false);
        }
        if (state.currentScreen === 'screen-mp-lobby') renderLobby();
      }
      return; // Skip the player-side game-start logic entirely
    }

    // GAME START: status flipped to playing and we have a deck (players only)
    // Use the normalized deck above — Firebase may serialize arrays as objects.
    const deckReady = normalizedDeck && normalizedDeck.length > 0;

    // Reconfigure our onDisconnect cleanup based on round status.
    // - In lobby: remove player record on drop.
    // - Playing: preserve record + mark finished+disconnected.
    // Cheap to call repeatedly (Firebase debounces); always idempotent.
    if (state.mpRole === 'guest') {
      updateDisconnectAction(lobby.status);
    }

    if (lobby.status === 'playing' && deckReady && state.game && state.game.mode !== 'mp-host' && state.game.mode !== 'mp-guest') {
      // We're a guest who hasn't started yet
      startGame({ deck: normalizedDeck, mode: 'mp-guest', difficulty: state.mpDifficulty });
    } else if (lobby.status === 'playing' && deckReady && !state.game) {
      // Already routed to lobby, but no game yet — start now
      const myMode = (state.mpRole === 'host') ? 'mp-host' : 'mp-guest';
      startGame({ deck: normalizedDeck, mode: myMode, difficulty: state.mpDifficulty });
    }

    // GAME END: when everyone finished, status becomes 'ended'
    if (lobby.status === 'ended') {
      // Force the results screen if our game is finished but we're still on game
      if (state.currentScreen === 'screen-game' && state.game && state.game.idx >= state.game.deck.length) {
        showMpLeaderboard();
      }
      if (state.currentScreen === 'screen-results') {
        showMpLeaderboard();
      }
    }

    // RESET TO LOBBY: host clicked Play Again. Pull guests back to the lobby
    // screen so they don't have to manually navigate.
    if (lobby.status === 'lobby' && state.mpRole === 'guest') {
      if (state.currentScreen === 'screen-results' || state.currentScreen === 'screen-game') {
        state.game = null;
        showScreen('screen-mp-lobby', false);
        toast('Back to lobby — host wants another round');
      }
    }

    // Re-render UI. Classroom drills skip live-board churn since students
    // never see it. The instructor dashboard is throttled separately
    // (see scheduleDashboardRender) to avoid freezing the browser at 50 players.
    if (state.currentScreen === 'screen-mp-lobby') renderLobby();
    if (state.currentScreen === 'screen-game' && state.mpLobbyType !== 'classroom') renderLiveBoard();
    if (state.currentScreen === 'screen-results') showMpLeaderboard();
    if (state.currentScreen === 'screen-cls-dashboard') scheduleDashboardRender();
    if (state.currentScreen === 'screen-cls-debrief') renderDebrief();
  }, (err) => {
    console.error('Subscribe failed', err);
    toast(fbErrorText(err));
  });
}

/* ---------- HOST: start the game ---------- */

async function hostStartGame() {
  if (state.mpRole !== 'host' && state.mpRole !== 'instructor') return;
  // Need at least 1 actual player (excluding the instructor in classroom mode)
  const realPlayers = state.mpPlayers.filter(p => !p.isInstructor);
  if (realPlayers.length < 1) {
    toast(state.mpRole === 'instructor' ? 'Need at least one player to join first' : 'Need at least one player');
    return;
  }

  const hard   = $('mp-difficulty-hard')?.dataset.active === 'true';
  const expert = $('mp-difficulty-expert')?.dataset.active === 'true';
  const difficulty = combinedDifficulty(hard, expert);
  const deck = buildDeck(state.mpDeckCount, difficulty);

  // Reset all player stats. Instructors stay finished=true so they
  // never block the "everyone done" check.
  const playerUpdates = {};
  state.mpPlayers.forEach(p => {
    playerUpdates[`players/${p.id}/correct`] = 0;
    playerUpdates[`players/${p.id}/wrong`] = 0;
    playerUpdates[`players/${p.id}/totalTime`] = 0;
    playerUpdates[`players/${p.id}/progress`] = 0;
    playerUpdates[`players/${p.id}/finished`] = !!p.isInstructor;
    playerUpdates[`players/${p.id}/misses`] = null;
  });
  playerUpdates.deck = deck;
  playerUpdates.difficulty = difficulty;
  playerUpdates.status = 'playing';
  playerUpdates.roundStartedAt = firebase.database.ServerValue.TIMESTAMP;
  playerUpdates.roundEndedAt = null;
  playerUpdates.lastActivity = firebase.database.ServerValue.TIMESTAMP;

  try {
    await fbLobbyRef(state.mpCode).update(playerUpdates);
  } catch (err) {
    console.error('Host start failed', err);
    toast(fbErrorText(err));
    return;
  }

  // In classroom mode the instructor doesn't play — subscribeLobby will
  // route them to the dashboard once status flips to 'playing'.
  if (state.mpRole === 'instructor') return;

  // Host launches their own game (subscribe will fire and route guests)
  startGame({ deck, mode: 'mp-host', difficulty });
}

/* ---------- Mode + deck-size sync (called by lobby UI handlers) ---------- */

function setMpMode(mode) {
  state.mpMode = mode;
  if (state.mpRole === 'host' && state.mpCode) {
    // Reassign teams if switching into team mode
    const updates = { mode };
    if (mode === 'team') {
      state.mpPlayers.forEach((p, i) => {
        updates[`players/${p.id}/team`] = (i % 2 === 0) ? 'A' : 'B';
      });
    } else {
      state.mpPlayers.forEach(p => {
        updates[`players/${p.id}/team`] = null;
      });
    }
    fbLobbyRef(state.mpCode).update(updates).catch(err => {
      console.error('Mode update failed', err);
      toast(fbErrorText(err));
    });
  }
}

function setMpDeckCount(n) {
  state.mpDeckCount = n;
  if (state.mpRole === 'host' && state.mpCode) {
    fbLobbyRef(state.mpCode).update({ deckCount: n }).catch(err => {
      console.error('Deck count update failed', err);
    });
  }
}

function setMpDifficulty(d) {
  state.mpDifficulty = d;
  if (state.mpRole === 'host' && state.mpCode) {
    fbLobbyRef(state.mpCode).update({ difficulty: d }).catch(err => {
      console.error('Difficulty update failed', err);
    });
  }
}

/* ---------- LOBBY UI render (shared) ---------- */

function renderLobby() {
  $('lobby-code-v').textContent = state.mpCode || '----';
  const isClassroom = state.mpLobbyType === 'classroom';

  // Build the player-list HTML.
  // - In multiplayer, everyone is shown as themselves.
  // - In classroom, players see "DISPATCH" in place of the instructor's name
  //   so they can't tell who is running the drill.
  // - The instructor sees the actual list including themselves (with "INSTRUCTOR" role).
  const html = state.mpPlayers.map(p => {
    const teamTxt = p.team ? `· TEAM ${p.team}` : '';
    let displayName = p.name;
    let roleLabel;
    let rowClass = '';
    if (p.isInstructor) {
      // Hide instructor identity from regular players
      if (state.mpRole !== 'instructor') displayName = 'DISPATCH';
      roleLabel = 'INSTRUCTOR';
      rowClass = 'instructor';
    } else {
      roleLabel = p.isHost ? 'HOST' : 'PLAYER';
      if (p.isHost) rowClass = 'host';
    }
    return `<div class="player-row ${rowClass}">
      <span class="ind"></span>
      <span>${escapeHtml(displayName)}</span>
      <span class="role">${roleLabel} ${teamTxt}</span>
    </div>`;
  }).join('');
  $('player-list-body').innerHTML = html || '<div style="color:var(--text-mute);font-family:var(--mono);font-size:0.8rem;text-align:center;padding:8px">NO PLAYERS YET</div>';

  // Show host controls for host OR instructor (instructor uses same setup UI)
  const showControls = (state.mpRole === 'host' || state.mpRole === 'instructor');
  $('host-controls').style.display = showControls ? 'block' : 'none';
  $('guest-wait').style.display = (state.mpRole === 'guest') ? 'block' : 'none';
  // Update Start button label for classroom
  const startBtn = $('mp-start');
  if (startBtn) {
    startBtn.textContent = (state.mpRole === 'instructor')
      ? 'START DRILL · LAUNCH DASHBOARD →'
      : 'START GAME →';
  }
  // Show difficulty warnings to guests so they're not surprised.
  const diff = splitDifficulty(state.mpDifficulty);
  $('guest-hard-indicator').style.display   = (state.mpRole === 'guest' && diff.hard)   ? 'block' : 'none';
  $('guest-expert-indicator').style.display = (state.mpRole === 'guest' && diff.expert) ? 'block' : 'none';

  // Sync deck-size selection
  qsa('#mp-deck-options .option').forEach(o => {
    o.classList.toggle('selected', parseInt(o.dataset.count, 10) === state.mpDeckCount);
  });
  // Sync mode toggle
  qsa('.team-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === state.mpMode);
  });
  // Sync host's difficulty buttons to lobby state
  const diffHard = $('mp-difficulty-hard');
  const diffExpert = $('mp-difficulty-expert');
  if (diffHard) {
    diffHard.dataset.active = diff.hard ? 'true' : 'false';
    diffHard.classList.toggle('active', diff.hard);
  }
  if (diffExpert) {
    diffExpert.dataset.active = diff.expert ? 'true' : 'false';
    diffExpert.classList.toggle('active', diff.expert);
  }
}

/* ============================================================
   8. GAME MODE
   ============================================================
   Time-bounded MCI scene. Multiple patients live on the board
   at once. Each one drains a stability bar in real time:
     - Yellows that drain past becomesAt deteriorate to RED
       (vitals + correct answer both update, "DETERIORATED" badge
        appears on the card).
     - Reds (and deteriorated yellows) that drain past expiresAt
       are removed as deceased — score takes the -15 hit and the
       loss is recorded for the AAR.
     - Greens and Blacks are stable (no deterioration).
   New patients spawn on a fixed interval up to a max scene size,
   so the scene grows if you fall behind. Game ends at the timer
   or when the player taps END DRILL EARLY. AAR shows top
   mistakes with timestamps in the order they happened.
   ============================================================ */

// Per-category drain configuration — drives both the stability
// bar's color and the deterioration timing. Tuned so a 3-min
// drill feels pressured but winnable.
const GM_DETERIORATION = {
  green:  { drainMs: 999999, becomesAt: null,    expiresAt: null    }, // stable
  yellow: { drainMs: 30000,  becomesAt: 30000,   expiresAt: 50000   }, // → red at 30s; never reaches expiresAt as yellow (becomesAt fires first), kept for safety
  red:    { drainMs: 35000,  becomesAt: null,    expiresAt: 35000   }, // dead at 35s
  black:  { drainMs: 999999, becomesAt: null,    expiresAt: null    }, // already gone, no change
};

// Spawn cadence is randomized 1-10s between arrivals. The variance
// matters: it produces real waves (a 10s lull, then a 1s burst that
// floods the scene), which feels more like actual rescue-progress
// pacing than a metronome. Average is ~5.5s, similar to the old
// fixed value — the chaos is the point.
const GM_SPAWN_MIN_MS = 1000;
const GM_SPAWN_MAX_MS = 10000;
const GM_MAX_SCENE = 5;       // max patients on the board at once
const GM_INITIAL_SCENE = 3;   // patients spawned at game start
const GM_TICK_MS = 250;       // how often we update stability bars
const GM_SPEED_BONUS_MS = 12000; // tag within this window for +5 bonus (achievable for a practiced player)
const GM_SPEED_BONUS = 5;
const GM_SCORE = { red: 10, yellow: 5, green: 5, black: 5, wrong: -10, lost: -15 };

const gm = {
  active: false,
  startTime: 0,
  endTime: 0,
  durationMs: 180000,
  difficulty: 'normal',
  patients: [],          // [{id, scenario, addedAt, currentAnswer, originalAnswer, deteriorated}]
  history: [],           // every event for AAR: {type, scenario, picked, score, atMs, originalAnswer}
  score: 0,
  triagedCount: 0,
  lostCount: 0,
  saveCount: 0,
  inboundCount: 0,       // patients spawned but not yet on screen (visual cue only)
  tickHandle: null,
  spawnHandle: null,
  endHandle: null,
  patientSeq: 0,
};

function gmReset() {
  gm.active = false;
  gm.startTime = 0;
  gm.endTime = 0;
  gm.patients = [];
  gm.history = [];
  gm.score = 0;
  gm.triagedCount = 0;
  gm.lostCount = 0;
  gm.saveCount = 0;
  gm.inboundCount = 0;
  if (gm.tickHandle)  { clearInterval(gm.tickHandle);  gm.tickHandle = null; }
  // spawnHandle is a setTimeout, not setInterval, so use clearTimeout
  if (gm.spawnHandle) { clearTimeout(gm.spawnHandle);  gm.spawnHandle = null; }
  if (gm.endHandle)   { clearTimeout(gm.endHandle);    gm.endHandle = null; }
}

// Recursively schedule the next spawn. Each scheduling picks its
// own random delay in [GM_SPAWN_MIN_MS, GM_SPAWN_MAX_MS], so the
// cadence is non-uniform — sometimes a quick burst, sometimes a lull.
function gmScheduleNextSpawn() {
  if (!gm.active) return;
  const delay = GM_SPAWN_MIN_MS + Math.floor(Math.random() * (GM_SPAWN_MAX_MS - GM_SPAWN_MIN_MS + 1));
  gm.spawnHandle = setTimeout(() => {
    gmSpawnPatient();
    gmScheduleNextSpawn();
  }, delay);
}

// One patient = one freshly-generated scenario plus runtime state.
// Uses generatePatient (weighted random) instead of generateDeck(1, ...)
// because the deck builder's largest-remainder math is degenerate at
// count=1 — it would always return the highest-weight category (green).
//
// visibleWindow is the bar's drain duration — RANDOMIZED 30-40 s per
// patient regardless of category so the bar can't be reverse-engineered
// to identify a tag. The actual deterioration math (becomesAt, expiresAt)
// is unaffected and runs from cfg, not from the bar.
function gmMakePatient() {
  const scenario = (window.generatePatient
    ? window.generatePatient(gm.difficulty)
    : window.generateDeck(1, gm.difficulty)[0]);
  return {
    id: 'gp_' + (gm.patientSeq++),
    scenario,
    addedAt: Date.now(),
    originalAnswer: scenario.answer,
    currentAnswer: scenario.answer,
    deteriorated: false,
    visibleWindow: 30000 + Math.floor(Math.random() * 10000),
  };
}

function gmSpawnPatient() {
  if (!gm.active) return;
  if (gm.patients.length >= GM_MAX_SCENE) return;
  const p = gmMakePatient();
  gm.patients.push(p);
  gmRenderPatient(p, true);
  gmUpdateHud();
}

function gmStartGame() {
  gmReset();
  gm.active = true;
  gm.startTime = Date.now();
  gm.endTime = gm.startTime + gm.durationMs;
  // Difficulty pulled from the GM setup toggles
  const hard = $('gm-difficulty-hard')?.dataset.active === 'true';
  const expert = $('gm-difficulty-expert')?.dataset.active === 'true';
  gm.difficulty = combinedDifficulty(hard, expert);

  $('gm-scene').innerHTML = '';
  $('gm-empty').style.display = 'none';
  showScreen('screen-gm-play');

  // Seed the scene
  for (let i = 0; i < GM_INITIAL_SCENE; i++) gmSpawnPatient();

  gmScheduleNextSpawn();
  gm.tickHandle  = setInterval(gmTick, GM_TICK_MS);
  gm.endHandle   = setTimeout(gmEndGame, gm.durationMs);

  gmUpdateHud();
}

// Tick: update stability bars, deteriorate yellows past threshold,
// expire reds past threshold. Cheap — runs every 250ms.
function gmTick() {
  if (!gm.active) return;
  const now = Date.now();
  // Iterate a copy so we can mutate gm.patients during the loop
  for (const p of gm.patients.slice()) {
    const cfg = GM_DETERIORATION[p.currentAnswer] || GM_DETERIORATION.yellow;
    const elapsed = now - p.addedAt;
    // Has the patient deteriorated past the "becomes" threshold? (yellow → red only)
    if (cfg.becomesAt && !p.deteriorated && elapsed >= cfg.becomesAt) {
      gmDeteriorate(p);
      // Reset the elapsed clock so the now-RED patient gets its own death timer
      p.addedAt = now;
      continue;
    }
    // Has the patient expired? (red → black, removed)
    if (cfg.expiresAt && elapsed >= cfg.expiresAt) {
      gmExpirePatient(p);
      continue;
    }
    // Just update the bar
    gmUpdateStability(p, elapsed, cfg);
  }
  gmUpdateHudTimer();
  // End of game?
  if (now >= gm.endTime) {
    gmEndGame();
  }
}

// Move a yellow patient into "now red" — update vitals to a
// borderline RED set, swap correct answer, badge the card.
function gmDeteriorate(p) {
  p.deteriorated = true;
  p.currentAnswer = 'red';
  // Replace vitals with a borderline-RED set so the player has
  // a chance to read the new state before the patient dies.
  p.scenario.respirations = `${32 + Math.floor(Math.random()*5)}/min, labored`;
  p.scenario.perfusion    = 'Pulse weak';
  p.scenario.mental       = 'Drowsy; cannot follow simple commands';
  // Re-randomize the visible bar window so the new red doesn't
  // inherit any pattern the player might have learned to associate
  // with the yellow phase.
  p.visibleWindow = 30000 + Math.floor(Math.random() * 10000);
  // Re-render the patient card in place
  const el = document.querySelector(`.gm-patient[data-id="${p.id}"]`);
  if (el) {
    el.classList.add('deteriorated');
    const v = el.querySelector('.gm-vitals');
    if (v) v.innerHTML = gmVitalsHtml(p.scenario);
  }
}

// Patient died on the player's watch. Record loss + remove card.
function gmExpirePatient(p) {
  if (p.currentAnswer === 'black') {
    // Black patients shouldn't expire — but if they do, just remove
    gmRemovePatient(p, 'expired');
    return;
  }
  gm.score += GM_SCORE.lost;
  gm.lostCount += 1;
  gm.history.push({
    type: 'lost',
    scenario: p.scenario,
    originalAnswer: p.originalAnswer,
    finalAnswer: p.currentAnswer,
    atMs: Date.now() - gm.startTime,
    score: GM_SCORE.lost,
  });
  // Brief "DECEASED" pop on the card before removal
  gmFlashCard(p, 'bad');
  gmShowPopup(p, '−15 LOST', 'minus');
  gmRemovePatient(p, 'expired');
  gmUpdateHud();
}

function gmRemovePatient(p, reason) {
  const idx = gm.patients.indexOf(p);
  if (idx >= 0) gm.patients.splice(idx, 1);
  const el = document.querySelector(`.gm-patient[data-id="${p.id}"]`);
  if (el) {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }
  gmRefreshEmptyState();
}

// Player tapped a triage color on a patient card
function gmTagPatient(id, picked) {
  if (!gm.active) return;
  const p = gm.patients.find(x => x.id === id);
  if (!p) return;
  const correct = (picked === p.currentAnswer);
  const elapsed = Date.now() - p.addedAt;
  let delta = 0;
  if (correct) {
    delta = GM_SCORE[picked] || 5;
    if (elapsed <= GM_SPEED_BONUS_MS) delta += GM_SPEED_BONUS;
    gm.saveCount += 1;
    gmFlashCard(p, 'ok');
    gmShowPopup(p, `+${delta}`, 'plus');
  } else {
    delta = GM_SCORE.wrong;
    gmFlashCard(p, 'bad');
    gmShowPopup(p, `${delta}`, 'minus');
  }
  gm.score += delta;
  gm.triagedCount += 1;
  gm.history.push({
    type: correct ? 'correct' : 'wrong',
    scenario: p.scenario,
    originalAnswer: p.originalAnswer,
    finalAnswer: p.currentAnswer,
    picked,
    atMs: Date.now() - gm.startTime,
    elapsedMs: elapsed,
    score: delta,
  });
  gmRemovePatient(p, 'tagged');
  gmUpdateHud();
}

// --- Render helpers ---

function gmVitalsHtml(s) {
  return `<span class="gm-v"><b>R</b>${escapeHtml(s.respirations)}</span>
          <span class="gm-v"><b>P</b>${escapeHtml(s.perfusion)}</span>
          <span class="gm-v"><b>M</b>${escapeHtml(s.mental)}</span>`;
}

function gmRenderPatient(p, isNew) {
  const sceneEl = $('gm-scene');
  if (!sceneEl) return;
  const el = document.createElement('div');
  el.className = 'gm-patient';
  el.dataset.id = p.id;
  el.innerHTML = `
    <div class="gm-stability"><div class="gm-stability-fill"></div></div>
    <div class="gm-narrative">${escapeHtml(p.scenario.description)}</div>
    <div class="gm-vitals">${gmVitalsHtml(p.scenario)}</div>
    <div class="gm-tagrow">
      <button class="gm-tag red"    data-tag="red">RED</button>
      <button class="gm-tag yellow" data-tag="yellow">YELLOW</button>
      <button class="gm-tag green"  data-tag="green">GREEN</button>
      <button class="gm-tag black"  data-tag="black">BLACK</button>
    </div>
  `;
  sceneEl.appendChild(el);
  gmRefreshEmptyState();
}

function gmUpdateStability(p, elapsed, cfg) {
  const el = document.querySelector(`.gm-patient[data-id="${p.id}"]`);
  if (!el) return;
  const fill = el.querySelector('.gm-stability-fill');
  if (!fill) return;
  // Bar drains over the patient's visibleWindow — same UI rate for
  // every category. The actual deterioration math runs separately
  // off cfg.becomesAt / cfg.expiresAt, so this disconnect is the
  // entire point: the bar must not telegraph the correct tag.
  const pct = Math.max(0, 100 * (1 - elapsed / p.visibleWindow));
  fill.style.width = pct + '%';
  // Threshold-based class flips for color + glow
  el.classList.toggle('warning',  pct > 0   && pct <= 60);
  el.classList.toggle('critical', pct > 0   && pct <= 25);
}

function gmRefreshEmptyState() {
  const empty = $('gm-empty');
  const scene = $('gm-scene');
  if (!empty || !scene) return;
  empty.style.display = (gm.patients.length === 0 && gm.active) ? 'flex' : 'none';
}

function gmFlashCard(p, kind) {
  const el = document.querySelector(`.gm-patient[data-id="${p.id}"]`);
  if (!el) return;
  el.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-bad');
  setTimeout(() => el.classList.remove('flash-ok', 'flash-bad'), 500);
}

function gmShowPopup(p, text, kind) {
  const el = document.querySelector(`.gm-patient[data-id="${p.id}"]`);
  if (!el) return;
  const pop = document.createElement('div');
  pop.className = 'gm-popup ' + (kind || 'plus');
  pop.textContent = text;
  el.appendChild(pop);
  setTimeout(() => pop.remove(), 900);
}

function gmUpdateHud() {
  const el = (id) => document.getElementById(id);
  if (el('gm-score'))   el('gm-score').textContent   = gm.score;
  if (el('gm-triaged')) el('gm-triaged').textContent = gm.triagedCount;
  if (el('gm-lost'))    el('gm-lost').textContent    = gm.lostCount;
  if (el('gm-inbound')) el('gm-inbound').textContent = Math.max(0, gm.patients.length);
  // Mark the lost cell red when there are deaths
  const lostCell = el('gm-lost')?.parentElement;
  if (lostCell) lostCell.classList.toggle('warn', gm.lostCount > 0);
}

function gmUpdateHudTimer() {
  const remainingMs = Math.max(0, gm.endTime - Date.now());
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const el = document.getElementById('gm-timer');
  if (el) {
    el.textContent = `${m}:${String(s).padStart(2,'0')}`;
    const cell = el.parentElement;
    if (cell) cell.classList.toggle('urgent', totalSec <= 15);
  }
}

// --- End of game + AAR ---

function gmEndGame() {
  if (!gm.active) return;
  gm.active = false;
  if (gm.tickHandle)  { clearInterval(gm.tickHandle);  gm.tickHandle = null; }
  if (gm.spawnHandle) { clearTimeout(gm.spawnHandle);  gm.spawnHandle = null; }
  if (gm.endHandle)   { clearTimeout(gm.endHandle);    gm.endHandle = null; }
  gmRenderResults();
  showScreen('screen-gm-results');
}

function gmRenderResults() {
  const elapsedSec = Math.round((Date.now() - gm.startTime) / 1000);
  const totalDecisions = gm.triagedCount + gm.lostCount;
  const acc = totalDecisions > 0 ? Math.round((gm.saveCount / totalDecisions) * 100) : 0;

  // Grade scale tuned for game mode: emphasizes lives saved over raw points
  let grade = 'F';
  if (gm.score >= 120 && gm.lostCount === 0) grade = 'S';
  else if (gm.score >= 90 && acc >= 90)  grade = 'A';
  else if (gm.score >= 60 && acc >= 80)  grade = 'B';
  else if (gm.score >= 30 && acc >= 65)  grade = 'C';
  else if (gm.score >= 0)                grade = 'D';
  // else stays F

  const ranks = {
    S: 'TRIAGE COMMANDER',
    A: 'SCENE COMMANDER',
    B: 'TRIAGE OFFICER',
    C: 'COMPETENT RESPONDER',
    D: 'NEEDS DRILL',
    F: 'RETURN TO TRAINING',
  };

  $('gm-grade').textContent = grade;
  $('gm-grade').className = 'grade-badge g-' + (grade === 'S' ? 'A' : grade);
  $('gm-rank').textContent = ranks[grade];
  $('gm-final-score').textContent = gm.score;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  $('gm-final-line').textContent = `${m}:${String(s).padStart(2,'0')} elapsed · ${gm.triagedCount} triaged · ${gm.saveCount} saved`;
  $('gm-acc').textContent = acc + '%';
  $('gm-saved').textContent = gm.saveCount;
  $('gm-deaths').textContent = gm.lostCount;

  // Reuse the per-grade quip system
  const roastEl = $('gm-roast');
  if (roastEl) {
    const pool = GRADE_QUIPS[grade];
    if (pool && pool.length) {
      roastEl.textContent = pool[Math.floor(Math.random() * pool.length)];
      roastEl.className = 'result-roast grade-' + grade;
      roastEl.style.display = '';
    } else {
      roastEl.style.display = 'none';
    }
  }

  // Debrief: top 3 mistakes by impact (lost > wrong over-triage > wrong under-triage)
  // Score order: lost (-15) is worst, then any wrong tag (-10).
  const mistakes = gm.history.filter(h => h.type === 'lost' || h.type === 'wrong');
  // Sort by score impact (most negative first), then by time
  mistakes.sort((a, b) => a.score - b.score || a.atMs - b.atMs);
  const top = mistakes.slice(0, 3);

  const debriefEl = $('gm-debrief');
  if (top.length === 0) {
    debriefEl.innerHTML = `<div class="gm-debrief-empty">No mistakes to debrief. Clean run.</div>`;
  } else {
    debriefEl.innerHTML = top.map(m => {
      const tm = m.atMs;
      const ts = `${Math.floor(tm/60000)}:${String(Math.floor(tm/1000)%60).padStart(2,'0')}`;
      if (m.type === 'lost') {
        const tagOriginal = TRIAGE_INFO[m.originalAnswer]?.short || m.originalAnswer.toUpperCase();
        return `<div class="gm-debrief-card lost">
          <div class="gm-debrief-head">DECEASED ON YOUR WATCH · ${ts}</div>
          <div class="gm-debrief-body">${escapeHtml(m.scenario.description)}</div>
          <div class="gm-debrief-meta">Should have been tagged ${tagOriginal}. Left to deteriorate. ${m.score} pts.</div>
        </div>`;
      }
      // Wrong tag — over- or under-triage?
      const order = { red: 4, yellow: 3, green: 2, black: 1 };
      const overOrUnder = (order[m.picked] > order[m.finalAnswer]) ? 'over' : 'under';
      const correctTag = TRIAGE_INFO[m.finalAnswer]?.short || m.finalAnswer.toUpperCase();
      const pickedTag  = TRIAGE_INFO[m.picked]?.short      || m.picked.toUpperCase();
      const label = overOrUnder === 'over' ? 'OVER-TRIAGED' : 'UNDER-TRIAGED';
      return `<div class="gm-debrief-card ${overOrUnder}">
        <div class="gm-debrief-head">${label} · ${ts}</div>
        <div class="gm-debrief-body">${escapeHtml(m.scenario.description)}</div>
        <div class="gm-debrief-meta">You picked ${pickedTag}. Correct was ${correctTag}. ${m.score} pts.</div>
      </div>`;
    }).join('');
  }
}

// --- Setup-screen wiring (registered on DOMContentLoaded below) ---

function gmInitWiring() {
  // Length picker
  qsa('#gm-length-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#gm-length-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      gm.durationMs = parseInt(opt.dataset.length, 10) * 1000;
    });
  });

  // Hard / Expert toggles
  ['gm-difficulty-hard', 'gm-difficulty-expert'].forEach(id => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = btn.dataset.active !== 'true';
      btn.dataset.active = next ? 'true' : 'false';
      btn.classList.toggle('active', next);
    });
  });

  // Start
  $('gm-start')?.addEventListener('click', gmStartGame);

  // End early
  $('gm-end-early')?.addEventListener('click', () => {
    if (!gm.active) return;
    if (confirm('End the drill now?')) gmEndGame();
  });

  // Replay / home from results
  $('gm-replay')?.addEventListener('click', () => showScreen('screen-gm-setup'));
  $('gm-home')?.addEventListener('click', () => showScreen('screen-home'));

  // Per-card triage taps via event delegation on the scene container
  $('gm-scene')?.addEventListener('click', (e) => {
    const tagBtn = e.target.closest('.gm-tag');
    if (!tagBtn) return;
    const card = tagBtn.closest('.gm-patient');
    if (!card) return;
    gmTagPatient(card.dataset.id, tagBtn.dataset.tag);
  });

  // Initialize default duration from the selected option
  const sel = document.querySelector('#gm-length-options .option.selected');
  if (sel) gm.durationMs = parseInt(sel.dataset.length, 10) * 1000;
}

// Hook into DOMContentLoaded — same pattern as the other modes use
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', gmInitWiring);
} else {
  gmInitWiring();
}

// Apply feature flags. Anything tagged data-feature="X" gets hidden
// when feature X is disabled. Cheap, declarative, easy to extend.
function applyFeatureFlags() {
  if (!FEATURE_MULTIPLAYER_ENABLED) {
    qsa('[data-feature="multiplayer"]').forEach(el => { el.style.display = 'none'; });
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyFeatureFlags);
} else {
  applyFeatureFlags();
}
