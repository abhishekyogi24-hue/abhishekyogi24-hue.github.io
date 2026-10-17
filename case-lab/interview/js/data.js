/* Mock interview — loads Case Lab data and picks the case / questions for a session.
   Single source of truth stays ../data/*.json; nothing here is duplicated. */

export const DATA_BASE = '../data/';
export const RESUME_FILES = ['../../kb/sources/core.md', '../../kb/sources/experience-in-detail.md'];

export const D = { cases: [], behav: { themes: [], questions: [] }, stories: [], frameworks: {}, schedule: { epoch: '2026-09-14', days: [] }, resume: '' };

async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}
async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    return r.ok ? r.text() : '';
  } catch (e) { return ''; }
}

export async function loadAll() {
  const [cases, behav, stories, frameworks, schedule, ...resume] = await Promise.all([
    fetchJSON(DATA_BASE + 'cases.json'),
    fetchJSON(DATA_BASE + 'behavioural.json'),
    fetchJSON(DATA_BASE + 'stories.json'),
    fetchJSON(DATA_BASE + 'frameworks.json'),
    fetchJSON(DATA_BASE + 'schedule.json'),
    ...RESUME_FILES.map(fetchText),
  ]);
  D.cases = cases.cases || [];
  D.behav = { themes: behav.themes || [], questions: behav.questions || [] };
  D.stories = stories.stories || [];
  D.frameworks = frameworks || {};
  D.schedule = schedule || D.schedule;
  D.resume = resume.filter(Boolean).join('\n\n---\n\n').trim();
  return D;
}

/* ---- Framework resolution (mirrors resolveFramework in ../script.js) ---- */
export function resolveFramework(key, frameworks = D.frameworks) {
  const raw = frameworks[key];
  if (!raw) return null;
  if (raw.inherits) {
    const base = frameworks[raw.inherits];
    if (!base) return raw;
    return Object.assign({}, base, raw, { stages: base.stages, rubric: base.rubric });
  }
  return raw;
}

/* ---- Day index: mirrors computeDayIndex() in ../script.js exactly (IST calendar day, clamped at 0).
   `now` is injectable for tests. ---- */
export function computeDayIndex(epochStr, overrideDay, now = new Date()) {
  if (overrideDay !== null && overrideDay !== undefined && !Number.isNaN(overrideDay)) return overrideDay;
  const istToday = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const parts = String(epochStr || '2026-09-14').split('-').map(Number);
  const idx = Math.floor((Date.UTC(istToday.getFullYear(), istToday.getMonth(), istToday.getDate())
    - Date.UTC(parts[0], parts[1] - 1, parts[2])) / 86400000);
  return idx < 0 ? 0 : idx;
}

/* Today's scheduled case id; null on a Sunday (null slot) or empty schedule. */
export function todaysCaseId(schedule = D.schedule, now = new Date()) {
  const days = schedule.days || [];
  if (!days.length) return null;
  const idx = computeDayIndex(schedule.epoch, null, now);
  return days[((idx % days.length) + days.length) % days.length] || null;
}

export function caseById(id) { return D.cases.find(c => c.id === id) || null; }

function randomOf(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

/* Choose the session's case from settings. Returns { case, note } so the UI can explain fallbacks. */
export function pickCase(s, now = new Date()) {
  if (s.caseMode === 'pick' && s.casePick) {
    const c = caseById(s.casePick);
    if (c) return { case: c, note: 'Picked case.' };
  }
  if (s.caseMode === 'today') {
    const id = todaysCaseId(D.schedule, now);
    const c = id && caseById(id);
    if (c) return { case: c, note: "Today's Case Lab case." };
    // Sunday / missing -> random fallback
    return { case: randomOf(D.cases), note: "No case scheduled today (rest day) — picked a random one." };
  }
  let pool = D.cases;
  if (s.caseTrack && s.caseTrack !== 'any') pool = pool.filter(c => c.track === s.caseTrack);
  if (s.caseDifficulty && s.caseDifficulty !== 'any') pool = pool.filter(c => String(c.difficulty) === String(s.caseDifficulty));
  if (!pool.length) pool = D.cases;
  return { case: randomOf(pool), note: 'Random case.' };
}

/* Behavioural questions: auto = weighted to themes not practised recently (history), else the user's picks. */
export function pickBehavioural(s, count, recentThemes = []) {
  const qs = D.behav.questions;
  if (s.behavMode === 'pick' && (s.behavPick || []).length) {
    const picked = s.behavPick.map(id => qs.find(q => q.id === id)).filter(Boolean);
    if (picked.length) return picked.slice(0, Math.max(count, picked.length));
  }
  const seen = new Map();
  recentThemes.forEach((t, i) => seen.set(t, (seen.get(t) || 0) + 1 + (recentThemes.length - i) / 100));
  const chosen = [];
  const usedThemes = new Set();
  const pool = qs.slice();
  while (chosen.length < count && pool.length) {
    // weight = 1 / (1 + times practised recently); one question per theme where possible
    const weights = pool.map(q => (usedThemes.has(q.theme) ? 0.05 : 1) / (1 + (seen.get(q.theme) || 0) * 2));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total, i = 0;
    for (; i < pool.length - 1; i++) { r -= weights[i]; if (r <= 0) break; }
    const q = pool.splice(i, 1)[0];
    chosen.push(q);
    usedThemes.add(q.theme);
  }
  return chosen;
}

export function themeLabel(key) {
  const t = D.behav.themes.find(x => x.key === key);
  return t ? t.label : key;
}
