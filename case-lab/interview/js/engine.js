/* Mock interview — client-side phase machine.
   Owns phase budgets, timers (pause-aware), director notes and the [[NEXT]]/[[END]] control tokens.
   No DOM access, so it can be unit-tested in node. */

/* weight = relative minutes in a 45-minute full loop; budgets are rescaled to the chosen length. */
export const PHASE_DEFS = {
  opening: {
    label: 'Opening', weight: 2, minTurns: 1, maxTurns: 2,
    goal: 'Greet the candidate, introduce yourself and the format briefly, put them at ease, then move into their introduction.',
  },
  intro: {
    label: 'Intro', weight: 4, minTurns: 1, maxTurns: 3,
    goal: 'Candidate gives a 2-minute "walk me through your background". Listen for the through-line and pick the threads you will pull on later. One light follow-up at most.',
  },
  resume: {
    label: 'Resume deep dive', weight: 10, minTurns: 3, maxTurns: 8,
    goal: 'Pick the 1-2 most interview-worthy projects from the resume (or the JD-relevant ones) and drill: their role vs the team, the number and how it was measured, the hardest trade-off, what failed, what they would do differently. Call out "we" answers.',
  },
  behavioural: {
    label: 'Behavioural', weight: 10, minTurns: 2, maxTurns: 9,
    goal: 'Ask the chosen behavioural questions (near-verbatim, one at a time). For each, probe for missing STAR parts, personal ownership and quantified results using the question\'s follow-ups.',
  },
  case: {
    label: 'Product case', weight: 17, minTurns: 5, maxTurns: 16,
    goal: 'Read out the case prompt, answer clarifying questions from the assumptions, let the candidate drive, probe with the follow-ups (2-3 of them) and the hidden pitfalls, give a time check about two-thirds through.',
  },
  candidate_qs: {
    label: 'Your questions', weight: 3, minTurns: 1, maxTurns: 4,
    goal: 'Invite the candidate\'s questions about the role, team and company. Answer briefly and realistically in persona (plausible, invented detail is fine). When they are done, wrap up.',
  },
  close: {
    label: 'Close', weight: 0.5, minTurns: 1, maxTurns: 1,
    goal: 'Thank them, give one sentence on next steps, say goodbye. End your message with [[END]].',
  },
};

export const ROUNDS = {
  full:        { label: 'Full loop',                 phases: ['opening', 'intro', 'resume', 'behavioural', 'case', 'candidate_qs', 'close'], behavCount: 2 },
  resume:      { label: 'Resume screen',             phases: ['opening', 'intro', 'resume', 'candidate_qs', 'close'], behavCount: 0 },
  behavioural: { label: 'Behavioural',               phases: ['opening', 'intro', 'behavioural', 'candidate_qs', 'close'], behavCount: 3 },
  case:        { label: 'Product case',              phases: ['opening', 'case', 'candidate_qs', 'close'], behavCount: 0 },
  hm:          { label: 'Hiring-manager mix',        phases: ['opening', 'intro', 'resume', 'behavioural', 'case', 'candidate_qs', 'close'], behavCount: 1,
                 weights: { resume: 8, behavioural: 5, case: 12 } },
};

/* Phase budgets in minutes; always sum to lengthMin. */
export function computeBudgets(roundKey, lengthMin) {
  const round = ROUNDS[roundKey] || ROUNDS.full;
  const w = id => (round.weights && round.weights[id]) || PHASE_DEFS[id].weight;
  const total = round.phases.reduce((s, id) => s + w(id), 0);
  return round.phases.map(id => Object.assign({ id, budgetMin: (w(id) / total) * lengthMin, usedSec: 0 }, PHASE_DEFS[id]));
}

/* ---- Control tokens ---- */
const TOKEN_RE = /\[\[\s*(NEXT|END)\s*\]\]/gi;
// A trailing, still-incomplete token while streaming: "[", "[[", "[[NE", "[[NEXT]" ...
const PARTIAL_RE = /\[(\[([NE][A-Za-z]{0,3}\]?)?)?$/;

/* Final parse of a full reply. */
export function parseReply(raw) {
  let next = false, end = false;
  const text = String(raw || '').replace(TOKEN_RE, (_, t) => { if (/next/i.test(t)) next = true; else end = true; return ''; })
    .replace(/[ \t]+\n/g, '\n').trim();
  return { text, next, end };
}

/* While streaming: what is safe to show / speak so far (complete tokens and token prefixes removed). */
export function streamSafe(raw) {
  return String(raw || '').replace(TOKEN_RE, '').replace(PARTIAL_RE, '');
}

const RAMBLE_WORDS = 350, RAMBLE_SEC = 180, SHORT_WORDS = 25, FORCE_FACTOR = 1.25;

export class Interview {
  constructor({ round = 'full', lengthMin = 45, behavCount, now = () => Date.now() } = {}) {
    this.roundKey = ROUNDS[round] ? round : 'full';
    this.lengthMin = lengthMin;
    this.behavCount = behavCount != null ? behavCount : ROUNDS[this.roundKey].behavCount;
    this.phases = computeBudgets(this.roundKey, lengthMin);
    this.now = now;
    this.idx = 0;
    this.turnsInPhase = 0;
    this.started = false;
    this.paused = false;
    this.pausedMs = 0;
    this.pauseStart = 0;
    this.startAt = 0;
    this.phaseStartSec = 0;
    this.forceWrapSent = false;
    this.timeCheckSent = false;
    this.ended = false;
  }

  get phase() { return this.phases[this.idx]; }
  get nextPhase() { return this.phases[this.idx + 1] || null; }
  get isLast() { return this.idx >= this.phases.length - 1; }

  start() { if (!this.started) { this.started = true; this.startAt = this.now(); } }
  pause() { if (this.started && !this.paused) { this.paused = true; this.pauseStart = this.now(); } }
  resume() { if (this.paused) { this.pausedMs += this.now() - this.pauseStart; this.paused = false; } }

  /* Active interview time in seconds (pauses excluded). */
  elapsedSec() {
    if (!this.started) return 0;
    const ref = this.paused ? this.pauseStart : this.now();
    return Math.max(0, (ref - this.startAt - this.pausedMs) / 1000);
  }
  phaseElapsedSec() { return Math.max(0, this.elapsedSec() - this.phaseStartSec); }

  /* Seconds spent in each phase so far (for metrics). */
  phaseUsage() {
    return this.phases.map((p, i) => (i === this.idx && !this.ended ? Object.assign({}, p, { usedSec: this.phaseElapsedSec() }) : p));
  }

  advance() {
    if (this.isLast) return false;
    this.phase.usedSec = this.phaseElapsedSec();
    this.idx++;
    this.phaseStartSec = this.elapsedSec();
    this.turnsInPhase = 0;
    this.forceWrapSent = false;
    this.timeCheckSent = false;
    return true;
  }

  finish() {
    if (this.ended) return;
    this.phase.usedSec = this.phaseElapsedSec();
    this.ended = true;
  }

  overBudget() { return this.phaseElapsedSec() > this.phase.budgetMin * 60; }
  wrapDue() { return this.phaseElapsedSec() > this.phase.budgetMin * 60 * FORCE_FACTOR || this.turnsInPhase > this.phase.maxTurns; }

  /* First user message of the session (no candidate speech yet). */
  startNote() {
    return `<director>\n${this._header()}\nThe candidate has just joined the call. Deliver your opening (phase "opening"): greet them by name if you know it, introduce yourself in one sentence, say how the session will run in one sentence, and ask if they are ready. Do not end with [[NEXT]] yet.\n</director>\n\n(The candidate has joined.)`;
  }

  _header() {
    const p = this.phase, n = this.nextPhase;
    const mm = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    return [
      `Phase: ${p.id} (${this.idx + 1} of ${this.phases.length}) — ${p.goal}`,
      `Time: phase ${mm(this.phaseElapsedSec())} of ${mm(p.budgetMin * 60)} budget; overall ${mm(this.elapsedSec())} of ${mm(this.lengthMin * 60)}.`,
      `Your turns so far in this phase: ${this.turnsInPhase} (typical ${p.minTurns}-${p.maxTurns}).`,
      n ? `If you transition, the next phase is "${n.id}": ${n.goal}` : 'This is the final phase.',
    ].join('\n');
  }

  /* Build the user message for the newest candidate answer. Earlier messages are never touched
     (append-only history keeps the prompt cache warm). */
  buildUserMessage({ text, words = 0, durationSec = 0, skipped = false }) {
    const p = this.phase;
    const flags = [];
    const instr = [];
    if (skipped) {
      flags.push('skipped');
      instr.push('The candidate skipped your last question. Acknowledge in a few words ("Sure, let\'s move on.") and continue with a different question or the next part of this phase. Do not comment on the skip.');
    } else {
      if (words > RAMBLE_WORDS || durationSec > RAMBLE_SEC) {
        flags.push('rambling');
        instr.push('The last answer ran long. Respond according to your interruption setting: redirect politely to the part you care about.');
      }
      if (words < SHORT_WORDS) {
        flags.push('short');
        instr.push('The last answer was thin. Probe for specifics (an example, a number, their personal role) rather than moving on.');
      }
    }
    if (this.overBudget()) flags.push('phase_over_budget');
    const wrap = this.wrapDue();
    if (wrap) {
      this.forceWrapSent = true;
      instr.push(this.isLast
        ? 'Time is up. Say goodbye now and end with [[END]].'
        : `Time for this phase is up. Wrap it in one sentence, ask the first question of the next phase ("${this.nextPhase.id}") and end your message with [[NEXT]].`);
    } else if (p.id !== 'close' && this.overBudget()) {
      instr.push('This phase is over its time budget; wrap up soon (within one or two turns) unless the candidate is mid-thought.');
    } else if (this.turnsInPhase >= p.minTurns && this.phaseElapsedSec() > p.budgetMin * 60 * 0.8 && this.nextPhase) {
      instr.push('You have what you need and the phase is nearly out of time. You may transition now.');
    }
    if (p.id === 'case' && !this.timeCheckSent && this.phaseElapsedSec() > p.budgetMin * 60 * (2 / 3)) {
      this.timeCheckSent = true;
      instr.push('Give a brief, natural time check ("we have about N minutes left") in this message.');
    }
    if (this.turnsInPhase === 0 && p.id !== 'opening') {
      instr.push(`The phase just changed to "${p.id}" without its first question being asked. Ask it now.`);
    }
    const note = [
      this._header(),
      `Candidate's last answer: ${words} words, ${Math.round(durationSec)}s.`,
      flags.length ? `Flags: ${flags.join(', ')}.` : 'Flags: none.',
      ...instr,
    ].join('\n');
    return `<director>\n${note}\n</director>\n\nCandidate said:\n${text}`;
  }

  /* Apply the interviewer's finished reply. Returns what the UI should do next. */
  applyReply(raw) {
    const r = parseReply(raw);
    this.turnsInPhase++;
    const forced = this.forceWrapSent;
    let advanced = false, ended = false;
    if (this.phase.id === 'close' && (r.end || r.next || forced || this.turnsInPhase >= this.phase.maxTurns + 1)) ended = true;
    else if (r.end && this.isLast) ended = true;
    else if ((r.next || forced) && !this.isLast) {
      advanced = this.advance();
      this.turnsInPhase = r.next ? 1 : 0; // the transition message carries the new phase's opening question
    }
    if (r.end && !this.isLast) { /* [[END]] before the close phase: ignore, keep interviewing */ }
    if (ended) this.finish();
    return { text: r.text, advanced, ended, phase: this.phase };
  }
}
