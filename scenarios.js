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
  // Perfusion phrasing helpers — used in plain English on the cards
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

  const blackVitals = () => ({
    respirations: 'No spontaneous respirations after airway repositioning',
    perfusion: 'Pulse is not Present',
    mental: 'Unresponsive',
  });

  /* ---------- narrative templates ---------- */

  const GREEN_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} walks toward you holding a folded handkerchief to a forehead laceration. Complains of a headache; otherwise alert and conversational.`,
    (p, s) => `${s}. ${cap(p)} is walking toward the triage point on their own, cradling a forearm with abrasions. Says they "just need a bandage."`,
    (p, s) => `${s}. ${cap(p)} walks over slowly, asking about a family member. Walking unaided, oriented, with minor cuts on the hands.`,
    (p, s) => `${s}. ${cap(p)} is walking toward you, limping but bearing weight on the ankle. Reports pain, declines further help, asks where to wait.`,
    (p, s) => `${s}. ${cap(p)} walks into the triage area covered in dust, rubbing their eyes. Sees, talks, and is walking normally.`,
    (p, s) => `${s}. ${cap(p)} walks up escorting another walking victim. Has a small scalp laceration, no other complaints.`,
    (p, s) => `${s}. ${cap(p)} walks up holding a wrist at an awkward angle. Alert, complaining of pain, walking unaided.`,
    (p, s) => `${s}. ${cap(p)} walks over with eyes red and watery from smoke. Coughing intermittently, talking in full sentences, walking on their own.`,
    (p, s) => `${s}. ${cap(p)} walks into the green-tag area on their own, presenting a hand laceration with controlled bleeding.`,
    (p, s) => `${s}. ${cap(p)} walks across the lot tearfully but on their own, no visible major injury, reporting back pain.`,
    (p, s) => `${s}. You see ${p} walking out of the smoke toward your position, coughing but alert and oriented.`,
    (p, s) => `${s}. ${cap(p)} is walking away from the scene with a friend, holding a bandage to a small cut on the arm.`,
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

  /* ---------- rationale builder ---------- */

  function rationaleFor(answer, scenario) {
    const rrNum = parseInt((scenario.respirations.match(/\d+/) || [])[0]);
    if (answer === 'green') {
      return 'Patient is ambulatory. Per START, walking wounded are tagged Minor (Green) and directed to a designated area for secondary triage — regardless of how their RPM looks at first glance.';
    }
    if (answer === 'black') {
      return 'No spontaneous respirations even after airway repositioning. Tag as Deceased / Expectant (Black) and move on. In a mass-casualty event, every second spent here is a second lost from a salvageable patient.';
    }
    if (answer === 'red') {
      if (!isNaN(rrNum) && rrNum > 30) {
        return `Respirations of ${rrNum}/min exceed 30 — this alone meets the Immediate (Red) criterion. RPM check stops here: tag and move on.`;
      }
      if (/not Present|greater than/i.test(scenario.perfusion)) {
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

  function makeScenario(category) {
    const patient = pick(PATIENTS);
    const setting = pick(SETTINGS);
    let narrative, vitals;

    switch (category) {
      case 'green':
        narrative = pick(GREEN_NARRATIVES)(patient, setting);
        vitals = greenVitals();
        break;
      case 'red-resp':
        narrative = pick(RED_RESP_NARRATIVES)(patient, setting);
        vitals = redRespVitals();
        break;
      case 'red-perf':
        narrative = pick(RED_PERF_NARRATIVES)(patient, setting);
        vitals = redPerfVitals();
        break;
      case 'red-mental':
        narrative = pick(RED_MENTAL_NARRATIVES)(patient, setting);
        vitals = redMentalVitals();
        break;
      case 'yellow':
        narrative = pick(YELLOW_NARRATIVES)(patient, setting);
        vitals = yellowVitals();
        break;
      case 'black':
        narrative = pick(BLACK_NARRATIVES)(patient, setting);
        vitals = blackVitals();
        break;
    }

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

  const CATEGORY_WEIGHTS = [
    { cat: 'green',       w: 25 },
    { cat: 'red-resp',    w: 12 },
    { cat: 'red-perf',    w: 12 },
    { cat: 'red-mental',  w: 8  },
    { cat: 'yellow',      w: 25 },
    { cat: 'black',       w: 8  },
  ];

  function buildCategoryQueue(count) {
    const totalW = CATEGORY_WEIGHTS.reduce((a, b) => a + b.w, 0);
    // Largest-remainder method: floor each ideal count, then distribute
    // any leftover slots to the categories with the largest fractional parts.
    // Guarantees the deck composition matches the weights as closely as
    // possible — no category gets squeezed out by greedy rounding.
    const slots = CATEGORY_WEIGHTS.map(cw => {
      const ideal = (cw.w / totalW) * count;
      return { cat: cw.cat, n: Math.floor(ideal), frac: ideal - Math.floor(ideal) };
    });
    let assigned = slots.reduce((s, x) => s + x.n, 0);
    let leftover = count - assigned;
    slots.sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < leftover; i++) slots[i % slots.length].n++;

    const queue = [];
    slots.forEach(s => { for (let k = 0; k < s.n; k++) queue.push(s.cat); });

    // Interleave shuffle so categories are mixed
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return queue;
  }

  function generateDeck(count) {
    count = Math.max(1, Math.min(parseInt(count) || 1, 500));
    const queue = buildCategoryQueue(count);
    return queue.map(makeScenario);
  }

  /* ---------- triage label info (used by UI) ----------
     `color`  — the saturated tag color (used for the card-back background)
     `text`   — the lighter glow color used for HUD highlights
     `ink`    — pure black/white for maximum readability ON the colored verdict card.
                Red/Yellow/Green get pure black so the verdict text reads like
                the print on a real triage tag. Black gets pure white.
  */
  const TRIAGE_INFO = {
    red:    { label: 'RED',    short: 'RED',    sub: 'IMMEDIATE', text: '#ff5757', color: '#ef3b3b', ink: '#000000', bg: '#2a0d0d' },
    yellow: { label: 'YELLOW', short: 'YELLOW', sub: 'DELAYED',   text: '#ffd24d', color: '#f5b800', ink: '#000000', bg: '#2a2410' },
    green:  { label: 'GREEN',  short: 'GREEN',  sub: 'MINOR',     text: '#3ee37b', color: '#22c55e', ink: '#000000', bg: '#0d2014' },
    black:  { label: 'BLACK',  short: 'BLACK',  sub: 'DECEASED',  text: '#cfd2d8', color: '#1c1c1c', ink: '#ffffff', bg: '#0a0a0c' },
  };

  // Expose to global scope for app.js
  window.generateDeck = generateDeck;
  window.TRIAGE_INFO = TRIAGE_INFO;
  // Backwards-compat stub
  window.SCENARIOS = [];
})();
