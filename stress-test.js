/* ============================================================
   TRIAGE IT — classroom stress simulator
   ============================================================
   Self-test for instructor-dashboard responsiveness under load.
   No install required — runs in the browser DevTools console.

   How it works:
     - stress(code, n) adds n fake players to your lobby in the
       waiting state (just like real guests joining).
     - You click START GAME normally. The simulator detects the
       status change and the fake players begin "playing" —
       ticking through the deck at ~5 s per card with ~70%
       accuracy, exactly as real players would.
     - stop() removes every simulated player.

   Workflow:
     1. Open the deployed app in a normal browser tab.
     2. Click CLASSROOM → enter a name → HOST DRILL.
        You'll land on the lobby screen with a code (ABCD-1234).
     3. Open DevTools (Cmd+Opt+I on Mac), Console tab.
        (Safari: enable the Develop menu in Settings → Advanced
         first, then Cmd+Opt+C. You may need to type
         "allow pasting" once before pasting works.)
     4. Open this file in any text editor, copy ALL of it, paste
        into the Console, hit Enter.
     5. Run:   stress('ABCD-1234', 50)
        ...with YOUR code and the number of players you want.
        50 fake players appear in the lobby almost instantly.
     6. Pick deck size + difficulty as normal, then click
        START GAME. The fake players begin progressing; watch
        the dashboard for stutter.
     7. When done:   stop()
        ...removes every simulated player from the lobby.

   Caveat: all fake players share ONE WebSocket connection
   (this browser tab's). That's good enough to measure dashboard
   render cost + Firebase broadcast volume, but it does NOT
   replicate per-device WiFi cost. For a true per-device test,
   open the app on real phones.
   ============================================================ */

(function () {
  if (!window.fbDb) {
    console.error('window.fbDb not found — open this on the Triage It page first.');
    return;
  }

  let active = false;        // stress() has been called and stop() has not
  let roundActive = false;   // host has clicked START (status === 'playing')
  let stoppers = [];         // cleanup functions for stop()
  let players = [];          // simulated player IDs in the current run
  let lobbyRef = null;
  let deckSize = 25;

  const FAKE_NAMES = [
    'Probie','Cap','BC','Engine','Truck','Rescue',
    'Medic','Hose','Halligan','Axe','Dispatch','Recruit'
  ];

  // Per-player ticker — runs after the host clicks START.
  function startTicker(id) {
    let progress = 0, correct = 0, wrong = 0, totalTime = 0;
    const tick = () => {
      if (!active || !roundActive) return;
      progress  += 1;
      totalTime += 4 + Math.random() * 3;
      if (Math.random() < 0.7) correct += 1; else wrong += 1;
      const finished = progress >= deckSize;
      lobbyRef.child('players/' + id).update({
        progress, correct, wrong, totalTime, finished
      });
      if (!finished) {
        const t = setTimeout(tick, 4000 + Math.random() * 3000);
        stoppers.push(() => clearTimeout(t));
      }
    };
    const first = setTimeout(tick, 1000 + Math.random() * 2000);
    stoppers.push(() => clearTimeout(first));
  }

  window.stress = function stress(code, count = 50) {
    if (active) {
      console.warn('A stress test is already running. Call stop() first.');
      return;
    }
    if (!/^[A-Z]{4}-[0-9]{4}$/.test(code)) {
      console.error('Code must look like ABCD-1234. Got:', code);
      return;
    }

    active = true;
    roundActive = false;
    stoppers = [];
    players = [];
    lobbyRef = window.fbDb.ref('lobbies/' + code);

    console.log(`Adding ${count} fake players to lobby ${code} (waiting state)…`);

    // Add each fake player exactly as a real guest would: in the
    // lobby with zeroed stats and finished=false. They show up in
    // the host's player list but don't progress until the round starts.
    for (let i = 0; i < count; i++) {
      const id   = 'p_sim' + Math.random().toString(36).slice(2, 10);
      const name = `${FAKE_NAMES[i % FAKE_NAMES.length]}${String(i + 1).padStart(2, '0')}`;
      const initial = {
        name, team: i % 2 === 0 ? 'A' : 'B',
        isHost: false, isInstructor: false,
        correct: 0, wrong: 0, totalTime: 0, progress: 0, finished: false
      };
      lobbyRef.child('players/' + id).set(initial);
      players.push(id);
      stoppers.push(() => lobbyRef.child('players/' + id).remove());
    }

    console.log(`Added. Now click START GAME in the host UI — fake players will begin ticking automatically.`);

    // Watch lobby status so we begin ticking the moment the host
    // clicks START (status -> 'playing'). The host's START call
    // resets all player stats; our tick then starts incrementing
    // from zero, exactly like a real player.
    const statusRef = lobbyRef.child('status');
    const statusHandler = statusRef.on('value', (snap) => {
      if (!active) return;
      const status = snap.val();
      if (status === 'playing' && !roundActive) {
        roundActive = true;
        // Pick up the host's chosen deck size before ticking starts.
        lobbyRef.child('deckCount').once('value').then((dcSnap) => {
          deckSize = parseInt(dcSnap.val(), 10) || 25;
          console.log(`Round started — ${players.length} fake players ticking through ${deckSize} cards.`);
          players.forEach(startTicker);
        });
      } else if (status !== 'playing' && roundActive) {
        // Round ended — tick functions will see roundActive=false on
        // their next firing and bail. No active cleanup needed here.
        roundActive = false;
      }
    });
    stoppers.push(() => statusRef.off('value', statusHandler));
  };

  window.stop = function stop() {
    active = false;
    roundActive = false;
    stoppers.forEach(fn => { try { fn(); } catch (e) {} });
    stoppers = [];
    players = [];
    console.log('Stopped. All simulated players removed from the lobby.');
  };

  console.log('Stress simulator loaded. Run:  stress("ABCD-1234", 50)');
})();
