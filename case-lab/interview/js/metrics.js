/* Mock interview — client-side communication metrics.
   These numbers are computed here (never by the model) and shown in the report. */

// Single words and phrases that count as fillers. "right?" only counts with the question mark.
const FILLER_PATTERNS = [
  /\bum+\b/gi, /\buh+\b/gi, /\ber+m?\b/gi, /\blike\b/gi, /\bbasically\b/gi, /\bactually\b/gi,
  /\byou know\b/gi, /\bsort of\b/gi, /\bkind of\b/gi, /\bliterally\b/gi, /\bright\?/gi,
];

export function countWords(text) {
  const m = String(text || '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

export function countFillers(text) {
  const t = String(text || '');
  return FILLER_PATTERNS.reduce((n, re) => n + (t.match(re) || []).length, 0);
}

/* Metrics for one answer. durationSec = first word -> Done; ttfwSec = question end -> first word. */
export function answerMetrics({ text, durationSec, ttfwSec, mode }) {
  const words = countWords(text);
  const dur = Math.max(0, durationSec || 0);
  return {
    words,
    durationSec: Math.round(dur),
    wpm: dur >= 5 && words ? Math.round(words / (dur / 60)) : null,
    fillers: countFillers(text),
    ttfwSec: ttfwSec == null ? null : Math.round(ttfwSec * 10) / 10,
    mode: mode || 'voice',
  };
}

/* Session-level roll-up. answers = [{phase, metrics, skipped}], phases = engine phase list with
   budgetMin and usedSec, totalSec = wall-clock interview length (pauses excluded). */
export function sessionMetrics({ answers, phases, totalSec }) {
  const real = answers.filter(a => !a.skipped);
  const talkSec = real.reduce((s, a) => s + a.metrics.durationSec, 0);
  const words = real.reduce((s, a) => s + a.metrics.words, 0);
  const fillers = real.reduce((s, a) => s + a.metrics.fillers, 0);
  const ttfw = real.map(a => a.metrics.ttfwSec).filter(v => v != null);
  const voiced = real.filter(a => a.metrics.mode === 'voice' && a.metrics.wpm);
  const longest = real.reduce((best, a) => (!best || a.metrics.durationSec > best.metrics.durationSec ? a : best), null);
  return {
    answerCount: real.length,
    skippedCount: answers.length - real.length,
    talkSec,
    talkRatio: totalSec > 0 ? Math.round((talkSec / totalSec) * 100) : 0,
    totalWords: words,
    avgWpm: voiced.length ? Math.round(voiced.reduce((s, a) => s + a.metrics.wpm, 0) / voiced.length) : null,
    fillersTotal: fillers,
    fillersPerMin: talkSec >= 30 ? Math.round((fillers / (talkSec / 60)) * 10) / 10 : null,
    avgTtfwSec: ttfw.length ? Math.round((ttfw.reduce((s, v) => s + v, 0) / ttfw.length) * 10) / 10 : null,
    longestAnswer: longest ? { phase: longest.phase, durationSec: longest.metrics.durationSec, words: longest.metrics.words } : null,
    totalSec: Math.round(totalSec),
    phases: phases.map(p => ({ id: p.id, label: p.label, budgetMin: Math.round(p.budgetMin * 10) / 10, usedMin: Math.round((p.usedSec / 60) * 10) / 10 })),
  };
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
