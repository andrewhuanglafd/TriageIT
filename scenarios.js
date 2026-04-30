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

  /* ============================================================
     VETERAN-MODE NARRATIVES
     ============================================================
     The hardest START judgment calls in real life live here:
       - Apneic patient → does breathing return after airway repositioning?
       - Agonal/gasping patient who LOOKS dying but is RED, not BLACK
       - Profound shock with absent perfusion + cannot follow commands —
         tempting to call BLACK, but they're salvageable Reds.
       - Discipline test: even after a 2nd attempt (which START says you
         shouldn't do, but trainees often want to), still no breathing
         means BLACK and you move on.
     ============================================================ */

  // RED via airway intervention: apneic → 1× head-tilt → breathing returns
  const VET_AIRWAY_RED_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is supine, unresponsive, no chest rise on first look. You perform a head-tilt / chin-lift — within seconds, slow shallow respirations begin. Pulse weak but palpable.`,
    (p, s) => `${s}. ${cap(p)} is pinned beneath drywall, jaw slack, no breathing observed. One head-tilt: spontaneous, irregular respirations resume. Skin pale and cool.`,
    (p, s) => `${s}. ${cap(p)} is found face-down. You roll them and reposition the airway — the chest begins to rise on its own after about three seconds. Color returns slowly.`,
    (p, s) => `${s}. ${cap(p)} is apneic on arrival. A single jaw-thrust opens the airway and breathing resumes, ~10/min and shallow. Carotid pulse present, weak.`,
    (p, s) => `${s}. ${cap(p)} is unresponsive, mouth full of debris. You clear it and lift the chin — agonal but present respirations begin. Cap refill > 2 sec.`,
  ];

  // BLACK: apneic → 1× head-tilt → still nothing. Move on.
  const VET_AIRWAY_BLACK_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is unresponsive, no chest rise. You perform a head-tilt / chin-lift — wait, observe — no spontaneous respirations return.`,
    (p, s) => `${s}. ${cap(p)} is found pulseless and apneic. One airway intervention — jaw-thrust — and no breathing returns within the count. Move on.`,
    (p, s) => `${s}. ${cap(p)} is supine with obvious major head trauma. Airway repositioned once. No respirations, no purposeful movement.`,
    (p, s) => `${s}. ${cap(p)} is found apneic in the rubble. A single chin-lift attempt — no chest rise, no air movement felt at the mouth.`,
    (p, s) => `${s}. ${cap(p)} is non-breathing on arrival. Head tilted, mouth checked clear. Watching the chest: nothing. Tag and move.`,
  ];

  // BLACK: tempting to try AGAIN. Some narratives describe the partner
  // repositioning a second time. STILL nothing. Discipline check.
  const VET_AIRWAY_PERSISTENT_BLACK_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is apneic. Your partner already tried a head-tilt — nothing. They reposition a second time, hoping. Still no breathing. You have other patients waiting.`,
    (p, s) => `${s}. ${cap(p)} hasn't breathed since you arrived. First chin-lift: nothing. Second attempt by the engineer: nothing. The protocol is one attempt.`,
    (p, s) => `${s}. ${cap(p)} found apneic. Bystander reports doing a head-tilt before you got there. You repeat it once: no respirations. No further interventions in MCI.`,
    (p, s) => `${s}. ${cap(p)} is pulseless and not breathing. A rookie next to you wants to try again. You've already done the one airway maneuver permitted. No respirations, no exceptions.`,
  ];

  // RED with agonal / very low respirations — visually disturbing but salvageable
  const VET_BORDERLINE_RED_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is on the ground, eyes glassy, taking gasping breaths roughly every four seconds. Carotid weak. Looks dying but is breathing on their own.`,
    (p, s) => `${s}. ${cap(p)} is supine with deep agonal respirations every 5–6 seconds. Skin gray. Pulse thready but palpable.`,
    (p, s) => `${s}. ${cap(p)} is unresponsive but breathing — ~6/min, irregular and noisy. Airway is patent. Pulse weak.`,
    (p, s) => `${s}. ${cap(p)} is exhibiting Cheyne-Stokes breathing pattern after a fall from height. Eyes open, no command-following. Pulse present.`,
    (p, s) => `${s}. ${cap(p)} has irregular shallow respirations, ~8/min. Body limp, eyes half-open. Cap refill > 2 sec. They're not breathing well, but they ARE breathing.`,
  ];

  // RED in extremis — multi-system failure, all RPM red flags. Easy to over-call BLACK.
  const VET_EXTREMIS_NARRATIVES = [
    (p, s) => `${s}. ${cap(p)} is non-ambulatory, breathing fast and shallow at ~38/min. No radial pulse. Eyes open but not tracking, no command-following. They are still breathing.`,
    (p, s) => `${s}. ${cap(p)} is sweating profusely, breathing rapidly, gray. No radial pulse, weak central pulse. Doesn't respond to your voice. Body still moves with each labored breath.`,
    (p, s) => `${s}. ${cap(p)} is on the ground with multi-system trauma. Tachypneic, cap refill ~5 sec, mumbling without purpose. Shock state — but airway is open and they're moving air.`,
    (p, s) => `${s}. ${cap(p)} is bleeding heavily despite a tourniquet. Pale, sweating, breathing fast. Doesn't follow commands. Eyes flicker open. Not dead.`,
  ];

  // Veteran-mode vitals
  const vetAirwayRedVitals = () => ({
    respirations: `${pick([6, 8, 10, 12])}/min after airway repositioning`,
    perfusion: pick([perfPresent(), perfAbsent()]),
    mental: pick(['Cannot follow simple commands', 'Unresponsive but breathing']),
  });
  const vetAirwayBlackVitals = () => ({
    respirations: 'No spontaneous respirations after airway repositioning',
    perfusion: pick(['Pulse is not Present', perfAbsent()]),
    mental: 'Unresponsive',
  });
  const vetAirwayPersistentBlackVitals = () => ({
    respirations: 'No respirations after a second attempted airway maneuver',
    perfusion: 'Pulse is not Present',
    mental: 'Unresponsive',
  });
  const vetBorderlineRedVitals = () => ({
    respirations: `${pick([5, 6, 8])}/min, agonal/irregular`,
    perfusion: perfAbsent(),
    mental: pick(['Cannot follow simple commands', 'Unresponsive but breathing']),
  });
  const vetExtremisVitals = () => ({
    respirations: `${randInt(34, 44)}/min, ${pick(['shallow', 'gasping', 'labored'])}`,
    perfusion: perfAbsent(),
    mental: 'Cannot follow simple commands',
  });

  /* ---------- rationale builder ---------- */

  function rationaleFor(answer, scenario, category) {
    const rrNum = parseInt((scenario.respirations.match(/\d+/) || [])[0]);
    if (answer === 'green') {
      return 'Patient is ambulatory. Per START, walking wounded are tagged Minor (Green) and directed to a designated area for secondary triage — regardless of how their RPM looks at first glance.';
    }
    if (answer === 'black') {
      if (category === 'vet-airway-persistent-black') {
        return 'No respirations after airway repositioning. START allows ONE airway intervention — head-tilt / chin-lift or jaw-thrust. After that, no breathing = BLACK. Discipline matters: time spent here is time stolen from a salvageable patient.';
      }
      return 'No spontaneous respirations even after airway repositioning. Tag as Deceased / Expectant (Black) and move on. In a mass-casualty event, every second spent here is a second lost from a salvageable patient.';
    }
    if (answer === 'red') {
      if (category === 'vet-airway-red') {
        return 'Apneic on arrival, but breathing returned after a single airway maneuver — that makes them Immediate (Red), not Black. Tag, move on. Definitive airway management happens after triage.';
      }
      if (category === 'vet-borderline-red') {
        return 'Agonal/irregular respirations are still respirations. The patient looks dying but is breathing on their own — they are Immediate (Red), not Black. Don\'t over-call expectant under pressure.';
      }
      if (category === 'vet-extremis') {
        return 'Multi-system failure with shock physiology — but they are still moving air on their own. RPM is profoundly red, mental status absent, perfusion gone. RED — salvageable with rapid intervention.';
      }
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
      // ----- Veteran mode categories -----
      case 'vet-airway-red':
        narrative = pick(VET_AIRWAY_RED_NARRATIVES)(patient, setting);
        vitals = vetAirwayRedVitals();
        break;
      case 'vet-airway-black':
        narrative = pick(VET_AIRWAY_BLACK_NARRATIVES)(patient, setting);
        vitals = vetAirwayBlackVitals();
        break;
      case 'vet-airway-persistent-black':
        narrative = pick(VET_AIRWAY_PERSISTENT_BLACK_NARRATIVES)(patient, setting);
        vitals = vetAirwayPersistentBlackVitals();
        break;
      case 'vet-borderline-red':
        narrative = pick(VET_BORDERLINE_RED_NARRATIVES)(patient, setting);
        vitals = vetBorderlineRedVitals();
        break;
      case 'vet-extremis':
        narrative = pick(VET_EXTREMIS_NARRATIVES)(patient, setting);
        vitals = vetExtremisVitals();
        break;
    }

    // Map category → final answer
    let answer;
    if (category === 'vet-airway-red' || category === 'vet-borderline-red' || category === 'vet-extremis') {
      answer = 'red';
    } else if (category === 'vet-airway-black' || category === 'vet-airway-persistent-black') {
      answer = 'black';
    } else if (category.startsWith('red')) {
      answer = 'red';
    } else {
      answer = category;
    }

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
    scenario.rationale = rationaleFor(answer, scenario, category);
    return scenario;
  }

  /* ---------- deck builder with category distribution ---------- */

  // Standard mode: realistic mass-casualty mix
  const CATEGORY_WEIGHTS_NORMAL = [
    { cat: 'green',       w: 25 },
    { cat: 'red-resp',    w: 12 },
    { cat: 'red-perf',    w: 12 },
    { cat: 'red-mental',  w: 8  },
    { cat: 'yellow',      w: 25 },
    { cat: 'black',       w: 8  },
  ];

  // Veteran mode: revolves around the borderline RED-vs-BLACK judgment.
  // No greens. Few yellows. Heavy on airway-intervention scenarios and
  // shock-state extremis. Designed to drill the reflex of NOT calling
  // a salvageable patient black under pressure.
  const CATEGORY_WEIGHTS_VETERAN = [
    { cat: 'vet-airway-red',              w: 22 },  // apneic → 1 head-tilt → breathing → RED
    { cat: 'vet-airway-black',            w: 18 },  // apneic → 1 head-tilt → nothing → BLACK
    { cat: 'vet-airway-persistent-black', w: 10 },  // 2nd attempt → still nothing → BLACK
    { cat: 'vet-borderline-red',          w: 16 },  // agonal but breathing → RED
    { cat: 'vet-extremis',                w: 14 },  // shock multi-system → RED
    { cat: 'red-resp',                    w: 8  },  // straight RR>30 sprinkled in
    { cat: 'red-perf',                    w: 6  },  // hemorrhage shock
    { cat: 'yellow',                      w: 4  },  // rare
    { cat: 'black',                       w: 2  },  // standard apneic black
  ];

  function buildCategoryQueue(count, difficulty) {
    const weights = (difficulty === 'veteran') ? CATEGORY_WEIGHTS_VETERAN : CATEGORY_WEIGHTS_NORMAL;
    const totalW = weights.reduce((a, b) => a + b.w, 0);
    // Largest-remainder method: floor each ideal count, then distribute
    // any leftover slots to the categories with the largest fractional parts.
    // Guarantees the deck composition matches the weights as closely as
    // possible — no category gets squeezed out by greedy rounding.
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

    // Interleave shuffle so categories are mixed
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return queue;
  }

  function generateDeck(count, difficulty) {
    count = Math.max(1, Math.min(parseInt(count) || 1, 500));
    const queue = buildCategoryQueue(count, difficulty);
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

  /* ============================================================
     EXPERT MODE — fatal-incident generator
     ============================================================
     Triggered when the player gets one wrong in Expert mode.
     Picks a randomized firefighter/medic-flavored death scenario.
     Each entry: short headline + a single line of detail.
     Tone is dark-funny but professional — these are training-room
     callbacks to "rookie mistakes that get you killed" stories
     veterans tell at the kitchen table.
     ============================================================ */
  const FATAL_INCIDENTS = [
    { head: 'YOU SKIPPED YOUR 360',
      body: 'Walked into the structure without a size-up. Roof collapsed onto your air pack.' },
    { head: 'STRUCK BY TRAFFIC',
      body: 'Stepped out of the rig without checking the lane. A box truck didn\'t see your turnouts.' },
    { head: 'HIT BY A CAR',
      body: 'Crossed the highway without a blocker. Driver was looking at their phone.' },
    { head: 'YOU FORGOT TO LOOK BOTH WAYS',
      body: 'Crossing the rural highway. The patient was fine. You weren\'t.' },
    { head: 'CAUGHT IN A FLASHOVER',
      body: 'Skipped the smoke read. Compartment lit off seconds after you stepped inside.' },
    { head: 'RAN OUT OF AIR',
      body: 'Ignored your low-air alarm pushing for "one more search." Made it 8 feet from the door.' },
    { head: 'FELL THROUGH THE FLOOR',
      body: 'Didn\'t sound the floor. The kitchen was over a finished basement that was no longer a floor.' },
    { head: 'STRUCK BY FALLING DEBRIS',
      body: 'Stood under the overhang to "get a better look." A 200-lb section of cornice answered.' },
    { head: 'POWER LINE DOWN',
      body: 'Pulled up at the MVA without scanning above. The downed line touched the rig as you stepped out.' },
    { head: 'BACKED OVER AT THE SCENE',
      body: 'Stood behind the engine to grab tools. The driver had no spotter and a tight cone of cars.' },
    { head: 'STRUCK BY A DRUNK DRIVER',
      body: 'Working the highway shoulder. They blew past the cones at 80 mph.' },
    { head: 'CARDIAC EVENT ON THE LINE',
      body: 'Pushed through the chest pain to finish the assignment. Made it to rehab. Didn\'t make it home.' },
    { head: 'CAUGHT IN A BACKDRAFT',
      body: 'Forced the door without venting first. The room had been waiting for you.' },
    { head: 'STRUCK BY A TRAIN',
      body: 'Worked the grade-crossing MVA without a flagger. Conductor laid on the horn for half a mile.' },
    { head: 'HEAT STROKE',
      body: 'Skipped rehab, third bottle on the line in 100°F gear. Found you down at the next change-out.' },
    { head: 'DROWNED ON A WATER RESCUE',
      body: 'No PFD, no tether, current looked manageable from the bank. It wasn\'t.' },
    { head: 'STRUCK WHILE FREEING THE TRAPPED',
      body: 'Pillar gave way during the extrication. No one was watching the load-bearing structure.' },
    { head: 'FELL FROM THE AERIAL',
      body: 'Unhooked early to climb down faster. The last rung was further than you thought.' },
    { head: 'NEEDLE STICK',
      body: 'Went bare-handed to clear an unknown patient\'s pockets. The cap was on the syringe. The needle wasn\'t.' },
    { head: 'EXPOSURE TO UNKNOWN CHEMICAL',
      body: 'Walked the spill without donning Level B. The placard was readable from twenty feet — you didn\'t look.' },
  ];

  function generateFatalIncident() {
    const inc = pick(FATAL_INCIDENTS);
    const id = `inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { id, head: inc.head, body: inc.body };
  }

  // Expose to global scope for app.js
  window.generateDeck = generateDeck;
  window.TRIAGE_INFO = TRIAGE_INFO;
  window.generateFatalIncident = generateFatalIncident;
  // Backwards-compat stub
  window.SCENARIOS = [];
})();
