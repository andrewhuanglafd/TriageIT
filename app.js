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
  spDifficulty: 'normal',  // 'normal' | 'veteran'

  // Multiplayer (Firebase Realtime DB)
  mpName: '',
  mpRole: null,           // 'host' | 'guest'
  mpCode: null,
  mpMode: 'ffa',          // 'ffa' | 'team'
  mpDeckCount: 25,
  mpDifficulty: 'normal', // 'normal' | 'veteran'
  mpPlayers: [],          // [{id,name,team,isHost,correct,wrong,totalTime,progress,finished}]
  mpMyId: null,
  mpListener: null,       // active firebase .on('value') callback ref
  mpListenerRef: null,    // database ref the listener is attached to
  mpDeck: null,           // cached current/last deck for misses-review

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
  // Procedural generation: every call produces a fresh, unique deck
  // with a balanced mix of GREEN/RED/YELLOW/BLACK scenarios.
  // Reshuffles between games never repeat — narratives, vitals, and
  // patient details are randomized on each invocation.
  // `difficulty` may be 'veteran' to engage the harder weight set.
  return generateDeck(count, difficulty);
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
    const difficulty = $('sp-veteran')?.checked ? 'veteran' : 'normal';
    state.spDifficulty = difficulty;
    startGame({ deck: buildDeck(n, difficulty), mode: 'solo', difficulty });
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
    });
  });
  // Veteran-mode toggle (host only — checkbox only exists in host UI)
  $('mp-veteran')?.addEventListener('change', (e) => {
    setMpDifficulty(e.target.checked ? 'veteran' : 'normal');
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
});

/* ============================================================
   4. GAME ENGINE
   ============================================================ */

function startGame({ deck, mode }) {
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
    mode                  // 'solo' | 'mp-host' | 'mp-guest'
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
}

function onTagPick(tag) {
  const g = state.game;
  if (!g || !g.cardStartTs) return;

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
    updates[`players/${state.mpMyId}/finished`] = (g.idx + 1 >= g.deck.length);
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
      // Use child push key so multiple misses don't overwrite each other
      const missKey = `m_${g.idx}`;
      updates[`players/${state.mpMyId}/misses/${missKey}`] = missEntry;
    }
    fbLobbyRef(state.mpCode).update(updates).catch(err => {
      console.error('Progress update failed', err);
    });

    // If host AND all players are now finished, flip lobby status to 'ended'
    if (g.mode === 'mp-host' && (g.idx + 1 >= g.deck.length)) {
      const allDone = state.mpPlayers.every(p => {
        if (p.id === state.mpMyId) return true; // we just set ourselves finished
        return p.finished;
      });
      if (allDone) {
        fbLobbyRef(state.mpCode).child('status').set('ended').catch(() => {});
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

  // Review-misses CTA: show only when game is fully done and someone has misses
  const myMisses = (state.mpPlayers.find(p => p.id === state.mpMyId)?.misses || []);
  const anyMisses = state.mpPlayers.some(p => (p.misses || []).length > 0);
  if (allDone && anyMisses) {
    html += `<button class="btn-ghost" id="review-misses-btn" style="margin-top:6px">REVIEW MISSED CARDS (${myMisses.length} YOURS · ${state.mpPlayers.reduce((s,p)=>s+(p.misses||[]).length,0)} TOTAL)</button>`;
  }

  $('mp-leaderboard').innerHTML = html;
  $('mp-leaderboard').style.display = 'block';

  // Wire up the review button after innerHTML is set
  const rb = document.getElementById('review-misses-btn');
  if (rb) rb.addEventListener('click', () => showReviewScreen());
}

function winsBadge(p) {
  const w = p.wins || 0;
  if (w < 1) return '';
  if (w === 1) return `<span class="lb-wins">WINNER</span>`;
  return `<span class="lb-wins lb-wins-multi">${w}× WINNER</span>`;
}

/* ============================================================
   REVIEW MISSED CARDS — multiplayer post-game
   Shows every missed card across all players with the patient
   narrative, the correct tag, what was picked, and the rationale.
   ============================================================ */

function showReviewScreen(modeOverride) {
  const isSolo = modeOverride === 'solo' || (state.game && state.game.mode === 'solo');
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
    // Multiplayer: aggregate misses across all players
    if (!state.mpDeck || !state.mpDeck.length) {
      toast('No deck data to review');
      return;
    }
    deck = state.mpDeck;
    byCard = {};
    state.mpPlayers.forEach(p => {
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
      <div class="review-tag">REVIEW · MISSED CARDS</div>
      <div class="review-title">${indices.length} CARD${indices.length > 1 ? 'S' : ''} TO REVIEW</div>
      <div class="review-sub">Tap any card to expand the explanation</div>
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

async function createLobby() {
  teardownMp();
  state.mpRole = 'host';
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
        // Check ttl: if it exists and is stale, we'll overwrite anyway
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

  // Build initial lobby document with the host as first player
  const initial = {
    hostName: state.mpName,
    mode: state.mpMode || 'ffa',
    deckCount: state.mpDeckCount || 25,
    status: 'lobby',
    lastActivity: firebase.database.ServerValue.TIMESTAMP,
    players: {
      [state.mpMyId]: {
        name: state.mpName,
        team: null,
        isHost: true,
        correct: 0, wrong: 0, totalTime: 0, progress: 0, finished: false
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

  // Compose player record
  const playerCount = lobby.players ? Object.keys(lobby.players).length : 0;
  const team = (lobby.mode === 'team') ? (playerCount % 2 === 0 ? 'A' : 'B') : null;
  const playerRecord = {
    name: state.mpName,
    team: team,
    isHost: false,
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
    // Cache the current/last deck so the misses-review screen can look up cards
    if (Array.isArray(lobby.deck) && lobby.deck.length > 0) {
      state.mpDeck = lobby.deck;
    }

    // Convert players object → ordered array (host first, then by name)
    const players = lobby.players ? Object.entries(lobby.players).map(([id, p]) => ({
      id, name: p.name, team: p.team, isHost: !!p.isHost,
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

    // GAME START: status flipped to playing and we have a deck
    if (lobby.status === 'playing' && lobby.deck && state.game && state.game.mode !== 'mp-host' && state.game.mode !== 'mp-guest') {
      // We're a guest who hasn't started yet
      const deck = lobby.deck;
      if (Array.isArray(deck) && deck.length > 0) {
        startGame({ deck, mode: 'mp-guest' });
      }
    } else if (lobby.status === 'playing' && lobby.deck && !state.game) {
      // Already routed to lobby, but no game yet — start now
      const deck = lobby.deck;
      if (Array.isArray(deck) && deck.length > 0) {
        const myMode = (state.mpRole === 'host') ? 'mp-host' : 'mp-guest';
        startGame({ deck, mode: myMode });
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
  if (state.mpRole !== 'host') return;
  if (state.mpPlayers.length < 1) { toast('Need at least one player'); return; }

  const difficulty = $('mp-veteran')?.checked ? 'veteran' : 'normal';
  const deck = buildDeck(state.mpDeckCount, difficulty);

  // Reset all player stats
  const playerUpdates = {};
  state.mpPlayers.forEach(p => {
    playerUpdates[`players/${p.id}/correct`] = 0;
    playerUpdates[`players/${p.id}/wrong`] = 0;
    playerUpdates[`players/${p.id}/totalTime`] = 0;
    playerUpdates[`players/${p.id}/progress`] = 0;
    playerUpdates[`players/${p.id}/finished`] = false;
    playerUpdates[`players/${p.id}/misses`] = null;
  });
  playerUpdates.deck = deck;
  playerUpdates.difficulty = difficulty;
  playerUpdates.status = 'playing';
  playerUpdates.lastActivity = firebase.database.ServerValue.TIMESTAMP;

  try {
    await fbLobbyRef(state.mpCode).update(playerUpdates);
  } catch (err) {
    console.error('Host start failed', err);
    toast(fbErrorText(err));
    return;
  }

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
  // Player list
  const html = state.mpPlayers.map(p => {
    const teamTxt = p.team ? `· TEAM ${p.team}` : '';
    return `<div class="player-row ${p.isHost ? 'host' : ''}">
      <span class="ind"></span>
      <span>${escapeHtml(p.name)}</span>
      <span class="role">${p.isHost ? 'HOST' : 'PLAYER'} ${teamTxt}</span>
    </div>`;
  }).join('');
  $('player-list-body').innerHTML = html || '<div style="color:var(--text-mute);font-family:var(--mono);font-size:0.8rem;text-align:center;padding:8px">NO PLAYERS YET</div>';

  // Show host controls only for host
  $('host-controls').style.display = (state.mpRole === 'host') ? 'block' : 'none';
  $('guest-wait').style.display = (state.mpRole === 'guest') ? 'block' : 'none';
  // Show veteran-mode warning to guests so they're not surprised
  $('guest-vet-indicator').style.display = (state.mpRole === 'guest' && state.mpDifficulty === 'veteran') ? 'block' : 'none';

  // Sync deck-size selection
  qsa('#mp-deck-options .option').forEach(o => {
    o.classList.toggle('selected', parseInt(o.dataset.count, 10) === state.mpDeckCount);
  });
  // Sync mode toggle
  qsa('.team-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === state.mpMode);
  });
  // Sync host's veteran-mode checkbox to whatever's in the lobby state
  // (in case the screen was navigated away and back)
  const vetCb = $('mp-veteran');
  if (vetCb) vetCb.checked = (state.mpDifficulty === 'veteran');
}
