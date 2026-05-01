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
  // Difficulty values:
  //   'normal'      — standard MCI mix (greens, yellows, reds, blacks)
  //   'hard'        — borderline RED-vs-BLACK judgment calls (no greens)
  //   'expert'      — standard mix + sudden-death scoring (one wrong = over)
  //   'hard-expert' — borderline calls AND sudden death stacked
  // Hard scenarios are unlocked when difficulty contains 'hard' (either alone or combined).
  const useHardDeck = difficulty === 'hard' || difficulty === 'hard-expert';
  const genDifficulty = useHardDeck ? 'veteran' : 'normal';
  return generateDeck(count, genDifficulty);
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
  $('mp-join-confirm').addEventListener('click', () => {
    const code = $('mp-join-code').value.trim().toUpperCase();
    if (code.length !== 4) { toast('Enter 4-letter code'); return; }
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
  // Decision-speed slider — instructor drags between 5-30 seconds.
  // OFF button disables the per-card timer entirely.
  // Writes are throttled on `change` (released drag), not `input`, to avoid
  // hammering Firebase as the slider moves.
  $('dash-speed-slider')?.addEventListener('input', (e) => {
    const secs = parseInt(e.target.value, 10);
    const lbl = $('dash-speed-value');
    if (lbl) lbl.textContent = secs + 's';
  });
  $('dash-speed-slider')?.addEventListener('change', (e) => {
    if (state.mpRole !== 'instructor' || !state.mpCode) return;
    const secs = parseInt(e.target.value, 10);
    fbLobbyRef(state.mpCode).child('decisionTimerSec').set(secs).catch(() => {});
  });
  $('dash-speed-off')?.addEventListener('click', () => {
    if (state.mpRole !== 'instructor' || !state.mpCode) return;
    fbLobbyRef(state.mpCode).child('decisionTimerSec').set(0).catch(() => {});
    // Update the UI immediately so the instructor sees the change without
    // waiting for the Firebase round-trip to call renderDashboard.
    const lbl = $('dash-speed-value');
    if (lbl) lbl.textContent = 'OFF';
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
  $('mp-join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

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

  // HUD: show or hide live board for multiplayer
  $('live-board-wrap').style.display =
    (mode === 'mp-host' || mode === 'mp-guest') ? 'block' : 'none';

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

  $('hud-card').textContent = `${g.idx + 1}/${g.deck.length}`;
  $('hud-correct').textContent = g.correct;
  $('hud-wrong').textContent = g.wrong;
  $('hud-streak').textContent = g.streak;
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

  // Render live board for multiplayer
  if (g.mode === 'mp-host' || g.mode === 'mp-guest') renderLiveBoard();

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

  // Render verdict on card back
  const info = TRIAGE_INFO[card.answer];
  const back = $('card-back');
  back.style.background = info.color;
  back.style.color = info.ink;

  const lbl = $('verdict-label');
  lbl.textContent = info.label;
  lbl.style.color = info.ink;
  lbl.style.webkitTextFillColor = info.ink;  // override gradient clip
  lbl.style.background = 'none';

  const vc = $('verdict-correct');
  if (correct) {
    vc.textContent = "CORRECT";
    vc.classList.remove('no'); vc.classList.add('ok');
  } else {
    vc.textContent = `WRONG · YOU PICKED ${TRIAGE_INFO[tag].short}`;
    vc.classList.remove('ok'); vc.classList.add('no');
  }

  const rat = $('verdict-rationale');
  rat.textContent = card.rationale;
  rat.style.color = info.ink;
  rat.style.webkitTextFillColor = info.ink;  // override gradient clip
  rat.style.background = 'none';
  rat.style.opacity = '1';

  $('card').classList.add('flipped');

  // Update HUD with streak feedback
  $('hud-correct').textContent = g.correct;
  $('hud-wrong').textContent = g.wrong;
  $('hud-streak').textContent = g.streak;
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

  // Send progress in multiplayer (write directly to Firebase)
  if ((g.mode === 'mp-host' || g.mode === 'mp-guest') && state.mpCode && state.mpMyId) {
    const updates = {};
    updates[`players/${state.mpMyId}/correct`] = g.correct;
    updates[`players/${state.mpMyId}/wrong`] = g.wrong;
    updates[`players/${state.mpMyId}/totalTime`] = g.totalTime;
    updates[`players/${state.mpMyId}/progress`] = g.idx + 1;
    // EXPERT MODE in multiplayer: a wrong answer ends THIS player's run.
    // Mark them finished so others see they're done.
    const expertFail = (!correct && isExpertDeath(g.difficulty));
    updates[`players/${state.mpMyId}/finished`] = expertFail || (g.idx + 1 >= g.deck.length);
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

    // If everyone is now finished, flip lobby status to 'ended'.
    // - Multiplayer: only the host triggers this (classic behavior).
    // - Classroom: the instructor never plays, so any guest finishing
    //   their last card needs to be allowed to flip the status.
    const meDone = expertFail || (g.idx + 1 >= g.deck.length);
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
    // EXPERT MODE: a wrong answer ends the game immediately with a fatal incident
    if (!correct && isExpertDeath(g.difficulty)) {
      g.expertFailed = true;
      g.fatalIncident = window.generateFatalIncident();
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

  // Solo review-misses button
  const soloReviewBtn = $('solo-review-btn');
  if (g.mode === 'solo') {
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
  // Sort: most correct first, fastest time as tiebreaker
  const players = state.mpPlayers.slice();
  players.sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    return a.totalTime - b.totalTime;
  });

  const allDone = state.mpPlayers.length > 0 && state.mpPlayers.every(p => p.finished);
  let html = '';

  if (allDone) {
    // Big completion banner
    html += `
      <div class="mp-complete-banner">
        <div class="mp-complete-tag">DRILL COMPLETE</div>
        <div class="mp-complete-title">ALL PLAYERS FINISHED</div>
        <div class="mp-complete-sub">${state.mpPlayers.length} ${state.mpPlayers.length === 1 ? 'player' : 'players'} · final results below</div>
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
    const finishedCount = state.mpPlayers.filter(p => p.finished).length;
    html += `
      <div class="mp-progress-banner">
        <div class="mp-progress-spinner"></div>
        <div class="mp-progress-text">
          <div class="mp-progress-title">WAITING FOR OTHER PLAYERS</div>
          <div class="mp-progress-sub">${finishedCount} of ${state.mpPlayers.length} finished</div>
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
  const totalMissCount = state.mpPlayers.reduce((s, p) => s + (p.misses || []).length, 0);
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

  // Sync decision-speed slider to current lobby setting (in case it was changed
  // elsewhere, e.g. on a different device). Slider holds a 5-30s value; the
  // separate "OFF" indicator handles the timer-disabled case.
  const speedSlider = $('dash-speed-slider');
  const speedValue = $('dash-speed-value');
  const speedOff = $('dash-speed-off');
  if (speedSlider && speedValue) {
    const cur = state.decisionTimerSec || 0;
    if (cur > 0) {
      speedSlider.value = Math.max(5, Math.min(30, cur));
      speedValue.textContent = cur + 's';
      if (speedOff) speedOff.classList.remove('on');
    } else {
      speedValue.textContent = 'OFF';
      if (speedOff) speedOff.classList.add('on');
      // Slider stays at its last position visually so the instructor's reference
      // point doesn't reset when toggling OFF/back-on.
    }
  }

  const deckSize = (state.mpDeck && state.mpDeck.length) || state.mpDeckCount || 1;

  // One row per player. Show score, pace, current card.
  const rows = players.map(p => {
    const pct = Math.min(100, Math.round((p.progress / deckSize) * 100));
    const totalAns = p.correct + p.wrong;
    const accuracy = totalAns > 0 ? Math.round((p.correct / totalAns) * 100) : 0;
    const teamTxt = p.team ? `<span class="dash-team team-${p.team.toLowerCase()}">${p.team}</span>` : '';
    const statusTxt = p.finished
      ? `<span class="dash-status done">✓ FINISHED</span>`
      : `<span class="dash-status active">CARD ${p.progress + 1}/${deckSize}</span>`;
    return `<div class="dash-row ${p.finished ? 'finished' : ''}">
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

  // Try up to 5 times to find a free 4-letter code
  let code, ok = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = rand4Letters();
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

  // Auto-remove our player record on disconnect
  fbPlayerRef(code, state.mpMyId).onDisconnect().remove();

  $('mp-join-status').textContent = 'CONNECTED · IN LOBBY';
  $('mp-join-status').className = 'status-line connected';

  showScreen('screen-mp-lobby');
  subscribeLobby(code);
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
    state.decisionTimerSec = lobby.decisionTimerSec || 0;
    // Cache the current/last deck so the misses-review screen can look up cards
    if (Array.isArray(lobby.deck) && lobby.deck.length > 0) {
      state.mpDeck = lobby.deck;
    }

    // Convert players object → ordered array. Track isInstructor.
    const players = lobby.players ? Object.entries(lobby.players).map(([id, p]) => ({
      id, name: p.name, team: p.team, isHost: !!p.isHost,
      isInstructor: !!p.isInstructor,
      correct: p.correct || 0, wrong: p.wrong || 0,
      totalTime: p.totalTime || 0, progress: p.progress || 0,
      finished: !!p.finished,
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
        renderDashboard();
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
    if (lobby.status === 'playing' && lobby.deck && state.game && state.game.mode !== 'mp-host' && state.game.mode !== 'mp-guest') {
      // We're a guest who hasn't started yet
      const deck = lobby.deck;
      if (Array.isArray(deck) && deck.length > 0) {
        startGame({ deck, mode: 'mp-guest', difficulty: state.mpDifficulty });
      }
    } else if (lobby.status === 'playing' && lobby.deck && !state.game) {
      // Already routed to lobby, but no game yet — start now
      const deck = lobby.deck;
      if (Array.isArray(deck) && deck.length > 0) {
        const myMode = (state.mpRole === 'host') ? 'mp-host' : 'mp-guest';
        startGame({ deck, mode: myMode, difficulty: state.mpDifficulty });
      }
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

    // Re-render UI
    if (state.currentScreen === 'screen-mp-lobby') renderLobby();
    if (state.currentScreen === 'screen-game') renderLiveBoard();
    if (state.currentScreen === 'screen-results') showMpLeaderboard();
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
