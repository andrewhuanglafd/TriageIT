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
  spBound: 'cards',        // 'cards' | 'time' — solo Training round termination
  spLengthSec: 180,        // when spBound === 'time', round length in seconds

  // Multiplayer (Firebase Realtime DB)
  mpName: '',
  mpRole: null,           // 'host' | 'guest' | 'instructor'
  mpCode: null,
  mpMode: 'ffa',          // 'ffa' | 'team'
  mpDeckCount: 25,
  mpDifficulty: 'normal', // 'normal' | 'hard' | 'expert' | 'hard-expert'
  mpGameType: 'training', // 'training' | 'hard' | 'expert' | 'chaos' | 'fog'
  mpGameLengthSec: 180,   // For game-mode types (Hard/Expert/Chaos/Fog)
  mpGameBound: 'time',    // 'time' | 'cards' — round termination type for game-mode classroom
  mpGameCardLimit: 25,    // When mpGameBound === 'cards', end after this many tags
  mpTrainingBound: 'cards', // 'cards' | 'time' — round termination type for classroom Training
  mpTrainingLengthSec: 180, // When mpTrainingBound === 'time', round length in seconds
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

// Map a screen id to its tactical mode label for the topbar's
// "MODE 0X · NAME" sub-line. Returns null on the home screen so the
// brand falls back to its static tagline. The label is monochrome
// and uses the same accent color as the rest of the system —
// differentiation comes from text content + the menu glyphs, not
// from per-mode color tinting (which would compete with the
// triage palette).
function modeLabel(screenId) {
  if (screenId === 'screen-how') return '▦ FIELD MANUAL';
  if (screenId.startsWith('screen-gm-')) {
    const subBadge = ({ hard: '⚠ HARD', expert: '☠ EXPERT', chaos: '⚡ CHAOS', fog: '◐ FOG OF WAR' })[gm.subMode];
    return subBadge ? `⌖ DIFFICULTY · ${subBadge}` : '⌖ MODE 02 · GAME MODE';
  }
  if (screenId.startsWith('screen-cls-')) return '◉ MODE 04 · CLASSROOM';
  if (screenId.startsWith('screen-mp-')) {
    // Classroom: include the picked difficulty when available so the
    // host sees their choice reflected in the topbar.
    if (state.mpLobbyType === 'classroom') {
      const gtBadge = ({ training: '▤ TRAINING', hard: '⚠ HARD', expert: '☠ EXPERT', chaos: '⚡ CHAOS', fog: '◐ FOG OF WAR' })[state.mpGameType];
      return gtBadge ? `◉ CLASSROOM · ${gtBadge}` : '◉ MODE 04 · CLASSROOM';
    }
    return '◈ MODE 03 · MULTIPLAYER';
  }
  if (screenId === 'screen-sp-setup') return '▤ MODE 01 · TRAINING';
  // The shared screens (game / results / review / expert-fail) need
  // to know which mode the player is in to pick a label.
  if (screenId === 'screen-game' || screenId === 'screen-results'
      || screenId === 'screen-expert-fail' || screenId === 'screen-review') {
    if (state.game) {
      if (state.game.mode === 'solo') return '▤ MODE 01 · TRAINING';
      if (state.game.mode === 'mp-host' || state.game.mode === 'mp-guest') {
        return state.mpLobbyType === 'classroom'
          ? '◉ MODE 04 · CLASSROOM'
          : '◈ MODE 03 · MULTIPLAYER';
      }
    }
  }
  return null;
}

// Re-paint the topbar's mode sub-line from the current screen + state.
// Safe to call any time — used both on screen change and on in-screen
// state changes (e.g. picking a difficulty in Game Mode setup).
function refreshTopbar() {
  const subEl = $('brand-sub');
  if (!subEl) return;
  const label = modeLabel(state.currentScreen);
  subEl.textContent = label || 'START · MCI TRAINING';
}

function showScreen(id, pushHistory = true) {
  qsa('.screen').forEach(el => el.classList.remove('active'));
  $(id).classList.add('active');

  if (pushHistory && state.currentScreen !== id) {
    state.history.push(id);
  }
  state.currentScreen = id;

  // Home button visibility — shows on every screen except home itself
  $('home-btn').style.display = (id === 'screen-home') ? 'none' : 'inline-block';

  // Topbar mode tag — context-aware label that signals which mode
  // the user is currently inside. Falls back to the static brand
  // tagline on the home screen.
  refreshTopbar();

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
  if (id === 'screen-gm-setup') gmSyncSetupScreen();
  if (id === 'screen-sp-setup') spSyncSetupScreen();
}

// Re-sync the Game Mode setup screen's visual state to gm.bound /
// gm.subMode. Called every time the screen is shown so leftover state
// from a prior run doesn't desync the picker against the engine.
// Also clears the difficulty pick so the user makes a fresh choice.
function gmSyncSetupScreen() {
  // Bound toggle: highlight whichever button matches gm.bound
  qsa('#gm-bound-toggle button').forEach(b => {
    const on = (b.dataset.bound === gm.bound);
    b.classList.toggle('active', on);
  });
  const lenWrap = $('gm-length-wrap');
  const cardWrap = $('gm-cards-wrap');
  if (gm.bound === 'cards') {
    if (lenWrap)  lenWrap.style.display  = 'none';
    if (cardWrap) cardWrap.style.display = '';
  } else {
    if (lenWrap)  lenWrap.style.display  = '';
    if (cardWrap) cardWrap.style.display = 'none';
  }
  // Length / cardLimit pickers: ensure the currently selected option
  // matches the live engine state (carries over between runs).
  qsa('#gm-length-options .option').forEach(o => {
    o.classList.toggle('selected', parseInt(o.dataset.length, 10) * 1000 === gm.durationMs);
  });
  qsa('#gm-cards-options .option').forEach(o => {
    o.classList.toggle('selected', parseInt(o.dataset.count, 10) === gm.cardLimit);
  });
  // Difficulty: clear so the user picks fresh — chaos/fog buttons must
  // be tapped explicitly to set gm.subMode. The breadcrumb falls back
  // to "MODE 02 · GAME MODE" until they do.
  ['gm-mode-chaos', 'gm-mode-fog'].forEach(id => {
    const b = $(id);
    if (!b) return;
    b.dataset.active = 'false';
    b.classList.remove('active');
  });
  gm.subMode = null;
  const descEl = $('gm-mode-desc-line');
  if (descEl) descEl.textContent = 'Pick a difficulty to see what it tests.';
  refreshTopbar();
}

// Same idea for solo Training setup — sync the bound toggle + wraps to
// state.spBound and ensure the selected option matches state.
function spSyncSetupScreen() {
  qsa('#sp-bound-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.bound === state.spBound);
  });
  const deckWrap = $('sp-deck-wrap');
  const timeWrap = $('sp-time-wrap');
  if (state.spBound === 'time') {
    if (deckWrap) deckWrap.style.display = 'none';
    if (timeWrap) timeWrap.style.display = '';
  } else {
    if (deckWrap) deckWrap.style.display = '';
    if (timeWrap) timeWrap.style.display = 'none';
  }
  qsa('#sp-time-options .option').forEach(o => {
    o.classList.toggle('selected', parseInt(o.dataset.length, 10) === state.spLengthSec);
  });
  qsa('#sp-deck-options .option').forEach(o => {
    o.classList.toggle('selected', parseInt(o.dataset.count, 10) === state.spDeckCount);
  });
}

// Navigate straight back to the home menu from any screen, tearing
// down any in-progress drill, lobby listener, or Game Mode timer
// along the way so we don't leak listeners or keep ticking in the bg.
function goHome() {
  // INSTRUCTOR EXIT during an active classroom round — confirm, then
  // end the round for everyone instead of just leaving. Each student's
  // current correct/wrong/totalTime/progress becomes their final score
  // (their per-card writes already populated Firebase; for game-mode
  // classroom, the abort path snapshots their stats before routing).
  if (state.mpRole === 'instructor'
      && state.mpLobbyType === 'classroom'
      && state.mpCode
      && state.currentScreen === 'screen-cls-dashboard') {
    const ok = confirm(
      'End this drill now?\n\n' +
      'Every student will jump to the leaderboard with their current score. ' +
      'You cannot resume this round.'
    );
    if (!ok) return;
    // Push status='ended' + mark all real players finished so the
    // "everyone done" check resolves and the lobby listener routes
    // everyone (instructor included) to the unified leaderboard.
    const updates = {
      status: 'ended',
      roundEndedAt: firebase.database.ServerValue.TIMESTAMP,
      lastActivity: firebase.database.ServerValue.TIMESTAMP,
    };
    state.mpPlayers.forEach(p => {
      if (!p.isInstructor) updates[`players/${p.id}/finished`] = true;
    });
    fbLobbyRef(state.mpCode).update(updates).catch(err => {
      console.error('Instructor end-round failed', err);
      toast(fbErrorText(err));
    });
    return;  // stay in the lobby — listener will route to leaderboard
  }

  // Confirm before quitting an active solo/MP card-flip drill
  if (state.currentScreen === 'screen-game' && state.game) {
    if (!confirm('Quit this drill and return to the main menu?')) return;
  }
  // Confirm before abandoning an in-progress Game Mode round
  if (state.currentScreen === 'screen-gm-play' && typeof gm !== 'undefined' && gm.active) {
    if (!confirm('End the current Game Mode drill and return to the main menu?')) return;
  }
  // Tear down any active multiplayer/classroom listeners + leave the lobby
  if (typeof teardownMp === 'function') teardownMp();
  // Stop any Game Mode timers/spawn handles
  if (typeof gm !== 'undefined' && gm.active && typeof gmReset === 'function') gmReset();

  state.history = ['screen-home'];
  showScreen('screen-home', false);
}

/* ============================================================
   3. HOME / SETUP / MENU
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // Home menu
  qsa('[data-go]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.go));
  });

  $('home-btn').addEventListener('click', goHome);

  // ---- Solo setup ----
  // Round-type toggle — CARDS vs TIME. Swaps which sub-picker is visible.
  qsa('#sp-bound-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('#sp-bound-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.spBound = btn.dataset.bound;
      const deckWrap = $('sp-deck-wrap');
      const timeWrap = $('sp-time-wrap');
      if (state.spBound === 'time') {
        if (deckWrap) deckWrap.style.display = 'none';
        if (timeWrap) timeWrap.style.display = '';
      } else {
        if (deckWrap) deckWrap.style.display = '';
        if (timeWrap) timeWrap.style.display = 'none';
      }
    });
  });
  qsa('#sp-deck-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#sp-deck-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      state.spDeckCount = parseInt(opt.dataset.count, 10);
      $('sp-custom').value = '';
    });
  });
  qsa('#sp-time-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#sp-time-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      state.spLengthSec = parseInt(opt.dataset.length, 10) || 180;
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
    const hard   = $('sp-difficulty-hard')?.dataset.active === 'true';
    const expert = $('sp-difficulty-expert')?.dataset.active === 'true';
    const difficulty = combinedDifficulty(hard, expert);
    state.spDifficulty = difficulty;
    if (state.spBound === 'time') {
      // Time-bound Training: large deck so the round ends on the clock,
      // not on running out of cards. 500 fits the existing rules ceiling.
      const lengthSec = state.spLengthSec || 180;
      startGame({ deck: buildDeck(500, difficulty), mode: 'solo', difficulty, bound: 'time', lengthSec });
    } else {
      const n = state.spDeckCount;
      if (!n || n < 1) { toast('Pick a deck size'); return; }
      startGame({ deck: buildDeck(n, difficulty), mode: 'solo', difficulty, bound: 'cards' });
    }
  });

  // Training difficulty — Hard and Expert are MUTUALLY EXCLUSIVE.
  // Picking one deactivates the other; clicking an active button
  // deactivates it (back to Normal). Visual style of each button is
  // unchanged — they still highlight + glow when active.
  const diffButtons = ['sp-difficulty-hard', 'sp-difficulty-expert'];
  diffButtons.forEach(id => {
    $(id)?.addEventListener('click', () => {
      const btn = $(id);
      const wasActive = btn.dataset.active === 'true';
      // Deactivate every difficulty button first so only one can be on
      diffButtons.forEach(otherId => {
        const other = $(otherId);
        if (!other) return;
        other.dataset.active = 'false';
        other.classList.remove('active');
      });
      // Then re-activate the one we just clicked, unless it was already active
      // (clicking an active button toggles it OFF — back to Normal)
      if (!wasActive) {
        btn.dataset.active = 'true';
        btn.classList.add('active');
      }
    });
  });

  // Training airway-repositioning button (only fires on Hard / Expert
  // for apneic patients — see trainingAirwaySetup in renderCard)
  $('training-airway-btn')?.addEventListener('click', trainingAirwayPress);

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
    // Reset all player records and lobby state, keep everyone in the lobby.
    //
    // SPLIT INTO TWO PHASES so unpushed Firebase rules don't break the reset:
    //   Phase 1 (must succeed): legacy fields the deployed rules already
    //     accept — correct, wrong, totalTime, progress, finished, misses,
    //     wins + the lobby's deck/status/lastActivity.
    //   Phase 2 (best effort): the new streak fields — winStreak, silvers,
    //     bronzes. If the deployed rules don't validate these yet, this
    //     write fails silently; the lobby still resets properly.
    //
    // Without this split, RTDB's atomic updates would reject the whole
    // batch on one bad field, the status would stay 'ended', and the
    // listener would yank the instructor back to the debrief screen.
    const realPlayers = state.mpPlayers.filter(p => !p.isInstructor);
    const placements = computePlacements(realPlayers);
    const firstIds  = new Set((placements[0] || []).map(p => p.id));
    const secondIds = new Set((placements[1] || []).map(p => p.id));
    const thirdIds  = new Set((placements[2] || []).map(p => p.id));

    const reset = {};
    const streak = {};
    state.mpPlayers.forEach(p => {
      const isFirst  = firstIds.has(p.id);
      const isSecond = secondIds.has(p.id);
      const isThird  = thirdIds.has(p.id);
      // Phase 1 — legacy fields
      reset[`players/${p.id}/wins`]      = (p.wins || 0) + (isFirst ? 1 : 0);
      reset[`players/${p.id}/correct`]   = 0;
      reset[`players/${p.id}/wrong`]     = 0;
      reset[`players/${p.id}/totalTime`] = 0;
      reset[`players/${p.id}/progress`]  = 0;
      reset[`players/${p.id}/finished`]  = false;
      reset[`players/${p.id}/misses`]    = null;
      // Phase 2 — new streak fields
      streak[`players/${p.id}/silvers`]   = (p.silvers   || 0) + (isSecond ? 1 : 0);
      streak[`players/${p.id}/bronzes`]   = (p.bronzes   || 0) + (isThird  ? 1 : 0);
      streak[`players/${p.id}/winStreak`] = isFirst ? ((p.winStreak || 0) + 1) : 0;
    });
    reset.deck = null;
    reset.status = 'lobby';
    reset.lastActivity = firebase.database.ServerValue.TIMESTAMP;

    fbLobbyRef(state.mpCode).update(reset).catch(err => {
      console.error('Reset failed', err);
    });
    fbLobbyRef(state.mpCode).update(streak).catch(() => {
      // Silent — old rules without winStreak/silvers/bronzes will reject
      // these. Streaks won't persist until rules are re-deployed, but the
      // lobby reset above succeeds either way.
    });
    showScreen('screen-mp-lobby');
  });
  $('debrief-home')?.addEventListener('click', () => {
    teardownMp();
    state.history = ['screen-home'];
    showScreen('screen-home', false);
  });

  // Unified leaderboard buttons (used by both instructor + students)
  $('lb-instructor-debrief-toggle')?.addEventListener('click', () => {
    const debriefEl = $('lb-instructor-debrief');
    const btn = $('lb-instructor-debrief-toggle');
    if (!debriefEl || !btn) return;
    const isOpen = debriefEl.style.display !== 'none';
    if (isOpen) {
      debriefEl.style.display = 'none';
      btn.textContent = '▼ EXPAND DEBRIEF · COMMONLY MISSED CARDS';
    } else {
      // Render the existing debrief content into our inline container
      const oldDebriefBody = $('debrief-body');
      const tmp = document.createElement('div');
      const origParent = oldDebriefBody?.parentNode;
      if (oldDebriefBody) {
        // Render renderDebrief into the existing #debrief-body, then
        // copy the resulting innerHTML into our inline panel.
        renderDebrief();
        debriefEl.innerHTML = oldDebriefBody.innerHTML;
      } else {
        debriefEl.innerHTML = '<p style="color:var(--text-mute);font-family:var(--mono);font-size:0.78rem">Debrief unavailable.</p>';
      }
      debriefEl.style.display = 'block';
      btn.textContent = '▲ COLLAPSE DEBRIEF';
    }
  });
  $('lb-replay')?.addEventListener('click', () => {
    // Replay = same as the instructor's "Run Another Drill" — reset
    // the lobby and put everyone back on the lobby screen.
    if (state.mpRole === 'instructor' || state.mpRole === 'host') {
      $('debrief-new-drill')?.click();
    } else {
      // Guest can only wait for host to restart
      toast('Waiting for host to start another drill');
    }
  });
  $('lb-home')?.addEventListener('click', () => {
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

  // Difficulty picker — five mutually-exclusive game-type toggles
  // styled like the Hard/Expert dramatic buttons. TRAINING shows the
  // deck/team sub-controls; the four game-mode types swap to a length
  // picker. The selected gameType gets written to Firebase so guests
  // know which engine to start.
  qsa('#host-gametype-options [data-gametype]').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('#host-gametype-options [data-gametype]').forEach(b => {
        b.classList.remove('active');
        b.dataset.active = 'false';
      });
      btn.classList.add('active');
      btn.dataset.active = 'true';
      const gt = btn.dataset.gametype || 'training';
      state.mpGameType = gt;
      refreshTopbar();
      const trainEl = $('host-training-controls');
      const gameEl = $('host-gamemode-controls');
      if (gt === 'training') {
        if (trainEl) trainEl.style.display = '';
        if (gameEl) gameEl.style.display = 'none';
      } else {
        if (trainEl) trainEl.style.display = 'none';
        if (gameEl) gameEl.style.display = '';
        // MODE picker (HEAD-TO-HEAD vs TEAM) now applies to game-mode
        // types too — no auto-force to FFA. Each player still runs
        // their own engine; team scoring just aggregates correct counts.
      }
      // Push the change to Firebase if we already have a lobby
      if (state.mpCode && (state.mpRole === 'host' || state.mpRole === 'instructor')) {
        const updates = {
          gameType: gt,
          gameLengthSec: state.mpGameLengthSec || 180,
          lastActivity: firebase.database.ServerValue.TIMESTAMP,
        };
        fbLobbyRef(state.mpCode).update(updates).catch(() => {});
      }
    });
  });
  // Round-type toggle for game-mode types — TIME vs CARDS
  qsa('#host-gm-bound-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('#host-gm-bound-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bound = btn.dataset.bound || 'time';
      state.mpGameBound = bound;
      const lenWrap = $('host-gm-length-wrap');
      const cardWrap = $('host-gm-cards-wrap');
      if (bound === 'cards') {
        if (lenWrap)  lenWrap.style.display  = 'none';
        if (cardWrap) cardWrap.style.display = '';
      } else {
        if (lenWrap)  lenWrap.style.display  = '';
        if (cardWrap) cardWrap.style.display = 'none';
      }
      // boundType is pushed atomically by hostStartGame; no per-click
      // write here so we don't fire a Firebase update on every toggle
      // (and trigger PERMISSION_DENIED noise on legacy rules).
    });
  });

  // Length picker for game-mode types
  qsa('#host-gm-length-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#host-gm-length-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      const sec = parseInt(opt.dataset.length, 10) || 180;
      state.mpGameLengthSec = sec;
      if (state.mpCode && (state.mpRole === 'host' || state.mpRole === 'instructor')) {
        fbLobbyRef(state.mpCode).update({
          gameLengthSec: sec,
          lastActivity: firebase.database.ServerValue.TIMESTAMP,
        }).catch(() => {});
      }
    });
  });

  // Card-count picker for game-mode types
  qsa('#host-gm-cards-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#host-gm-cards-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      const n = parseInt(opt.dataset.count, 10) || 25;
      state.mpGameCardLimit = n;
      const customEl = $('host-gm-cards-custom');
      if (customEl) customEl.value = '';  // clear custom on preset pick
      // cardLimit is pushed atomically by hostStartGame; no per-click write.
    });
  });
  // Custom card-count input for game-mode types — overrides preset 1-500
  $('host-gm-cards-custom')?.addEventListener('input', (e) => {
    const n = parseInt(e.target.value, 10);
    if (!isNaN(n) && n >= 1 && n <= 500) {
      qsa('#host-gm-cards-options .option').forEach(o => o.classList.remove('selected'));
      state.mpGameCardLimit = n;
    }
  });

  // HEAD-TO-HEAD / TEAM picker — scoped to buttons that carry data-mode
  // so it doesn't clobber other .team-toggle pickers (e.g. the
  // ROUND TYPE toggle for time vs cards).
  qsa('.team-toggle button[data-mode]').forEach(b => {
    b.addEventListener('click', () => {
      qsa('.team-toggle button[data-mode]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      setMpMode(b.dataset.mode);
      renderLobby();
    });
  });
  // Training ROUND TYPE toggle (classroom) — CARDS vs TIME
  qsa('#host-train-bound-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('#host-train-bound-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bound = btn.dataset.bound || 'cards';
      state.mpTrainingBound = bound;
      const deckWrap = $('host-train-deck-wrap');
      const timeWrap = $('host-train-time-wrap');
      if (bound === 'time') {
        if (deckWrap) deckWrap.style.display = 'none';
        if (timeWrap) timeWrap.style.display = '';
      } else {
        if (deckWrap) deckWrap.style.display = '';
        if (timeWrap) timeWrap.style.display = 'none';
      }
      // boundType is pushed atomically by hostStartGame; no per-click write.
    });
  });
  qsa('#host-train-time-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#host-train-time-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      const sec = parseInt(opt.dataset.length, 10) || 180;
      state.mpTrainingLengthSec = sec;
      // Push gameLengthSec — it's already in the rules (30-600 valid range)
      if (state.mpCode && (state.mpRole === 'host' || state.mpRole === 'instructor')) {
        fbLobbyRef(state.mpCode).update({
          gameLengthSec: sec,
          lastActivity: firebase.database.ServerValue.TIMESTAMP,
        }).catch(() => {});
      }
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
      // Host returns to lobby; reset stats via Firebase. Same two-phase
      // split as the classroom debrief reset — Phase 1 must succeed
      // (lobby returns to 'lobby' state), Phase 2 (new streak fields)
      // is best-effort so unpushed rules don't break the round reset.
      const realPlayers = state.mpPlayers.filter(p => !p.isInstructor);
      const placements = computePlacements(realPlayers);
      const firstIds = new Set((placements[0] || []).map(p => p.id));
      const secondIds = new Set((placements[1] || []).map(p => p.id));
      const thirdIds = new Set((placements[2] || []).map(p => p.id));

      const updates = {};
      const streak = {};
      state.mpPlayers.forEach(p => {
        const isFirst  = firstIds.has(p.id);
        const isSecond = secondIds.has(p.id);
        const isThird  = thirdIds.has(p.id);
        // Phase 1 — legacy fields
        updates[`players/${p.id}/wins`]    = (p.wins || 0) + (isFirst ? 1 : 0);
        updates[`players/${p.id}/correct`] = 0;
        updates[`players/${p.id}/wrong`] = 0;
        updates[`players/${p.id}/totalTime`] = 0;
        updates[`players/${p.id}/progress`] = 0;
        updates[`players/${p.id}/finished`] = false;
        updates[`players/${p.id}/misses`] = null;
        // Phase 2 — new streak fields (best-effort)
        streak[`players/${p.id}/silvers`]   = (p.silvers   || 0) + (isSecond ? 1 : 0);
        streak[`players/${p.id}/bronzes`]   = (p.bronzes   || 0) + (isThird  ? 1 : 0);
        streak[`players/${p.id}/winStreak`] = isFirst ? ((p.winStreak || 0) + 1) : 0;
      });
      updates.deck = null;
      updates.status = 'lobby';
      updates.lastActivity = firebase.database.ServerValue.TIMESTAMP;
      if (state.mpCode) {
        fbLobbyRef(state.mpCode).update(updates).catch(err => {
          console.error('Reset failed', err);
        });
        // Best-effort streak fields — silent fail if rules don't allow them.
        fbLobbyRef(state.mpCode).update(streak).catch(() => {});
      }
      state.game = null;
      showScreen('screen-mp-lobby');
    } else if (state.game?.mode === 'mp-guest') {
      state.game = null;
      showScreen('screen-mp-lobby');
    } else {
      // Solo play-again: replay with the same bound the player picked.
      if (state.spBound === 'time') {
        const lengthSec = state.spLengthSec || 180;
        startGame({ deck: buildDeck(500, state.spDifficulty), mode: 'solo', difficulty: state.spDifficulty, bound: 'time', lengthSec });
      } else {
        startGame({ deck: buildDeck(state.spDeckCount, state.spDifficulty), mode: 'solo', difficulty: state.spDifficulty, bound: 'cards' });
      }
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
    // Solo: same difficulty, same bound, fresh deck
    const difficulty = state.spDifficulty || 'expert';
    if (state.spBound === 'time') {
      const lengthSec = state.spLengthSec || 180;
      startGame({ deck: buildDeck(500, difficulty), mode: 'solo', difficulty, bound: 'time', lengthSec });
    } else {
      const n = state.spDeckCount;
      startGame({ deck: buildDeck(n, difficulty), mode: 'solo', difficulty, bound: 'cards' });
    }
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

function startGame({ deck, mode, difficulty, bound, lengthSec }) {
  const roundBound = (bound === 'time') ? 'time' : 'cards';
  const startTs = Date.now();
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
    fatalIncident: null,
    bound: roundBound,                              // 'cards' | 'time'
    startTime: startTs,
    endTime: (roundBound === 'time')
      ? startTs + ((lengthSec || 180) * 1000)
      : 0,
    durationMs: (roundBound === 'time') ? (lengthSec || 180) * 1000 : 0,
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
  if (roundBound === 'time') startRoundTimer();
}

// Round-level timer for time-bound Training. Runs alongside the per-card
// ticker; ends the game when the clock hits 0 regardless of where the
// player is in the deck.
let roundTimerHandle = null;
function startRoundTimer() {
  stopRoundTimer();
  roundTimerHandle = setInterval(() => {
    const g = state.game;
    if (!g || g.bound !== 'time') { stopRoundTimer(); return; }
    if (Date.now() >= g.endTime) {
      stopRoundTimer();
      endGame();
    }
  }, 250);
}
function stopRoundTimer() {
  if (roundTimerHandle) { clearInterval(roundTimerHandle); roundTimerHandle = null; }
}

function formatRoundClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

let gameTicker = null;
function startGameTicker() {
  if (gameTicker) clearInterval(gameTicker);
  gameTicker = setInterval(() => {
    const g = state.game;
    if (!g) return;
    // Round countdown for time-bound runs (live HUD update). Runs even
    // when no card is in play (between flips), so the clock stays honest.
    if (g.bound === 'time' && g.endTime) {
      const remain = Math.max(0, g.endTime - Date.now());
      const cardEl = $('hud-card');
      if (cardEl) cardEl.textContent = formatRoundClock(remain);
    }
    if (!g.cardStartTs) return;
    const elapsed = (Date.now() - g.cardStartTs) / 1000;
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

  // HUD case/round cell — bound-aware. CARDS bound: "X/N" with label
  // "Case". TIME bound: countdown + label "Round" (the round-timer
  // ticker keeps the value live; this is the initial paint).
  const cardLbl = $('hud-card-lbl');
  if (g.bound === 'time') {
    setHudValue('hud-card', formatRoundClock(Math.max(0, g.endTime - Date.now())));
    if (cardLbl) cardLbl.textContent = 'Round';
  } else {
    setHudValue('hud-card', `${g.idx + 1}/${g.deck.length}`);
    if (cardLbl) cardLbl.textContent = 'Case';
  }
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

  // Hard / Expert difficulty in Training: apneic patients (BLACK
  // scenarios) require interactive airway repositioning before
  // tagging. The OUTCOME is randomized — breathing may or may not
  // return on each attempt — so the player can't game the answer
  // from the card vitals alone.
  trainingAirwaySetup(card);

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

/* ----- Training airway repositioning (Hard / Expert) -----
   When an apneic patient (BLACK scenario) is shown in Training and
   the active difficulty is Hard, Expert, or Hard-Expert, lock the
   tag buttons and require the player to work the airway. Each
   press is a 50/50 — breathing returns (RED) or stays apneic.
   After two attempts the airway is "resolved": if breathing
   never returned, the patient is BLACK; otherwise RED. The
   correct answer (card.answer) is overridden if breathing returns,
   so the player must read the outcome rather than the original
   scenario answer.
   ============================================================ */

const TRAINING_AIRWAY_MAX = 2;
const TRAINING_AIRWAY_RETURN_PROB = 0.5; // 50/50 per attempt

function trainingDifficultyHasAirway() {
  const d = state.game?.difficulty;
  return d === 'hard' || d === 'expert' || d === 'hard-expert';
}

// Decide whether this card needs airway interaction. Called from
// renderCard at the start of each card.
function trainingAirwaySetup(card) {
  const g = state.game;
  if (!g) return;
  // Airway only triggers in solo-Training Hard/Expert with apneic patients
  const isApneic = (card.answer === 'black');
  const needsAirway = (g.mode === 'solo') && trainingDifficultyHasAirway() && isApneic;
  if (!needsAirway) {
    g.airway = null;
    trainingAirwayHide();
    return;
  }
  g.airway = {
    attempts: 0,
    resolved: false,
    breathingReturned: false,
    originalRespirations: card.respirations,
    originalRationale: card.rationale,
  };
  // Mask the respirations so it doesn't telegraph the post-airway answer
  card.respirations = 'Apneic on initial assessment — airway has not been worked';
  $('rpm-r').textContent = card.respirations;
  trainingAirwayShow(TRAINING_AIRWAY_MAX);
}

function trainingAirwayShow(attemptsLeft) {
  const row = $('training-airway-row');
  const btn = $('training-airway-btn');
  if (!row || !btn) return;
  row.style.display = '';
  btn.textContent = `⊕ REPOSITION AIRWAY · ${attemptsLeft} ATTEMPT${attemptsLeft === 1 ? '' : 'S'} LEFT`;
  btn.disabled = false;
  // Tag buttons stay ENABLED — the player can choose to skip the
  // airway maneuver, but doing so is a teachable mistake (handled
  // in onTagPick: skipping = automatic wrong with a corrective
  // rationale).
}

function trainingAirwayHide() {
  const row = $('training-airway-row');
  if (row) row.style.display = 'none';
}

function trainingAirwayPress() {
  const g = state.game;
  if (!g || !g.airway || g.airway.resolved) return;
  g.airway.attempts += 1;
  const card = g.deck[g.idx];
  const isLastAttempt = g.airway.attempts >= TRAINING_AIRWAY_MAX;
  const breathingReturns = Math.random() < TRAINING_AIRWAY_RETURN_PROB;

  if (breathingReturns) {
    // Patient recovered — RED is now the correct answer
    g.airway.breathingReturned = true;
    g.airway.resolved = true;
    const newRR = 14 + Math.floor(Math.random() * 8);
    card.respirations = `${newRR}/min, weak — spontaneous breathing returned after airway repositioning`;
    card.answer = 'red';
    card.rationale = `Patient was apneic on arrival; airway repositioning restored spontaneous respirations at ${newRR}/min. Tag IMMEDIATE (Red) and move on — they're salvageable but unstable.`;
    $('rpm-r').textContent = card.respirations;
    trainingAirwayHide();
    return;
  }

  if (isLastAttempt) {
    // Two failed attempts — patient is deceased. Override the
    // simpler Normal-mode rationale with the context-aware one
    // that mentions both attempts (this is the Hard/Expert path).
    g.airway.resolved = true;
    card.respirations = 'No spontaneous respirations after two airway repositioning attempts';
    card.answer = 'black';
    card.rationale = 'After two airway repositioning attempts, no spontaneous respirations returned. Tag DECEASED (Black) and move on — every second here is a second from a salvageable patient.';
    $('rpm-r').textContent = card.respirations;
    trainingAirwayHide();
    return;
  }

  // First attempt failed — try again
  card.respirations = `Attempt 1: head-tilt complete, no spontaneous respirations resumed`;
  $('rpm-r').textContent = card.respirations;
  trainingAirwayShow(TRAINING_AIRWAY_MAX - g.airway.attempts);
}

function onTagPick(tag) {
  const g = state.game;
  if (!g || !g.cardStartTs) return;

  // Tag submitted — kill the per-card decision timer (manual or auto)
  stopDecisionTimer();

  qsa('.t-btn').forEach(b => b.disabled = true);

  const card = g.deck[g.idx];

  // AIRWAY-SKIP TEACHING MOMENT: if this card needed airway repositioning
  // (Hard/Expert + apneic patient) and the player tagged WITHOUT working
  // the airway at all, force-mark the answer as wrong and override the
  // rationale with a corrective explanation. They can pick any color, but
  // skipping the procedure is the failure being trained against.
  let airwaySkipped = false;
  if (g.airway && g.airway.attempts === 0) {
    airwaySkipped = true;
    // Override card answer to a tag the player did NOT pick so the
    // result registers as wrong regardless of which color they tapped.
    card.answer = (tag === 'red') ? 'black' : 'red';
    card.rationale =
      'You skipped airway repositioning. On an apneic patient START requires you to attempt the airway maneuver — head-tilt or jaw thrust — BEFORE tagging. ' +
      'Without that, you can\'t tell RED (breathing returns) from BLACK (still apneic). Always work the airway first; tag based on the outcome.';
    // Resolve the airway state so the verdict screen doesn't try to
    // keep the row visible afterwards.
    g.airway.resolved = true;
    trainingAirwayHide();
  }

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

/* ============================================================
   STREAK SYSTEM — winner/loser quips + tier rendering
   ============================================================
   Tracks consecutive 1st-place finishes within a single lobby's
   life. Visible badges escalate as someone keeps winning so the
   crew has a clear "target" to take down. Loser/dethroned quips
   add the social pressure on the other end. Placeholders in the
   strings: {W} = winner name, {L} = ex-champ name, {N} = streak length. */

const STREAK_QUIPS_WINNER = [
  'Took first. Try not to make a habit of it.',
  'Won the round. Crew is mildly surprised.',
  'First place. Captain raised an eyebrow.',
  'Top of the board. The bar was low, but still.',
  'Nice run. Don\'t get cocky.',
];
const STREAK_QUIPS_STREAK = [
  'Two for two. Now everyone\'s watching.',
  'Back-to-back. Suspicious.',
  'Two in a row. Crew\'s getting concerned.',
  'Building a streak. Captain wants a word.',
  'Two straight. Either it\'s skill or the algorithm likes them.',
];
const STREAK_QUIPS_TARGET = [
  'Three straight. There\'s a bounty out.',
  'On a tear. Crew is plotting.',
  'Target acquired. Someone step up.',
  'Three in a row. Rest of you should be embarrassed.',
  'Reigning unchecked. The shift is officially compromised.',
];
const STREAK_QUIPS_DOMINANT = [
  'Dominant. Rest of the crew is in shambles.',
  'Untouchable. Captain\'s considering retirement.',
  'Reigning champ. Anyone left who wants to try?',
  'Owns the room. Bar is officially on the floor.',
  'Cleared the leaderboard. Save the rest of us some dignity.',
];
const STREAK_QUIPS_BREAKER = [
  'Took down {L}\'s {N}-streak. Welcome to legend.',
  'Felled the giant. Buy yourself a coffee.',
  'Killed the streak. {L} sulks. Crew rejoices.',
  'Ended {L}\'s reign. {L} is reconsidering some life choices.',
  'Beat the unbeatable. Captain takes notes.',
];
const STREAK_QUIPS_DETHRONED = [
  'Streak ended at {N}. The crown was heavy.',
  'All good things end. Even {W}\'s reign.',
  'Got dethroned. {W} won\'t even make eye contact.',
  '{N}-streak broken. Captain isn\'t surprised.',
  'Reign ends. {W} looks for someone to blame.',
];
const STREAK_QUIPS_LOSER = [
  'Yet another loss to {W}. Maybe try a different chair.',
  '{W} won again. Take notes or take a hobby.',
  '{W} is carrying the whole crew. Embarrassing for the rest.',
  'Lost to {W} again. Captain isn\'t impressed.',
  'Came in last. Behind {W}, obviously.',
];

// Pick a random line from a pool with {W} {L} {N} substitution.
function pickQuip(pool, vars) {
  if (!pool || !pool.length) return '';
  const line = pool[Math.floor(Math.random() * pool.length)];
  return line.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null) ? vars[k] : '');
}

// Group players into placement buckets. Returns [[1st], [2nd], [3rd], ...]
// where each inner array contains players tied at that placement
// (same correct count AND same totalTime).
function computePlacements(players) {
  const sorted = players.slice().sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    return a.totalTime - b.totalTime;
  });
  const groups = [];
  let group = [];
  let key = null;
  for (const p of sorted) {
    const k = p.correct + ':' + p.totalTime;
    if (k !== key) {
      if (group.length) groups.push(group);
      group = [p];
      key = k;
    } else {
      group.push(p);
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

// Streak length → tier name. Drives badge text + CSS treatment.
function streakTier(n) {
  if (n >= 4) return 'DOMINANT';
  if (n === 3) return 'TARGET';
  if (n === 2) return 'STREAK';
  if (n === 1) return 'WINNER';
  return null;
}

// Render the streak badge for a player. Used by the leaderboard.
// `breakerOf` is the name of the ex-champ this player just dethroned
// (only set when this player is a one-round STREAK BREAKER).
function streakBadge(p, breakerOf) {
  if (breakerOf) {
    return `<span class="lb-streak breaker">★ STREAK BREAKER</span>`;
  }
  const streak = p.winStreak || 0;
  const tier = streakTier(streak);
  if (!tier) return '';
  const labels = {
    WINNER:   'WINNER',
    STREAK:   '★★ STREAK',
    TARGET:   `⚐ TARGET · ${streak}×`,
    DOMINANT: `⚑ DOMINANT · ${streak}×`,
  };
  return `<span class="lb-streak ${tier.toLowerCase()}">${labels[tier]}</span>`;
}

function endGame() {
  stopGameTicker();
  stopRoundTimer();
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

  // Time-bound rounds: the player only saw a subset of the deck. Use
  // cards-actually-answered as the denominator so accuracy reflects
  // their real run, not the (huge) latent deck.
  const seen = (g.bound === 'time')
    ? (g.correct + g.wrong)
    : g.deck.length;
  const total = seen;
  const acc = total > 0 ? Math.round((g.correct / total) * 100) : 0;
  const avg = total > 0 ? (g.totalTime / total) : 0;
  const grade = gradeFor(acc, avg);
  const rank = rankFor(grade);

  // MP mode: when the round ends from the timer (not from running out
  // of cards), the per-card writer's isLastCard branch never fired.
  // Write the final stats + finished flag here so the lobby's
  // "everyone done" check resolves correctly.
  if ((g.mode === 'mp-host' || g.mode === 'mp-guest') && state.mpCode && state.mpMyId && g.bound === 'time') {
    const updates = {};
    updates[`players/${state.mpMyId}/correct`]   = g.correct;
    updates[`players/${state.mpMyId}/wrong`]     = g.wrong;
    updates[`players/${state.mpMyId}/totalTime`] = g.totalTime;
    updates[`players/${state.mpMyId}/progress`]  = g.correct + g.wrong;
    updates[`players/${state.mpMyId}/finished`]  = true;
    updates['lastActivity'] = firebase.database.ServerValue.TIMESTAMP;
    fbLobbyRef(state.mpCode).update(updates).catch(() => {});
    // Last-player end-of-round trigger (matches the per-card writer's logic)
    const isClassroom = state.mpLobbyType === 'classroom';
    const canTriggerEnd = (g.mode === 'mp-host') || (isClassroom && g.mode === 'mp-guest');
    if (canTriggerEnd) {
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

  $('result-tag').textContent = (g.mode === 'solo') ? 'AFTER-ACTION REPORT' : 'YOUR DRILL · AAR';
  const gradeEl = $('result-grade');
  gradeEl.textContent = grade;
  gradeEl.className = 'grade-badge g-' + (grade === 'S' ? 'A' : grade); // S shares gold treatment with A
  $('result-rank').textContent = rank;
  $('result-score').textContent = `${g.correct}/${total}`;
  $('result-time').textContent = `${fmtTime(g.totalTime)} · ${avg.toFixed(1)}s avg`;

  // AAR quip — defaults to per-grade roast, but in MP/classroom modes
  // a streak-related quip (LOSER or DETHRONED) overrides when relevant.
  const roastEl = $('result-roast');
  if (roastEl) {
    let quipText = '';
    let quipClass = 'result-roast grade-' + grade;
    const isMpMode = (g.mode === 'mp-host' || g.mode === 'mp-guest') && state.mpPlayers && state.mpPlayers.length;

    if (isMpMode) {
      const realPlayers = state.mpPlayers.filter(p => !p.isInstructor);
      const placements = computePlacements(realPlayers);
      const winners = placements[0] || [];
      const winnerIds = new Set(winners.map(p => p.id));
      const me = realPlayers.find(p => p.id === state.mpMyId);
      const myRankBucket = placements.findIndex(grp => grp.find(x => x.id === state.mpMyId));

      // I was a streak holder (≥2) and just lost → DETHRONED override
      if (me && !winnerIds.has(me.id) && (me.winStreak || 0) >= 2) {
        const winnerName = winners[0]?.name || 'someone';
        quipText = pickQuip(STREAK_QUIPS_DETHRONED, { W: winnerName, N: me.winStreak || 0 });
        quipClass = 'result-roast grade-D'; // amber, "barely cleared the bar" tier
      }
      // I placed below top 3 AND there's a fresh winner who's now on a 2+ streak → LOSER
      else if (me && myRankBucket > 2 && winners.length > 0) {
        const topWinner = winners[0];
        const winnerStreakAfter = (topWinner.winStreak || 0) + 1; // post-bump
        if (winnerStreakAfter >= 2) {
          quipText = pickQuip(STREAK_QUIPS_LOSER, { W: topWinner.name });
          quipClass = 'result-roast grade-F';
        }
      }
    }

    // Fall back to grade quip if no streak override fired
    if (!quipText) {
      const pool = GRADE_QUIPS[grade];
      if (pool && pool.length) {
        quipText = pool[Math.floor(Math.random() * pool.length)];
      }
    }

    if (quipText) {
      roastEl.textContent = quipText;
      roastEl.className = quipClass;
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

  // Compute round placements + post-round streak state. The leaderboard
  // shows what streaks WILL be once the host clicks Play Again — that's
  // when the actual Firebase write happens. Pre-bumping the display lets
  // the AAR show the streak escalation immediately.
  const placements = computePlacements(realPlayers);
  const firstPlace = placements[0] || [];
  const winnerIds = new Set(firstPlace.map(p => p.id));
  const dethronedThisRound = realPlayers.filter(p =>
    !winnerIds.has(p.id) && (p.winStreak || 0) >= 2);
  const dethronedNames = dethronedThisRound.map(p => p.name);
  const dethronedStreakLens = dethronedThisRound.map(p => p.winStreak || 0);
  const isStreakBreakerRound = allDone && dethronedThisRound.length > 0;
  const winnerNames = firstPlace.map(p => p.name);

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

    // Build the player object the badge sees: post-round streak when
    // the round just ended, current streak when still mid-round.
    let displayP = p;
    let breakerOf = null;
    if (allDone) {
      const willWin = winnerIds.has(p.id);
      const newStreak = willWin ? (p.winStreak || 0) + 1 : 0;
      displayP = { ...p, winStreak: newStreak };
      if (willWin && isStreakBreakerRound) {
        breakerOf = dethronedNames.join(', ');
      }
      // Add row decoration for high-tier streaks
      const tier = streakTier(newStreak);
      if (tier === 'TARGET' || tier === 'DOMINANT') {
        rowCls = (rowCls + ' streak-' + tier.toLowerCase()).trim();
      }
    }

    // Pick a stable quip per player+streak combo for the row sub-line.
    let quipLine = '';
    if (allDone && rowCls.includes('first')) {
      const tier = streakTier(displayP.winStreak || 0);
      if (breakerOf) {
        const breakerVars = { L: dethronedNames[0] || 'them', N: dethronedStreakLens[0] || 0 };
        quipLine = `<div class="lb-quip breaker">${escapeHtml(pickQuip(STREAK_QUIPS_BREAKER, breakerVars))}</div>`;
      } else if (tier === 'DOMINANT') {
        quipLine = `<div class="lb-quip dominant">${escapeHtml(pickQuip(STREAK_QUIPS_DOMINANT))}</div>`;
      } else if (tier === 'TARGET') {
        quipLine = `<div class="lb-quip target">${escapeHtml(pickQuip(STREAK_QUIPS_TARGET))}</div>`;
      } else if (tier === 'STREAK') {
        quipLine = `<div class="lb-quip streak">${escapeHtml(pickQuip(STREAK_QUIPS_STREAK))}</div>`;
      } else if (tier === 'WINNER') {
        quipLine = `<div class="lb-quip">${escapeHtml(pickQuip(STREAK_QUIPS_WINNER))}</div>`;
      }
    }
    // Dethroned ex-champ gets a quip line too
    if (allDone && dethronedThisRound.find(d => d.id === p.id)) {
      const dethronedVars = {
        W: winnerNames[0] || 'them',
        N: p.winStreak || 0,
      };
      quipLine = `<div class="lb-quip dethroned">${escapeHtml(pickQuip(STREAK_QUIPS_DETHRONED, dethronedVars))}</div>`;
      rowCls = (rowCls + ' streak-dethroned').trim();
    }

    return `<div class="lb-row ${rowCls}">
      <span class="rk">${medal || `<span class="rk-num">${rank}</span>`}</span>
      <span class="nm">
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-meta">${teamTxt}${meTxt}${streakBadge(displayP, breakerOf)}${finishMark}</span>
        ${quipLine}
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
// Unified end-of-round leaderboard. Shown to EVERYONE in classroom
// mode (instructor + students) once status flips to 'ended'. Replaces
// the old split where guests saw screen-results and instructor saw
// screen-cls-debrief separately. Instructor gets an EXPAND toggle
// that surfaces the original commonly-missed-cards debrief inline.
function renderClsLeaderboard() {
  const players = state.mpPlayers.filter(p => !p.isInstructor);
  // Rank: most correct first, fastest total time as tiebreaker.
  // Works across all 5 game types — they all track `correct` and
  // `totalTime`. Score field exists for Game Mode but is intentionally
  // NOT used here so the ranking is objective (purely how many they
  // got right + how fast they were, no penalty math).
  const sorted = players.slice().sort((a, b) => {
    const correctDiff = (b.correct || 0) - (a.correct || 0);
    if (correctDiff !== 0) return correctDiff;
    return (a.totalTime || 0) - (b.totalTime || 0);
  });

  const isInstructor = (state.mpRole === 'instructor');
  const finishedCount = players.filter(p => p.finished).length;
  const sub = $('lb-hero-sub');
  if (sub) sub.textContent = `${finishedCount} of ${players.length} finished · ${(state.mpGameType || 'training').toUpperCase()}`;

  // Build the ranked rows
  const html = sorted.map((p, i) => {
    const rank = i + 1;
    const total = (p.correct || 0) + (p.wrong || 0);
    const correctOf = total > 0 ? `${p.correct}/${total}` : `${p.correct || 0}`;
    const acc = total > 0 ? Math.round((p.correct / total) * 100) : 0;
    const meTxt = (p.id === state.mpMyId) ? `<span class="lb-you">YOU</span>` : '';
    let medal = '', rowCls = '';
    if (rank === 1) { medal = '<span class="medal gold">🏆</span>'; rowCls = 'first'; }
    else if (rank === 2) { medal = '<span class="medal silver">🥈</span>'; rowCls = 'second'; }
    else if (rank === 3) { medal = '<span class="medal bronze">🥉</span>'; rowCls = 'third'; }
    const finishMark = p.finished ? '' : `<span class="lb-status">in-progress</span>`;
    return `<div class="lb-row ${rowCls}">
      <span class="rk">${medal || `<span class="rk-num">${rank}</span>`}</span>
      <span class="nm">
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-meta">${meTxt}${finishMark}</span>
      </span>
      <span class="sc">
        <span class="sc-main">${correctOf}</span>
        <span class="sc-acc">${acc}%</span>
      </span>
      <span class="tm">${fmtTime(p.totalTime)}</span>
    </div>`;
  }).join('');
  const body = $('lb-final-body');
  if (body) body.innerHTML = `<div class="leaderboard">${html}</div>`;

  // Instructor-only: expand-debrief toggle for commonly-missed cards
  const toggleBtn = $('lb-instructor-debrief-toggle');
  const debriefEl = $('lb-instructor-debrief');
  if (toggleBtn) toggleBtn.style.display = isInstructor ? '' : 'none';
  if (debriefEl) debriefEl.style.display = 'none'; // collapsed by default
  if (toggleBtn) toggleBtn.textContent = '▼ EXPAND DEBRIEF · COMMONLY MISSED CARDS';
}

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
  const players = state.mpPlayers.slice().sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    return (a.totalTime || 0) - (b.totalTime || 0);
  });
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
        // Instructor goes to the unified leaderboard (replaces the
        // standalone debrief screen). Debrief content is still
        // accessible via the EXPAND toggle on the leaderboard.
        if (state.currentScreen !== 'screen-cls-leaderboard') {
          showScreen('screen-cls-leaderboard');
        }
        renderClsLeaderboard();
      } else if (lobby.status === 'lobby') {
        if (state.currentScreen === 'screen-cls-dashboard' || state.currentScreen === 'screen-cls-debrief' || state.currentScreen === 'screen-cls-leaderboard') {
          showScreen('screen-mp-lobby', false);
        }
        if (state.currentScreen === 'screen-mp-lobby') renderLobby();
      }
      return; // Skip the player-side game-start logic entirely
    }

    // GAME START: status flipped to playing. Two paths:
    //   Training: lobby has a shared deck — start the deck-based engine
    //   Game-mode types (Hard/Expert/Chaos/Fog): no deck; each guest
    //     spawns their own patients via the appropriate engine.
    const deckReady = normalizedDeck && normalizedDeck.length > 0;
    const lobbyGameType = lobby.gameType || 'training';
    const isGameMode = (lobbyGameType !== 'training');

    // Reconfigure our onDisconnect cleanup based on round status.
    // - In lobby: remove player record on drop.
    // - Playing: preserve record + mark finished+disconnected.
    // Cheap to call repeatedly (Firebase debounces); always idempotent.
    if (state.mpRole === 'guest') {
      updateDisconnectAction(lobby.status);
    }

    if (lobby.status === 'playing' && isGameMode && !gm.active && state.currentScreen !== 'screen-gm-results') {
      // Game-Mode classroom round — fire the appropriate engine for this guest.
      gmStartClassroomGuest(lobbyGameType, lobby.gameLengthSec || 180, lobby.boundType || 'time', lobby.cardLimit || 25);
    } else if (lobby.status === 'playing' && deckReady && state.game && state.game.mode !== 'mp-host' && state.game.mode !== 'mp-guest') {
      // Training: we're a guest who hasn't started yet
      const trainBound = (lobby.boundType === 'time') ? 'time' : 'cards';
      const opts = { deck: normalizedDeck, mode: 'mp-guest', difficulty: state.mpDifficulty, bound: trainBound };
      if (trainBound === 'time') opts.lengthSec = lobby.gameLengthSec || 180;
      startGame(opts);
    } else if (lobby.status === 'playing' && deckReady && !state.game) {
      // Training: already routed to lobby, but no game yet — start now
      const myMode = (state.mpRole === 'host') ? 'mp-host' : 'mp-guest';
      const trainBound = (lobby.boundType === 'time') ? 'time' : 'cards';
      const opts = { deck: normalizedDeck, mode: myMode, difficulty: state.mpDifficulty, bound: trainBound };
      if (trainBound === 'time') opts.lengthSec = lobby.gameLengthSec || 180;
      startGame(opts);
    }

    // GAME END: when everyone finished, status becomes 'ended'.
    // Classroom: yank EVERYONE (instructor + students, all game types)
    // to the unified leaderboard. Multiplayer (non-classroom): leave
    // current behavior (re-render in-place leaderboard).
    if (lobby.status === 'ended') {
      if (state.mpLobbyType === 'classroom') {
        // INSTRUCTOR-ABORT PATH: if a student is mid-round when the
        // instructor ends the drill, halt their engine and snapshot
        // their CURRENT score to Firebase before routing. For Training,
        // the per-card writer keeps Firebase mostly fresh; for Game
        // Mode classroom (gm engine), per-tag writes don't happen so
        // we MUST snapshot here or the student's final shows zeroes.
        if (typeof gm !== 'undefined' && gm.active) gmAbortAndSnapshot();
        if (state.game && (state.game.mode === 'mp-host' || state.game.mode === 'mp-guest')) {
          trainingAbortAndSnapshot();
        }
        if (state.currentScreen !== 'screen-cls-leaderboard') {
          showScreen('screen-cls-leaderboard');
        }
        renderClsLeaderboard();
      } else {
        // MP non-classroom — original in-place leaderboard refresh
        if (state.currentScreen === 'screen-game' && state.game && state.game.idx >= state.game.deck.length) {
          showMpLeaderboard();
        }
        if (state.currentScreen === 'screen-results') {
          showMpLeaderboard();
        }
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

  // Defensive re-sync: read the picker DOM directly so the round
  // launches with whatever the host actually has selected, even if a
  // change handler missed (e.g. rapid clicks racing the listener).
  const activeGtBtn = document.querySelector('#host-gametype-options [data-gametype].active');
  if (activeGtBtn) state.mpGameType = activeGtBtn.dataset.gametype || 'training';
  const activeBoundBtn = document.querySelector('#host-gm-bound-toggle button.active');
  if (activeBoundBtn) state.mpGameBound = activeBoundBtn.dataset.bound || 'time';
  const activeTrainBoundBtn = document.querySelector('#host-train-bound-toggle button.active');
  if (activeTrainBoundBtn) state.mpTrainingBound = activeTrainBoundBtn.dataset.bound || 'cards';
  const activeGmLengthOpt = document.querySelector('#host-gm-length-options .option.selected');
  if (activeGmLengthOpt) state.mpGameLengthSec = parseInt(activeGmLengthOpt.dataset.length, 10) || 180;
  const activeGmCardsOpt = document.querySelector('#host-gm-cards-options .option.selected');
  if (activeGmCardsOpt) state.mpGameCardLimit = parseInt(activeGmCardsOpt.dataset.count, 10) || 25;
  const activeTrainTimeOpt = document.querySelector('#host-train-time-options .option.selected');
  if (activeTrainTimeOpt) state.mpTrainingLengthSec = parseInt(activeTrainTimeOpt.dataset.length, 10) || 180;

  const gameType = state.mpGameType || 'training';
  const isTraining = (gameType === 'training');

  // Difficulty + deck only matter for Training-style rounds. Game-mode
  // types (Hard/Expert/Chaos/Fog) carry their own built-in difficulty
  // and don't share a deck — each guest spawns their own patients.
  let difficulty = 'normal';
  let deck = null;
  const trainingBound = state.mpTrainingBound || 'cards';
  if (isTraining) {
    const hard   = $('mp-difficulty-hard')?.dataset.active === 'true';
    const expert = $('mp-difficulty-expert')?.dataset.active === 'true';
    difficulty = combinedDifficulty(hard, expert);
    // Time-bound Training: build a 500-card deck so the round ends on
    // the clock, not on running out of cards. Cards-bound: use the
    // host's chosen deck size as today.
    const deckCount = (trainingBound === 'time') ? 500 : state.mpDeckCount;
    deck = buildDeck(deckCount, difficulty);
  } else {
    // Map the picked sub-mode to its baked-in difficulty preset
    difficulty = (gameType === 'fog' || gameType === 'chaos' || gameType === 'expert')
      ? 'hard-expert'
      : 'hard-expert'; // hard sub-mode also uses borderline + red-herrings
  }

  // Bound + cardLimit values used both for Phase 2 (Firebase write) and
  // for the host's own engine launch. Declared at function scope so the
  // host start path below can read them regardless of whether Phase 2
  // ran. Fall back to safe defaults if state isn't set.
  const gmBoundType = state.mpGameBound || 'time';
  const cardLimit   = state.mpGameCardLimit || 25;

  // ─── Phase 1 (MUST SUCCEED): everything guests need to actually
  // launch the right engine. If this fails the round can't start and
  // we bail with the toast. gameType + gameLengthSec are ESSENTIAL —
  // without gameType, guests default to Training and a game-mode round
  // silently breaks (guest tries to load a deck that doesn't exist).
  const phase1 = {};
  state.mpPlayers.forEach(p => {
    phase1[`players/${p.id}/correct`]   = 0;
    phase1[`players/${p.id}/wrong`]     = 0;
    phase1[`players/${p.id}/totalTime`] = 0;
    phase1[`players/${p.id}/progress`]  = 0;
    phase1[`players/${p.id}/finished`]  = !!p.isInstructor;
  });
  phase1.status = 'playing';
  phase1.lastActivity = firebase.database.ServerValue.TIMESTAMP;
  phase1.difficulty = difficulty;
  phase1.gameType = gameType;            // routes guests to right engine
  phase1.gameLengthSec = isTraining      // round length (time-bound only)
    ? (state.mpTrainingLengthSec || 180)
    : (state.mpGameLengthSec || 180);
  // Training NEEDS the deck for guests to play. Game-mode types skip
  // the deck (each guest spawns their own patients).
  if (isTraining) {
    phase1.deck = deck;
  } else {
    phase1.deck = null;                  // clear leftover deck from prior training round
  }

  try {
    await fbLobbyRef(state.mpCode).update(phase1);
  } catch (err) {
    console.error('Host start failed', err);
    toast(fbErrorText(err) + ' — push firebase-rules.json to your DB');
    return;
  }

  // ─── Phase 2 (BEST EFFORT): newer fields the deployed rules may not
  // accept yet. boundType + cardLimit drive the cards-vs-time toggle;
  // if rejected, guests fall back to time/25. Once-per-session skip
  // after a rejection so we don't spam PERMISSION_DENIED.
  if (!state.mpBoundRulesRejected) {
    const phase2 = {
      roundStartedAt: firebase.database.ServerValue.TIMESTAMP,
      roundEndedAt: null,
      boundType: isTraining ? trainingBound : gmBoundType,
    };
    if (!isTraining) phase2.cardLimit = cardLimit;
    // Clear last round's misses (best-effort; if rules reject misses
    // for some reason, it's only cosmetic — leaderboard still works).
    state.mpPlayers.forEach(p => {
      phase2[`players/${p.id}/misses`] = null;
    });
    fbLobbyRef(state.mpCode).update(phase2).catch(() => {
      // Once-per-session: skip future Phase 2 writes.
      state.mpBoundRulesRejected = true;
      console.warn('Phase 2 round-start fields rejected — push firebase-rules.json to enable cards-bound rounds');
    });
  }

  // In classroom mode the instructor doesn't play — subscribeLobby will
  // route them to the dashboard once status flips to 'playing'.
  if (state.mpRole === 'instructor') return;

  // Host plays too. Training uses the shared deck; for game-mode types
  // the host runs their own engine just like the guests.
  if (isTraining && deck) {
    const opts = { deck, mode: 'mp-host', difficulty, bound: trainingBound };
    if (trainingBound === 'time') opts.lengthSec = state.mpTrainingLengthSec || 180;
    startGame(opts);
  } else {
    gmStartClassroomGuest(gameType, state.mpGameLengthSec || 180, gmBoundType, cardLimit);
  }
}

/* ---------- Mode + deck-size sync (called by lobby UI handlers) ---------- */

function setMpMode(mode) {
  state.mpMode = mode;
  if ((state.mpRole === 'host' || state.mpRole === 'instructor') && state.mpCode) {
    // Reassign teams if switching into team mode. Skip the instructor
    // record itself — they don't play and shouldn't be on a team.
    const updates = { mode };
    const realPlayers = state.mpPlayers.filter(p => !p.isInstructor);
    if (mode === 'team') {
      realPlayers.forEach((p, i) => {
        updates[`players/${p.id}/team`] = (i % 2 === 0) ? 'A' : 'B';
      });
    } else {
      realPlayers.forEach(p => {
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

  // Target banner — visible to everyone in the lobby when at least
  // one real player is on a 2+ win streak from the previous round(s).
  // Calls them out by name so the rest of the crew has a target.
  const banner = $('target-banner');
  if (banner) {
    const realP = state.mpPlayers.filter(p => !p.isInstructor && (p.winStreak || 0) >= 2);
    realP.sort((a, b) => (b.winStreak || 0) - (a.winStreak || 0));
    if (realP.length) {
      const top = realP[0];
      const tier = streakTier(top.winStreak || 0);
      const label = (tier === 'DOMINANT') ? 'DOMINANT' : 'TARGET';
      banner.className = 'target-banner ' + tier.toLowerCase();
      banner.innerHTML = `
        <div class="target-banner-tag">⚐ ${label}</div>
        <div class="target-banner-name">${escapeHtml(top.name)} · ${top.winStreak}-DRILL STREAK</div>
        <div class="target-banner-msg">Take them down.</div>
      `;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  }

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
  // Sync mode toggle — ONLY the buttons that actually represent a mode
  // (HEAD-TO-HEAD vs TEAM). The other .team-toggle pickers (ROUND TYPE)
  // have data-bound, not data-mode, and must not be touched here.
  qsa('.team-toggle button[data-mode]').forEach(b => {
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
const GM_MAX_SCENE = 4;       // max patients on the board at once (3-4 per Expert spec)
const GM_INITIAL_SCENE = 3;   // patients spawned at game start
const GM_TICK_MS = 250;       // how often we update stability bars
const GM_SPEED_BONUS_MS = 12000; // tag within this window for +5 bonus (achievable for a practiced player)
const GM_SPEED_BONUS = 5;
const GM_SCORE = { red: 10, yellow: 5, green: 5, black: 5, wrong: -10, lost: -15 };

const gm = {
  active: false,
  classroomMode: false,  // true when launched by gmStartClassroomGuest (writes to Firebase + finished flag)
  subMode: 'expert',     // 'hard' | 'expert' | 'chaos' | 'fog'
  bound: 'time',         // 'time' = stop on clock, 'cards' = stop after N triages
  cardLimit: 25,         // when bound==='cards', end after this many tagged patients
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
  // Hard mode — single-patient queue
  hardQueue: [],         // upcoming patient scenarios for the round
  hardCurrent: null,     // {id, scenario, addedAt, airwayAttempts, airwayResolved}
  // Chaos mode — speed leaderboard
  chaosTriageTimes: [],  // ms per correct triage, for avg/best calc
  chaosFailed: false,    // set when sudden death triggers
  // Fog of War mode
  fogPhase: null,        // 'reveal' | 'pick' | null
  fogRevealHandle: null,
  fogPickHandle: null,
  fogCurrent: null,
};

function gmReset() {
  gm.active = false;
  // classroomMode is intentionally NOT reset here — it's a session-level
  // flag set by the entry point (gmStartClassroomGuest sets it true,
  // standalone Game Mode picker sets it false). Engine restarts within
  // the same session preserve the flag.
  gm.startTime = 0;
  gm.endTime = 0;
  gm.patients = [];
  gm.history = [];
  gm.score = 0;
  gm.triagedCount = 0;
  gm.lostCount = 0;
  gm.saveCount = 0;
  gm.inboundCount = 0;
  gm.hardQueue = [];
  gm.hardCurrent = null;
  gm.chaosTriageTimes = [];
  gm.chaosFailed = false;
  gm.fogPhase = null;
  gm.fogCurrent = null;
  if (gm.tickHandle)  { clearInterval(gm.tickHandle);  gm.tickHandle = null; }
  // spawnHandle is a setTimeout, not setInterval, so use clearTimeout
  if (gm.spawnHandle) { clearTimeout(gm.spawnHandle);  gm.spawnHandle = null; }
  if (gm.endHandle)   { clearTimeout(gm.endHandle);    gm.endHandle = null; }
  if (gm.fogRevealHandle) { clearTimeout(gm.fogRevealHandle); gm.fogRevealHandle = null; }
  if (gm.fogPickHandle)   { clearTimeout(gm.fogPickHandle);   gm.fogPickHandle = null; }
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
  // Apneic (BLACK) patients carry an airway-interaction state and
  // get their respirations masked so the player must work the airway
  // to see the outcome (just like Training Hard/Expert).
  const isApneic = (scenario.answer === 'black');
  if (isApneic) {
    scenario._origRespirations = scenario.respirations;
    scenario._origRationale    = scenario.rationale;
    scenario.respirations      = 'Apneic on initial assessment — airway has not been worked';
  }
  return {
    id: 'gp_' + (gm.patientSeq++),
    scenario,
    addedAt: Date.now(),
    originalAnswer: scenario.answer,
    currentAnswer: scenario.answer,
    deteriorated: false,
    visibleWindow: 30000 + Math.floor(Math.random() * 10000),
    airway: isApneic ? { attempts: 0, resolved: false } : null,
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

// Classroom-mode dispatcher — used by hostStartGame and guest's
// subscribeLobby route. Sets the chosen game length, flips the
// classroom flag, then routes to the right engine. Each engine
// already supports gm.subMode-based behavior; the new classroomMode
// flag tells gmEndGame + scoring loops to write to Firebase and
// stay on the per-player results screen instead of doing standalone
// post-game routing.
function gmStartClassroomGuest(gameType, lengthSec, boundType, cardLimit) {
  gm.subMode = gameType;                         // 'hard' | 'expert' | 'chaos' | 'fog'
  gm.durationMs = (lengthSec || 180) * 1000;
  gm.bound = (boundType === 'cards') ? 'cards' : 'time';
  gm.cardLimit = cardLimit || 25;
  gm.classroomMode = true;
  gmStartGame();
}

// Dispatch to the right sub-mode engine. Each sub-mode has its own
// startGame variant — they share gmReset / gmEndGame / gmRenderResults
// but differ in the gameplay loop, scoring rules, and view layout.
function gmStartGame() {
  switch (gm.subMode) {
    case 'hard':   gmStartHard();   return;
    case 'chaos':  gmStartChaos();  return;
    case 'fog':    gmStartFog();    return;
    case 'expert': /* fallthrough */
    default:       gmStartExpert();
  }
}

// Multi-patient scene engine — what was originally Game Mode.
// Used by EXPERT and (with a few overrides) CHAOS.
function gmStartExpert() {
  gmReset();
  gm.subMode = 'expert';
  gm.active = true;
  gm.startTime = Date.now();
  gm.endTime = gm.startTime + gm.durationMs;
  // Expert / Chaos pull patients from the full procedural pool
  // (all four categories, with Hard-style borderline scenarios mixed
  // in via the 'hard-expert' difficulty preset that flips both knobs).
  gm.difficulty = 'hard-expert';

  $('gm-scene').innerHTML = '';
  $('gm-empty').style.display = 'none';
  showScreen('screen-gm-play');

  // Seed the scene
  for (let i = 0; i < GM_INITIAL_SCENE; i++) gmSpawnPatient();

  gmScheduleNextSpawn();
  gm.tickHandle  = setInterval(gmTick, GM_TICK_MS);
  // Time-bound: end on the clock. Cards-bound: end after gm.cardLimit
  // tagged-or-lost patients (handled in gmTagPatient/gmExpirePatient).
  if (gm.bound === 'time') {
    gm.endHandle = setTimeout(gmEndGame, gm.durationMs);
  }

  gmUpdateHud();
}

/* ============================================================
   CHAOS MODE — Expert engine + sudden death + speed leaderboard.
   First wrong tag (or expired patient) ends the run. Survivors
   compete on fastest average triage time per card. localStorage
   best-time persists across sessions on the same device.
   ============================================================ */

// Witty Chaos-mode quips. First-responder humor — a sly jab on
// failure, dry praise on survival. Variables: {N} = correct triages,
// {T} = average time per triage in seconds.
const CHAOS_SURVIVE_QUIPS = [
  'Survived. Crew is impressed. Captain less so — now do it faster.',
  'Cleared the round. The bar moves up tomorrow.',
  '{N} clean triages. Try not to brag at shift change.',
  'Made it out clean. Buy the next round.',
  'Survived. The MCI did not. Good work.',
  '{N} correct, no fails. The kind of run that ends arguments.',
  'Cleared it. Now the question is can you do it again.',
  'Captain wants to know what you ate today.',
  'Nobody died on your watch. Set a new floor.',
  'Survived. Don\'t get used to it.',
];

const CHAOS_DEATH_QUIPS = [
  'Made it to {N}. The crew is unimpressed.',
  '{N} correct. Then you panicked. Captain noticed.',
  'You were doing fine. Then you weren\'t. {N} cards in.',
  '{N} clean tags, then a hot mess. Classic.',
  'Sailed through {N}. Wrecked on the next one.',
  'Did great until you didn\'t. {N} cards before the wheels fell off.',
  '{N} for {N}. Then a 50-50 you flubbed. Math is unforgiving.',
  'BC reviewed your run. He used the word "promising."',
  'Solid through {N}. Then the brain went on coffee break.',
  '{N} correct, one wrong. The wrong one ends the round. Don\'t love that rule? Take it up with reality.',
  'You\'re great at the easy ones. Less great at the hard one.',
  'Probie levels: {N}. Captain levels: not yet.',
  'Made it further than your last run. Probably. We weren\'t watching.',
  '{N} cards. Crew\'s polite, says you\'ve "got potential."',
  'Could have kept going. Didn\'t. Dwell on that.',
];

function gmStartChaos() {
  // Run on the same scene engine as Expert, with sudden-death + speed
  // tracking flipped on. Round CAN end three ways:
  //   1. Wrong tag → fail
  //   2. Patient deteriorates → fail
  //   3. Time runs out clean → survived (the win condition)
  // gmStartExpert already sets gm.endTime / endHandle from the picked
  // duration, so we leave both intact.
  gmStartExpert();
  gm.subMode = 'chaos';
  gm.chaosFailed = false;
  gm.chaosTriageTimes = [];
  gmUpdateHud();
}

// Called when a Chaos run is terminated by a wrong tag or expired
// patient. Records the run, picks a quip, shows the death screen.
function gmChaosTriggerFailure(reason) {
  if (gm.subMode !== 'chaos' || gm.chaosFailed) return;
  gm.chaosFailed = true;
  // Compute stats for the AAR / death screen
  const correctCount = gm.saveCount;
  const avgMs = (gm.chaosTriageTimes.length > 0)
    ? (gm.chaosTriageTimes.reduce((s, x) => s + x, 0) / gm.chaosTriageTimes.length)
    : 0;
  const avgSec = (avgMs / 1000).toFixed(2);

  // Best-time leaderboard via localStorage (per device)
  const key = 'triageit.chaos.bestTime';
  const prevBest = parseFloat(localStorage.getItem(key) || '0');
  const isNewBest = (correctCount >= 5) && (prevBest === 0 || avgMs < prevBest);
  if (isNewBest) {
    try { localStorage.setItem(key, String(avgMs)); } catch (e) { /* localStorage may be disabled */ }
  }
  gm.chaosBestMs = isNewBest ? avgMs : prevBest;
  gm.chaosIsNewBest = isNewBest;
  gm.chaosAvgMs = avgMs;
  gm.chaosCorrectCount = correctCount;
  gm.chaosFailureReason = reason || 'wrong';

  // Pick a death quip with substitution
  const pool = CHAOS_DEATH_QUIPS;
  gm.chaosDeathQuip = pool[Math.floor(Math.random() * pool.length)]
    .replace(/\{N\}/g, correctCount)
    .replace(/\{T\}/g, avgSec);

  // End the round (gmEndGame routes to results renderer)
  gmEndGame();
}

/* ============================================================
   HARD MODE — single patient at a time, RED/BLACK only,
   interactive 2-attempt airway repositioning for apneic cases.
   The airway interaction is the key teaching moment in START:
   you MUST attempt to reposition before tagging, and the result
   of that maneuver determines RED (breathing returns) vs BLACK
   (still apneic).
   ============================================================ */

const GM_HARD_AIRWAY_MAX = 2;

function gmStartHard() {
  gmReset();
  gm.subMode = 'hard';
  gm.active = true;
  gm.startTime = Date.now();
  gm.endTime = gm.startTime + gm.durationMs;
  gm.difficulty = 'hard-expert'; // borderline vitals + red-herring narratives

  showScreen('screen-gm-hard');
  gmHardUpdateHud();
  gmHardNextPatient();

  gm.tickHandle = setInterval(gmHardTickTimer, 250);
  // Time-bound: end on the clock. Cards-bound: end after gm.cardLimit
  // tagged patients (handled in gmHardTag), no setTimeout.
  if (gm.bound === 'time') {
    gm.endHandle = setTimeout(gmEndGame, gm.durationMs);
  }
}

// Pull the next patient from the procedural Hard pool, render it,
// reset airway interaction state. Apneic (BLACK or BLACK-narrative)
// patients lock the tag buttons until airway has been worked.
function gmHardNextPatient() {
  if (!gm.active) return;
  const scenario = (window.generateHardPatient
    ? window.generateHardPatient()
    : window.generatePatient('hard-expert'));
  // An apneic narrative on a BLACK card means the airway is the
  // deciding question. Force-resolve airway before tagging.
  const isApneic = /no\s+spontaneous\s+respirations|apneic|airway/i.test(scenario.respirations + ' ' + scenario.description);
  gm.hardCurrent = {
    id: 'gh_' + (gm.patientSeq++),
    scenario,
    addedAt: Date.now(),
    airwayAttempts: 0,
    airwayResolved: !isApneic, // non-apneic = nothing to resolve
    isApneic,
  };
  gmHardRender();
}

function gmHardRender() {
  const stage = $('gm-hard-stage');
  if (!stage) return;
  const p = gm.hardCurrent;
  if (!p) { stage.innerHTML = ''; return; }
  const s = p.scenario;
  stage.innerHTML = `
    <div class="gm-hard-card">
      <div class="gm-hard-tag">CASE FILE · ASSESS</div>
      <div class="gm-hard-narrative">${escapeHtml(s.description)}</div>
      <div class="gm-hard-divider"></div>
      <div class="gm-hard-vitals">
        <div class="gm-hard-vital"><span class="k">RESPIRATIONS</span><span class="v" id="gm-hard-r">${escapeHtml(s.respirations)}</span></div>
        <div class="gm-hard-vital"><span class="k">PERFUSION</span><span class="v">${escapeHtml(s.perfusion)}</span></div>
        <div class="gm-hard-vital"><span class="k">MENTAL STATUS</span><span class="v">${escapeHtml(s.mental)}</span></div>
      </div>
    </div>
  `;
  gmHardSyncControls();
}

// Show / hide / enable the airway button + tag buttons based on
// whether the patient still needs an airway maneuver.
function gmHardSyncControls() {
  const p = gm.hardCurrent;
  const airwayRow = $('gm-hard-airway-row');
  const airwayBtn = $('gm-hard-airway-btn');
  if (!p || !airwayRow || !airwayBtn) return;

  if (p.isApneic && !p.airwayResolved) {
    airwayRow.style.display = '';
    const left = GM_HARD_AIRWAY_MAX - p.airwayAttempts;
    airwayBtn.textContent = `⊕ REPOSITION AIRWAY · ${left} ATTEMPT${left === 1 ? '' : 'S'} LEFT`;
    airwayBtn.disabled = false;
    // Disable tag buttons until airway is resolved
    qsa('#gm-hard-tagrow .t-btn').forEach(b => { b.disabled = true; });
  } else {
    airwayRow.style.display = 'none';
    qsa('#gm-hard-tagrow .t-btn').forEach(b => { b.disabled = false; });
  }
}

// Player taps "REPOSITION AIRWAY". Update narrative with the
// attempt result. If breathing returns OR attempts run out, the
// airway is "resolved" and tagging unlocks.
function gmHardAirway() {
  const p = gm.hardCurrent;
  if (!p || !p.isApneic || p.airwayResolved) return;
  p.airwayAttempts += 1;

  // Outcome: BLACK patients stay apneic on every attempt.
  // RED-by-airway-recovery patients (rare in our pool — mostly modeled
  // as BLACK) would have breathing return. For our pool, BLACK is
  // exclusively "no spontaneous respirations after repositioning",
  // so attempts always show no return for BLACK. After GM_HARD_AIRWAY_MAX
  // attempts, airway is "resolved" — they're truly deceased.
  const lastAttempt = p.airwayAttempts >= GM_HARD_AIRWAY_MAX;
  const stillApneic = (p.scenario.answer === 'black');

  let outcomeLine;
  if (stillApneic) {
    outcomeLine = lastAttempt
      ? 'Second attempt: jaw thrust performed, still no spontaneous respirations.'
      : 'First attempt: head-tilt complete, no spontaneous respirations.';
  } else {
    // For RED patients with apneic-looking narratives (edge case in our pool)
    outcomeLine = `Spontaneous breathing returns at ${15 + Math.floor(Math.random()*8)}/min after repositioning.`;
    p.scenario.respirations = `${15 + Math.floor(Math.random()*8)}/min, weak`;
    p.airwayResolved = true;
  }

  // Update the on-card respirations to show the attempt result
  const rEl = document.getElementById('gm-hard-r');
  if (rEl) {
    rEl.innerHTML = escapeHtml(p.scenario.respirations) +
      `<span class="gm-hard-airway-note">${escapeHtml(outcomeLine)}</span>`;
  }

  if (lastAttempt) p.airwayResolved = true;
  gmHardSyncControls();
}

// Player taps a triage tag. Score, advance to next patient.
function gmHardTag(tag) {
  const p = gm.hardCurrent;
  if (!p || !gm.active) return;
  // Block tagging if airway not resolved (UI also disables but be defensive)
  if (p.isApneic && !p.airwayResolved) return;

  const correct = (tag === p.scenario.answer);
  const elapsed = Date.now() - p.addedAt;
  let delta = 0;
  if (correct) {
    delta = (p.scenario.answer === 'red' ? 10 : 5);
    if (elapsed <= 12000) delta += 5;
    gm.saveCount += 1;
  } else {
    delta = -10;
  }
  gm.score += delta;
  gm.triagedCount += 1;
  if (!correct) gm.lostCount += 1; // "wrong" tracked under lostCount for the AAR

  gm.history.push({
    type: correct ? 'correct' : 'wrong',
    scenario: p.scenario,
    originalAnswer: p.scenario.answer,
    finalAnswer: p.scenario.answer,
    picked: tag,
    atMs: Date.now() - gm.startTime,
    elapsedMs: elapsed,
    score: delta,
  });

  // Brief flash on the card before advancing
  const stage = $('gm-hard-stage');
  const card = stage?.querySelector('.gm-hard-card');
  if (card) {
    card.classList.add(correct ? 'flash-ok' : 'flash-bad');
  }
  gm.hardCurrent = null;
  gmHardUpdateHud();
  // Cards-bound: end the run when we hit the picked card limit
  if (gm.bound === 'cards' && gm.triagedCount >= gm.cardLimit) {
    setTimeout(() => { if (gm.active) gmEndGame(); }, 420);
    return;
  }
  setTimeout(() => gmHardNextPatient(), 380);
}

function gmHardUpdateHud() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('gm-hard-score', gm.score);
  set('gm-hard-triaged', gm.triagedCount);
  set('gm-hard-wrong', gm.lostCount);
}

function gmHardTickTimer() {
  if (!gm.active) return;
  const el = document.getElementById('gm-hard-timer');
  const lbl = document.getElementById('gm-hard-timer-lbl');
  if (gm.bound === 'cards') {
    // Cards-bound HUD: progress against the card limit, no countdown.
    const cell = el?.parentElement;
    if (el)  el.textContent  = `${gm.triagedCount}/${gm.cardLimit}`;
    if (lbl) lbl.textContent = 'Cards';
    if (cell) cell.classList.remove('urgent');
    return;
  }
  const remainingMs = Math.max(0, gm.endTime - Date.now());
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (el) {
    el.textContent = `${m}:${String(s).padStart(2,'0')}`;
    const cell = el.parentElement;
    if (cell) cell.classList.toggle('urgent', totalSec <= 15);
  }
  if (lbl) lbl.textContent = 'Timer';
  if (Date.now() >= gm.endTime) gmEndGame();
}

/* ============================================================
   FOG OF WAR — memory under chaos.
   Each card cycles through two phases:
     1. REVEAL — patient card visible for 5-8 seconds. Read fast.
     2. PICK   — card disappears, tag picker appears with a 5-10s
                 timer. Pick from memory. No re-look.
   Reveal time scales mildly with content density (longer narrative
   = more reveal time). Pick window narrows as the round progresses
   to test cognitive endurance.
   ============================================================ */

const GM_FOG_REVEAL_MIN = 5000;  // ms — short cards
const GM_FOG_REVEAL_MAX = 8000;  // ms — content-heavy cards
const GM_FOG_PICK_START = 9000;  // ms — first card's pick timer
const GM_FOG_PICK_END   = 6000;  // ms — pick timer narrows toward this
const GM_FOG_PICK_EARLY = 2500;  // ms — tap-to-skip pick window (press your luck)

function gmStartFog() {
  gmReset();
  gm.subMode = 'fog';
  gm.active = true;
  gm.startTime = Date.now();
  gm.endTime = gm.startTime + gm.durationMs;
  gm.difficulty = 'hard-expert'; // mix of hard + expert content

  showScreen('screen-gm-fog');
  gmFogUpdateHud();
  gmFogNextPatient();

  gm.tickHandle = setInterval(gmFogTickRoundTimer, 250);
  if (gm.bound === 'time') {
    gm.endHandle = setTimeout(gmEndGame, gm.durationMs);
  }
}

function gmFogNextPatient() {
  if (!gm.active) return;
  const scenario = (window.generatePatient
    ? window.generatePatient(gm.difficulty)
    : window.generateDeck(1, gm.difficulty)[0]);
  // Reveal time scales with narrative length: more text = longer look.
  const len = (scenario.description || '').length + (scenario.respirations || '').length + (scenario.perfusion || '').length + (scenario.mental || '').length;
  let reveal = Math.min(GM_FOG_REVEAL_MAX, Math.max(GM_FOG_REVEAL_MIN, 4000 + len * 6));
  // Apneic patients need extra reveal time so the player has room to
  // do the airway maneuver (up to 2 attempts × ~1s each) AND still
  // get a full memorization window. Add 6s.
  const isApneic = (scenario.answer === 'black');
  if (isApneic) {
    reveal += 6000;
    scenario._origRespirations = scenario.respirations;
    scenario._origRationale    = scenario.rationale;
    scenario.respirations      = 'Apneic on initial assessment — airway has not been worked';
  }
  // Pick timer narrows over the round (cognitive endurance test).
  // Time-bound: scale by elapsed/duration. Cards-bound: scale by
  // tagged/cardLimit so the pressure ramps even without a clock.
  const progressFrac = (gm.bound === 'cards' && gm.cardLimit > 0)
    ? Math.min(1, (gm.triagedCount + gm.lostCount) / gm.cardLimit)
    : Math.min(1, (Date.now() - gm.startTime) / gm.durationMs);
  const pickMs = GM_FOG_PICK_START - (GM_FOG_PICK_START - GM_FOG_PICK_END) * progressFrac;

  gm.fogCurrent = {
    id: 'gf_' + (gm.patientSeq++),
    scenario,
    revealMs: reveal,
    pickMs,
    revealStart: Date.now(),
    cardStartTs: Date.now(), // for the per-card HUD timer
    pickDeadline: 0,
    answered: false,
    airway: isApneic ? { attempts: 0, resolved: false } : null,
  };
  gmFogShowReveal();
}

function gmFogShowReveal() {
  const p = gm.fogCurrent;
  if (!p) return;
  gm.fogPhase = 'reveal';
  $('gm-fog-pick').style.display = 'none';
  $('gm-fog-reveal').style.display = '';
  gmFogRenderRevealCard();
  // Animate the reveal countdown bar
  const fill = $('gm-fog-reveal-fill');
  if (fill) {
    fill.style.transition = 'none';
    fill.style.width = '100%';
    // force reflow so the next transition takes effect
    void fill.offsetWidth;
    fill.style.transition = `width ${p.revealMs}ms linear`;
    fill.style.width = '0%';
  }
  if (gm.fogRevealHandle) clearTimeout(gm.fogRevealHandle);
  gm.fogRevealHandle = setTimeout(gmFogShowPick, p.revealMs);
}

// Render the reveal card. Pulled out of gmFogShowReveal so the
// airway maneuver can re-render in place when its result is shown.
function gmFogRenderRevealCard() {
  const p = gm.fogCurrent;
  const card = $('gm-fog-card');
  if (!p || !card) return;
  const airwayHtml = (p.airway && !p.airway.resolved)
    ? `<div class="gm-fog-airway">
         <button class="gm-airway-btn-card" id="gm-fog-airway-btn">⊕ REPOSITION AIRWAY · ${2 - p.airway.attempts} ATTEMPT${(2 - p.airway.attempts) === 1 ? '' : 'S'} LEFT</button>
       </div>`
    : '';
  card.innerHTML = `
    <div class="gm-fog-narrative">${escapeHtml(p.scenario.description)}</div>
    <div class="gm-fog-divider"></div>
    <div class="gm-fog-vitals">
      <div class="gm-fog-v"><span class="k">R</span><span class="v">${escapeHtml(p.scenario.respirations)}</span></div>
      <div class="gm-fog-v"><span class="k">P</span><span class="v">${escapeHtml(p.scenario.perfusion)}</span></div>
      <div class="gm-fog-v"><span class="k">M</span><span class="v">${escapeHtml(p.scenario.mental)}</span></div>
    </div>
    ${airwayHtml}
  `;
  // Wire the airway button if present
  const btn = $('gm-fog-airway-btn');
  if (btn) btn.addEventListener('click', gmFogAirwayPress);
}

function gmFogAirwayPress() {
  const p = gm.fogCurrent;
  if (!p || !p.airway || p.airway.resolved) return;
  p.airway.attempts += 1;
  const isLast = p.airway.attempts >= 2;
  const breathingReturns = Math.random() < 0.5;
  const s = p.scenario;

  if (breathingReturns) {
    p.airway.resolved = true;
    const newRR = 14 + Math.floor(Math.random() * 8);
    s.respirations = `${newRR}/min, weak — spontaneous breathing returned after airway repositioning`;
    s.answer = 'red';
    s.rationale = `Apneic on arrival; airway repositioning restored spontaneous respirations at ${newRR}/min. IMMEDIATE (Red).`;
  } else if (isLast) {
    p.airway.resolved = true;
    s.respirations = 'No spontaneous respirations after two airway repositioning attempts';
    s.answer = 'black';
    s.rationale = 'After two airway repositioning attempts, no spontaneous respirations returned. DECEASED (Black).';
  } else {
    s.respirations = 'Attempt 1: head-tilt complete, no spontaneous respirations resumed';
  }
  gmFogRenderRevealCard();
}

function gmFogShowPick(overrideMs) {
  const p = gm.fogCurrent;
  if (!p || !gm.active) return;
  gm.fogPhase = 'pick';
  // Use override (set when player tapped the card to skip the reveal
  // — they pressed their luck, so they get a 2.5s window). Otherwise
  // fall back to the per-patient pickMs that was sized at spawn.
  const pickMs = overrideMs || p.pickMs;
  p.pickDeadline = Date.now() + pickMs;
  $('gm-fog-reveal').style.display = 'none';
  $('gm-fog-pick').style.display = '';
  // Reset + start pick countdown bar
  const fill = $('gm-fog-pick-fill');
  if (fill) {
    fill.style.transition = 'none';
    fill.style.width = '100%';
    void fill.offsetWidth;
    fill.style.transition = `width ${pickMs}ms linear`;
    fill.style.width = '0%';
  }
  // Tick the visible seconds counter
  if (gm.fogPickHandle) clearInterval(gm.fogPickHandle);
  gm.fogPickHandle = setInterval(() => {
    if (!gm.active || !gm.fogCurrent) return;
    const left = Math.max(0, p.pickDeadline - Date.now());
    const sec = (left / 1000).toFixed(1);
    const secsEl = $('gm-fog-pick-secs');
    if (secsEl) secsEl.textContent = sec + 's';
    if (left <= 0) {
      // Timeout = wrong
      gmFogTag(null);
    }
  }, 100);
}

function gmFogTag(tag) {
  const p = gm.fogCurrent;
  if (!p || !gm.active || p.answered) return;
  p.answered = true;
  if (gm.fogPickHandle) { clearInterval(gm.fogPickHandle); gm.fogPickHandle = null; }
  if (gm.fogRevealHandle) { clearTimeout(gm.fogRevealHandle); gm.fogRevealHandle = null; }

  // Airway-skip: if the patient was apneic and the player never
  // worked the airway during the reveal, force-mark the tag as wrong.
  // (The card has already disappeared by this point — they failed
  // the procedural check, not just the memory check.)
  if (p.airway && !p.airway.resolved && p.airway.attempts === 0) {
    p.scenario.answer = (tag === 'red') ? 'black' : 'red';
    p.scenario.rationale =
      'You skipped airway repositioning during the reveal. Apneic patients require the maneuver before tagging — RED if breathing returns, BLACK if not. You can\'t determine this from memory alone.';
    p.airway.resolved = true;
  }
  const correct = (tag === p.scenario.answer);
  let delta = 0;
  if (correct) {
    delta = (p.scenario.answer === 'red' ? 10 : 5);
    gm.saveCount += 1;
  } else {
    delta = -10;
    if (tag === null) gm.lostCount += 1; // ran out of time
  }
  gm.score += delta;
  gm.triagedCount += 1;
  if (!correct) gm.lostCount += (tag === null ? 0 : 1);

  gm.history.push({
    type: correct ? 'correct' : (tag === null ? 'lost' : 'wrong'),
    scenario: p.scenario,
    originalAnswer: p.scenario.answer,
    finalAnswer: p.scenario.answer,
    picked: tag || 'no-answer',
    atMs: Date.now() - gm.startTime,
    elapsedMs: 0,
    score: delta,
  });

  // Brief flash — flash the entire pick area red/green
  const pickEl = $('gm-fog-pick');
  if (pickEl) {
    pickEl.classList.add(correct ? 'flash-ok' : 'flash-bad');
    setTimeout(() => pickEl.classList.remove('flash-ok', 'flash-bad'), 380);
  }
  gm.fogCurrent = null;
  gmFogUpdateHud();
  // Cards-bound: end after the picked card limit (counts triaged + lost)
  if (gm.bound === 'cards' && (gm.triagedCount + gm.lostCount) >= gm.cardLimit) {
    setTimeout(() => { if (gm.active) gmEndGame(); }, 550);
    return;
  }
  // Brief pause then next patient
  setTimeout(() => {
    if (gm.active) gmFogNextPatient();
  }, 500);
}

function gmFogUpdateHud() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('gm-fog-score', gm.score);
  set('gm-fog-triaged', gm.triagedCount);
  set('gm-fog-wrong', gm.lostCount);
}

function gmFogTickRoundTimer() {
  if (!gm.active) return;
  const el = document.getElementById('gm-fog-timer');
  const lbl = document.getElementById('gm-fog-timer-lbl');
  if (gm.bound === 'cards') {
    const cell = el?.parentElement;
    if (el)  el.textContent  = `${gm.triagedCount}/${gm.cardLimit}`;
    if (lbl) lbl.textContent = 'Cards';
    if (cell) cell.classList.remove('urgent');
  } else {
    const remainingMs = Math.max(0, gm.endTime - Date.now());
    const totalSec = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (el) {
      el.textContent = `${m}:${String(s).padStart(2,'0')}`;
      const cell = el.parentElement;
      if (cell) cell.classList.toggle('urgent', totalSec <= 15);
    }
    if (lbl) lbl.textContent = 'Round';
    if (Date.now() >= gm.endTime) gmEndGame();
  }
  // Per-card elapsed timer (resets when next patient lands)
  const cardEl = document.getElementById('gm-fog-card-timer');
  if (cardEl && gm.fogCurrent && gm.fogCurrent.cardStartTs) {
    const cardSec = (Date.now() - gm.fogCurrent.cardStartTs) / 1000;
    cardEl.textContent = cardSec.toFixed(1) + 's';
  }
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
  // End of game? Time-bound only — cards-bound runs end inside the tag
  // and expire handlers, not on the clock.
  if (gm.bound === 'time' && gm.endTime > 0 && now >= gm.endTime) {
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

  // Chaos sudden-death — letting a patient deteriorate counts as a fail
  if (gm.subMode === 'chaos') {
    setTimeout(() => gmChaosTriggerFailure('expired'), 600);
    return;
  }
  // Cards-bound: a lost patient still counts toward the round's card budget
  if (gm.bound === 'cards' && (gm.triagedCount + gm.lostCount) >= gm.cardLimit) {
    setTimeout(() => { if (gm.active) gmEndGame(); }, 650);
  }
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
  // Airway-skip: tagging an apneic patient without working the airway
  // is the procedural failure being trained against. Force the answer
  // to something the player did NOT pick so the result registers as
  // wrong, then inject the corrective rationale.
  if (p.airway && !p.airway.resolved && p.airway.attempts === 0) {
    p.scenario.answer = (picked === 'red') ? 'black' : 'red';
    p.currentAnswer = p.scenario.answer;
    p.scenario.rationale =
      'You skipped airway repositioning on an apneic patient. START requires the head-tilt or jaw thrust BEFORE tagging — the maneuver is what tells you RED (breathing returns) from BLACK (still apneic). Tag based on the outcome of the maneuver, not on first impression.';
    p.airway.resolved = true;
  }
  const correct = (picked === p.currentAnswer);
  const elapsed = Date.now() - p.addedAt;
  let delta = 0;
  if (correct) {
    delta = GM_SCORE[picked] || 5;
    if (elapsed <= GM_SPEED_BONUS_MS) delta += GM_SPEED_BONUS;
    gm.saveCount += 1;
    gmFlashCard(p, 'ok');
    gmShowPopup(p, `+${delta}`, 'plus');
    // Chaos: track triage time per correct card for the speed leaderboard
    if (gm.subMode === 'chaos') gm.chaosTriageTimes.push(elapsed);
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

  // Chaos sudden-death — first wrong tag ends the run
  if (!correct && gm.subMode === 'chaos') {
    setTimeout(() => gmChaosTriggerFailure('wrong'), 600);
    return;
  }
  // Cards-bound: end after the picked card limit (counts both correct
  // tags and lost patients since both consume a "card" of the round).
  if (gm.bound === 'cards' && (gm.triagedCount + gm.lostCount) >= gm.cardLimit) {
    setTimeout(() => { if (gm.active) gmEndGame(); }, 650);
  }
}

// --- Render helpers ---

function gmVitalsHtml(s) {
  return `<span class="gm-v"><b>R</b>${escapeHtml(s.respirations)}</span>
          <span class="gm-v"><b>P</b>${escapeHtml(s.perfusion)}</span>
          <span class="gm-v"><b>M</b>${escapeHtml(s.mental)}</span>`;
}

// Inline airway-button row, rendered on apneic patients while the
// airway is unresolved. Click handled via event delegation on .gm-scene
// (see gmAirwayPressChaos below).
function gmAirwayRowHtml(p) {
  if (!p.airway || p.airway.resolved) return '';
  const left = 2 - p.airway.attempts;
  return `<div class="gm-card-airway">
    <button class="gm-airway-btn-card" data-airway>⊕ REPOSITION AIRWAY · ${left} ATTEMPT${left === 1 ? '' : 'S'} LEFT</button>
  </div>`;
}

// Random-outcome airway maneuver on a Chaos/Expert patient card.
// Mirrors the Training mechanic (50/50 per attempt, 2 attempts max).
// Updates the patient's scenario in place and re-renders the card's
// vitals + airway row to show the outcome.
function gmAirwayPressChaos(patientId) {
  const p = gm.patients.find(x => x.id === patientId);
  if (!p || !p.airway || p.airway.resolved) return;
  p.airway.attempts += 1;
  const isLast = p.airway.attempts >= 2;
  const breathingReturns = Math.random() < 0.5;
  const s = p.scenario;

  if (breathingReturns) {
    p.airway.resolved = true;
    const newRR = 14 + Math.floor(Math.random() * 8);
    s.respirations = `${newRR}/min, weak — spontaneous breathing returned after airway repositioning`;
    s.answer = 'red';
    s.rationale = `Apneic on arrival; airway repositioning restored spontaneous respirations at ${newRR}/min. Tag IMMEDIATE (Red) — salvageable but unstable.`;
    p.currentAnswer = 'red';
    p.originalAnswer = 'red';
  } else if (isLast) {
    p.airway.resolved = true;
    s.respirations = 'No spontaneous respirations after two airway repositioning attempts';
    s.answer = 'black';
    s.rationale = 'After two airway repositioning attempts, no spontaneous respirations returned. Tag DECEASED (Black) and move on.';
    p.currentAnswer = 'black';
  } else {
    s.respirations = 'Attempt 1: head-tilt complete, no spontaneous respirations resumed';
  }

  // Re-render the card's vitals + airway row in place
  const el = document.querySelector(`.gm-patient[data-id="${p.id}"]`);
  if (el) {
    const v = el.querySelector('.gm-vitals');
    if (v) v.innerHTML = gmVitalsHtml(s);
    const oldAirway = el.querySelector('.gm-card-airway');
    const newHtml = gmAirwayRowHtml(p);
    if (oldAirway) {
      if (newHtml) {
        // Replace its contents with the updated button (attempts left)
        oldAirway.outerHTML = newHtml;
      } else {
        oldAirway.remove();
      }
    }
  }
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
    ${gmAirwayRowHtml(p)}
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
  const el = document.getElementById('gm-timer');
  const lbl = document.getElementById('gm-timer-lbl');
  if (gm.bound === 'cards') {
    const cell = el?.parentElement;
    if (el)  el.textContent  = `${gm.triagedCount}/${gm.cardLimit}`;
    if (lbl) lbl.textContent = 'Cards';
    if (cell) cell.classList.remove('urgent');
    return;
  }
  const remainingMs = Math.max(0, gm.endTime - Date.now());
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (el) {
    el.textContent = `${m}:${String(s).padStart(2,'0')}`;
    const cell = el.parentElement;
    if (cell) cell.classList.toggle('urgent', totalSec <= 15);
  }
  if (lbl) lbl.textContent = 'Timer';
}

// --- End of game + AAR ---

// Halt a Game Mode round in progress and write the player's CURRENT
// stats to Firebase, without showing the per-player results screen.
// Called when the lobby flips to 'ended' from outside (instructor cut
// the round off). The caller routes to the leaderboard.
function gmAbortAndSnapshot() {
  if (!gm.active) return;
  gm.active = false;
  if (gm.tickHandle)      { clearInterval(gm.tickHandle);      gm.tickHandle = null; }
  if (gm.spawnHandle)     { clearTimeout(gm.spawnHandle);      gm.spawnHandle = null; }
  if (gm.endHandle)       { clearTimeout(gm.endHandle);        gm.endHandle = null; }
  if (gm.fogRevealHandle) { clearTimeout(gm.fogRevealHandle);  gm.fogRevealHandle = null; }
  if (gm.fogPickHandle)   { clearInterval(gm.fogPickHandle);   gm.fogPickHandle = null; }
  if (gm.classroomMode && state.mpCode && state.mpMyId) {
    const updates = {};
    updates[`players/${state.mpMyId}/correct`]   = gm.saveCount || 0;
    updates[`players/${state.mpMyId}/wrong`]     = (gm.triagedCount + gm.lostCount) - (gm.saveCount || 0);
    updates[`players/${state.mpMyId}/totalTime`] = Math.round((Date.now() - gm.startTime) / 1000);
    updates[`players/${state.mpMyId}/progress`]  = (gm.triagedCount || 0);
    updates[`players/${state.mpMyId}/finished`]  = true;
    updates['lastActivity'] = firebase.database.ServerValue.TIMESTAMP;
    fbLobbyRef(state.mpCode).update(updates).catch(() => {});
  }
}

// Same idea for a Training round — halt the per-card engine and write
// the player's CURRENT correct/wrong/totalTime/progress to Firebase.
function trainingAbortAndSnapshot() {
  const g = state.game;
  if (!g) return;
  if (typeof stopGameTicker === 'function') stopGameTicker();
  if (typeof stopRoundTimer === 'function') stopRoundTimer();
  if ((g.mode === 'mp-host' || g.mode === 'mp-guest') && state.mpCode && state.mpMyId) {
    const updates = {};
    updates[`players/${state.mpMyId}/correct`]   = g.correct;
    updates[`players/${state.mpMyId}/wrong`]     = g.wrong;
    updates[`players/${state.mpMyId}/totalTime`] = g.totalTime;
    updates[`players/${state.mpMyId}/progress`]  = g.correct + g.wrong;
    updates[`players/${state.mpMyId}/finished`]  = true;
    updates['lastActivity'] = firebase.database.ServerValue.TIMESTAMP;
    fbLobbyRef(state.mpCode).update(updates).catch(() => {});
  }
  state.game = null;
}

function gmEndGame() {
  if (!gm.active) return;
  gm.active = false;
  if (gm.tickHandle)  { clearInterval(gm.tickHandle);  gm.tickHandle = null; }
  if (gm.spawnHandle) { clearTimeout(gm.spawnHandle);  gm.spawnHandle = null; }
  if (gm.endHandle)   { clearTimeout(gm.endHandle);    gm.endHandle = null; }
  gmRenderResults();

  // CLASSROOM MODE: this player's run is done — write a final score
  // payload to Firebase and stay on the personal results screen
  // (with misses-review). The lobby-listener "all done → 'ended'"
  // logic will route everyone to the unified leaderboard once the
  // last player finishes.
  if (gm.classroomMode && state.mpCode && state.mpMyId) {
    const updates = {};
    updates[`players/${state.mpMyId}/correct`] = gm.saveCount || 0;
    updates[`players/${state.mpMyId}/wrong`]   = (gm.triagedCount + gm.lostCount) - (gm.saveCount || 0);
    updates[`players/${state.mpMyId}/totalTime`] = Math.round((Date.now() - gm.startTime) / 1000);
    updates[`players/${state.mpMyId}/progress`] = (gm.triagedCount || 0);
    updates[`players/${state.mpMyId}/finished`] = true;
    updates['lastActivity'] = firebase.database.ServerValue.TIMESTAMP;
    // NOTE: don't write per-player `score` or `gameType` here — they're
    // not in the legacy player-record rules ($other validates false), so
    // including them would cause the WHOLE atomic update to fail with
    // PERMISSION_DENIED. Leaderboard ranks by correct desc, totalTime asc
    // (gameType is at lobby level; raw score is recoverable from correct).
    fbLobbyRef(state.mpCode).update(updates).catch(() => {});
  }

  showScreen('screen-gm-results');
}

function gmRenderResults() {
  const elapsedSec = Math.round((Date.now() - gm.startTime) / 1000);
  const totalDecisions = gm.triagedCount + gm.lostCount;
  const acc = totalDecisions > 0 ? Math.round((gm.saveCount / totalDecisions) * 100) : 0;

  // CHAOS post-processing: when the round ends naturally (timer ran
  // out without failure), populate the speed stats now since
  // gmChaosTriggerFailure didn't fire to set them.
  if (gm.subMode === 'chaos' && !gm.chaosFailed) {
    gm.chaosCorrectCount = gm.saveCount;
    const avgMs = (gm.chaosTriageTimes.length > 0)
      ? (gm.chaosTriageTimes.reduce((s, x) => s + x, 0) / gm.chaosTriageTimes.length)
      : 0;
    gm.chaosAvgMs = avgMs;
    // Update best-time leaderboard for SURVIVED runs only
    const key = 'triageit.chaos.bestTime';
    const prevBest = parseFloat(localStorage.getItem(key) || '0');
    const isNewBest = (gm.chaosCorrectCount >= 5) && (prevBest === 0 || avgMs < prevBest);
    if (isNewBest) {
      try { localStorage.setItem(key, String(avgMs)); } catch (e) {}
    }
    gm.chaosBestMs = isNewBest ? avgMs : prevBest;
    gm.chaosIsNewBest = isNewBest;
  }

  // Grading is now uniform across all 5 game types: based on accuracy
  // (correct count / total decisions). Speed isn't part of the grade
  // formula — speed shows up in the final-line stats and as the
  // tiebreaker on the unified leaderboard. Chaos still gets a small
  // bump for surviving the full clock since that's a meaningful
  // outcome distinct from raw accuracy.
  let grade = 'F';
  if (acc >= 95 && gm.lostCount === 0) grade = 'S';
  else if (acc >= 90)                  grade = 'A';
  else if (acc >= 80)                  grade = 'B';
  else if (acc >= 70)                  grade = 'C';
  else if (acc >= 60)                  grade = 'D';
  if (gm.subMode === 'chaos' && !gm.chaosFailed && grade === 'B') grade = 'A'; // bump for survival

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
  // Final SCORE = correct answers (consistent across all modes — solo,
  // multiplayer, classroom). Tiebreaker is fastest time.
  $('gm-final-score').textContent = gm.saveCount || 0;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;

  // CHAOS — replace the sub-line with speed/best-time stats
  if (gm.subMode === 'chaos') {
    const avgSec = ((gm.chaosAvgMs || 0) / 1000).toFixed(2);
    const bestSec = ((gm.chaosBestMs || 0) / 1000).toFixed(2);
    const newBestTag = gm.chaosIsNewBest ? ' · NEW BEST!' : '';
    const outcomeTag = gm.chaosFailed
      ? `ended on ${gm.chaosFailureReason === 'expired' ? 'patient lost on watch' : 'wrong tag'}`
      : 'SURVIVED THE FULL ROUND';
    $('gm-final-line').textContent =
      `${avgSec}s avg · best ${bestSec}s${newBestTag} · ${outcomeTag}`;
  } else {
    $('gm-final-line').textContent = `${m}:${String(s).padStart(2,'0')} elapsed · ${gm.triagedCount} triaged · ${gm.saveCount} correct`;
  }

  $('gm-acc').textContent = acc + '%';
  $('gm-saved').textContent = gm.saveCount;
  $('gm-deaths').textContent = gm.lostCount;

  // Quip: Chaos uses its own pools (death OR survive), others use grade quips
  const roastEl = $('gm-roast');
  if (roastEl) {
    let chaosQuip = '';
    if (gm.subMode === 'chaos') {
      if (gm.chaosFailed && gm.chaosDeathQuip) {
        chaosQuip = gm.chaosDeathQuip;
      } else if (!gm.chaosFailed) {
        // Survived — pick from the survive pool
        const pool = CHAOS_SURVIVE_QUIPS;
        chaosQuip = pool[Math.floor(Math.random() * pool.length)]
          .replace(/\{N\}/g, gm.chaosCorrectCount || 0);
      }
    }
    if (chaosQuip) {
      roastEl.textContent = chaosQuip;
      roastEl.className = 'result-roast grade-' + (gm.chaosFailed ? 'F' : (grade === 'F' ? 'D' : grade));
      roastEl.style.display = '';
    } else {
      const pool = GRADE_QUIPS[grade];
      if (pool && pool.length) {
        roastEl.textContent = pool[Math.floor(Math.random() * pool.length)];
        roastEl.className = 'result-roast grade-' + grade;
        roastEl.style.display = '';
      } else {
        roastEl.style.display = 'none';
      }
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
  // Round-type toggle — TIME vs CARDS. Swaps which picker is visible.
  qsa('#gm-bound-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('#gm-bound-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      gm.bound = btn.dataset.bound || 'time';
      const lenWrap = $('gm-length-wrap');
      const cardWrap = $('gm-cards-wrap');
      if (gm.bound === 'cards') {
        if (lenWrap)  lenWrap.style.display  = 'none';
        if (cardWrap) cardWrap.style.display = '';
      } else {
        if (lenWrap)  lenWrap.style.display  = '';
        if (cardWrap) cardWrap.style.display = 'none';
      }
    });
  });

  // Length picker — applies when bound is TIME. CHAOS uses it as the
  // survive-the-clock countdown.
  qsa('#gm-length-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#gm-length-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      gm.durationMs = parseInt(opt.dataset.length, 10) * 1000;
    });
  });

  // Card-count picker — applies when bound is CARDS.
  qsa('#gm-cards-options .option').forEach(opt => {
    opt.addEventListener('click', () => {
      qsa('#gm-cards-options .option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      gm.cardLimit = parseInt(opt.dataset.count, 10) || 25;
      const customEl = $('gm-cards-custom');
      if (customEl) customEl.value = '';  // clear custom on preset pick
    });
  });
  // Custom card-count input — overrides the preset (1-500)
  $('gm-cards-custom')?.addEventListener('input', (e) => {
    const n = parseInt(e.target.value, 10);
    if (!isNaN(n) && n >= 1 && n <= 500) {
      qsa('#gm-cards-options .option').forEach(o => o.classList.remove('selected'));
      gm.cardLimit = n;
    }
  });

  // Sub-mode toggle buttons — mutually exclusive selection (Hard/Expert
  // pattern from Training). Selection just toggles state; BEGIN DRILL
  // starts the run.
  const gmModeButtons = ['gm-mode-chaos', 'gm-mode-fog'];
  const gmModeBlurbs = {
    chaos: 'CHAOS · Sudden death. One wrong tag ends the run. Survive the full clock to set a record on fastest avg triage time.',
    fog:   'FOG OF WAR · Each patient visible for a few seconds, then disappears. Tag from memory in 5-10s. Tests recall under pressure.',
  };
  gmModeButtons.forEach(id => {
    $(id)?.addEventListener('click', () => {
      const btn = $(id);
      const wasActive = btn.dataset.active === 'true';
      // Deselect all first (mutually exclusive)
      gmModeButtons.forEach(otherId => {
        const other = $(otherId);
        if (!other) return;
        other.dataset.active = 'false';
        other.classList.remove('active');
      });
      // Re-activate unless we're toggling off the one we just clicked
      const descEl = $('gm-mode-desc-line');
      if (!wasActive) {
        btn.dataset.active = 'true';
        btn.classList.add('active');
        gm.subMode = btn.dataset.submode;
        if (descEl) descEl.textContent = gmModeBlurbs[gm.subMode] || '';
      } else {
        gm.subMode = null;
        if (descEl) descEl.textContent = 'Pick a difficulty to see what it tests.';
      }
      refreshTopbar();
    });
  });

  // BEGIN DRILL button — only fires once a difficulty is selected
  $('gm-start')?.addEventListener('click', () => {
    if (gm.subMode !== 'chaos' && gm.subMode !== 'fog') {
      toast('Pick a difficulty first');
      return;
    }
    gm.classroomMode = false;  // standalone Game Mode is solo, not classroom
    // Re-read both pickers from DOM so the live selection wins even if a
    // listener missed (e.g. user tabbed instead of clicked).
    const tsel = document.querySelector('#gm-length-options .option.selected');
    if (tsel) gm.durationMs = parseInt(tsel.dataset.length, 10) * 1000;
    const csel = document.querySelector('#gm-cards-options .option.selected');
    if (csel) gm.cardLimit = parseInt(csel.dataset.count, 10) || 25;
    const tbtn = document.querySelector('#gm-bound-toggle button.active');
    if (tbtn) gm.bound = tbtn.dataset.bound || 'time';
    gmStartGame();
  });

  // End early
  $('gm-end-early')?.addEventListener('click', () => {
    if (!gm.active) return;
    if (confirm('End the drill now?')) gmEndGame();
  });

  // Replay / home from results
  $('gm-replay')?.addEventListener('click', () => {
    // Classroom: stay put; the host runs the next drill from the
    // unified leaderboard, which pulls everyone back to lobby.
    if (gm.classroomMode) {
      toast('Waiting for instructor to start another drill');
      return;
    }
    showScreen('screen-gm-setup');
  });
  $('gm-home')?.addEventListener('click', () => {
    // Classroom: leaving Game Mode mid-classroom = leave the lobby
    if (gm.classroomMode) {
      teardownMp();
      state.history = ['screen-home'];
      gm.classroomMode = false;
      showScreen('screen-home', false);
      return;
    }
    showScreen('screen-home');
  });

  // Per-card scene events — tag button OR airway button. Single
  // delegated listener keeps things cheap with up to 4 patients on
  // screen, each with up to 5 buttons (4 tags + 1 airway).
  $('gm-scene')?.addEventListener('click', (e) => {
    const card = e.target.closest('.gm-patient');
    if (!card) return;
    const airwayBtn = e.target.closest('[data-airway]');
    if (airwayBtn) {
      gmAirwayPressChaos(card.dataset.id);
      return;
    }
    const tagBtn = e.target.closest('.gm-tag');
    if (tagBtn) {
      gmTagPatient(card.dataset.id, tagBtn.dataset.tag);
    }
  });

  // ---- Hard Mode controls ----
  $('gm-hard-airway-btn')?.addEventListener('click', gmHardAirway);
  qsa('#gm-hard-tagrow .t-btn').forEach(btn => {
    btn.addEventListener('click', () => gmHardTag(btn.dataset.tag));
  });
  $('gm-hard-end-early')?.addEventListener('click', () => {
    if (!gm.active) return;
    if (confirm('End the drill now?')) gmEndGame();
  });

  // ---- Fog of War controls ----
  qsa('.gm-fog-tagrow .t-btn').forEach(btn => {
    btn.addEventListener('click', () => gmFogTag(btn.dataset.tag));
  });
  $('gm-fog-end-early')?.addEventListener('click', () => {
    if (!gm.active) return;
    if (confirm('End the drill now?')) gmEndGame();
  });
  // Tap-to-answer-early: clicking the reveal card commits to memorize
  // and skips straight to the pick phase — but the player is on a
  // SHORT 2.5s clock, not the normal 6-9s window. Press your luck:
  // tap when you know it; eat the truncated timer if you don't.
  // The airway button handles its own click and bubbles, so we ignore
  // those — only the card surface itself is the skip trigger.
  $('gm-fog-reveal')?.addEventListener('click', (e) => {
    if (gm.fogPhase !== 'reveal') return;
    if (e.target.closest('.gm-airway-btn-card')) return;
    gmFogShowPick(GM_FOG_PICK_EARLY);
  });

  // Initialize default duration + card limit from selected options
  const sel = document.querySelector('#gm-length-options .option.selected');
  if (sel) gm.durationMs = parseInt(sel.dataset.length, 10) * 1000;
  const csel = document.querySelector('#gm-cards-options .option.selected');
  if (csel) gm.cardLimit = parseInt(csel.dataset.count, 10) || 25;
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
