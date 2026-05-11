/* ============================================================
   TRIAGE IT — Procedural Scenario Generator
   ============================================================
   START algorithm (in evaluation order):

     0. Can the patient walk?            → GREEN  (Minor)
     1. Apneic? Reposition airway:
          still apneic                   → BLACK  (Deceased)
          breathing returns              → RED    (Immediate)
     2. Respirations > 30/min            → RED    (Immediate)
     3. No radial pulse / cap-refill >2s → RED    (Immediate)
     4. Cannot follow simple commands    → RED    (Immediate)
     5. Otherwise                        → YELLOW (Delayed)

   Cards display vitals as RPM:
     R — Respirations
     P — Perfusion (radial pulse OR cap refill)
     M — Mental status (follows simple commands?)
   The ambulatory state is described in the narrative.

   Each call to generateDeck(n) produces n unique scenarios
   freshly composed from templates, patient descriptors,
   setting context, and randomized vitals. Reshuffle between
   games and you'll get a new mix every time.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- helpers ---------- */
  const randInt = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /* ---------- contextual variety pools ---------- */
  const SETTINGS = [
    'On scene at a multi-vehicle freeway pile-up',
    'Inside a partially collapsed apartment building',
    'At an industrial fire on the loading dock',
    'In the staging area after a structure fire',
    'At a construction site after a scaffold collapse',
    'Following an explosion at a chemical warehouse',
    'After a transit bus rollover',
    'At an outdoor concert after the stage collapsed',
    'After a partial roof collapse at a venue',
    'On scene at a train derailment',
    'In a parking structure after a vehicle ramming',
    'At a school gymnasium serving as a casualty point',
    'On the curb outside a restaurant after a kitchen fire',
    'In a stairwell of an evacuated office tower',
    'On the sidewalk after an apartment balcony collapse',
  ];

  const PATIENTS = [
    'an adult man, late 20s',
    'a woman in her early 30s',
    'an elderly man, approximately 70',
    'a middle-aged woman',
    'a teenage boy',
    'a male construction worker',
    'a woman in her 50s',
    'a man in business attire',
    'a young adult, college-aged',
    'an older woman, late 60s',
    'a delivery driver in uniform',
    'a teenage girl',
    'a middle-aged man with a beard',
    'a woman wearing scrubs',
    'a man in his 40s',
  ];

  /* ---------- vital-sign generators per START branch ---------- */
  const perfPresent = () => pick([
    'Pulse is Present',
    `Capillary refill ${pick(['1 second','1 second'])} (less than 2 sec)`,
  ]);
  const perfAbsent = () => pick([
    'Pulse is not Present',
    `Capillary refill ${randInt(3,5)} seconds (greater than 2 sec)`,
  ]);

  const greenVitals = () => ({
    respirations: `${randInt(14, 22)}/min, regular`,
    perfusion: perfPresent(),
    mental: 'Follows simple commands',
  });

  const redRespVitals = () => ({
    respirations: `${randInt(32, 46)}/min, ${pick(['shallow', 'labored', 'gasping'])}`,
    perfusion: pick([perfPresent(), perfAbsent()]),
    mental: pick(['Follows simple commands', 'Cannot follow simple commands']),
  });

  const redPerfVitals = () => ({
    respirations: `${randInt(18, 28)}/min, regular`,
    perfusion: perfAbsent(),
    mental: pick(['Follows simple commands', 'Cannot follow simple commands']),
  });

  const redMentalVitals = () => ({
    respirations: `${randInt(16, 28)}/min, regular`,
    perfusion: perfPresent(),
    mental: 'Cannot follow simple commands',
  });

  const yellowVitals = () => ({
    respirations: `${randInt(14, 26)}/min, regular`,
    perfusion: perfPresent(),
    mental: 'Follows simple commands',
  });

  // Default BLACK vitals (used for Normal-difficulty Training, where
  // the airway maneuver is not part of the interactive mechanic).
  // Hard/Expert overrides this text in trainingAirwaySetup so the
  // player has to actually work the airway to find the answer.
  const blackVitals = () => ({
    respirations: 'No spontaneous respirations',
    perfusion: 'Pulse is not Present',
    mental: 'Unresponsive',
  });

  /* ---------- HARD-mode vitals: right at the threshold ----------
     Same correct answer as the normal generators above, but with
     numbers parked on the algorithm boundary so the player can't
     coast on obvious cues. RR 31 vs 38 is the same RED but feels
     much closer to the "is this really above 30?" gut call. */

  const redRespVitalsHard = () => ({
    // Just over the 30/min threshold — easy to misread as tachypneic-but-OK
    respirations: `${randInt(31, 36)}/min, ${pick(['shallow', 'labored', 'audible'])}`,
    perfusion: perfPresent(),
    mental: 'Follows simple commands',
  });

  const redPerfVitalsHard = () => ({
    respirations: `${randInt(20, 28)}/min, regular`,
    perfusion: pick([
      `Capillary refill ${randInt(3, 4)} seconds (greater than 2 sec)`,
      'Pulse not palpable at the wrist',
      'Capillary refill prolonged at 3 seconds (greater than 2 sec)',
    ]),
    mental: 'Follows simple commands',
  });

  const redMentalVitalsHard = () => ({
    respirations: `${randInt(20, 28)}/min, regular`,
    perfusion: perfPresent(),
    mental: pick([
      'Looks at you when called but cannot follow simple commands',
      'Drowsy; cannot follow simple commands',
      'Moans, cannot follow simple commands',
    ]),
  });

  const yellowVitalsHard = () => ({
    // High-normal RR — sits just under the 30/min threshold so it's
    // tempting to call RED. Per START, ≤30 with intact P+M = YELLOW.
    respirations: `${randInt(26, 30)}/min, regular`,
    perfusion: perfPresent(),
    mental: 'Follows simple commands',
  });

  const blackVitalsHard = () => ({
    respirations: pick([
      'No spontaneous respirations after airway repositioning',
      'Single agonal gasp on airway repositioning, then no further respirations',
      'No spontaneous respirations after two airway repositioning attempts',
    ]),
    perfusion: 'Pulse is not Present',
    mental: 'Unresponsive',
  });

  /* ---------- narrative templates ---------- */

  const GREEN_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} walks toward you holding a folded handkerchief to a forehead laceration. Complains of a headache; otherwise alert and conversational.`,
    (p, s) => `${s}. ${cap(p)} approaches the triage point on foot, cradling a forearm with abrasions. Says they "just need a bandage."`,
    (p, s) => `${s}. ${cap(p)} walks over slowly, asking about a family member. Ambulatory, oriented, with minor cuts on the hands.`,
    (p, s) => `${s}. ${cap(p)} limps toward you favoring one ankle but bearing weight. Reports pain, declines further help, asks where to wait.`,
    (p, s) => `${s}. ${cap(p)} walks into the triage area covered in dust, rubbing their eyes. Sees, talks, breathes normally.`,
    (p, s) => `${s}. ${cap(p)} approaches escorting another walking victim. Has a small scalp laceration, no other complaints.`,
    (p, s) => `${s}. ${cap(p)} walks up holding a wrist at an awkward angle. Alert, complaining of pain. Walks unaided.`,
    (p, s) => `${s}. ${cap(p)} walks over, eyes red and watery from smoke. Coughing intermittently, talking in full sentences.`,
    (p, s) => `${s}. ${cap(p)} steps into the green-tag area on their own, presenting a hand laceration with controlled bleeding.`,
    (p, s) => `${s}. ${cap(p)} walks across the lot tearfully but ambulatory, no visible major injury, reporting back pain.`,
  ];

  const RED_RESP_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is supine on the ground, unable to walk, with paradoxical chest wall movement. Breathing fast and shallow.`,
    (p, s) => `${s}. ${cap(p)} cannot stand, leaning against debris. Visible chest wound; you hear gurgling, audible breathing effort.`,
    (p, s) => `${s}. ${cap(p)} is on the ground, sweating and pale. Cannot get up. Breathing rapidly with accessory muscle use.`,
    (p, s) => `${s}. ${cap(p)} did not walk to the assembly point. Found seated against a wall, gasping, chest moving rapidly.`,
    (p, s) => `${s}. ${cap(p)} is pinned at the legs by a fallen panel — not ambulatory. Tachypneic with audible wheezing.`,
    (p, s) => `${s}. ${cap(p)} is laid out on a tarp, conscious but cannot stand. Chest rising rapidly, lips slightly cyanotic.`,
  ];

  const RED_PERF_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is unable to walk; significant blood loss from a thigh wound, pressure dressing in place. Skin cool and pale.`,
    (p, s) => `${s}. ${cap(p)} sits slumped, unable to rise. Open femur fracture with continued ooze; skin clammy.`,
    (p, s) => `${s}. ${cap(p)} cannot ambulate. Abdominal distension, diaphoretic, fingertips dusky.`,
    (p, s) => `${s}. ${cap(p)} is on the ground, not walking, lacerations to multiple extremities, skin cold to touch.`,
    (p, s) => `${s}. ${cap(p)} is lying on the floor, not walking. Penetrating wound to the flank; skin pale, extremities cool.`,
    (p, s) => `${s}. ${cap(p)} is non-ambulatory after a crush mechanism. Skin cool, pale, sweaty.`,
  ];

  const RED_MENTAL_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is non-ambulatory, eyes open but staring through you. Does not respond when you ask them to squeeze your hand.`,
    (p, s) => `${s}. ${cap(p)} cannot stand and is mumbling incoherently. Visible scalp laceration with bony deformity beneath.`,
    (p, s) => `${s}. ${cap(p)} sits propped against rubble, not walking. Eyes open but no purposeful response to commands.`,
    (p, s) => `${s}. ${cap(p)} is on the ground with a head injury. Does not follow "show me two fingers." Moans only.`,
    (p, s) => `${s}. ${cap(p)} cannot get up. Disoriented, asks the same question repeatedly, does not follow simple instruction.`,
  ];

  const YELLOW_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} cannot walk due to a deformed lower leg, but is alert, talking calmly, and rates pain a 7/10.`,
    (p, s) => `${s}. ${cap(p)} sits on the ground with a sling improvised from a shirt; suspected clavicle fracture. Cannot walk far but oriented.`,
    (p, s) => `${s}. ${cap(p)} is unable to walk because of a deep thigh laceration, bleeding well controlled by direct pressure. Alert and conversing.`,
    (p, s) => `${s}. ${cap(p)} is non-ambulatory after a fall, c-spine being held by a bystander. Talks coherently, denies numbness.`,
    (p, s) => `${s}. ${cap(p)} cannot bear weight on either leg; ankle deformities bilaterally. Awake, oriented, asks about their phone.`,
    (p, s) => `${s}. ${cap(p)} sits in the staging area with abdominal pain after a seatbelt mechanism. Cannot walk, but vitals stable.`,
    (p, s) => `${s}. ${cap(p)} is non-ambulatory due to extremity fractures, alert and answering questions appropriately.`,
    (p, s) => `${s}. ${cap(p)} cannot stand due to back pain after debris fell on them. Awake, oriented, complaining of pain only.`,
  ];

  const BLACK_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is unresponsive on the ground. You reposition the airway and wait — no spontaneous respirations resume.`,
    (p, s) => `${s}. ${cap(p)} is found pulseless and apneic under fallen debris. Airway opened: no breathing returns.`,
    (p, s) => `${s}. ${cap(p)} lies motionless. No chest rise on observation; you tilt the head — still no respirations.`,
    (p, s) => `${s}. ${cap(p)} is supine and not breathing. Jaw thrust performed: respirations do not return.`,
    (p, s) => `${s}. ${cap(p)} is unresponsive with no chest movement. Airway repositioned without effect.`,
  ];

  /* ---------- EXPERT-mode red-herring narratives ----------
     Same correct answer, but the picture either looks worse than
     it is (scary GREEN walking-wounded) or better than it is
     (calm patient with hidden tachypnea). Forces the player to
     follow the algorithm strictly instead of going on gestalt. */

  const GREEN_HERRING_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} walks toward you with a deep scalp laceration soaking the front of their shirt. Talking in full sentences, asking about coworkers.`,
    (p, s) => `${s}. ${cap(p)} limps over with an obvious open forearm fracture, bone visible. Pale and sweating from pain, but ambulatory and oriented.`,
    (p, s) => `${s}. ${cap(p)} approaches the green-tag area cradling a partially amputated finger wrapped in a t-shirt. Ashen but conversational.`,
    (p, s) => `${s}. ${cap(p)} walks across the lot covered head to toe in soot, coughing intermittently. Talks in full sentences, breathing on their own.`,
    (p, s) => `${s}. ${cap(p)} steps in covered in another victim's blood, asking where to wait. No injury of their own visible. Walking, alert.`,
    (p, s) => `${s}. ${cap(p)} walks up holding a chunk of glass in their thigh, blood seeping past their fingers. Alert, oriented, walking unaided.`,
  ];

  const RED_RESP_HERRING_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} sits quietly against a wall, no obvious external injury. Eyes closed but breathing rapidly — you count 34 in a minute.`,
    (p, s) => `${s}. ${cap(p)} is on a tarp, conscious and not in obvious distress, looks comfortable. Chest is moving fast: 36/min.`,
    (p, s) => `${s}. ${cap(p)} mumbles when spoken to. No external bleeding, no obvious injury. Respirations are rapid and shallow at 38/min.`,
    (p, s) => `${s}. ${cap(p)} is propped up against debris, calmly answering questions. You note their chest is rising 32 times a minute.`,
  ];

  const RED_PERF_HERRING_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is on the ground after being thrown clear of the wreck. No external bleeding visible. Skin cool, capillary refill 4 seconds.`,
    (p, s) => `${s}. ${cap(p)} sits up, no obvious wounds, complaining of stomach pain. Skin clammy, pulse not palpable at the wrist.`,
    (p, s) => `${s}. ${cap(p)} is non-ambulatory after the wall fell. Looks intact externally — but skin is cold and pale, fingertips dusky.`,
    (p, s) => `${s}. ${cap(p)} is sitting against rubble, not visibly bleeding, talking. You check radial pulse: not palpable. Skin clammy.`,
  ];

  const RED_MENTAL_HERRING_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is sitting up, eyes open and tracking your movements. When you ask them to squeeze your hand, they just stare back.`,
    (p, s) => `${s}. ${cap(p)} is non-ambulatory, looks alert at first glance. Asks you the same question — "what happened?" — three times.`,
    (p, s) => `${s}. ${cap(p)} sits propped up, no visible injury, no bleeding. Cannot follow "show me two fingers" despite open eyes.`,
    (p, s) => `${s}. ${cap(p)} is on the ground without obvious trauma. Eyes track but there's no purposeful response to commands.`,
  ];

  const YELLOW_HERRING_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} has an obvious deformed femur, bleeding controlled by a tourniquet. Cannot walk. Pain is severe — but RR, pulse, and mental status are all intact.`,
    (p, s) => `${s}. ${cap(p)} sits in a pool of blood from a scalp laceration, pressure dressing applied. Cannot walk. Talking, breathing normally, follows commands.`,
    (p, s) => `${s}. ${cap(p)} non-ambulatory after being struck by debris, abdominal pain. Vitals are reassuringly normal: respirations regular, pulse strong, alert.`,
    (p, s) => `${s}. ${cap(p)} is on the ground with bilateral lower-leg deformities, screaming in pain. Cannot bear weight. Otherwise breathing normally, follows commands.`,
  ];

  const BLACK_HERRING_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is on the ground unresponsive. Bystanders insist they were talking five minutes ago. Airway repositioned: no spontaneous respirations.`,
    (p, s) => `${s}. ${cap(p)} is supine, motionless, looks recently injured — face still warm. Airway opened, no breathing returns.`,
    (p, s) => `${s}. ${cap(p)} found pulseless. A single agonal gasp follows the airway lift, then nothing further.`,
    (p, s) => `${s}. ${cap(p)} is unresponsive next to a relatively minor-looking wound. Repositioning the airway does not restart respirations.`,
  ];

  /* ---------- rationale builder ---------- */

  function rationaleFor(answer, scenario) {
    const rrNum = parseInt((scenario.respirations.match(/\d+/) || [])[0]);
    if (answer === 'green') {
      return 'Patient is ambulatory. Per START, walking wounded are tagged Minor (Green) and directed to a designated area for secondary triage — regardless of how their RPM looks at first glance.';
    }
    if (answer === 'black') {
      return 'Patient is not breathing on their own. Tag as Deceased / Expectant (Black) and move on. In a mass-casualty event, every second spent here is a second lost from a salvageable patient.';
    }
    if (answer === 'red') {
      if (!isNaN(rrNum) && rrNum > 30) {
        return `Respirations of ${rrNum}/min exceed 30 — this alone meets the Immediate (Red) criterion. RPM check stops here: tag and move on.`;
      }
      if (/not Present|greater than|not palpable|prolonged/i.test(scenario.perfusion)) {
        return `Inadequate perfusion (${scenario.perfusion}) with respirations ≤30 = Immediate (Red). Hemorrhage control en route to higher care.`;
      }
      if (/cannot/i.test(scenario.mental)) {
        return 'Patient cannot follow simple commands despite adequate respirations and perfusion. Altered mental status = Immediate (Red).';
      }
      return 'RPM findings meet Immediate (Red) criteria.';
    }
    return 'Non-ambulatory but RPM is intact: respirations ≤30, perfusion adequate, and follows simple commands. Tag Delayed (Yellow) — care needed but can wait while Reds are handled.';
  }

  /* ---------- core generator ---------- */

  // Per-category lookup tables — let makeScenario pick the right
  // vital generator + narrative pool based on the difficulty preset
  // without a 6-arm switch repeated for each variant.
  const VITALS_NORMAL = {
    'green':      greenVitals,
    'red-resp':   redRespVitals,
    'red-perf':   redPerfVitals,
    'red-mental': redMentalVitals,
    'yellow':     yellowVitals,
    'black':      blackVitals,
  };
  const VITALS_HARD = {
    'green':      greenVitals,         // greens stay easy; trick is in narrative
    'red-resp':   redRespVitalsHard,
    'red-perf':   redPerfVitalsHard,
    'red-mental': redMentalVitalsHard,
    'yellow':     yellowVitalsHard,
    'black':      blackVitalsHard,
  };
  const NARRATIVES_NORMAL = {
    'green':      GREEN_NARRATIVES,
    'red-resp':   RED_RESP_NARRATIVES,
    'red-perf':   RED_PERF_NARRATIVES,
    'red-mental': RED_MENTAL_NARRATIVES,
    'yellow':     YELLOW_NARRATIVES,
    'black':      BLACK_NARRATIVES,
  };
  const NARRATIVES_HERRING = {
    'green':      GREEN_HERRING_NARRATIVES,
    'red-resp':   RED_RESP_HERRING_NARRATIVES,
    'red-perf':   RED_PERF_HERRING_NARRATIVES,
    'red-mental': RED_MENTAL_HERRING_NARRATIVES,
    'yellow':     YELLOW_HERRING_NARRATIVES,
    'black':      BLACK_HERRING_NARRATIVES,
  };

  function makeScenario(category, preset) {
    const patient = pick(PATIENTS);
    const setting = pick(SETTINGS);
    const vitalsTable    = preset.borderlineVitals ? VITALS_HARD : VITALS_NORMAL;
    const narrativeTable = preset.redHerrings      ? NARRATIVES_HERRING : NARRATIVES_NORMAL;
    const vitals    = vitalsTable[category]();
    const narrative = pick(narrativeTable[category])(patient, setting);

    const answer = category.startsWith('red') ? 'red' : category;
    const id = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const scenario = {
      id,
      description: narrative,
      respirations: vitals.respirations,
      perfusion: vitals.perfusion,
      mental: vitals.mental,
      answer,
      rationale: ''
    };
    scenario.rationale = rationaleFor(answer, scenario);
    return scenario;
  }

  /* ---------- deck builder with category distribution ---------- */

  // Standard mix used for 'normal' difficulty.
  const NORMAL_WEIGHTS = [
    { cat: 'green',       w: 25 },
    { cat: 'red-resp',    w: 12 },
    { cat: 'red-perf',    w: 12 },
    { cat: 'red-mental',  w: 8  },
    { cat: 'yellow',      w: 25 },
    { cat: 'black',       w: 8  },
  ];

  // 'veteran' (Hard) mix — drops greens, leans on borderline RED-vs-BLACK
  // and yellow/red judgment calls. Matches buildDeck()'s intent in app.js.
  const VETERAN_WEIGHTS = [
    { cat: 'red-resp',    w: 14 },
    { cat: 'red-perf',    w: 14 },
    { cat: 'red-mental',  w: 12 },
    { cat: 'yellow',      w: 30 },
    { cat: 'black',       w: 30 },
  ];

  function buildCategoryQueue(count, weights) {
    const totalW = weights.reduce((a, b) => a + b.w, 0);
    // Largest-remainder method: floor each ideal count, then distribute
    // any leftover slots to the categories with the largest fractional parts.
    const slots = weights.map(cw => {
      const ideal = (cw.w / totalW) * count;
      return { cat: cw.cat, n: Math.floor(ideal), frac: ideal - Math.floor(ideal) };
    });
    let assigned = slots.reduce((s, x) => s + x.n, 0);
    let leftover = count - assigned;
    slots.sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < leftover; i++) slots[i % slots.length].n++;

    const queue = [];
    slots.forEach(s => { for (let k = 0; k < s.n; k++) queue.push(s.cat); });

    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return queue;
  }

  // Difficulty presets — three knobs control what gets harder:
  //   weights           : category mix (drop greens for hard variants)
  //   borderlineVitals  : numbers parked on the algorithm boundary
  //   redHerrings       : narratives that look like a different tag
  // Strings here must match the values app.js's combinedDifficulty()
  // can produce: 'normal' | 'hard' | 'expert' | 'hard-expert'.
  const DIFFICULTY_PRESETS = {
    normal:        { weights: NORMAL_WEIGHTS,  borderlineVitals: false, redHerrings: false },
    hard:          { weights: VETERAN_WEIGHTS, borderlineVitals: true,  redHerrings: false },
    expert:        { weights: NORMAL_WEIGHTS,  borderlineVitals: false, redHerrings: true  },
    'hard-expert': { weights: VETERAN_WEIGHTS, borderlineVitals: true,  redHerrings: true  },
  };
  // Legacy alias — early buildDeck() called this 'veteran' before
  // we differentiated hard vs expert. Keep it pointing at hard.
  DIFFICULTY_PRESETS.veteran = DIFFICULTY_PRESETS.hard;

  function generateDeck(count, difficulty) {
    count = Math.max(1, Math.min(parseInt(count) || 1, 500));
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
    const queue = buildCategoryQueue(count, preset.weights);
    return queue.map(cat => makeScenario(cat, preset));
  }

  // Single-patient generator for Game Mode, which spawns one
  // patient at a time over the lifetime of the round. The deck
  // builder above uses largest-remainder math that's correct for
  // batches but degenerate at count=1 (always returns the highest-
  // weight category — green, in NORMAL_WEIGHTS). Weighted random
  // sampling fixes that and gives the right long-run distribution.
  function generatePatient(difficulty) {
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
    const totalW = preset.weights.reduce((a, b) => a + b.w, 0);
    let r = Math.random() * totalW;
    for (const cw of preset.weights) {
      r -= cw.w;
      if (r <= 0) return makeScenario(cw.cat, preset);
    }
    return makeScenario(preset.weights[0].cat, preset);
  }

  // HARD MODE patient generator — restricted pool of borderline RED
  // and BLACK only. Always uses borderlineVitals + redHerrings on the
  // 'hard-expert' preset so every scenario is at the edge of the
  // algorithm threshold. About 35% black to make the apneic-airway
  // decision a meaningful share of the round.
  const HARD_WEIGHTS = [
    { cat: 'red-resp',    w: 18 },
    { cat: 'red-perf',    w: 18 },
    { cat: 'red-mental',  w: 14 },
    { cat: 'black',       w: 35 },
  ];
  function generateHardPatient() {
    const preset = DIFFICULTY_PRESETS['hard-expert'];
    const totalW = HARD_WEIGHTS.reduce((a, b) => a + b.w, 0);
    let r = Math.random() * totalW;
    for (const cw of HARD_WEIGHTS) {
      r -= cw.w;
      if (r <= 0) return makeScenario(cw.cat, preset);
    }
    return makeScenario(HARD_WEIGHTS[0].cat, preset);
  }

  /* ---------- triage label info (consumed by app.js) ----------
     Keys required by app.js:
       .color  — bold triage color (card-back background, bar fill)
       .ink    — text color used on top of .color
       .label  — full uppercase label ("RED", "YELLOW", ...)
       .short  — short tag shown inline ("WRONG · YOU PICKED RED")
     Color values mirror the CSS custom properties in styles.css
     (--red, --yellow, --green, --black) so the JS-driven verdict
     screen stays visually consistent with the rest of the UI. */
  // Labels follow EMS treatment-area naming so the UI is consistent
  // with the answer buttons (IMMEDIATE / DELAYED / MINOR / DECEASED).
  // Color codes still drive backgrounds + tag classes via the keys.
  const TRIAGE_INFO = {
    red:    { label: 'IMMEDIATE', short: 'IMMEDIATE', color: '#ef3b3b', ink: '#ffffff' },
    yellow: { label: 'DELAYED',   short: 'DELAYED',   color: '#f5b800', ink: '#2a1f00' },
    green:  { label: 'MINOR',     short: 'MINOR',     color: '#22c55e', ink: '#02240f' },
    black:  { label: 'DECEASED',  short: 'DECEASED',  color: '#0a0a0c', ink: '#ffffff' },
  };

  /* ---------- EXPERT-mode fatal incident ----------
     Shown on the death screen after a wrong answer in expert /
     hard-expert mode. Tone matches the F-roast lines: brief,
     a little dark, tongue-in-cheek without being mean. Each
     incident is { head, body } — head is the headline, body is
     the one-line consequence.

     app.js calls this via window.generateFatalIncident(); if it
     ever goes missing again, app.js falls back to a default so
     the player isn't stranded mid-card. */
  const FATAL_INCIDENTS = [
    { head: 'PATIENT WAS WALKING',
      body: 'You tagged a walking-wounded patient as deceased. They walked off and filed a complaint with the BC.' },
    { head: 'MISSED THE TACHYPNEA',
      body: 'Respiratory rate was over 30. You tagged them delayed. They coded en route to staging.' },
    { head: 'WRONG PRIORITY',
      body: 'While you mis-tagged a stable patient, the unidentified red exsanguinated three meters away.' },
    { head: 'BLACK MEANS BLACK',
      body: 'Apneic after airway repositioning means BLACK. You worked them anyway — the next red ran out of time.' },
    { head: 'OVER-TRIAGED',
      body: 'You called every yellow a red. Resources ran out for the actual reds. Outcome: poor.' },
    { head: 'UNDER-TRIAGED',
      body: 'You called the reds yellows. They were stable when transported — at the back of the line.' },
    { head: 'MISSED THE PERFUSION CHECK',
      body: 'Capillary refill was prolonged. You missed it. They were the youngest patient on scene.' },
    { head: 'ALTERED, NOT ASLEEP',
      body: "Patient couldn't follow simple commands. You called it minor. The CT later showed why." },
    { head: 'WALKING IS GREEN',
      body: 'They were upright and ambulatory. You over-tagged them. Two reds didn\'t get sorted while you debated.' },
    { head: 'ONE WRONG CALL',
      body: 'In Expert mode, every call counts. The MCI didn\'t forgive that one.' },
  ];
  function generateFatalIncident() {
    return FATAL_INCIDENTS[Math.floor(Math.random() * FATAL_INCIDENTS.length)];
  }

  /* ---------- TREATMENT AREA mode ----------
     Generates a fixed-size scene of patients that the FIRST-arriving
     unit has already tagged. The player's job is reassessment: catch
     deteriorating patients, fix mistags, set transport order.

     Each returned patient carries:
       correctTag   — ground truth (immutable)
       initialTag   — what the first unit tagged (immutable, AAR)
       currentTag   — mutates on retag / deterioration
       deteriorating — true → app.js gives this patient a `becomesAt`
                       clock that flips correctTag yellow→red unless
                       the player upgrades it first
     Mistag matrix is realistic: a real RED gets under-triaged to
     YELLOW, a real YELLOW gets panic-upgraded to RED, etc. */

  // Mix per scene — keeps every zone populated regardless of count.
  function treatmentMix(count) {
    const red    = Math.max(1, Math.round(count * 3/12));
    const green  = Math.max(1, Math.round(count * 3/12));
    const black  = Math.max(1, Math.round(count * 1/12));
    const yellow = Math.max(1, count - red - green - black);
    return { red, yellow, green, black };
  }

  // What the first unit got wrong, by truth color.
  const TREAT_MISTAG = {
    red:    'yellow',  // under-triaged
    yellow: 'red',     // over-triaged
    green:  'yellow',  // over-triaged (laid down)
    black:  'yellow',  // missed agonal / thought salvageable
  };

  // Map a treatment-area "truth" tag to the sampler category used by
  // makeScenario. Reds split across three sub-categories so vitals
  // come from a varied pool.
  function pickRedCategory() {
    return pick(['red-resp', 'red-perf', 'red-mental']);
  }
  function categoryFor(truthTag) {
    if (truthTag === 'red')   return pickRedCategory();
    return truthTag; // 'yellow' | 'green' | 'black'
  }

  function generateTreatmentScene(count, difficulty, opts) {
    // Cap raised to 200 so card-count rounds (10/25/50/100) and the
    // time-bound queue can both be served from a single batch.
    count = Math.max(4, Math.min(parseInt(count) || 12, 200));
    const o = opts || {};
    const mistagFrac      = (typeof o.mistagFrac === 'number')      ? o.mistagFrac      : 0.30;
    const deteriorateFrac = (typeof o.deteriorateFrac === 'number') ? o.deteriorateFrac : 0.45;

    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
    const mix = treatmentMix(count);

    const truthQueue = [];
    for (let i = 0; i < mix.red;    i++) truthQueue.push('red');
    for (let i = 0; i < mix.yellow; i++) truthQueue.push('yellow');
    for (let i = 0; i < mix.green;  i++) truthQueue.push('green');
    for (let i = 0; i < mix.black;  i++) truthQueue.push('black');
    // Shuffle so the AAR ordering isn't predictable
    for (let i = truthQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [truthQueue[i], truthQueue[j]] = [truthQueue[j], truthQueue[i]];
    }

    const patients = truthQueue.map((truth, idx) => {
      const scenario = makeScenario(categoryFor(truth), preset);
      // Apneic black patients need their respirations masked the same
      // way Game Mode does — the player should see "apneic on initial
      // assessment" until they would re-work the airway. For Treatment
      // Area we don't have an airway button on the pip surface, so just
      // restore the truth phrase ("No spontaneous respirations after
      // airway repositioning") which still reads naturally.
      // (Hard preset's blackVitalsHard already says this; normal preset
      // says "No spontaneous respirations" which also reads fine.)

      // Mistag roll. Greens with red-herring narratives get a small
      // bias upward — those patients LOOK bad and so are more likely
      // to have been over-triaged by the first unit.
      let mistagP = mistagFrac;
      if (truth === 'green' && preset.redHerrings) mistagP = Math.min(0.55, mistagFrac + 0.15);
      const mistagged = Math.random() < mistagP;
      const currentTag = mistagged ? TREAT_MISTAG[truth] : truth;

      // Deterioration only applies to true yellows that were tagged
      // yellow by the first unit (i.e. sitting in the yellow zone).
      // Mistagged yellows that landed in red are treated as static
      // puzzles — the deterioration-catch mechanic lives in the
      // yellow zone where it's visible.
      let deteriorating = false;
      if (truth === 'yellow' && currentTag === 'yellow' && Math.random() < deteriorateFrac) {
        deteriorating = true;
      }

      return {
        id: 'tp_' + idx,
        scenario,
        correctTag: truth,    // app.js will flip this to 'red' for deteriorating yellows after becomesAt
        initialTag: currentTag,
        currentTag,
        deteriorating,
      };
    });

    return patients;
  }

  // Expose to global scope for app.js
  window.generateDeck = generateDeck;
  window.generatePatient = generatePatient;
  window.generateHardPatient = generateHardPatient;
  window.generateTreatmentScene = generateTreatmentScene;
  window.generateFatalIncident = generateFatalIncident;
  window.TRIAGE_INFO = TRIAGE_INFO;
  // Backwards-compat stub
  window.SCENARIOS = [];
})();
