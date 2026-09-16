// PM Case Lab — vanilla JS, no build step, no framework.
'use strict';

/* ============================== Constants ============================== */
const LS_NOTES = 'caselab_notes_v1';
const LS_SCORES = 'caselab_scores_v1';
const LS_STATUS = 'caselab_status_v1';
const LS_BEHAV = 'caselab_behav_v1';
const LS_BEHAV_STATUS = 'caselab_behav_status_v1';
const LS_THEME = 'caselab_theme_v1';
const LS_ACTIVITY = 'caselab_activity_v1';
const LS_LIVE = 'caselab_live_v1';
const STATUSES = ['new', 'active', 'completed', 'bookmarked', 'skipped'];
const TOTAL_TIMER_SEC = 45 * 60;
const LIVE_MIN_WORDS = 5;
const LIVE_MIN_SCORE = 4;
const LIVE_SPEAK_WPM = 130;
// Base URL of the chatbot-worker deployment (see ../chatbot-worker/README.md,
// "Live case answers"). Empty = inline "Get answer" is off and the "Copy AI
// prompt" fallback is the primary path — nothing here ever assumes it's set.
const LIVE_WORKER_URL = '';
const LIVE_FIRST_BYTE_TIMEOUT_MS = 15000;
const LIVE_IDLE_TIMEOUT_MS = 20000;
const LIVE_ANSWER_MAX_STORED_CHARS = 60000;
const LIVE_SUBMIT_DEBOUNCE_MS = 600;

/* ============================== Global data ============================== */
let FRAMEWORKS = {};
let CASES = [];
let SCHEDULE = { epoch: '2026-09-14', days: [] };
let STORIES = [];
let BEHAVIOURAL = null;
let COVERAGE = null;
let DAY_INDEX = 0;
let timerState = null; // { caseId, running, elapsedSec, intervalId, currentStageIdx, stageStartElapsedSec, segments }

const state = {
  activeView: 'today',
  practiceCaseId: null,
  practiceReturnView: 'today',
  casesFilter: { status: 'all', track: 'all', type: 'all', company: 'all', region: 'all', difficulty: 'all', q: '' },
  live: {
    text: '', typeOverride: null, frameworkOverride: null, cls: null,
    answer: '', answerStatus: 'idle', answerError: null, answerCode: null,
    answerFor: null, answerAt: null, abort: null, partial: false,
    workerReachable: null, lastSubmitAt: 0
  }
};

/* ============================== Small utilities ============================== */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function titleCase(s) {
  return String(s == null ? '' : s).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function fmtTime(sec) {
  sec = Math.max(0, sec | 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function wrapIndex(idx, len) {
  if (!len) return 0;
  return ((idx % len) + len) % len;
}
function uniqueSorted(arr) {
  return [...new Set(arr)].sort();
}

/* ---- localStorage: every read/write wrapped, never throws ---- */
function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore quota/denied errors */ }
}

/* ============================== Day / schedule math ============================== */
function computeDayIndex(epochStr, overrideDay) {
  if (overrideDay !== null && overrideDay !== undefined && !Number.isNaN(overrideDay)) return overrideDay;
  const istToday = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const parts = String(epochStr || '2026-09-14').split('-').map(Number);
  const ey = parts[0], em = parts[1], ed = parts[2];
  const idx = Math.floor((Date.UTC(istToday.getFullYear(), istToday.getMonth(), istToday.getDate())
    - Date.UTC(ey, em - 1, ed)) / 86400000);
  // Before the epoch (the rotation hasn't started yet) show day 0 rather than wrapping round
  // to an arbitrary case at the end of the schedule. Mirrors resolveDay() in CaseLabAppsScript.gs.
  return idx < 0 ? 0 : idx;
}
function dateForIndex(epochStr, idx) {
  const parts = String(epochStr || '2026-09-14').split('-').map(Number);
  const base = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  base.setUTCDate(base.getUTCDate() + idx);
  return base.toISOString().slice(0, 10);
}
function getDayOverride() {
  const p = new URLSearchParams(location.search).get('day');
  if (p === null || p === '') return null;
  const n = parseInt(p, 10);
  return Number.isNaN(n) ? null : n;
}

/* ============================== Framework resolution ============================== */
function resolveFramework(key) {
  const raw = FRAMEWORKS[key];
  if (!raw) return null;
  if (raw.inherits) {
    const base = FRAMEWORKS[raw.inherits];
    if (!base) return raw;
    return Object.assign({}, base, raw, { stages: base.stages, rubric: base.rubric });
  }
  return raw;
}
function getFrameworkForCase(c) {
  const fw = resolveFramework(c.framework);
  return fw || { label: 'Unknown framework', totalMin: 45, stages: [], rubric: [] };
}
function frameworkPitfalls(fw) {
  const out = [];
  (fw.stages || []).forEach(s => (s.pitfalls || []).forEach(p => { if (!out.includes(p)) out.push(p); }));
  return out;
}
function matchModelAnswer(caseObj, fw) {
  const map = {};
  ((caseObj.modelAnswer && caseObj.modelAnswer.stages) || []).forEach(s => { map[s.stage] = s.walkthrough; });
  return (fw.stages || []).map(st => ({ stage: st, walkthrough: map[st.name] || null }));
}
function getCaseById(id) { return CASES.find(c => c.id === id) || null; }

function scoreSummaryText(score) {
  const vals = Object.values((score && score.dims) || {});
  if (!vals.length) return 'not scored yet';
  const counts = { weak: 0, solid: 0, strong: 0 };
  vals.forEach(v => { if (counts[v] !== undefined) counts[v]++; });
  const avg = vals.reduce((a, v) => a + ({ weak: 1, solid: 2, strong: 3 }[v] || 0), 0) / vals.length;
  return `${counts.strong} strong · ${counts.solid} solid · ${counts.weak} weak (avg ${avg.toFixed(1)}/3)`;
}

/* ============================== localStorage-backed stores ============================== */
// -- status (cases) --
function getAllStatus() { return lsGet(LS_STATUS, {}); }
function getCaseStatus(id) { return getAllStatus()[id] || 'new'; }
function setCaseStatus(id, status, opts) {
  opts = opts || {};
  const all = getAllStatus();
  if (opts.auto && all[id] === 'completed') return;
  all[id] = status;
  lsSet(LS_STATUS, all);
  recordActivity();
}

// -- notes --
function getAllNotes() { return lsGet(LS_NOTES, {}); }
function getCaseNotes(id) { return getAllNotes()[id] || {}; }
function setCaseNote(id, stageKey, text) {
  const all = getAllNotes();
  const cur = all[id] || {};
  cur[stageKey] = text;
  all[id] = cur;
  lsSet(LS_NOTES, all);
  recordActivity();
}
const noteTimers = {};
function debounceSaveNote(caseId, stageKey, text) {
  const k = caseId + '::' + stageKey;
  clearTimeout(noteTimers[k]);
  noteTimers[k] = setTimeout(() => {
    setCaseNote(caseId, stageKey, text);
    const hint = document.getElementById('save-hint-' + stageKey);
    if (hint) hint.textContent = 'saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, 400);
}

// -- scores --
function getAllScores() { return lsGet(LS_SCORES, {}); }
function getCaseScore(id) { return getAllScores()[id] || null; }
function setCaseScoreDim(id, dim, level) {
  const all = getAllScores();
  const cur = all[id] || { dims: {} };
  cur.dims = cur.dims || {};
  cur.dims[dim] = level;
  cur.savedAt = new Date().toISOString();
  all[id] = cur;
  lsSet(LS_SCORES, all);
  recordActivity();
  return cur;
}

// -- behavioural answers --
function getAllBehav() { return lsGet(LS_BEHAV, {}); }
function getBehavAnswer(qid) { return getAllBehav()[qid] || { fields: {}, linkedStories: [] }; }
function setBehavField(qid, fieldName, text) {
  const all = getAllBehav();
  const cur = all[qid] || { fields: {}, linkedStories: [] };
  cur.fields = cur.fields || {};
  cur.fields[fieldName] = text;
  cur.savedAt = new Date().toISOString();
  all[qid] = cur;
  lsSet(LS_BEHAV, all);
  recordActivity();
}
function toggleLinkedStory(qid, storyId) {
  const all = getAllBehav();
  const cur = all[qid] || { fields: {}, linkedStories: [] };
  cur.linkedStories = cur.linkedStories || [];
  const idx = cur.linkedStories.indexOf(storyId);
  if (idx === -1) cur.linkedStories.push(storyId); else cur.linkedStories.splice(idx, 1);
  all[qid] = cur;
  lsSet(LS_BEHAV, all);
  recordActivity();
}
function hasBehavAnswer(qid) {
  const a = getAllBehav()[qid];
  if (!a || !a.fields) return false;
  return Object.values(a.fields).some(v => v && String(v).trim().length > 0);
}
const behavTimers = {};
function debounceSaveBehavField(qid, field, text) {
  const k = qid + '::' + field;
  clearTimeout(behavTimers[k]);
  behavTimers[k] = setTimeout(() => setBehavField(qid, field, text), 400);
}

// -- behavioural status --
function getAllBehavStatus() { return lsGet(LS_BEHAV_STATUS, {}); }
function getBehavStatus(qid) { return getAllBehavStatus()[qid] || 'new'; }
function setBehavStatus(qid, status) {
  const all = getAllBehavStatus();
  all[qid] = status;
  lsSet(LS_BEHAV_STATUS, all);
  recordActivity();
}

// -- activity log / streak --
function istDateStr(d) {
  d = d || new Date();
  const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const y = ist.getFullYear(), m = String(ist.getMonth() + 1).padStart(2, '0'), dd = String(ist.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function recordActivity() {
  const all = lsGet(LS_ACTIVITY, {});
  all[istDateStr()] = true;
  lsSet(LS_ACTIVITY, all);
}
function computeStreak() {
  const all = lsGet(LS_ACTIVITY, {});
  let cursor = new Date();
  let dateStr = istDateStr(cursor);
  if (!all[dateStr]) {
    cursor = new Date(cursor.getTime() - 86400000);
    dateStr = istDateStr(cursor);
    if (!all[dateStr]) return 0;
  }
  let streak = 0;
  while (all[dateStr]) {
    streak++;
    cursor = new Date(cursor.getTime() - 86400000);
    dateStr = istDateStr(cursor);
  }
  return streak;
}

/* ============================== Behavioural data helpers (defensive) ============================== */
function getBehavQuestions() {
  if (!BEHAVIOURAL) return [];
  if (Array.isArray(BEHAVIOURAL)) return BEHAVIOURAL;
  if (Array.isArray(BEHAVIOURAL.questions)) return BEHAVIOURAL.questions;
  return [];
}
function getQuestionById(qid) {
  return getBehavQuestions().find(q => q.id === qid) || null;
}
function storiesForQuestion(qid) {
  return STORIES.filter(s => Array.isArray(s.questionTags) && s.questionTags.includes(qid));
}
function getBehavThemesList() {
  if (BEHAVIOURAL && Array.isArray(BEHAVIOURAL.themes)) {
    return BEHAVIOURAL.themes.map(t => (typeof t === 'string' ? t : (t.key || t.name || String(t))));
  }
  const set = new Set();
  getBehavQuestions().forEach(q => { if (q.theme) set.add(q.theme); });
  return [...set];
}
// Themes may be plain strings or {key,label,why} objects — prefer the human label when present.
function themeLabel(key) {
  if (BEHAVIOURAL && Array.isArray(BEHAVIOURAL.themes)) {
    const found = BEHAVIOURAL.themes.find(t => (typeof t === 'string' ? t : (t.key || t.name)) === key);
    if (found && typeof found === 'object' && found.label) return found.label;
  }
  return titleCase(key);
}
// A list field in the data may arrive as a single string, an array of strings, or be absent.
function asList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}
function fieldsForStructure(s) {
  const STRUCTURES = { STAR: ['Situation', 'Task', 'Action', 'Result'], CARL: ['Context', 'Action', 'Result', 'Learning'] };
  return STRUCTURES[String(s || 'STAR').toUpperCase()] || STRUCTURES.STAR;
}
function deriveThemesFromStories() {
  const set = new Set();
  STORIES.forEach(s => (s.themes || []).forEach(t => set.add(t)));
  return [...set].sort();
}
function computeCoverage() {
  if (COVERAGE && Array.isArray(COVERAGE.themes)) {
    const themes = COVERAGE.themes.map(t => (typeof t === 'string' ? t : (t.key || t.name || String(t))));
    const map = {};
    themes.forEach(key => {
      map[key] = (COVERAGE.byTheme && COVERAGE.byTheme[key])
        || (COVERAGE.map && COVERAGE.map[key])
        || STORIES.filter(s => (s.themes || []).includes(key)).map(s => s.id);
    });
    return { themes, map };
  }
  const themes = getBehavThemesList().length ? getBehavThemesList() : deriveThemesFromStories();
  const map = {};
  themes.forEach(t => { map[t] = STORIES.filter(s => (s.themes || []).includes(t)).map(s => s.id); });
  return { themes, map };
}

/* ============================== Timer ============================== */
function computeSegments(stages) {
  if (!stages || !stages.length) return [];
  const avgs = stages.map(s => (((s.minMin || 0) + (s.maxMin || s.minMin || 0)) / 2) || 1);
  const sum = avgs.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const segs = stages.map((s, i) => {
    const dur = Math.round((avgs[i] / sum) * TOTAL_TIMER_SEC);
    const seg = { key: s.key, name: s.name, startSec: acc, durSec: dur, minMin: s.minMin, maxMin: s.maxMin };
    acc += dur;
    return seg;
  });
  segs[segs.length - 1].durSec = TOTAL_TIMER_SEC - segs[segs.length - 1].startSec;
  return segs;
}
function initTimerForCase(caseId) {
  if (timerState && timerState.caseId === caseId) return;
  if (timerState && timerState.intervalId) clearInterval(timerState.intervalId);
  const c = getCaseById(caseId);
  const fw = c ? getFrameworkForCase(c) : { stages: [] };
  timerState = {
    caseId, running: false, elapsedSec: 0, intervalId: null,
    currentStageIdx: 0, stageStartElapsedSec: 0,
    segments: computeSegments(fw.stages)
  };
}
function startTimer() {
  if (!timerState || timerState.running) return;
  timerState.running = true;
  timerState.intervalId = setInterval(() => { timerState.elapsedSec++; updateTimerDisplay(); }, 1000);
  updateTimerDisplay();
}
function pauseTimer() {
  if (!timerState) return;
  timerState.running = false;
  clearInterval(timerState.intervalId);
  updateTimerDisplay();
}
function resetTimer() {
  if (!timerState) return;
  pauseTimer();
  timerState.elapsedSec = 0;
  timerState.currentStageIdx = 0;
  timerState.stageStartElapsedSec = 0;
}
function setCurrentStage(idx) {
  if (!timerState) return;
  timerState.currentStageIdx = idx;
  timerState.stageStartElapsedSec = timerState.elapsedSec;
  updateTimerDisplay();
}
function renderTimerBar() {
  const bar = document.getElementById('timer-bar');
  const nav = document.getElementById('timer-stage-nav');
  if (!bar || !nav || !timerState) return;
  bar.innerHTML = `<div class="timer-fill" id="timer-fill"></div>` + timerState.segments.map((s, i) => {
    const widthPct = (s.durSec / TOTAL_TIMER_SEC * 100).toFixed(3);
    return `<div class="timer-seg" data-seg-idx="${i}" style="width:${widthPct}%" title="${esc(s.name)} (${s.minMin}-${s.maxMin} min)"></div>`;
  }).join('');
  nav.innerHTML = timerState.segments.map((s, i) =>
    `<button type="button" class="chip-btn" data-stage-idx="${i}" aria-pressed="${String(i === timerState.currentStageIdx)}">${esc(s.name)}</button>`
  ).join('');
}
function updateTimerDisplay() {
  if (!timerState) return;
  const elapsedEl = document.getElementById('timer-elapsed');
  if (!elapsedEl) return; // practice view not currently in DOM view
  elapsedEl.textContent = fmtTime(timerState.elapsedSec);
  const stageLabelEl = document.getElementById('timer-stage-label');
  const warnEl = document.getElementById('timer-warning');
  const fillEl = document.getElementById('timer-fill');
  const seg = timerState.segments[timerState.currentStageIdx];
  const c = getCaseById(timerState.caseId);
  const fw = c ? getFrameworkForCase(c) : null;
  const stageDef = fw ? fw.stages[timerState.currentStageIdx] : null;
  if (stageLabelEl) stageLabelEl.innerHTML = seg ? `Stage: <b>${esc(seg.name)}</b>` : '';
  const inStageSec = timerState.elapsedSec - timerState.stageStartElapsedSec;
  const overThreshold = stageDef ? stageDef.maxMin * 60 : Infinity;
  if (warnEl) warnEl.hidden = !(inStageSec > overThreshold);
  if (fillEl) fillEl.style.width = Math.min(100, (timerState.elapsedSec / TOTAL_TIMER_SEC) * 100) + '%';
  document.querySelectorAll('#timer-bar .timer-seg').forEach(elx => {
    elx.classList.toggle('active', Number(elx.dataset.segIdx) === timerState.currentStageIdx);
  });
  document.querySelectorAll('#timer-stage-nav .chip-btn').forEach(elx => {
    elx.setAttribute('aria-pressed', String(Number(elx.dataset.stageIdx) === timerState.currentStageIdx));
  });
  const startBtn = document.getElementById('timer-start'), pauseBtn = document.getElementById('timer-pause');
  if (startBtn) startBtn.disabled = timerState.running;
  if (pauseBtn) pauseBtn.disabled = !timerState.running;
}

/* ============================== View switching ============================== */
function showView(name) {
  ['today', 'cases', 'behavioural', 'stories', 'progress', 'live', 'practice'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.hidden = (v !== name);
  });
  document.querySelectorAll('#tab-nav button[data-tab]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  });
}
function switchTab(tab) {
  state.activeView = tab;
  showView(tab);
  if (tab === 'today') renderToday();
  else if (tab === 'cases') renderCases();
  else if (tab === 'behavioural') renderBehavioural();
  else if (tab === 'stories') renderStories();
  else if (tab === 'progress') renderProgress();
  else if (tab === 'live') renderLive();
  renderStats();
}
function jumpToQuestion(qid) {
  switchTab('behavioural');
  requestAnimationFrame(() => {
    const el = document.querySelector(`details[data-qid="${window.CSS && CSS.escape ? CSS.escape(qid) : qid}"]`);
    if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
}
function openCase(caseId, returnView) {
  const c = getCaseById(caseId);
  if (!c) return;
  state.practiceReturnView = returnView || state.activeView;
  state.practiceCaseId = caseId;
  if (getCaseStatus(caseId) !== 'completed') setCaseStatus(caseId, 'active', { auto: true });
  initTimerForCase(caseId);
  renderPractice(caseId);
  showView('practice');
  renderStats();
}
function goBackFromPractice() {
  switchTab(state.practiceReturnView || 'today');
}

/* ============================== Shared refresh ============================== */
function afterMutation() {
  renderStats();
  if (state.activeView === 'today') renderToday();
  else if (state.activeView === 'cases') renderCases();
  else if (state.activeView === 'behavioural') renderBehavioural();
  else if (state.activeView === 'stories') renderStories();
  else if (state.activeView === 'progress') renderProgress();
  if (timerState) updatePracticeStatusSelect(timerState.caseId);
}
function updatePracticeStatusSelect(id) {
  const sel = document.getElementById('practice-status-select');
  if (sel) sel.value = getCaseStatus(id);
}

/* ============================== Header stats ============================== */
function renderStats() {
  const el = document.getElementById('stats');
  if (!el) return;
  const total = CASES.length;
  const statusCounts = {}; STATUSES.forEach(s => statusCounts[s] = 0);
  CASES.forEach(c => { statusCounts[getCaseStatus(c.id)] = (statusCounts[getCaseStatus(c.id)] || 0) + 1; });
  const streak = computeStreak();
  const cov = computeCoverage();
  const gapCount = cov.themes.filter(t => (cov.map[t] || []).length === 0).length;
  const behavQs = getBehavQuestions();
  const behavAttempted = behavQs.filter(q => hasBehavAnswer(q.id) || getBehavStatus(q.id) !== 'new').length;
  const behavPct = behavQs.length ? Math.round((behavAttempted / behavQs.length) * 100) : null;
  el.innerHTML = `
    <div class="stat"><div class="n">${streak}</div><div class="l">Day streak</div></div>
    <div class="stat"><div class="n">${statusCounts.completed}/${total}</div><div class="l">Cases completed</div></div>
    <div class="stat"><div class="n">${statusCounts.active}</div><div class="l">In progress</div></div>
    <div class="stat"><div class="n">${behavPct === null ? '—' : behavPct + '%'}</div><div class="l">Behavioural coverage</div></div>
    <div class="stat"><div class="n">${gapCount}</div><div class="l">Story gaps</div></div>`;
}

/* ============================== Today ============================== */
function renderToday() {
  const el = document.getElementById('view-today');
  if (!el) return;
  const len = (SCHEDULE.days || []).length;
  if (!len) { el.innerHTML = '<div class="empty">Schedule data isn\'t available.</div>'; return; }
  const idx = wrapIndex(DAY_INDEX, len);
  const caseId = SCHEDULE.days[idx];
  if (caseId === null || caseId === undefined) {
    el.innerHTML = renderReviewDigestHTML();
    return;
  }
  const c = getCaseById(caseId);
  if (!c) {
    el.innerHTML = `<div class="empty">Today's scheduled case (<b>${esc(caseId)}</b>) isn't in the case library yet.</div>`;
    return;
  }
  el.innerHTML = renderCaseDetailHTML(c, { showStart: true });
}
function renderCaseDetailHTML(c, opts) {
  opts = opts || {};
  const fw = getFrameworkForCase(c);
  const status = getCaseStatus(c.id);
  const score = getCaseScore(c.id);
  return `
    <div class="case-detail">
      <div class="card-top">
        <div>
          <h2>${esc(c.title)}</h2>
          <div class="company-chips">${(c.company || []).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>
        </div>
        <span class="badge status-${esc(status)}">${esc(titleCase(status))}</span>
      </div>
      <div class="badges">
        <span class="badge accent">${esc(titleCase(c.track))}</span>
        <span class="badge neutral">${esc(titleCase(c.type))}</span>
        <span class="badge neutral">Difficulty ${esc(String(c.difficulty))}/5</span>
        <span class="badge neutral">${esc(titleCase(c.region))}</span>
        <span class="badge neutral">${esc(String(c.timeboxMin || 45))} min timebox</span>
      </div>
      ${c.industry ? `<div class="note">${esc(titleCase(c.industry))}</div>` : ''}
      <div>
        <p class="block-label">Prompt</p>
        <div class="prompt-block">${esc(c.prompt)}</div>
      </div>
      ${(c.context && c.context.length) ? `<div><p class="block-label">Context</p><ul class="plain">${c.context.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${(c.assumptions && c.assumptions.length) ? `<div><p class="block-label">Assumptions</p><ul class="assumptions">${c.assumptions.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${(c.followUps && c.followUps.length) ? `<details class="followups"><summary>Follow-up questions (${c.followUps.length})</summary><ul class="plain">${c.followUps.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
      ${(c.related && c.related.length) ? `<div><p class="block-label">Related cases</p><div class="company-chips">${c.related.map(rid => { const rc = getCaseById(rid); return `<button type="button" class="chip-btn" data-action="open-case" data-id="${esc(rid)}">${esc(rc ? rc.title : rid)}</button>`; }).join('')}</div></div>` : ''}
      ${score ? `<div class="note">Self-score on file: ${scoreSummaryText(score)}</div>` : ''}
      ${opts.showStart ? `<div><button type="button" class="btn" data-action="open-case" data-id="${esc(c.id)}">Start practice →</button></div>` : ''}
      <div>
        <p class="block-label">${esc(fw.label)} framework · ${esc(String(fw.totalMin || 45))} min</p>
        ${stageListHTML(fw)}
      </div>
    </div>`;
}
function stageListHTML(fw) {
  return `<div class="stage-list">
    ${(fw.stages || []).map(s => `
      <div class="stage-row">
        <div class="stage-row-top"><h4>${esc(s.name)}</h4><span class="stage-time">${esc(String(s.minMin))}–${esc(String(s.maxMin))} min</span></div>
        <div class="stage-guidance">${esc(s.guidance)}</div>
        <div class="stage-good">What good looks like: ${esc(s.whatGoodLooksLike)}</div>
      </div>`).join('')}
  </div>`;
}
function renderReviewDigestHTML() {
  const len = (SCHEDULE.days || []).length;
  const rows = [];
  for (let i = 1; i <= 6; i++) {
    const idx = DAY_INDEX - i;
    const wrapped = wrapIndex(idx, len);
    const caseId = SCHEDULE.days[wrapped];
    if (caseId === null || caseId === undefined) continue;
    const c = getCaseById(caseId);
    const dateLabel = dateForIndex(SCHEDULE.epoch, idx);
    const score = getCaseScore(caseId);
    rows.push(`
      <div class="review-case-row">
        <div>
          <div style="font-weight:600;font-size:13.5px">${c ? esc(c.title) : esc(caseId)}</div>
          <div class="note">${esc(dateLabel)}</div>
        </div>
        <span class="review-score">${score ? scoreSummaryText(score) : 'not attempted'}</span>
        <span class="badge status-${esc(getCaseStatus(caseId))}">${esc(titleCase(getCaseStatus(caseId)))}</span>
      </div>`);
  }
  const behavQs = getBehavQuestions();
  let behavBlock;
  if (behavQs.length) {
    const weekNum = Math.floor(DAY_INDEX / 7);
    const qi = wrapIndex(weekNum, behavQs.length);
    const q = behavQs[qi];
    behavBlock = `
      <div class="case-detail" style="margin-top:16px">
        <p class="block-label">This week's behavioural question</p>
        <div class="prompt-block">${esc(q.question || q.text || 'Untitled question')}</div>
      </div>`;
  } else {
    behavBlock = `<div class="empty" style="margin-top:16px">Behavioural question bank isn't available yet — check back soon.</div>`;
  }
  return `
    <div class="case-detail">
      <h2>Sunday review</h2>
      <p class="note">No new case today. Here's how the last 6 days went.</p>
      <div>${rows.length ? rows.join('') : '<div class="empty">No case history yet.</div>'}</div>
    </div>
    ${behavBlock}`;
}

/* ============================== Cases ============================== */
function caseMatchesFilters(c, f, ignoreKey) {
  if (ignoreKey !== 'status' && f.status !== 'all' && getCaseStatus(c.id) !== f.status) return false;
  if (ignoreKey !== 'track' && f.track !== 'all' && c.track !== f.track) return false;
  if (ignoreKey !== 'type' && f.type !== 'all' && c.type !== f.type) return false;
  if (ignoreKey !== 'company' && f.company !== 'all' && !(c.company || []).includes(f.company)) return false;
  if (ignoreKey !== 'region' && f.region !== 'all' && c.region !== f.region) return false;
  if (ignoreKey !== 'difficulty' && f.difficulty !== 'all' && String(c.difficulty) !== String(f.difficulty)) return false;
  if (f.q) {
    const hay = (c.title + ' ' + c.prompt + ' ' + (c.company || []).join(' ')).toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}
function caseCardHTML(c) {
  const status = getCaseStatus(c.id);
  const score = getCaseScore(c.id);
  return `
    <article class="card" data-case-id="${esc(c.id)}">
      <div class="card-top">
        <div>
          <h3>${esc(c.title)}</h3>
          <div class="company">${esc((c.company || []).join(', '))}</div>
        </div>
      </div>
      <div class="badges">
        <span class="badge status-${esc(status)}">${esc(titleCase(status))}</span>
        <span class="badge accent">${esc(titleCase(c.track))}</span>
        <span class="badge neutral">${esc(titleCase(c.type))}</span>
        <span class="badge neutral">Diff ${esc(String(c.difficulty))}</span>
        <span class="badge neutral">${esc(titleCase(c.region))}</span>
      </div>
      ${score ? `<div class="note">${scoreSummaryText(score)}</div>` : ''}
      <div class="card-foot">
        <select class="status-select" data-status-for="${esc(c.id)}" aria-label="Status for ${esc(c.title)}">
          ${STATUSES.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}
        </select>
        <button type="button" class="btn small" data-action="open-case" data-id="${esc(c.id)}">Open →</button>
      </div>
    </article>`;
}
function renderCases() {
  const el = document.getElementById('view-cases');
  if (!el) return;
  const active = document.activeElement;
  const wasSearchFocused = active && active.id === 'case-search';
  const selStart = wasSearchFocused ? active.selectionStart : null;

  const f = state.casesFilter;
  const tracks = uniqueSorted(CASES.map(c => c.track));
  const types = uniqueSorted(CASES.map(c => c.type));
  const companies = uniqueSorted(CASES.flatMap(c => c.company || []));
  const regions = uniqueSorted(CASES.map(c => c.region));
  const difficulties = uniqueSorted(CASES.map(c => c.difficulty));

  function countForValue(key, value) {
    return CASES.filter(c => {
      if (!caseMatchesFilters(c, f, key)) return false;
      if (value === 'all') return true;
      if (key === 'company') return (c.company || []).includes(value);
      if (key === 'difficulty') return String(c.difficulty) === String(value);
      return c[key] === value;
    }).length;
  }
  function countForStatus(value) {
    return CASES.filter(c => {
      if (!caseMatchesFilters(c, f, 'status')) return false;
      if (value === 'all') return true;
      return getCaseStatus(c.id) === value;
    }).length;
  }
  function chipRowHTML(label, key, values) {
    const options = ['all', ...values];
    return `<div class="filter-row"><span class="flabel">${esc(label)}</span>${options.map(v => {
      const lbl = v === 'all' ? 'All' : (key === 'difficulty' ? 'Diff ' + v : titleCase(String(v)));
      return `<button type="button" class="chip-btn" data-filter="${key}" data-value="${esc(String(v))}" aria-pressed="${String(f[key] === v)}">${esc(lbl)} <span class="chip-n">${countForValue(key, v)}</span></button>`;
    }).join('')}</div>`;
  }
  const statusChips = `<div class="filter-row"><span class="flabel">Status</span>${['all', ...STATUSES].map(v => {
    const lbl = v === 'all' ? 'All' : titleCase(v);
    return `<button type="button" class="chip-btn" data-filter="status" data-value="${v}" aria-pressed="${String(f.status === v)}">${esc(lbl)} <span class="chip-n">${countForStatus(v)}</span></button>`;
  }).join('')}</div>`;

  const filterPanel = `
    <div class="filter-panel">
      <label class="search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="case-search" type="search" placeholder="Search title, prompt, or company…" value="${esc(f.q)}"></label>
      ${statusChips}
      ${chipRowHTML('Track', 'track', tracks)}
      ${chipRowHTML('Type', 'type', types)}
      ${chipRowHTML('Company', 'company', companies)}
      ${chipRowHTML('Region', 'region', regions)}
      ${chipRowHTML('Difficulty', 'difficulty', difficulties)}
    </div>`;

  const list = CASES.filter(c => caseMatchesFilters(c, f, ''));
  const cardsHTML = list.length ? `<div class="grid">${list.map(caseCardHTML).join('')}</div>` : '<div class="empty">No cases match these filters.</div>';

  el.innerHTML = `
    <div class="sec-head"><h2>Case library</h2><span class="count">${list.length} of ${CASES.length} shown</span></div>
    ${filterPanel}
    ${cardsHTML}`;

  if (wasSearchFocused) {
    const input = document.getElementById('case-search');
    if (input) { input.focus(); if (selStart != null) input.setSelectionRange(selStart, selStart); }
  }
}

/* ============================== Behavioural ============================== */
function questionCardHTML(q) {
  const ans = getBehavAnswer(q.id);
  const status = getBehavStatus(q.id);
  const fields = fieldsForStructure(q.structure);
  const linked = ans.linkedStories || [];
  const suggested = storiesForQuestion(q.id).filter(s => !linked.includes(s.id));
  const variants = asList(q.variants), probes = asList(q.probes), pitfalls = asList(q.pitfalls), followUps = asList(q.followUps);
  return `
    <details class="question-card" data-qid="${esc(q.id)}">
      <summary><span>${esc(q.question || q.text || 'Untitled question')}</span><span class="badge status-${esc(status)}">${esc(titleCase(status))}</span></summary>
      <div class="qbody">
        ${suggested.length ? `<div><p class="block-label">Suggested from your stories</p><div class="tag-row">${suggested.map(s => `<button type="button" class="tag-chip" data-action="suggest-story" data-qid="${esc(q.id)}" data-story="${esc(s.id)}" title="${esc(s.title)} — click to link it">${esc(s.title)}</button>`).join('')}</div></div>` : ''}
        ${variants.length ? `<div><p class="block-label">Variants</p><ul class="plain">${variants.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}
        ${probes.length ? `<div><p class="block-label">Probes</p><ul class="plain">${probes.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}
        ${pitfalls.length ? `<div><p class="block-label">Pitfalls</p><ul class="plain">${pitfalls.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}
        ${followUps.length ? `<div><p class="block-label">Follow-ups</p><ul class="plain">${followUps.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}
        <div>
          <p class="block-label">Your answer (${esc(String(q.structure || 'STAR').toUpperCase())})</p>
          ${fields.map(fld => `<div class="answer-field"><label>${esc(fld)}</label><textarea data-behav-field="${esc(fld)}" data-qid="${esc(q.id)}">${esc((ans.fields || {})[fld] || '')}</textarea></div>`).join('')}
        </div>
        <div>
          <p class="block-label">Link stories</p>
          <div class="story-link-list">
            ${STORIES.map(s => `<button type="button" class="story-toggle" data-action="toggle-story" data-qid="${esc(q.id)}" data-story="${esc(s.id)}" aria-pressed="${String(linked.includes(s.id))}">${esc(s.title)}</button>`).join('')}
          </div>
          ${linked.map(sid => {
            const s = STORIES.find(x => x.id === sid);
            if (!s) return '';
            return `<div class="linked-story"><b>${esc(s.title)}</b> (${esc(s.company)})<br><b>S:</b> ${esc(s.situation)}<br><b>T:</b> ${esc(s.task)}<br><b>A:</b> ${esc(s.action)}<br><b>R:</b> ${esc(s.result)}</div>`;
          }).join('')}
        </div>
        <div class="card-foot">
          <select class="status-select" data-behav-status-for="${esc(q.id)}" aria-label="Status">
            ${STATUSES.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}
          </select>
        </div>
      </div>
    </details>`;
}
function renderBehavioural() {
  const el = document.getElementById('view-behavioural');
  if (!el) return;
  const openIds = new Set([...el.querySelectorAll('details[data-qid][open]')].map(d => d.dataset.qid));
  const questions = getBehavQuestions();
  const ioBar = `
    <div class="io-bar">
      <button type="button" class="btn ghost small" data-action="export-json">Export JSON</button>
      <button type="button" class="btn ghost small" data-action="import-json">Import JSON</button>
      <input type="file" id="import-file-input" accept="application/json" hidden>
    </div>`;
  if (!questions.length) {
    el.innerHTML = `${ioBar}<div class="empty">Behavioural question bank isn't available yet — <b>data/behavioural.json</b> hasn't been published. Export/Import below still cover any notes, scores, and status you've already saved.</div>`;
    return;
  }
  const groups = {};
  questions.forEach(q => { const t = q.theme || 'Uncategorised'; (groups[t] = groups[t] || []).push(q); });
  const themeKeys = Object.keys(groups).sort((a, b) => themeLabel(a).localeCompare(themeLabel(b)));
  const body = themeKeys.map(t => `
    <div class="theme-group">
      <h3>${esc(themeLabel(t))}</h3>
      ${groups[t].map(questionCardHTML).join('')}
    </div>`).join('');
  el.innerHTML = `${ioBar}<div class="sec-head"><h2>Behavioural bank</h2><span class="count">${questions.length} questions</span></div>${body}`;
  openIds.forEach(id => {
    const d = el.querySelector(`details[data-qid="${window.CSS && CSS.escape ? CSS.escape(id) : id}"]`);
    if (d) d.open = true;
  });
}

/* ============================== Stories ============================== */
function storyCardHTML(s) {
  const tags = Array.isArray(s.questionTags) ? s.questionTags : [];
  const tagChips = tags.map(qid => {
    const q = getQuestionById(qid);
    const label = q ? (q.question || q.text || qid) : qid;
    return `<button type="button" class="tag-chip" data-action="goto-question" data-qid="${esc(qid)}" title="${esc(label)}">${esc(label.length > 56 ? label.slice(0, 53) + '…' : label)}</button>`;
  }).join('');
  return `
    <article class="card">
      <div><h3>${esc(s.title)}</h3><div class="company">${esc(s.company)}${s.role ? ` · ${esc(s.role)}` : ''}</div></div>
      ${s.metrics && s.metrics.length ? `<div class="badges">${s.metrics.map(m => `<span class="stat-chip">${esc(m.label)}: ${esc(m.value)}</span>`).join('')}</div>` : ''}
      <div class="star-grid">
        <div class="star-field"><div class="flabel">Situation</div><p>${esc(s.situation || '')}</p></div>
        <div class="star-field"><div class="flabel">Task</div><p>${esc(s.task || '')}</p></div>
        <div class="star-field"><div class="flabel">Action</div><p>${esc(s.action || '')}</p></div>
        <div class="star-field"><div class="flabel">Result</div><p>${esc(s.result || '')}</p></div>
      </div>
      ${s.sourceQuote ? `<blockquote class="quote">&ldquo;${esc(s.sourceQuote)}&rdquo;</blockquote>` : ''}
      ${tagChips ? `<div class="star-field"><div class="flabel">Answers these interview questions</div><div class="tag-row">${tagChips}</div></div>` : ''}
    </article>`;
}
function renderStories() {
  const el = document.getElementById('view-stories');
  if (!el) return;
  const cards = STORIES.map(storyCardHTML).join('');
  const cov = computeCoverage();
  const withStories = cov.themes.filter(t => (cov.map[t] || []).length > 0);
  const gaps = cov.themes.filter(t => (cov.map[t] || []).length === 0);
  const tableRows = withStories.map(t => {
    const ids = cov.map[t] || [];
    const titles = ids.map(id => { const s = STORIES.find(x => x.id === id); return s ? s.title : id; });
    return `<tr><td>${esc(themeLabel(t))}</td><td>${ids.length}</td><td>${titles.map(esc).join(', ')}</td></tr>`;
  }).join('');
  const gapCards = gaps.length ? gaps.map(t => `<div class="gap-card"><b>${esc(themeLabel(t))}</b> — no story yet. Stories to write.</div>`).join('') : '<div class="note">No coverage gaps.</div>';
  el.innerHTML = `
    <div class="sec-head"><h2>Stories</h2><span class="count">${STORIES.length} stories</span></div>
    ${STORIES.length ? `<div class="grid">${cards}</div>` : '<div class="empty">No stories available.</div>'}
    <div class="sec-head"><h2>Theme coverage</h2><span class="count">${withStories.length} covered · ${gaps.length} gaps</span></div>
    <div class="coverage-table-wrap"><table class="coverage"><thead><tr><th>Theme</th><th># Stories</th><th>Stories</th></tr></thead><tbody>${tableRows || '<tr><td colspan="3">No themes found.</td></tr>'}</tbody></table></div>
    <div style="margin-top:14px">
      <p class="block-label">Stories to write</p>
      ${gapCards}
    </div>`;
}

/* ============================== Progress ============================== */
function renderProgress() {
  const el = document.getElementById('view-progress');
  if (!el) return;
  const streak = computeStreak();
  const total = CASES.length;
  const statusCounts = {}; STATUSES.forEach(s => statusCounts[s] = 0);
  CASES.forEach(c => { statusCounts[getCaseStatus(c.id)] = (statusCounts[getCaseStatus(c.id)] || 0) + 1; });
  const attempted = CASES.filter(c => getCaseStatus(c.id) !== 'new').length;

  const dims = {};
  const allScores = getAllScores();
  Object.values(allScores).forEach(score => {
    Object.entries(score.dims || {}).forEach(([dim, level]) => {
      dims[dim] = dims[dim] || { weak: 0, solid: 0, strong: 0 };
      if (dims[dim][level] !== undefined) dims[dim][level]++;
    });
  });
  const dimRows = Object.keys(dims).sort().map(d => {
    const c = dims[d];
    return `<div class="dim-row"><span class="dim-name">${esc(d)}</span><span class="dim-score">strong ${c.strong} · solid ${c.solid} · weak ${c.weak}</span></div>`;
  }).join('') || '<div class="note">No self-scores saved yet — score a case from its Practice view to see dimensions here.</div>';

  const behavQs = getBehavQuestions();
  const behavAttempted = behavQs.filter(q => hasBehavAnswer(q.id) || getBehavStatus(q.id) !== 'new').length;
  const behavPct = behavQs.length ? Math.round((behavAttempted / behavQs.length) * 100) : null;

  const cov = computeCoverage();
  const gapCount = cov.themes.filter(t => (cov.map[t] || []).length === 0).length;

  el.innerHTML = `
    <div class="sec-head"><h2>Progress</h2></div>
    <div class="progress-grid">
      <div class="progress-tile"><div class="n">${streak}</div><div class="l">Day streak</div></div>
      <div class="progress-tile"><div class="n">${attempted}/${total}</div><div class="l">Cases attempted</div></div>
      <div class="progress-tile"><div class="n">${statusCounts.completed}</div><div class="l">Completed</div></div>
      <div class="progress-tile"><div class="n">${statusCounts.active}</div><div class="l">In progress</div></div>
      <div class="progress-tile"><div class="n">${statusCounts.bookmarked}</div><div class="l">Bookmarked</div></div>
      <div class="progress-tile"><div class="n">${statusCounts.skipped}</div><div class="l">Skipped</div></div>
      <div class="progress-tile"><div class="n">${behavPct === null ? '—' : behavPct + '%'}</div><div class="l">Behavioural coverage</div></div>
      <div class="progress-tile"><div class="n">${gapCount}</div><div class="l">Story gaps</div></div>
    </div>
    <div class="sec-head"><h2>Rubric dimensions</h2><span class="hint">Averaged across every scored case, so weak dimensions surface.</span></div>
    <div class="card">${dimRows}</div>`;
}

/* ============================== Practice (inside a case) ============================== */
function renderPractice(caseId) {
  const el = document.getElementById('view-practice');
  if (!el) return;
  const c = getCaseById(caseId);
  if (!c) { el.innerHTML = '<div class="empty">Case not found.</div>'; return; }
  const fw = getFrameworkForCase(c);
  const status = getCaseStatus(c.id);
  const notes = getCaseNotes(c.id);

  el.innerHTML = `
    <div class="practice-header">
      <button type="button" class="back-btn" id="practice-back">← Back</button>
      <h2 style="margin:0;font-size:19px">${esc(c.title)}</h2>
      <select class="status-select" id="practice-status-select" aria-label="Case status">
        ${STATUSES.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}
      </select>
    </div>

    <details class="case-brief" open>
      <summary>Case details &amp; framework scaffold <span class="note" style="display:inline">— click to collapse</span></summary>
      ${renderCaseDetailHTML(c, { showStart: false })}
    </details>

    <div class="timer-panel">
      <div class="timer-top">
        <div class="timer-elapsed" id="timer-elapsed">00:00</div>
        <div class="timer-stage" id="timer-stage-label"></div>
        <span class="timer-warning" id="timer-warning" hidden>⚠ Stage running long</span>
        <div class="timer-controls">
          <button type="button" class="btn small ghost" id="timer-start">Start</button>
          <button type="button" class="btn small ghost" id="timer-pause">Pause</button>
          <button type="button" class="btn small ghost" id="timer-reset">Reset</button>
        </div>
      </div>
      <div class="timer-bar" id="timer-bar"></div>
      <div class="timer-stage-nav" id="timer-stage-nav"></div>
    </div>

    <div>
      <p class="block-label">Notepad</p>
      <div class="notepad-grid" id="notepad-grid">
        ${(fw.stages || []).map(s => `
          <div class="notepad-stage">
            <label>${esc(s.name)} <span class="save-hint" id="save-hint-${esc(s.key)}"></span></label>
            <textarea data-stage-key="${esc(s.key)}" placeholder="Notes for ${esc(s.name)}…">${esc(notes[s.key] || '')}</textarea>
          </div>`).join('')}
      </div>
    </div>

    <div><button type="button" class="btn" id="show-model-btn">Show model answer</button></div>
    <div class="model-answer" id="model-answer-area" hidden></div>`;

  initTimerForCase(caseId);
  renderTimerBar();
  updateTimerDisplay();

  if (getCaseScore(c.id)) revealModelAnswer(c, fw);
}
function revealModelAnswer(c, fw) {
  const area = document.getElementById('model-answer-area');
  if (!area) return;
  const matched = matchModelAnswer(c, fw);
  const trackPitfalls = frameworkPitfalls(fw);
  const casePitfalls = c.pitfalls || [];
  const combinedPitfalls = [...casePitfalls, ...trackPitfalls.filter(p => !casePitfalls.includes(p))];
  area.innerHTML = `
    <p class="block-label">Model answer walkthrough</p>
    <div class="model-answer-stages">
      ${matched.map(m => m.walkthrough ? `<div class="walkthrough-stage"><h4>${esc(m.stage.name)}</h4><p>${esc(m.walkthrough)}</p></div>` : '').join('')}
    </div>
    ${combinedPitfalls.length ? `<div><p class="block-label">Pitfalls to avoid</p><ul class="pitfall-list">${combinedPitfalls.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <div id="rubric-widget-area"></div>`;
  area.hidden = false;
  renderRubricWidget(c, fw);
  const btn = document.getElementById('show-model-btn');
  if (btn) btn.textContent = 'Model answer shown';
}
function renderRubricWidget(c, fw) {
  const wrap = document.getElementById('rubric-widget-area');
  if (!wrap) return;
  const score = getCaseScore(c.id);
  const dims = (score && score.dims) || {};
  const total = (fw.rubric || []).length;
  const scoredCount = Object.keys(dims).length;
  wrap.innerHTML = `
    <p class="block-label">Self-score</p>
    ${(fw.rubric || []).map(r => `
      <div class="rubric-row">
        <div class="rubric-dim">${esc(r.dimension)}</div>
        <div class="rubric-levels">
          ${['weak', 'solid', 'strong'].map(level => `
            <button type="button" class="rubric-level ${level} ${dims[r.dimension] === level ? 'selected' : ''}" data-dim="${esc(r.dimension)}" data-level="${level}">
              <b>${level}</b>
              <p>${esc(r[level] || '')}</p>
            </button>`).join('')}
        </div>
      </div>`).join('')}
    <div class="note">${scoredCount}/${total} dimensions scored${scoredCount === total && total > 0 ? ' — case marked completed.' : '.'}</div>`;
}

/* ============================== Live case (interview co-pilot) ============================== */
// No network call, no API key: a local keyword classifier guesses the case type, shows the
// matching framework's real stage scaffold on screen immediately, and a "Copy AI prompt" button
// packages everything into a prompt you paste into your own Claude/ChatGPT tab to get a full
// model answer. The classifier is a best-effort guess, never presented as ground truth — a manual
// type/framework override sits right next to it, equally prominent.

const TYPE_TAXONOMY = {
  'ai-0to1': { track: 'ai-product', framework: 'ai-product', label: 'AI 0-to-1' },
  'ai-evals': { track: 'ai-product', framework: 'ai-product', label: 'AI Evals' },
  'ai-guardrails': { track: 'ai-product', framework: 'ai-product', label: 'AI Guardrails' },
  'ai-metrics': { track: 'ai-product', framework: 'ai-product', label: 'AI Metrics' },
  'ai-ux-trust': { track: 'ai-product', framework: 'ai-product', label: 'AI UX & Trust' },
  'comparative': { track: 'product-sense', framework: 'product-sense', label: 'Comparative' },
  'define-metrics': { track: 'analytical', framework: 'analytical', label: 'Define Metrics' },
  'design-0to1': { track: 'product-sense', framework: 'product-sense', label: 'Design 0-to-1' },
  'experiment': { track: 'analytical', framework: 'analytical', label: 'Experiment' },
  'funnel': { track: 'analytical', framework: 'analytical', label: 'Funnel' },
  'goal-setting': { track: 'analytical', framework: 'analytical', label: 'Goal Setting' },
  'growth-loop': { track: 'cross-cutting', framework: 'product-sense', label: 'Growth Loop' },
  'improve-existing': { track: 'product-sense', framework: 'product-sense', label: 'Improve Existing' },
  'marketplace': { track: 'cross-cutting', framework: 'product-sense', label: 'Marketplace' },
  'metric-tradeoff': { track: 'analytical', framework: 'analytical', label: 'Metric Trade-off' },
  'new-segment': { track: 'product-sense', framework: 'product-sense', label: 'New Segment' },
  'platform-api': { track: 'cross-cutting', framework: 'product-sense', label: 'Platform / API' },
  'pricing': { track: 'cross-cutting', framework: 'product-sense', label: 'Pricing' },
  'prioritization': { track: 'cross-cutting', framework: 'product-sense', label: 'Prioritization' },
  'rca': { track: 'analytical', framework: 'rca', label: 'Root Cause Analysis' },
  'retention': { track: 'analytical', framework: 'analytical', label: 'Retention' },
  'teardown': { track: 'product-sense', framework: 'product-sense', label: 'Teardown' },
  'trust-safety': { track: 'cross-cutting', framework: 'product-sense', label: 'Trust & Safety' }
};
const TYPE_PRIORITY = ['rca', 'experiment', 'funnel', 'retention', 'marketplace', 'platform-api',
  'growth-loop', 'pricing', 'trust-safety', 'prioritization', 'goal-setting', 'metric-tradeoff',
  'define-metrics', 'ai-guardrails', 'ai-evals', 'ai-ux-trust', 'ai-metrics', 'ai-0to1',
  'comparative', 'teardown', 'new-segment', 'design-0to1', 'improve-existing'];

const SHORTHAND_MAP = [
  [/\brca\b/g, 'root cause analysis'],
  [/\bnsm\b/g, 'north star metric'],
  [/\bab\s?test(ing)?\b/g, 'ab test experiment'],
  [/\b(dau|wau|mau)\b/g, 'active users retention'],
  [/\bd(1|7|14|28|30)\b/g, 'retention cohort'],
  [/\bw(1|2|4)\b/g, 'retention cohort'],
  [/\b(ctr|cvr|cr)\b/g, 'conversion rate'],
  [/\bdrop ?offs?\b/g, 'dropoff'],
  [/\b(0 ?[-to]+ ?1|zero to one)\b/g, 'zero to one'],
  [/\b(llm|genai|gen ?ai|gpt|foundation model)\b/g, 'ai'],
  [/\b(ml|machine learning)\b/g, 'ai model'],
  [/\brag\b/g, 'ai retrieval'],
  [/\bltv\b/g, 'lifetime value'], [/\bcac\b/g, 'acquisition cost'],
  [/\b(mrr|arr)\b/g, 'revenue'], [/\bgmv\b/g, 'revenue volume'],
  [/\bq[1-4]\b/g, 'quarterly'],
  [/\b(okrs?|kr)\b/g, 'goal okr'],
  [/\b(ts|t&s|tands)\b/g, 'trust safety'],
  [/\bkyc\b/g, 'kyc verification'],
  [/\bux\b/g, 'ux experience'],
  [/\b(b2b|b2c|smb)\b/g, 'segment'],
  [/\bpmf\b/g, 'product market fit'],
  [/\bnps\b/g, 'metric satisfaction'],
  [/\bfnl\b/g, 'funnel'], [/\bretn\b/g, 'retention'],
  [/\bconvn?\b/g, 'conversion'], [/\busr\b/g, 'user'],
  [/\bwk\b/g, 'week'], [/\bmkt\b/g, 'market'], [/\bmtrc\b/g, 'metric'],
  [/\bexp\b/g, 'experiment'], [/\bseg\b/g, 'segment'], [/\bprod\b/g, 'product']
];
function normalizeCaseText(raw) {
  let s = ' ' + String(raw || '').toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ').trim() + ' ';
  SHORTHAND_MAP.forEach(([re, sub]) => { s = s.replace(re, ' ' + sub + ' '); });
  return ' ' + s.replace(/\s+/g, ' ').trim() + ' ';
}

const CLASSIFIER_RULES = [
  { type: 'rca',
    strong: [/\broot cause\b/, /\bwhy (did|has|is|would)\b[^.]{0,60}\b(drop|dropped|declin|fall|fell|down|decreas|spike|surge)/, /\b(dropped|fell|declined) (by )?\d+/],
    phrases: ['root cause analysis', 'walk me through your root cause', 'diagnose the drop', 'drop in', 'decline in', 'fell by', 'dropped by', 'went down', 'hasnt recovered', 'stayed at that lower level', 'in a single week', 'over three days', 'week over week', 'day over day', 'what would you investigate', 'something broke', 'no code change'],
    terms: ['drop', 'dropped', 'dropping', 'declin', 'plummet', 'fell', 'dip', 'spike', 'sudden', 'overnight', 'investigate', 'anomaly', 'regression', 'incident', 'diagnos'],
    negative: ['funnel', 'retention cohort'] },
  { type: 'funnel',
    strong: [/\bfunnel\b/, /\bdropoff\b/, /\bwhere (are|do) (users|people) (falling|dropping) off\b/],
    phrases: ['conversion funnel', 'signup to first', 'sign up to first', 'cart to purchase', 'checkout funnel', 'onboarding to first', 'add to cart but', 'never complete', 'abandon the flow', 'step in the flow', 'falling off', 'activation rate', 'first order', 'first trade', 'first match', 'complete checkout', 'analyze this funnel'],
    terms: ['funnel', 'dropoff', 'abandon', 'checkout', 'cart', 'signup', 'onboarding', 'activation', 'completion', 'conversion', 'step', 'leaky'],
    negative: ['root cause'] },
  { type: 'retention',
    strong: [/\bretention\b/, /\bcohort\b/, /\bchurn\b/],
    phrases: ['retention curve', 'retention rate', 'retention dropped', 'repeat purchase', 'come back', 'stopped coming back', 'flattened', 'cohort curve', 'new user cohort', '30 day retention', 'week 4 retention', 'resurrect', 'stickiness', 'habit formation'],
    terms: ['retention', 'retain', 'cohort', 'churn', 'repeat', 'resurrect', 'lapsed', 'dormant', 'stickiness'],
    negative: [] },
  { type: 'experiment',
    strong: [/\bab test\b/, /\bexperiment\b/, /\bstatistical(ly)? significan/],
    phrases: ['ab test experiment', 'split test', 'control group', 'treatment group', 'sample size', 'statistical significance', 'p value', 'how would you read out', 'holdout', 'novelty effect', 'power analysis', 'how would you test this', 'ship or not ship', 'rollout plan', 'randomiz'],
    terms: ['experiment', 'control', 'treatment', 'variant', 'significance', 'holdout', 'randomiz', 'sample', 'power', 'hypothesis', 'bucket'],
    negative: [] },
  { type: 'define-metrics',
    strong: [/\bhow would you measure (the )?success\b/, /\bmetric framework\b/, /\bnorth star\b/],
    phrases: ['how would you measure', 'measure the success', 'define a metric', 'metric framework', 'success metrics', 'north star metric', 'guardrail metric', 'what metrics would you track', 'how do you know it is working', 'health metrics', 'counter metric', 'top line metric', 'define the kpi'],
    terms: ['metric', 'metrics', 'measure', 'kpi', 'guardrail', 'instrument', 'dashboard', 'track'],
    negative: ['trade off', 'tradeoff', 'quarterly goal'] },
  { type: 'goal-setting',
    strong: [/\b(quarterly|annual) goal\b/, /\bwhat goal would you set\b/, /\bdefend the number\b/],
    phrases: ['set a goal', 'quarterly goal', 'goal for the quarter', 'goal for next quarter', 'what target would you set', 'defend the number', 'how would you defend', 'goal okr', 'key result', 'ambitious but achievable', 'how much should it move', 'what number would you commit'],
    terms: ['goal', 'target', 'okr', 'quarterly', 'commit', 'forecast', 'defend'],
    negative: [] },
  { type: 'metric-tradeoff',
    strong: [/\btrade ?off\b/, /\bat the expense of\b/, /\btension between\b/],
    phrases: ['trade off', 'tradeoff', 'at the expense of', 'balance between', 'how would you think about the trade', 'one goes up while', 'short term versus long term', 'engagement versus', 'growth versus quality', 'well being', 'cannibaliz', 'would you still ship it', 'which metric wins', 'competing metrics'],
    terms: ['tradeoff', 'tension', 'balance', 'cannibaliz', 'expense', 'sacrific', 'versus', 'conflict'],
    negative: [] },
  { type: 'ai-evals',
    strong: [/\bgolden set\b/, /\bquality bar\b/, /\beval(s|uation)?\b/, /\bllm as a? ?judge\b/],
    phrases: ['quality bar', 'golden set', 'offline eval', 'online eval', 'evaluate whether the model', 'good enough to ship', 'before rolling it out', 'regression test', 'ground truth', 'precision and recall', 'human labeling', 'annotator', 'benchmark suite', 'model version', 'is the new model better'],
    terms: ['eval', 'evals', 'benchmark', 'groundtruth', 'precision', 'recall', 'annotat', 'label', 'regression', 'judge', 'accuracy'],
    negative: [] },
  { type: 'ai-guardrails',
    strong: [/\bhallucinat/, /\bprompt injection\b/, /\bjailbreak\b/, /\bguardrail(s)? (for|against)\b/],
    phrases: ['prompt injection', 'jailbreak', 'red team', 'harmful output', 'confidently wrong', 'made up', 'fabricat', 'personal data', 'data privacy', 'dpdp', 'gdpr', 'compliance risk', 'vendor lock in', 'vendor dependency', 'model dependency', 'legal liability', 'abuse of the model', 'misuse', 'safety policy', 'what could go wrong'],
    terms: ['hallucinat', 'injection', 'jailbreak', 'privacy', 'pii', 'dpdp', 'gdpr', 'compliance', 'vendor', 'redteam', 'liability', 'guardrail', 'toxicity'],
    negative: [] },
  { type: 'ai-ux-trust',
    strong: [/\b(design|ux) (the )?(trust|citation|confidence|correction|handoff)/, /\bhuman in the loop\b/, /\bhand ?off to a human\b/],
    phrases: ['citation', 'cite sources', 'show confidence', 'confidence signal', 'trust the answer', 'let users correct', 'correct the answer', 'undo', 'human in the loop', 'hand off to a human', 'graceful fallback', 'when the model is wrong', 'accept or reject', 'inline suggestion', 'transparency', 'explainability', 'disclosure'],
    terms: ['citation', 'confidence', 'trust', 'undo', 'correction', 'handoff', 'transparen', 'explainab', 'fallback', 'disclaimer'],
    negative: [] },
  { type: 'ai-metrics',
    strong: [/\b(north star|nsm)\b[^.]{0,50}\b(ai|assistant|model|copilot|bot|agent)\b/, /\bacceptance rate\b/, /\bcontainment rate\b/],
    phrases: ['north star metric', 'acceptance rate', 'containment rate', 'deflection rate', 'task completion rate', 'cost per query', 'cost per successful', 'token cost', 'edit distance', 'measure the assistant', 'measure the ai', 'how would you measure the model', 'adoption of the ai', 'which metric should decide'],
    terms: ['acceptance', 'containment', 'deflection', 'metric', 'measure', 'cost', 'margin', 'adoption'],
    negative: ['golden set', 'quality bar'] },
  { type: 'ai-0to1',
    strong: [/\bdesign\b[^.]{0,40}\bai\b/, /\bshould (we|they|[a-z]+) (build|add|use|launch)\b[^.]{0,30}\bai\b/, /\bzero to one\b[^.]{0,30}\bai\b/],
    phrases: ['ai assistant', 'ai feature', 'ai powered', 'generative ai', 'ai agent', 'ai chatbot', 'ai copilot', 'build an ai', 'launch an ai', 'should we build this', 'why ai', 'ai first', 'new ai product', 'what should it do'],
    terms: ['assistant', 'copilot', 'chatbot', 'agent', 'generative'],
    negative: ['golden set', 'quality bar', 'north star metric', 'prompt injection', 'citation'] },
  { type: 'comparative',
    strong: [/\bwhy (did|do|might) [a-z0-9 ]{2,30} and [a-z0-9 ]{2,30} (diverge|differ|design|choose|take|go|make|build)/, /\bdiverged on\b/, /\bthese two (companies|products|platforms)\b/],
    phrases: ['why might these two', 'two different', 'took different', 'different approaches', 'diverged on', 'why did they differ', 'whereas', 'while the other', 'one does x and the other', 'compare the two', 'contrast the two', 'same problem differently', 'why not copy'],
    terms: ['diverge', 'differently', 'differ', 'contrast', 'comparative'],
    negative: [] },
  { type: 'teardown',
    strong: [/\bteardown\b/, /\btear down\b/, /\bproduct critique\b/],
    phrases: ['structured teardown', 'why it works', 'what you would improve', 'walk through a teardown', 'critique this product', 'favorite product', 'favourite product', 'least favorite product', 'what would you change about it', 'break down why this works', 'evaluate this product'],
    terms: ['teardown', 'critique', 'dissect'],
    negative: [] },
  { type: 'design-0to1',
    strong: [/\bdesign a (new )?product\b/, /\bassume nothing (exists|purpose built)\b/, /\bfrom scratch\b/],
    phrases: ['design a product for', 'design a new product', 'build a product for', 'nothing exists today', 'doesnt exist today', 'from scratch', 'greenfield', 'brand new product', 'launch a new product', 'zero to one', 'blank slate', 'what would you build'],
    terms: ['greenfield', 'scratch'],
    negative: ['ai', 'improve'] },
  { type: 'new-segment',
    strong: [/\bfor (first time|new|underserved|rural|elderly|blind|low literacy)\b/, /\btier ?[23]\b/, /\bnew (market|geography|segment|audience)\b/],
    phrases: ['tier 2', 'tier 3', 'first time users', 'first time online', 'non english', 'regional language', 'low literacy', 'underserved', 'rural users', 'elderly', 'senior citizens', 'accessibility', 'gig workers', 'small business owners', 'new geography', 'new market', 'expand to a new', 'users who have never', 'unbanked', 'underbanked'],
    terms: ['segment', 'persona', 'underserved', 'rural', 'literacy', 'accessibility', 'demographic', 'newcomer'],
    negative: [] },
  { type: 'improve-existing',
    strong: [/\bhow would you improve\b/, /\bimprove (the )?(engagement|conversion|discovery|onboarding|experience|retention of)\b/, /\bwhat would you change about\b/],
    phrases: ['how would you improve', 'improve the experience', 'make it better', 'increase engagement', 'drive more usage', 'get more people to', 'grow usage of', 'existing feature', 'underused feature', 'more of our users', 'boost adoption'],
    terms: ['improve', 'increase', 'boost', 'enhance', 'optimiz'],
    negative: ['nothing exists today', 'from scratch'] },
  { type: 'growth-loop',
    strong: [/\bgrowth loop\b/, /\bviral(ity)? loop\b/, /\breferral (program|loop)\b/, /\bflywheel\b/],
    phrases: ['growth loop', 'viral loop', 'acquisition loop', 'referral program', 'invite a friend', 'network effect', 'word of mouth', 'k factor', 'flywheel', 'content loop', 'ugc loop', 'self reinforcing', 'compounding growth', 'share with friends', 'loop mechanics'],
    terms: ['loop', 'viral', 'referral', 'invite', 'flywheel', 'acquisition'],
    negative: [] },
  { type: 'marketplace',
    strong: [/\bmarketplace\b/, /\bcold start\b/, /\b(supply and demand|demand and supply)\b/, /\btwo sided\b/],
    phrases: ['supply and demand', 'two sided', 'buyers and sellers', 'drivers and riders', 'hosts and guests', 'supply side', 'demand side', 'liquidity', 'cold start', 'chicken and egg', 'matching', 'take rate', 'supply constrained', 'launch in a new city', 'seller onboarding', 'not enough supply'],
    terms: ['marketplace', 'liquidity', 'supply', 'demand', 'buyers', 'sellers', 'hosts', 'drivers', 'riders', 'matching', 'coldstart'],
    negative: [] },
  { type: 'platform-api',
    strong: [/\bapi\b/, /\bdeveloper platform\b/, /\bsdk\b/, /\brate limit\b/],
    phrases: ['api version', 'rate limits', 'third party developers', 'developer experience', 'developer platform', 'integration partners', 'webhook', 'backwards compatibility', 'deprecate', 'internal platform', 'platform team', 'open up the platform', 'ecosystem of developers', 'self serve integration'],
    terms: ['api', 'sdk', 'platform', 'developer', 'integration', 'webhook', 'deprecat', 'versioning', 'ratelimit', 'ecosystem'],
    negative: [] },
  { type: 'pricing',
    strong: [/\bpricing\b/, /\bprice (increase|change|point|it)\b/, /\bpackag(e|ing)\b[^.]{0,30}\b(tier|plan|subscription|premium)\b/, /\bpaywall\b/],
    phrases: ['how would you price', 'price increase', 'raise prices', 'pricing strategy', 'packaging', 'plan tiers', 'free tier', 'premium tier', 'paywall', 'willingness to pay', 'monetiz', 'freemium', 'bundling', 'per seat', 'usage based pricing', 'discount', 'subscription tier'],
    terms: ['pricing', 'price', 'tier', 'packaging', 'paywall', 'monetiz', 'freemium', 'subscription', 'discount', 'bundle'],
    negative: [] },
  { type: 'prioritization',
    strong: [/\bprioriti[sz]/, /\b(which|what) (one )?would you (build|pick|choose|do) (first|next)\b/, /\bthree (credible )?(bets|options|initiatives|directions)\b/],
    phrases: ['how would you prioritize', 'how would you prioritise', 'which one would you build', 'what would you build first', 'three options', 'three bets', 'next quarter roadmap', 'limited resources', 'where would you invest', 'sequencing', 'pick one of these', 'rank these', 'impact versus effort', 'rice score', 'say no to'],
    terms: ['prioritiz', 'prioritis', 'roadmap', 'backlog', 'bet', 'invest', 'sequence', 'rank'],
    negative: [] },
  { type: 'trust-safety',
    strong: [/\btrust and safety\b/, /\b(fraud|counterfeit|harassment|moderation|scam)\b/],
    phrases: ['trust and safety', 'fake reviews', 'counterfeit', 'bad actors', 'policy violation', 'content moderation', 'moderator tooling', 'harassment', 'misinformation', 'kyc verification', 'fraud risk', 'spam', 'scam', 'underage', 'account takeover', 'report and appeal'],
    terms: ['fraud', 'abuse', 'spam', 'scam', 'moderation', 'moderator', 'counterfeit', 'harassment', 'kyc', 'misinformation', 'safety', 'enforcement'],
    negative: [] }
];
const AI_SIGNAL_RE = /\b(ai|model|assistant|copilot|chatbot|agent|hallucinat|prompt|retrieval|inference|embedding|summariz|recommendation model|classifier)\b/;

function scoreRule(rule, hay, aiSignal) {
  let score = 0;
  const hits = { strong: [], phrases: [], terms: [] };
  (rule.strong || []).forEach(re => { if (re.test(hay)) { score += 5; hits.strong.push(re.source); } });
  (rule.phrases || []).forEach(p => { if (hay.includes(' ' + p + ' ') || hay.includes(p)) { score += 3; hits.phrases.push(p); } });
  (rule.terms || []).forEach(t => { if (hay.includes(t)) { score += 1; hits.terms.push(t); } });
  (rule.negative || []).forEach(n => { if (hay.includes(n)) score -= 2; });
  if (rule.type.indexOf('ai-') === 0) score += aiSignal ? 2 : -5;
  return { score, hits };
}
function classifyCaseText(raw) {
  const trimmed = String(raw || '').trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  if (!trimmed) return { status: 'empty', ranked: [], top: null, confidence: 'none', words: 0, aiSignal: false };
  const hay = normalizeCaseText(trimmed);
  const aiSignal = AI_SIGNAL_RE.test(hay);
  const ranked = CLASSIFIER_RULES.map(rule => {
    const { score, hits } = scoreRule(rule, hay, aiSignal);
    return { type: rule.type, score, hits };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.hits.strong.length !== a.hits.strong.length) return b.hits.strong.length - a.hits.strong.length;
    const pa = TYPE_PRIORITY.indexOf(a.type), pb = TYPE_PRIORITY.indexOf(b.type);
    if (pa !== pb) return pa - pb;
    return a.type.localeCompare(b.type);
  });
  const s1 = ranked[0] ? ranked[0].score : 0;
  const s2 = ranked[1] ? ranked[1].score : 0;
  if (words < LIVE_MIN_WORDS || s1 < LIVE_MIN_SCORE) {
    return { status: 'unsure', ranked, top: null, confidence: 'low', words, aiSignal };
  }
  const confidence = (s1 - s2 >= 3) ? 'high' : 'medium';
  return { status: 'ok', ranked, top: ranked[0].type, confidence, words, aiSignal };
}

function liveSelection() {
  const cls = state.live.cls || classifyCaseText(state.live.text);
  const isOverridden = !!state.live.typeOverride;
  const type = state.live.typeOverride || cls.top || 'improve-existing';
  const meta = TYPE_TAXONOMY[type] || TYPE_TAXONOMY['improve-existing'];
  const frameworkKey = state.live.frameworkOverride || meta.framework;
  const fw = getFrameworkForCase({ framework: frameworkKey });
  return { type, typeLabel: meta.label, track: meta.track, frameworkKey, fw, isOverridden, confidence: cls.confidence, status: cls.status, cls };
}
function rubricReadOnlyHTML(fw) {
  if (!(fw.rubric || []).length) return '';
  return `<div>
    ${fw.rubric.map(r => `
      <div class="rubric-row">
        <div class="rubric-dim">${esc(r.dimension)}</div>
        <div class="rubric-levels">
          ${['weak', 'solid', 'strong'].map(level => `
            <div class="rubric-level static ${level}"><b>${level}</b><p>${esc(r[level] || '')}</p></div>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
}
function buildLivePrompt(sel, caseText) {
  const fw = sel.fw;
  const cls = sel.cls;
  const stagesBlock = (fw.stages || []).map((s, i) =>
    `${i + 1}. ${s.name} (${s.minMin}–${s.maxMin} min)\n` +
    `   What to do: ${s.guidance}\n` +
    `   What good looks like: ${s.whatGoodLooksLike}` +
    ((s.pitfalls || []).length ? `\n   Avoid: ${s.pitfalls.join('; ')}` : '')
  ).join('\n\n');
  const rubricBlock = (fw.rubric || []).map(r =>
    `- ${r.dimension}\n    weak:   ${r.weak}\n    solid:  ${r.solid}\n    strong: ${r.strong}`
  ).join('\n');
  const altText = (cls && cls.ranked && cls.ranked.length > 1)
    ? `; the runners-up it considered were ${cls.ranked.slice(1, 3).map(r => (TYPE_TAXONOMY[r.type] || {}).label || r.type).join(' and ')}`
    : '';
  const classifierNote = sel.isOverridden
    ? `I chose this framework by hand on my practice site, so treat it as deliberate.`
    : (sel.status === 'unsure'
      ? `My practice site could NOT confidently classify this case — the framework below is a default, not a judgement. Decide for yourself whether it fits before you use it.`
      : `A local keyword classifier on my practice site (no AI, just keyword scoring) guessed this is a "${sel.typeLabel}" case with ${sel.confidence} confidence${altText}. It is often wrong on short or unusual prompts.`);
  return `You are an experienced product-management interview coach. I am sitting in a live PM interview right now and need a model answer I can read out loud in the next few minutes. Speed and specificity matter more than hedging.

=== 1. THE CASE, EXACTLY AS I TYPED IT ===

The text below is likely fragmented, abbreviated, mistyped or half-finished, because I typed it under time pressure while the interviewer was still talking. Do NOT ask me clarifying questions and do NOT wait for more input — there is no time for a second turn. Instead:
- Reconstruct the most probable full interview prompt from the fragments.
- Expand shorthand (e.g. "nsm" = North Star metric, "d30 ret" = 30-day retention, "rca" = root cause analysis, "ab" = A/B test, "dau/mau" = daily/monthly active users, "0-1" = zero to one, "t&s" = trust and safety).
- Silently fix typos and missing words. Fill obvious gaps with the most standard version of that case.
- State your reconstruction in ONE sentence, prefixed "READING IT AS:", before anything else.

<case>
${caseText}
</case>

=== 2. THE FRAMEWORK TO ANSWER IN ===

${classifierNote}

The framework is "${fw.label}", ${fw.totalMin || 45} minutes total. Its stages, with the real timeboxes I will be held to:

${stagesBlock || '(stage data unavailable — use your own best structure for this framework)'}

=== 3. WHAT TO PRODUCE ===

Step 1 — Sanity check. If "${fw.label}" is genuinely the wrong shape for this case, say so in one line starting "FRAMEWORK CHECK:", name the framework you would use instead and why in under 25 words, and then answer using YOUR framework, not mine. If it fits, write "FRAMEWORK CHECK: fits." and continue. Do not be polite about this — a wrong framework costs me the interview.

Step 2 — The model answer. Write it stage by stage, using the exact stage names above as headings, in the order above. For each stage:
- Write the words I should actually SAY, in first person and in spoken English ("I'll assume...", "The segment I'd focus on is...", "The reason I'd rank that first is..."). Not bullet-point shorthand, not an essay.
- Keep each stage sayable inside its stated timebox at about ${LIVE_SPEAK_WPM} words per minute of speech. Put the approximate word count in brackets after each heading so I can see it fits.
- Be specific to THIS case: name real segments, real metric definitions with timeframes, real numbers, real trade-offs. Never write placeholder text like "the relevant metric" or "[insert example]". If you need a number, invent a plausible one and flag it as an assumption.
- Hit the "What good looks like" line for that stage, and dodge the "Avoid" items.
- End each stage with one line beginning "↳ if pressed:" giving the single sharpest sentence I can add if the interviewer digs into that stage.

Step 3 — Then add exactly three short sections:
- "IF THEY PUSH BACK" — the three most likely follow-up questions for this specific case, each with a two-sentence answer.
- "TRAPS" — the three mistakes that would most damage this answer, in one line each.
- "30-SECOND VERSION" — the entire answer compressed into something I can say in 30 seconds if I run out of time.

=== 4. HOW I WILL BE GRADED ===

This is the rubric my interviewer is effectively using:

${rubricBlock || '(rubric unavailable)'}

After the answer, grade your own answer against each dimension in one line — weak / solid / strong, plus what would push it one level up.

Output plain text. Short paragraphs. No preamble, no "great question", no restating these instructions. Start at the READING IT AS line.`;
}
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
}
function liveTypeSelectHTML(selected) {
  const byTrack = {};
  Object.keys(TYPE_TAXONOMY).forEach(t => { const tr = TYPE_TAXONOMY[t].track; (byTrack[tr] = byTrack[tr] || []).push(t); });
  const trackOrder = ['product-sense', 'analytical', 'ai-product', 'cross-cutting'];
  return `<select id="live-type-select" class="status-select" aria-label="Case type">
    ${trackOrder.filter(tr => byTrack[tr]).map(tr => `
      <optgroup label="${esc(titleCase(tr))}">
        ${byTrack[tr].sort((a, b) => TYPE_TAXONOMY[a].label.localeCompare(TYPE_TAXONOMY[b].label)).map(t =>
          `<option value="${esc(t)}" ${t === selected ? 'selected' : ''}>${esc(TYPE_TAXONOMY[t].label)}</option>`).join('')}
      </optgroup>`).join('')}
  </select>`;
}
function liveFrameworkSelectHTML(selected) {
  const keys = ['product-sense', 'analytical', 'rca', 'ai-product'];
  return `<select id="live-framework-select" class="status-select" aria-label="Framework">
    ${keys.map(k => `<option value="${esc(k)}" ${k === selected ? 'selected' : ''}>${esc((resolveFramework(k) || {}).label || titleCase(k))}</option>`).join('')}
  </select>`;
}
function renderLive() {
  const el = document.getElementById('view-live');
  if (!el) return;
  el.innerHTML = `
    <div class="sec-head"><h2>Live case</h2><span class="count">for when you're mid-interview</span></div>
    <p class="note">Paste or type the case the interviewer just gave you — fragments and shorthand are fine. This guesses the case type locally (no AI on this device) and shows the matching framework instantly.</p>
    <textarea id="live-input" class="live-input" placeholder="e.g. why did checkout conversion drop 12% last week for zomato, or design a product for gig workers…">${esc(state.live.text)}</textarea>
    <div id="live-result"></div>
    <div id="live-answer"></div>`;
  const ta = document.getElementById('live-input');
  if (ta) { ta.selectionStart = ta.selectionEnd = ta.value.length; }
  updateLiveResult();
  renderLiveAnswer();
  // Fire-and-forget: only used to soften the error copy if the worker is known
  // unreachable before the user even tries — never gates submission.
  liveHealthCheck().then(() => { if (state.live.workerReachable === false) updateLiveResult(); });
}
function liveGuessHTML(sel) {
  const cls = sel.cls;
  let badgeHTML;
  if (sel.isOverridden) {
    badgeHTML = `<span class="badge accent">${esc(sel.typeLabel)}</span><span class="badge neutral">manually chosen</span>`;
  } else if (sel.status === 'empty') {
    badgeHTML = `<span class="badge neutral">nothing typed yet</span>`;
  } else if (sel.status === 'unsure') {
    badgeHTML = `<span class="badge neutral">not classified — pick a type</span>`;
  } else {
    badgeHTML = `<span class="badge accent">${esc(sel.typeLabel)}</span><span class="badge ${sel.confidence === 'high' ? 'fresh' : 'verify'}">${esc(sel.confidence)} confidence</span>`;
  }
  const alternates = (!sel.isOverridden && cls && cls.ranked && cls.ranked.length > 1 && sel.status !== 'empty')
    ? `<div class="live-controls"><span class="flabel">Also considered</span>${cls.ranked.slice(1, 3).filter(r => r.score > 0).map(r =>
        `<button type="button" class="chip-btn" data-action="live-pick-type" data-type="${esc(r.type)}">${esc((TYPE_TAXONOMY[r.type] || {}).label || r.type)} · ${r.score}</button>`).join('')}</div>`
    : (sel.status === 'unsure' ? `<p class="note">Type a bit more, or pick the case type yourself below.</p>` : '');
  const whyDetails = (!sel.isOverridden && cls && cls.top)
    ? (() => {
        const top = cls.ranked.find(r => r.type === cls.top);
        const kw = top ? [...top.hits.strong, ...top.hits.phrases, ...top.hits.terms].slice(0, 8) : [];
        return kw.length ? `<details class="followups"><summary>Why this guess</summary><ul class="plain">${kw.map(k => `<li>${esc(k)}</li>`).join('')}</ul></details>` : '';
      })()
    : '';
  return `
    <div class="live-guess">
      <div class="live-controls">${badgeHTML}</div>
      ${alternates}
      <div class="live-controls">
        <span class="flabel">Case type</span>${liveTypeSelectHTML(sel.type)}
        <span class="flabel">Framework</span>${liveFrameworkSelectHTML(sel.frameworkKey)}
        ${sel.isOverridden ? `<button type="button" class="btn ghost small" data-action="live-reset">Reset to auto-guess</button>` : ''}
      </div>
      ${whyDetails}
    </div>`;
}
function updateLiveResult() {
  const wrap = document.getElementById('live-result');
  if (!wrap) return;
  const sel = liveSelection();
  if (sel.status === 'empty') {
    wrap.innerHTML = `${liveGuessHTML(sel)}<div class="empty">Paste or type the case prompt above — even a few fragments will do. The framework scaffold appears here instantly.</div>`;
    return;
  }
  const fw = sel.fw;
  const prompt = buildLivePrompt(sel, state.live.text);
  wrap.innerHTML = `
    ${liveGuessHTML(sel)}
    <div class="case-detail">
      <p class="block-label">${esc(fw.label)} framework · ${esc(String(fw.totalMin || 45))} min</p>
      ${stageListHTML(fw)}
      ${frameworkPitfalls(fw).length ? `<details class="followups"><summary>Pitfalls to avoid</summary><ul class="plain">${frameworkPitfalls(fw).map(p => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
      ${(fw.rubric || []).length ? `<details class="followups"><summary>Rubric you'll be scored against</summary>${rubricReadOnlyHTML(fw)}</details>` : ''}
    </div>
    ${liveActionsHTML()}
    <details class="followups"><summary>Preview the exact prompt</summary><textarea class="live-prompt-box" id="live-prompt-fallback" readonly>${esc(prompt)}</textarea></details>`;
}
function liveActionsHTML() {
  const st = state.live;
  const busy = st.answerStatus === 'loading' || st.answerStatus === 'streaming';
  const configured = liveWorkerConfigured();
  const unreachableNote = (configured && st.workerReachable === false)
    ? ` — the answer service didn't respond to a health check, but Enter will still try`
    : '';
  const actions = `
    ${configured ? `<button type="button" class="btn" id="live-answer-btn" data-action="live-answer" ${busy ? 'disabled' : ''}>${busy ? 'Getting answer…' : 'Get answer'}</button>` : ''}
    <button type="button" class="btn ${configured ? 'ghost small' : ''}" id="live-copy-btn" data-action="live-copy">Copy AI prompt</button>
    <button type="button" class="btn ghost small" data-action="live-clear">Clear</button>`;
  const note = configured
    ? `Press <b>Enter</b> to get a model answer here · <b>Shift+Enter</b> for a new line${unreachableNote}`
    : `Inline answers aren't set up on this device — <b>Enter</b> copies the prompt for your own Claude/ChatGPT tab.`;
  return `<div class="live-actions">${actions}</div><p class="note">${note}</p>`;
}
function saveLiveDraft() {
  const st = state.live;
  const answerToStore = (st.answer && st.answer.length <= LIVE_ANSWER_MAX_STORED_CHARS) ? st.answer : '';
  lsSet(LS_LIVE, {
    text: st.text, typeOverride: st.typeOverride, frameworkOverride: st.frameworkOverride,
    answer: answerToStore, answerFor: st.answerFor, answerAt: st.answerAt,
    updatedAt: new Date().toISOString()
  });
}
let liveSaveTimer = null;
let liveClassifyTimer = null;
function debounceSaveLiveDraft() {
  clearTimeout(liveSaveTimer);
  liveSaveTimer = setTimeout(saveLiveDraft, 400);
}
function debounceClassifyLive() {
  clearTimeout(liveClassifyTimer);
  liveClassifyTimer = setTimeout(() => {
    state.live.cls = classifyCaseText(state.live.text);
    updateLiveResult();
  }, 250);
}
function loadLiveDraft() {
  const saved = lsGet(LS_LIVE, null);
  if (saved && typeof saved === 'object') {
    state.live.text = saved.text || '';
    state.live.typeOverride = saved.typeOverride || null;
    state.live.frameworkOverride = saved.frameworkOverride || null;
    state.live.cls = state.live.text ? classifyCaseText(state.live.text) : null;
    state.live.answer = saved.answer || '';
    state.live.answerFor = saved.answerFor || null;
    state.live.answerAt = saved.answerAt || null;
    // Never restore a busy status — a page load always starts idle/done, never mid-request.
    state.live.answerStatus = state.live.answer ? 'done' : 'idle';
    state.live.partial = false;
  }
}

/* ---- Live case: inline AI answer (backend-assisted, additive to the local classifier above) ---- */
// The local classifier and buildLivePrompt()/"Copy AI prompt" are untouched and stay fully
// functional with LIVE_WORKER_URL empty or the worker unreachable — this section only adds an
// optional inline path on top. See chatbot-worker/src/live-case-prompt.js for the server twin.
function liveWorkerConfigured() { return !!LIVE_WORKER_URL; }

async function liveHealthCheck() {
  if (!liveWorkerConfigured() || state.live.workerReachable !== null) return;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const res = await fetch(LIVE_WORKER_URL + '/health', { signal: ac.signal });
    clearTimeout(t);
    state.live.workerReachable = !!res.ok;
  } catch (e) {
    state.live.workerReachable = false;
  }
}

function liveRequestPayload(sel) {
  const cls = sel.cls || {};
  const alternates = (cls.ranked || []).slice(1, 3).filter(r => r.score > 0).map(r => (TYPE_TAXONOMY[r.type] || {}).label || r.type);
  return {
    caseText: state.live.text,
    framework: {
      key: sel.frameworkKey, label: sel.fw.label, totalMin: sel.fw.totalMin,
      stages: (sel.fw.stages || []).map(s => ({ name: s.name, minMin: s.minMin, maxMin: s.maxMin, guidance: s.guidance, whatGoodLooksLike: s.whatGoodLooksLike, pitfalls: s.pitfalls || [] })),
      rubric: (sel.fw.rubric || []).map(r => ({ dimension: r.dimension, weak: r.weak, solid: r.solid, strong: r.strong }))
    },
    classifier: { typeLabel: sel.typeLabel, confidence: sel.confidence, status: sel.status, overridden: sel.isOverridden, alternates },
    speakWpm: LIVE_SPEAK_WPM,
    stream: true
  };
}

// Parses the model's "## Heading [~N words]" output contract. Tolerant of a
// truncated final section, since this runs on every streamed chunk.
function parseLiveAnswer(text) {
  const result = { readingAs: '', frameworkCheck: '', sections: [] };
  if (!text) return result;
  const headingLineRe = /^##\s+(.+?)\s*$/m;
  const firstMatch = headingLineRe.exec(text);
  const firstHeadingIndex = firstMatch ? firstMatch.index : -1;
  const preamble = firstHeadingIndex === -1 ? text : text.slice(0, firstHeadingIndex);
  const readingMatch = preamble.match(/READING IT AS:\s*(.+)/i);
  if (readingMatch) result.readingAs = readingMatch[1].trim();
  const fwMatch = preamble.match(/FRAMEWORK CHECK:\s*(.+)/i);
  if (fwMatch) result.frameworkCheck = fwMatch[1].trim();
  if (firstHeadingIndex === -1) return result;

  const body = text.slice(firstHeadingIndex);
  const re = /^##\s+(.+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(body)) !== null) marks.push({ index: m.index, heading: m[1], len: m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i].len;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const wordMatch = marks[i].heading.match(/^(.*?)\s*\[~?\s*(\d+)\s*words?\]$/i);
    result.sections.push({
      heading: (wordMatch ? wordMatch[1] : marks[i].heading).trim(),
      wordHint: wordMatch ? wordMatch[2] : null,
      body: body.slice(start, end).trim()
    });
  }
  return result;
}

function renderLiveAnswer() {
  const wrap = document.getElementById('live-answer');
  if (!wrap) return;
  const st = state.live;
  if (st.answerStatus === 'idle' && !st.answer && !st.answerError) { wrap.innerHTML = ''; return; }

  const busy = st.answerStatus === 'loading' || st.answerStatus === 'streaming';
  const parsed = parseLiveAnswer(st.answer);
  const sel = liveSelection();

  let statusText = '';
  if (st.answerStatus === 'loading') statusText = 'Contacting the answer service…';
  else if (st.answerStatus === 'streaming') statusText = 'Writing the answer…';
  else if (st.answerStatus === 'done' && st.partial) statusText = 'Stopped — partial answer kept';
  else if (st.answerStatus === 'done') statusText = 'Done';

  const metaChips = [];
  if (parsed.readingAs) metaChips.push(`<span class="badge neutral">READING IT AS: ${esc(parsed.readingAs)}</span>`);
  if (parsed.frameworkCheck) {
    const fits = /^fits\.?$/i.test(parsed.frameworkCheck);
    metaChips.push(`<span class="badge ${fits ? 'fresh' : 'verify'}">FRAMEWORK CHECK: ${esc(parsed.frameworkCheck)}</span>`);
  }

  const stagesHTML = parsed.sections.map(s => {
    const is30s = /30-SECOND VERSION/i.test(s.heading);
    const paras = s.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    return `<div class="walkthrough-stage${is30s ? ' live-answer-30s' : ''}">
      <h4>${esc(s.heading)}${s.wordHint ? ` <span class="stage-time">~${esc(s.wordHint)} words</span>` : ''}</h4>
      ${paras.map(p => `<p${/^(↳|if pressed)/i.test(p) ? ' class="live-if-pressed"' : ''}>${esc(p)}</p>`).join('')}
    </div>`;
  }).join('');

  const skeleton = (busy && !stagesHTML)
    ? `<div class="live-skeleton" style="width:70%"></div><div class="live-skeleton" style="width:92%"></div><div class="live-skeleton" style="width:55%"></div>`
    : '';

  let errorHTML = '';
  if (st.answerStatus === 'error') errorHTML = `<div class="live-answer-error"><p>${esc(st.answerError || 'Something went wrong.')}</p></div>`;
  else if (st.answerStatus === 'done' && st.partial) errorHTML = `<div class="live-answer-error"><p>The answer was cut off — what's above is still usable.</p></div>`;

  const stopBtn = busy ? `<button type="button" class="btn ghost small" data-action="live-stop">Stop</button>` : '';
  const retryBtn = (st.answerStatus === 'error' && st.answerCode !== 'rate_limited' && st.answerCode !== 'origin_not_allowed')
    ? `<button type="button" class="btn ghost small" data-action="live-answer-retry">Retry</button>` : '';
  const regenBtn = (st.answerStatus === 'done')
    ? `<button type="button" class="btn ghost small" data-action="live-regenerate">Regenerate</button>` : '';

  wrap.innerHTML = `
    <div class="model-answer live-answer" id="live-answer-card">
      <div class="live-answer-head">
        <p class="block-label">Model answer${sel.typeLabel ? ` · ${esc(sel.typeLabel)}` : ''}</p>
        ${busy ? '<span class="live-spinner" aria-hidden="true"></span>' : ''}
        <span class="live-answer-status" role="status" aria-live="polite">${esc(statusText)}</span>
        ${stopBtn}${regenBtn}${retryBtn}
      </div>
      ${metaChips.length ? `<div class="live-answer-meta">${metaChips.join('')}</div>` : ''}
      ${errorHTML}
      <div class="model-answer-stages" id="live-answer-body">${stagesHTML}${skeleton}</div>
    </div>`;
}

let liveAnswerRenderScheduled = false;
function scheduleLiveAnswerRender() {
  if (liveAnswerRenderScheduled) return;
  liveAnswerRenderScheduled = true;
  requestAnimationFrame(() => { liveAnswerRenderScheduled = false; renderLiveAnswer(); });
}

function abortLiveCase() {
  const st = state.live;
  if (st.abort) { try { st.abort.abort(); } catch (e) {} }
  st.abort = null;
  if (st.answer) { st.answerStatus = 'done'; st.partial = true; } else { st.answerStatus = 'idle'; }
  saveLiveDraft();
  renderLiveAnswer();
  updateLiveResult();
}

async function submitLiveCase(opts) {
  opts = opts || {};
  const st = state.live;
  if (st.answerStatus === 'loading' || st.answerStatus === 'streaming') return;

  const trimmed = (st.text || '').trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  if (wordCount < LIVE_MIN_WORDS) {
    st.answerError = 'Type a few more words, then press Enter.';
    st.answerCode = null;
    renderLiveAnswer();
    return;
  }

  const sel = liveSelection();
  const signature = sel.frameworkKey + '|' + trimmed;

  if (!opts.force && st.answerFor === signature && st.answer && st.answerStatus === 'done') {
    const card = document.getElementById('live-answer-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const now = Date.now();
  if (!opts.force && now - st.lastSubmitAt < LIVE_SUBMIT_DEBOUNCE_MS) return;
  st.lastSubmitAt = now;

  if (!liveWorkerConfigured()) {
    // No backend configured — Enter still does something useful: the same
    // copy-to-clipboard the "Copy AI prompt" button does.
    const prompt = buildLivePrompt(sel, st.text);
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      const btn = document.getElementById('live-copy-btn');
      if (btn) { const orig = 'Copy AI prompt'; btn.textContent = 'Copied ✓'; setTimeout(() => { if (btn.isConnected) btn.textContent = orig; }, 2000); }
    } else {
      const box = document.getElementById('live-prompt-fallback');
      if (box) { const d = box.closest('details'); if (d) d.open = true; box.scrollIntoView({ behavior: 'smooth', block: 'center' }); box.focus(); box.select(); }
    }
    recordActivity();
    renderStats();
    return;
  }

  st.answer = '';
  st.answerStatus = 'loading';
  st.answerError = null;
  st.answerCode = null;
  st.partial = false;
  st.answerFor = signature;
  renderLiveAnswer();
  updateLiveResult();
  const anchor = document.getElementById('live-answer');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const ac = new AbortController();
  st.abort = ac;
  let watchdog = setTimeout(() => ac.abort(), LIVE_FIRST_BYTE_TIMEOUT_MS);
  const bump = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ac.abort(), LIVE_IDLE_TIMEOUT_MS); };
  const canStream = typeof ReadableStream !== 'undefined' && typeof Response !== 'undefined' && 'body' in Response.prototype;
  const payload = liveRequestPayload(sel);
  payload.stream = canStream;
  let sawStop = false;

  try {
    const res = await fetch(LIVE_WORKER_URL + '/live-case', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal
    });
    clearTimeout(watchdog);

    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) {}
      st.answerCode = (data && data.code) || (res.status === 429 ? 'rate_limited' : (res.status === 403 ? 'origin_not_allowed' : 'upstream_failed'));
      st.answerError = (data && data.error) || ('The answer service returned an error (' + res.status + ').');
      st.answerStatus = 'error';
      return;
    }

    // Trust the ACTUAL response Content-Type, not just our own capability flag —
    // a server can legitimately answer a streamed request with plain JSON (or
    // vice versa isn't possible, but defend the one direction that matters).
    const isEventStream = (res.headers.get('Content-Type') || '').indexOf('text/event-stream') !== -1;
    if (canStream && res.body && isEventStream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            let evt;
            try { evt = JSON.parse(jsonStr); } catch (e) { continue; }
            if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
              st.answer += evt.delta.text;
              st.answerStatus = 'streaming';
              scheduleLiveAnswerRender();
            } else if (evt.type === 'message_stop') {
              sawStop = true;
            } else if (evt.type === 'error') {
              st.answerCode = 'upstream_error';
              st.answerError = (evt.error && evt.error.message) || 'The answer service reported an error mid-stream.';
              sawStop = true;
            }
          }
        }
      }
      st.answerStatus = 'done';
      st.partial = !sawStop && !!st.answer;
      if (!st.answer && !st.answerError) { st.answerStatus = 'error'; st.answerCode = 'empty_answer'; st.answerError = 'No answer was generated.'; }
      if (st.answer) st.answerAt = new Date().toISOString();
    } else {
      const data = await res.json();
      st.answer = data.answer || '';
      st.answerStatus = st.answer ? 'done' : 'error';
      st.partial = false;
      if (!st.answer) { st.answerCode = 'empty_answer'; st.answerError = 'No answer was generated.'; }
      else st.answerAt = new Date().toISOString();
    }
  } catch (e) {
    clearTimeout(watchdog);
    if (e && e.name === 'AbortError') {
      if (st.answer) { st.answerStatus = 'done'; st.partial = true; }
      else { st.answerStatus = 'error'; st.answerCode = 'timeout'; st.answerError = "Timed out waiting for the answer service — you can retry, or use Copy AI prompt instead."; }
    } else {
      st.answerStatus = 'error';
      st.answerCode = 'network_error';
      st.answerError = "Couldn't reach the answer service — check your connection, or use Copy AI prompt instead.";
    }
  } finally {
    clearTimeout(watchdog);
    st.abort = null;
    saveLiveDraft();
    recordActivity();
    renderLiveAnswer();
    updateLiveResult();
    renderStats();
  }
}

/* ============================== Export / Import ============================== */
function buildExportPayload() {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    notes: lsGet(LS_NOTES, {}),
    scores: lsGet(LS_SCORES, {}),
    status: lsGet(LS_STATUS, {}),
    behavioural: lsGet(LS_BEHAV, {}),
    behavStatus: lsGet(LS_BEHAV_STATUS, {}),
    activity: lsGet(LS_ACTIVITY, {}),
    live: lsGet(LS_LIVE, null)
  };
}
function exportJSON() {
  try {
    const payload = buildExportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pm-case-lab-export.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { alert('Export failed: ' + (e && e.message ? e.message : e)); }
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function validateImportShape(obj) {
  if (!isPlainObject(obj)) return false;
  const requiredKeys = ['notes', 'scores', 'status', 'behavioural', 'behavStatus'];
  for (const k of requiredKeys) {
    if (!(k in obj) || !isPlainObject(obj[k])) return false;
  }
  return true;
}
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(String(reader.result)); } catch (e) { alert('Import failed: the file is not valid JSON.'); return; }
    if (!validateImportShape(data)) { alert('Import failed: this file does not match the expected PM Case Lab export shape.'); return; }
    lsSet(LS_NOTES, data.notes);
    lsSet(LS_SCORES, data.scores);
    lsSet(LS_STATUS, data.status);
    lsSet(LS_BEHAV, data.behavioural);
    lsSet(LS_BEHAV_STATUS, data.behavStatus);
    if (isPlainObject(data.activity)) lsSet(LS_ACTIVITY, data.activity);
    if (isPlainObject(data.live)) { lsSet(LS_LIVE, data.live); loadLiveDraft(); }
    afterMutation();
    alert('Import complete.');
  };
  reader.onerror = () => alert('Import failed: could not read the file.');
  reader.readAsText(file);
}

/* ============================== Theme toggle ============================== */
function applyStoredTheme() {
  const saved = lsGet(LS_THEME, null);
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
}
function wireThemeToggle() {
  const btn = document.getElementById('theme');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    lsSet(LS_THEME, next);
  });
}

/* ============================== Event wiring (once, delegated) ============================== */
function wireEvents() {
  document.getElementById('tab-nav').addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
  });

  document.getElementById('view-today').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="open-case"]');
    if (btn) openCase(btn.dataset.id, 'today');
  });

  const casesEl = document.getElementById('view-cases');
  casesEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip-btn[data-filter]');
    if (chip) { state.casesFilter[chip.dataset.filter] = chip.dataset.value; renderCases(); return; }
    const openBtn = e.target.closest('[data-action="open-case"]');
    if (openBtn) { openCase(openBtn.dataset.id, 'cases'); return; }
    const card = e.target.closest('.card[data-case-id]');
    if (card && !e.target.closest('select') && !e.target.closest('button')) {
      openCase(card.dataset.caseId, 'cases');
    }
  });
  casesEl.addEventListener('change', e => {
    const sel = e.target.closest('[data-status-for]');
    if (sel) { setCaseStatus(sel.dataset.statusFor, sel.value); afterMutation(); }
  });
  casesEl.addEventListener('input', e => {
    if (e.target.id === 'case-search') { state.casesFilter.q = e.target.value; renderCases(); }
  });

  const behavEl = document.getElementById('view-behavioural');
  behavEl.addEventListener('click', e => {
    if (e.target.closest('[data-action="export-json"]')) { exportJSON(); return; }
    if (e.target.closest('[data-action="import-json"]')) { const inp = document.getElementById('import-file-input'); if (inp) inp.click(); return; }
    const st = e.target.closest('[data-action="toggle-story"]');
    if (st) { toggleLinkedStory(st.dataset.qid, st.dataset.story); renderBehavioural(); afterMutation(); return; }
    const suggest = e.target.closest('[data-action="suggest-story"]');
    if (suggest) { toggleLinkedStory(suggest.dataset.qid, suggest.dataset.story); renderBehavioural(); afterMutation(); return; }
  });
  behavEl.addEventListener('input', e => {
    const ta = e.target.closest('[data-behav-field]');
    if (ta) debounceSaveBehavField(ta.dataset.qid, ta.dataset.behavField, ta.value);
  });

  const storiesEl = document.getElementById('view-stories');
  storiesEl.addEventListener('click', e => {
    const goto = e.target.closest('[data-action="goto-question"]');
    if (goto) { jumpToQuestion(goto.dataset.qid); return; }
  });

  const liveEl = document.getElementById('view-live');
  liveEl.addEventListener('input', e => {
    if (e.target.id === 'live-input') {
      state.live.text = e.target.value;
      debounceSaveLiveDraft();
      debounceClassifyLive();
    }
  });
  liveEl.addEventListener('keydown', e => {
    if (e.target.id !== 'live-input') return;
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return; // IME composition — never hijack
    if (e.shiftKey || e.altKey) return; // Shift+Enter (or Alt+Enter) = newline, textarea default
    e.preventDefault();
    submitLiveCase({ source: 'enter' });
  });
  liveEl.addEventListener('change', e => {
    if (e.target.id === 'live-type-select') {
      state.live.typeOverride = e.target.value;
      state.live.frameworkOverride = null;
      saveLiveDraft();
      updateLiveResult();
      return;
    }
    if (e.target.id === 'live-framework-select') {
      state.live.frameworkOverride = e.target.value;
      saveLiveDraft();
      updateLiveResult();
    }
  });
  liveEl.addEventListener('click', e => {
    const pick = e.target.closest('[data-action="live-pick-type"]');
    if (pick) { state.live.typeOverride = pick.dataset.type; state.live.frameworkOverride = null; saveLiveDraft(); updateLiveResult(); return; }
    if (e.target.closest('[data-action="live-reset"]')) { state.live.typeOverride = null; state.live.frameworkOverride = null; saveLiveDraft(); updateLiveResult(); return; }
    if (e.target.closest('[data-action="live-clear"]')) {
      if (!confirm('Clear the pasted case and start over?')) return;
      if (state.live.abort) { try { state.live.abort.abort(); } catch (err) {} }
      state.live = {
        text: '', typeOverride: null, frameworkOverride: null, cls: null,
        answer: '', answerStatus: 'idle', answerError: null, answerCode: null,
        answerFor: null, answerAt: null, abort: null, partial: false,
        workerReachable: state.live.workerReachable, lastSubmitAt: 0
      };
      saveLiveDraft();
      renderLive();
      return;
    }
    if (e.target.closest('[data-action="live-answer"]')) { submitLiveCase({ source: 'button' }); return; }
    if (e.target.closest('[data-action="live-answer-retry"]')) { submitLiveCase({ source: 'retry', force: true }); return; }
    if (e.target.closest('[data-action="live-regenerate"]')) { submitLiveCase({ source: 'regenerate', force: true }); return; }
    if (e.target.closest('[data-action="live-stop"]')) { abortLiveCase(); return; }
    const copyBtn = e.target.closest('[data-action="live-copy"]');
    if (copyBtn) {
      const sel = liveSelection();
      const prompt = buildLivePrompt(sel, state.live.text);
      copyTextToClipboard(prompt).then(ok => {
        const btn = document.getElementById('live-copy-btn');
        if (ok) {
          if (btn) { const orig = 'Copy AI prompt'; btn.textContent = 'Copied ✓'; setTimeout(() => { if (btn.isConnected) btn.textContent = orig; }, 2000); }
        } else {
          const box = document.getElementById('live-prompt-fallback');
          if (box) {
            const details = box.closest('details');
            if (details) details.open = true;
            box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            box.focus(); box.select();
          }
        }
        recordActivity();
        renderStats();
      });
    }
  });
  behavEl.addEventListener('change', e => {
    const sel = e.target.closest('[data-behav-status-for]');
    if (sel) { setBehavStatus(sel.dataset.behavStatusFor, sel.value); afterMutation(); return; }
    const file = e.target.closest('#import-file-input');
    if (file && file.files && file.files[0]) { importJSON(file.files[0]); file.value = ''; }
  });

  const practiceEl = document.getElementById('view-practice');
  practiceEl.addEventListener('click', e => {
    if (e.target.closest('#practice-back')) { goBackFromPractice(); return; }
    if (e.target.closest('#timer-start')) { startTimer(); return; }
    if (e.target.closest('#timer-pause')) { pauseTimer(); return; }
    if (e.target.closest('#timer-reset')) { resetTimer(); renderTimerBar(); updateTimerDisplay(); return; }
    const stageNavBtn = e.target.closest('#timer-stage-nav .chip-btn');
    if (stageNavBtn) { setCurrentStage(Number(stageNavBtn.dataset.stageIdx)); return; }
    if (e.target.closest('#show-model-btn')) {
      if (!timerState) return;
      const c = getCaseById(timerState.caseId);
      if (!c) return;
      revealModelAnswer(c, getFrameworkForCase(c));
      return;
    }
    const rubricBtn = e.target.closest('.rubric-level');
    if (rubricBtn && timerState) {
      const dim = rubricBtn.dataset.dim, level = rubricBtn.dataset.level;
      const c = getCaseById(timerState.caseId);
      if (!c) return;
      setCaseScoreDim(c.id, dim, level);
      const fw = getFrameworkForCase(c);
      const cur = getCaseScore(c.id);
      const allScored = (fw.rubric || []).length > 0 && fw.rubric.every(r => (cur.dims || {})[r.dimension]);
      if (allScored) setCaseStatus(c.id, 'completed');
      renderRubricWidget(c, fw);
      updatePracticeStatusSelect(c.id);
      afterMutation();
      return;
    }
  });
  practiceEl.addEventListener('input', e => {
    const ta = e.target.closest('[data-stage-key]');
    if (ta && timerState) debounceSaveNote(timerState.caseId, ta.dataset.stageKey, ta.value);
  });
  practiceEl.addEventListener('change', e => {
    const sel = e.target.closest('#practice-status-select');
    if (sel && timerState) { setCaseStatus(timerState.caseId, sel.value); afterMutation(); }
  });
}

/* ============================== Data loading ============================== */
async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Request failed: ' + url + ' (' + res.status + ')');
  return res.json();
}
async function loadCoreData() {
  const [fw, cs, sch, st] = await Promise.all([
    fetchJSON('./data/frameworks.json'),
    fetchJSON('./data/cases.json'),
    fetchJSON('./data/schedule.json'),
    fetchJSON('./data/stories.json')
  ]);
  FRAMEWORKS = fw || {};
  CASES = (cs && cs.cases) || [];
  SCHEDULE = sch || { epoch: '2026-09-14', days: [] };
  STORIES = (st && st.stories) || [];
}

/* ============================== Init ============================== */
async function init() {
  wireThemeToggle();
  applyStoredTheme();
  wireEvents();

  try {
    await loadCoreData();
  } catch (e) {
    FRAMEWORKS = {}; CASES = []; SCHEDULE = { epoch: '2026-09-14', days: [] }; STORIES = [];
  }
  try { BEHAVIOURAL = await fetchJSON('./data/behavioural.json'); } catch (e) { BEHAVIOURAL = null; }
  try { COVERAGE = await fetchJSON('./data/coverage.json'); } catch (e) { COVERAGE = null; }

  DAY_INDEX = computeDayIndex(SCHEDULE.epoch || '2026-09-14', getDayOverride());
  loadLiveDraft();

  const cParam = new URLSearchParams(location.search).get('c');
  if (cParam && getCaseById(cParam)) {
    state.activeView = 'cases';
    switchTab('cases');
    openCase(cParam, 'cases');
  } else {
    switchTab('today');
  }
}

document.addEventListener('DOMContentLoaded', init);
