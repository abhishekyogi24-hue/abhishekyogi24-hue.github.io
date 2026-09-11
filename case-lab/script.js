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
const STATUSES = ['new', 'active', 'completed', 'bookmarked', 'skipped'];
const TOTAL_TIMER_SEC = 45 * 60;

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
  casesFilter: { status: 'all', track: 'all', type: 'all', company: 'all', region: 'all', difficulty: 'all', q: '' }
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
  ['today', 'cases', 'behavioural', 'stories', 'progress', 'practice'].forEach(v => {
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
        <div class="stage-list">
          ${(fw.stages || []).map(s => `
            <div class="stage-row">
              <div class="stage-row-top"><h4>${esc(s.name)}</h4><span class="stage-time">${esc(String(s.minMin))}–${esc(String(s.maxMin))} min</span></div>
              <div class="stage-guidance">${esc(s.guidance)}</div>
              <div class="stage-good">What good looks like: ${esc(s.whatGoodLooksLike)}</div>
            </div>`).join('')}
        </div>
      </div>
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
    activity: lsGet(LS_ACTIVITY, {})
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
