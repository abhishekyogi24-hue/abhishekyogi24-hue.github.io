/* Mock interview — views, settings and wiring.
   Flow: setup -> interview (phase machine + streaming LLM + voice) -> report -> history. */

import { D, loadAll, resolveFramework, pickCase, pickBehavioural, todaysCaseId, caseById, themeLabel } from './data.js';
import { Interview, ROUNDS, streamSafe } from './engine.js';
import { PERSONAS, LEVELS, STYLES, buildInterviewerSystem, buildFeedbackRequest } from './prompts.js';
import { runInterviewer, runFeedback, LLMError } from './llm.js';
import { Speaker, Listener, loadVoices, groupVoices, sttSupported, ttsSupported } from './voice.js';
import { answerMetrics, sessionMetrics, fmtClock } from './metrics.js';
import { esc, renderReport, renderHistory, turnHTML, saveRecord, loadHistory, deleteRecord, recentThemes, toMarkdown, toJSON, download } from './report.js';

/* ============================== Constants / storage ============================== */
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const LS_SETTINGS = 'mi_settings_v1';
const LS_THEME = 'caselab_theme_v1';          // shared with Case Lab so the theme carries over
const KEY_ANTHROPIC = 'mi_key_anthropic', KEY_ELEVEN = 'mi_key_eleven';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function lsGet(key, fallback) { try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch (e) { return fallback; } }
function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ } }

/* API keys: sessionStorage unless "Remember on this device" is ticked. Never part of the settings blob. */
function getKey(name) {
  try { return sessionStorage.getItem(name) || localStorage.getItem(name) || ''; } catch (e) { return ''; }
}
function setKey(name, value, remember) {
  try {
    sessionStorage.removeItem(name); localStorage.removeItem(name);
    if (value) (remember ? localStorage : sessionStorage).setItem(name, value);
  } catch (e) { /* ignore */ }
}

const DEFAULTS = {
  round: 'full', length: 45, level: 'PM', style: 'faang', styleCustom: '', jd: '',
  caseMode: 'today', caseTrack: 'any', caseDifficulty: 'any', casePick: '',
  behavMode: 'auto', behavPick: [],
  resumeMode: 'default', resumeOwn: '',
  preset: 'priya', persona: Object.assign({}, PERSONAS.priya),
  voice: { engine: 'browser', voiceURI: '', rate: 1, pitch: 1, volume: 1, elevenVoiceId: '' },
  input: 'voice', sttLang: 'en-IN', keyRemember: false,
};
function loadSettings() {
  const saved = lsGet(LS_SETTINGS, {});
  return Object.assign({}, DEFAULTS, saved, {
    persona: Object.assign({}, DEFAULTS.persona, saved.persona || {}),
    voice: Object.assign({}, DEFAULTS.voice, saved.voice || {}),
  });
}
let S = loadSettings();
const saveSettings = () => lsSet(LS_SETTINGS, S);

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

/* ============================== Misc UI helpers ============================== */
function toast(msg, ms = 4200) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}
function showView(name) {
  ['setup', 'interview', 'report', 'history'].forEach(v => { $('#view-' + v).hidden = v !== name; });
  $$('#tab-nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === name || (name === 'report' && b.dataset.view === 'history'))));
  window.scrollTo({ top: 0 });
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ============================== Setup view ============================== */
let voiceList = [];
const ROUND_OPTIONS = Object.entries(ROUNDS).map(([k, r]) => [k, r.label]);
const TRACKS = [['any', 'Any track'], ['product-sense', 'Product sense'], ['analytical', 'Analytical'], ['rca', 'Root cause'], ['ai-product', 'AI product'], ['cross-cutting', 'Cross-cutting']];

function opt(v, label, cur) { return `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label)}</option>`; }
function segCtl(key, options, cur) {
  return `<div class="seg" role="group">${options.map(([v, l]) => `<button type="button" data-seg="${key}" data-v="${esc(v)}" aria-pressed="${String(cur) === String(v)}">${esc(l)}</button>`).join('')}</div>`;
}
function field(label, inner, hint) {
  return `<div class="field"><label class="flabel">${label}</label>${inner}${hint ? `<div class="note">${hint}</div>` : ''}</div>`;
}

function caseListOptions(filter) {
  const f = (filter || '').toLowerCase();
  return D.cases
    .filter(c => !f || (c.title + ' ' + (c.company || []).join(' ') + ' ' + c.track + ' ' + c.id).toLowerCase().includes(f))
    .map(c => opt(c.id, `[${c.track}] ${c.title}`, S.casePick)).join('');
}
function behavListOptions(filter) {
  const f = (filter || '').toLowerCase();
  return D.behav.questions
    .filter(q => !f || (q.question + ' ' + q.theme).toLowerCase().includes(f))
    .map(q => `<option value="${esc(q.id)}"${S.behavPick.includes(q.id) ? ' selected' : ''}>${esc(themeLabel(q.theme))} — ${esc(q.question)}</option>`).join('');
}
function voiceOptions() {
  const groups = groupVoices(voiceList);
  const auto = `<option value="">Auto — best match for ${esc(S.persona.lang)}</option>`;
  return auto + Object.entries(groups).filter(([, v]) => v.length).map(([g, vs]) =>
    `<optgroup label="${g === 'other' ? 'Other languages' : g}">${vs.map(v => `<option value="${esc(v.voiceURI)}"${S.voice.voiceURI === v.voiceURI ? ' selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}</optgroup>`).join('');
}

function renderSetup() {
  const root = $('#view-setup');
  const scroll = window.scrollY;
  const round = ROUNDS[S.round];
  const hasCase = round.phases.includes('case');
  const hasBehav = round.behavCount > 0;
  const todayId = todaysCaseId();
  const todayCase = todayId && caseById(todayId);
  const p = S.persona;
  const mockBanner = MOCK ? '<div class="banner mock">Mock mode (?mock=1): no API calls are made. The interviewer speaks canned lines and the report is canned data, so you can test the whole flow without a key.</div>' : '';

  root.innerHTML = `
    ${mockBanner}
    <div class="card form-section"><h3>Round</h3>
      ${field('Round type', segCtl('round', ROUND_OPTIONS, S.round), 'Full loop: intro, resume deep dive, behavioural, product case, your questions.')}
      ${field('Length', segCtl('length', [[30, '30 min'], [45, '45 min'], [60, '60 min']], S.length), 'Phase time budgets scale to the length.')}
      ${field('Level', segCtl('level', Object.keys(LEVELS).map(k => [k, k]), S.level), 'Sets the bar in both the interview and the grading.')}
    </div>

    <div class="card form-section"><h3>Company and role</h3>
      ${field('Company style', `<select data-k="style" data-rerender="1">${Object.entries(STYLES).map(([k, v]) => opt(k, v.label, S.style)).join('')}</select>`)}
      ${S.style === 'custom' ? field('Describe the company style', `<textarea data-k="styleCustom" rows="2" placeholder="e.g. B2B fintech, enterprise sales cycle, regulated, data-heavy">${esc(S.styleCustom)}</textarea>`) : ''}
      ${field('Target job description (optional)', `<textarea data-k="jd" rows="4" placeholder="Paste the JD. The interviewer tailors questions to it.">${esc(S.jd)}</textarea>`)}
    </div>

    ${hasCase ? `<div class="card form-section"><h3>Product case</h3>
      ${field('Case', segCtl('caseMode', [['today', "Today's case"], ['random', 'Random'], ['pick', 'Pick one']], S.caseMode),
        S.caseMode === 'today' ? (todayCase ? `Today: <b>${esc(todayCase.title)}</b> (${esc(todayCase.track)})` : 'No case scheduled today (rest day), so a random one will be used.') : '')}
      ${S.caseMode === 'random' ? `<div class="row2">
        ${field('Track', `<select data-k="caseTrack">${TRACKS.map(([v, l]) => opt(v, l, S.caseTrack)).join('')}</select>`)}
        ${field('Difficulty', `<select data-k="caseDifficulty">${[['any', 'Any'], [1, '1 · easier'], [2, '2 · medium'], [3, '3 · hard']].map(([v, l]) => opt(v, l, S.caseDifficulty)).join('')}</select>`)}</div>` : ''}
      ${S.caseMode === 'pick' ? field('Search and pick', `<input type="search" id="case-search" placeholder="Search ${D.cases.length} cases…"><select id="case-list" data-k="casePick" size="7">${caseListOptions('')}</select>`, S.casePick ? `Selected: <b>${esc((caseById(S.casePick) || {}).title || S.casePick)}</b>` : 'Nothing selected yet — a random case will be used.') : ''}
    </div>` : ''}

    ${hasBehav ? `<div class="card form-section"><h3>Behavioural questions</h3>
      ${field('Selection', segCtl('behavMode', [['auto', 'Auto'], ['pick', 'Pick']], S.behavMode), `Auto picks ${round.behavCount} question${round.behavCount > 1 ? 's' : ''}, weighted toward themes you haven't practised recently.`)}
      ${S.behavMode === 'pick' ? field('Search and pick (hold Ctrl/Cmd for several)', `<input type="search" id="behav-search" placeholder="Search ${D.behav.questions.length} questions…"><select id="behav-list" multiple size="8">${behavListOptions('')}</select>`) : ''}
    </div>` : ''}

    <div class="card form-section"><h3>Resume</h3>
      ${field('Source', segCtl('resumeMode', [['default', "Abhishek's resume (KB)"], ['own', 'Use my own']], S.resumeMode))}
      ${S.resumeMode === 'own' ? field('Paste your resume', `<textarea data-k="resumeOwn" rows="7" placeholder="Paste resume text…">${esc(S.resumeOwn)}</textarea>`) : `<div class="note">${D.resume ? `Loaded ${Math.round(D.resume.length / 1000)}k characters from the Case Lab knowledge base.` : 'Could not load the KB resume — paste your own instead.'}</div>`}
    </div>

    <div class="card form-section"><h3>Interviewer</h3>
      ${field('Preset', `<div class="seg" role="group">${Object.entries(PERSONAS).map(([k, v]) => `<button type="button" data-preset="${k}" aria-pressed="${S.preset === k}" title="${esc(v.blurb)}">${esc(v.name)}</button>`).join('')}<button type="button" data-preset="custom" aria-pressed="${S.preset === 'custom'}">Custom</button></div>`,
        S.preset !== 'custom' ? esc(PERSONAS[S.preset].blurb) : 'Fully custom interviewer.')}
      <div class="row2">
        ${field('Name', `<input type="text" data-k="persona.name" data-custom="1" value="${esc(p.name)}">`)}
        ${field('Title', `<input type="text" data-k="persona.title" data-custom="1" value="${esc(p.title)}">`)}
        ${field('Company', `<input type="text" data-k="persona.company" data-custom="1" value="${esc(p.company)}">`)}
        ${field('Accent (voice language)', `<select data-k="persona.lang" data-custom="1" data-rerender="1">${['en-IN', 'en-US', 'en-GB', 'en-AU'].map(l => opt(l, l, p.lang)).join('')}</select>`)}
        ${field('Tone', `<select data-k="persona.tone" data-custom="1">${[['warm', 'Warm'], ['neutral', 'Neutral'], ['tough', 'Tough']].map(([v, l]) => opt(v, l, p.tone)).join('')}</select>`)}
        ${field('Pushback', `<select data-k="persona.pushback" data-custom="1">${[['low', 'Low'], ['med', 'Medium'], ['high', 'High']].map(([v, l]) => opt(v, l, p.pushback)).join('')}</select>`)}
        ${field('Interruptions', `<select data-k="persona.interruptions" data-custom="1">${[['off', 'Off'], ['rambling', 'If rambling'], ['aggressive', 'Aggressive']].map(([v, l]) => opt(v, l, p.interruptions)).join('')}</select>`)}
        ${field('Follow-up depth', `<select data-k="persona.depth" data-custom="1" data-num="1">${[1, 2, 3, 4].map(n => opt(n, n, p.depth)).join('')}</select>`)}
      </div>
    </div>

    <div class="card form-section"><h3>Voice</h3>
      ${field('Engine', `<select data-k="voice.engine" data-rerender="1">${[['browser', 'Browser voice (free)'], ['eleven', 'ElevenLabs (your key)'], ['off', 'Off — read the interviewer']].map(([v, l]) => opt(v, l, S.voice.engine)).join('')}</select>`,
        ttsSupported() ? '' : 'This browser has no speech synthesis; text only.')}
      ${S.voice.engine !== 'off' ? `<div class="row2">
        ${S.voice.engine === 'browser' ? field('Voice', `<select id="voice-list" data-k="voice.voiceURI">${voiceOptions()}</select>`, 'Grouped by accent. Voices differ a lot per OS and browser.') : ''}
        ${S.voice.engine === 'eleven' ? field('ElevenLabs API key', `<input type="password" id="key-eleven" autocomplete="off" value="${esc(getKey(KEY_ELEVEN))}" placeholder="xi-api-key">`, 'Stored like the Anthropic key. Falls back to the browser voice on any error.') : ''}
        ${S.voice.engine === 'eleven' ? field('ElevenLabs voice id', `<input type="text" data-k="voice.elevenVoiceId" value="${esc(S.voice.elevenVoiceId)}" placeholder="voice id from your ElevenLabs library">`) : ''}
        ${field('Speed', `<input type="range" data-k="voice.rate" data-num="1" min="0.7" max="1.4" step="0.05" value="${S.voice.rate}"><span class="rv">${S.voice.rate}</span>`)}
        ${field('Pitch', `<input type="range" data-k="voice.pitch" data-num="1" min="0.6" max="1.6" step="0.05" value="${S.voice.pitch}"><span class="rv">${S.voice.pitch}</span>`)}
        ${field('Volume', `<input type="range" data-k="voice.volume" data-num="1" min="0.2" max="1" step="0.05" value="${S.voice.volume}"><span class="rv">${S.voice.volume}</span>`)}
      </div>
      <button type="button" class="btn small ghost" id="preview-voice">▶ Preview voice</button>` : ''}
    </div>

    <div class="card form-section"><h3>Your answers</h3>
      ${field('Input', segCtl('input', [['voice', 'Voice (mic)'], ['text', 'Text']], S.input),
        sttSupported() ? 'Chrome sends your microphone audio to Google for speech recognition. Choose Text if you do not want that. You can always type or edit the live transcript.'
          : 'This browser has no speech recognition (Firefox, for instance), so you will type your answers.')}
      ${S.input === 'voice' && sttSupported() ? field('Speech language', `<select data-k="sttLang">${[['en-IN', 'English (India)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['hi-IN', 'Hindi (India)']].map(([v, l]) => opt(v, l, S.sttLang)).join('')}</select>`) : ''}
    </div>

    <div class="card form-section"><h3>Anthropic API key</h3>
      ${MOCK ? '<div class="note">Not needed in mock mode.</div>' : `
      ${field('Key', `<input type="password" id="key-anthropic" autocomplete="off" value="${esc(getKey(KEY_ANTHROPIC))}" placeholder="sk-ant-…">`,
        'Requests go straight from your browser to api.anthropic.com. The key is kept for this tab only unless you tick Remember.')}
      <label class="check"><input type="checkbox" data-k="keyRemember" data-bool="1" ${S.keyRemember ? 'checked' : ''}> Remember on this device</label>
      <button type="button" class="btn small ghost" id="clear-keys">Clear saved keys</button>`}
    </div>

    <div class="start-row">
      <div id="setup-err" class="err" role="alert" hidden></div>
      <button type="button" class="btn big" id="start-btn">Start interview</button>
    </div>`;
  window.scrollTo({ top: scroll });
}

function applyPreset(key) {
  S.preset = key;
  if (key !== 'custom') { S.persona = Object.assign({}, PERSONAS[key]); S.voice.voiceURI = ''; }
  saveSettings();
  renderSetup();
}

function wireSetup() {
  const root = $('#view-setup');

  root.addEventListener('click', e => {
    const segBtn = e.target.closest('[data-seg]');
    if (segBtn) {
      const k = segBtn.dataset.seg;
      let v = segBtn.dataset.v;
      if (k === 'length') v = Number(v);
      S[k] = v;
      saveSettings(); renderSetup(); return;
    }
    const pre = e.target.closest('[data-preset]');
    if (pre) { applyPreset(pre.dataset.preset); return; }
    if (e.target.id === 'preview-voice') { previewVoice(); return; }
    if (e.target.id === 'clear-keys') {
      setKey(KEY_ANTHROPIC, '', false); setKey(KEY_ELEVEN, '', false);
      $$('#key-anthropic, #key-eleven').forEach(i => { i.value = ''; });
      toast('Saved keys cleared.'); return;
    }
    if (e.target.id === 'start-btn') startSession();
  });

  const onField = e => {
    const el = e.target;
    if (el.id === 'case-search') { $('#case-list').innerHTML = caseListOptions(el.value); return; }
    if (el.id === 'behav-search') { $('#behav-list').innerHTML = behavListOptions(el.value); return; }
    if (el.id === 'behav-list') {
      // Keep picks that are currently hidden by the search filter.
      const visible = [...el.options].map(o => o.value);
      S.behavPick = S.behavPick.filter(id => !visible.includes(id)).concat([...el.selectedOptions].map(o => o.value));
      saveSettings(); return;
    }
    if (el.id === 'key-anthropic') { setKey(KEY_ANTHROPIC, el.value.trim(), S.keyRemember); return; }
    if (el.id === 'key-eleven') { setKey(KEY_ELEVEN, el.value.trim(), S.keyRemember); return; }
    const k = el.dataset.k;
    if (!k) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.num) v = Number(v);
    setPath(S, k, v);
    if (el.dataset.custom) S.preset = 'custom';
    if (k === 'keyRemember') { setKey(KEY_ANTHROPIC, getKey(KEY_ANTHROPIC), v); setKey(KEY_ELEVEN, getKey(KEY_ELEVEN), v); }
    if (el.type === 'range') { const rv = el.parentElement.querySelector('.rv'); if (rv) rv.textContent = v; }
    saveSettings();
    if (k === 'casePick') renderSetupKeepList();
    else if (el.dataset.rerender) renderSetup();
    else if (el.dataset.custom) renderSetupPresetOnly();
  };
  root.addEventListener('input', onField);
  root.addEventListener('change', onField);
}
// Selecting a case only needs the hint text refreshed, not a full re-render (keeps scroll in the list).
function renderSetupKeepList() {
  const note = $('#case-list') && $('#case-list').closest('.field').querySelector('.note');
  if (note) note.innerHTML = `Selected: <b>${esc((caseById(S.casePick) || {}).title || S.casePick)}</b>`;
}
function renderSetupPresetOnly() {
  $$('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === S.preset)));
}

async function previewVoice() {
  const sp = previewSpeaker || (previewSpeaker = new Speaker({ onWarn: toast }));
  sp.cancel();
  sp.warned = false;
  sp.configure(speakerOpts());
  sp.say(`Hi, I'm ${S.persona.name}. Thanks for making the time today. Let's get started whenever you're ready.`);
}
let previewSpeaker = null;

function speakerOpts() {
  return Object.assign({}, S.voice, { lang: S.persona.lang, elevenKey: getKey(KEY_ELEVEN) });
}

/* ============================== Interview session ============================== */
let I = null; // active session

function buildPack() {
  const eng = I.eng;
  const roundDef = ROUNDS[S.round];
  let caseObj = null, caseNote = '';
  if (roundDef.phases.includes('case')) { const r = pickCase(S); caseObj = r.case; caseNote = r.note; }
  const behavQs = roundDef.behavCount > 0 ? pickBehavioural(S, roundDef.behavCount, recentThemes()) : [];
  const resume = S.resumeMode === 'own' && S.resumeOwn.trim() ? S.resumeOwn.trim() : D.resume;
  return {
    persona: S.persona, level: S.level, style: S.style, styleCustom: S.styleCustom, jd: S.jd,
    resume: resume || '(No resume provided. Ask the candidate to describe their background instead.)',
    roundLabel: roundDef.label, lengthMin: S.length, phases: eng.phases,
    caseObj, caseNote, framework: caseObj ? resolveFramework(caseObj.framework) : null,
    behavQs, stories: D.stories,
    allCaseIds: D.cases.map(c => c.id), allQuestionIds: D.behav.questions.map(q => q.id),
  };
}

function startSession() {
  const err = $('#setup-err');
  err.hidden = true;
  if (!MOCK && !getKey(KEY_ANTHROPIC)) { err.textContent = 'Add your Anthropic API key below (or open this page with ?mock=1 to try it without one).'; err.hidden = false; err.scrollIntoView({ block: 'center' }); return; }
  if (S.resumeMode === 'own' && !S.resumeOwn.trim()) { err.textContent = 'You chose "use my own resume" but the box is empty.'; err.hidden = false; return; }

  const eng = new Interview({ round: S.round, lengthMin: S.length });
  I = {
    eng, pack: null, system: '', messages: [], transcript: [], answers: [],
    speaker: new Speaker(Object.assign(speakerOpts(), {
      onState: sp => { I.speaking = sp; updateStatus(); },
      onWarn: toast,
    })),
    listener: null, abort: null, turnSeq: 0, stage: 'idle', paused: false, done: false,
    speaking: false, answer: null, timer: null, voiceMode: S.input === 'voice' && sttSupported(), startedWallAt: Date.now(),
  };
  I.pack = buildPack();
  I.system = buildInterviewerSystem(I.pack);
  I.listener = new Listener({
    onResult: (fin, interim) => onSpeechResult(fin, interim),
    onStatus: st => { I.micOn = st === 'listening'; updateStatus(); },
    onError: msg => { toast(msg, 6000); },
  });

  renderInterviewShell();
  showView('interview');
  document.body.classList.add('in-interview');
  eng.start();
  I.messages.push({ role: 'user', content: eng.startNote() });
  I.timer = setInterval(tick, 500);
  interviewerTurn();
}

/* ---------- interview screen shell ---------- */
function renderInterviewShell() {
  const p = I.pack.persona, eng = I.eng;
  const strip = eng.phases.map((ph, i) => `<div class="pseg" data-i="${i}" style="flex:${Math.max(ph.budgetMin, 0.6)}" title="${esc(ph.label)}"><div class="fill"></div><span class="plabel">${esc(ph.label)}</span><span class="ptime"></span></div>`).join('');
  $('#view-interview').innerHTML = `
    ${MOCK ? '<div class="banner mock">Mock mode — canned interviewer, no API calls.</div>' : ''}
    <div class="iv-top">
      <div class="interviewer-card card">
        <div class="avatar" aria-hidden="true">${esc(p.name.slice(0, 1))}</div>
        <div class="who-block">
          <div class="iname">${esc(p.name)}</div>
          <div class="isub">${esc(p.title)}, ${esc(p.company)}</div>
          <div class="istatus"><span class="dot" id="status-dot"></span><span id="status-text">Getting ready…</span></div>
        </div>
        <button type="button" class="btn small ghost" id="stop-voice" title="Stop the interviewer's voice">Skip voice</button>
      </div>
      <div class="clock-card card">
        <div class="clock-row"><span class="clabel">Overall</span><span class="clock" id="clock-total">00:00</span><span class="clabel">/ ${fmtClock(S.length * 60)}</span></div>
        <div class="clock-row"><span class="clabel" id="clock-phase-name">Phase</span><span class="clock small" id="clock-phase">00:00</span><span class="clabel" id="clock-phase-budget"></span></div>
      </div>
    </div>
    <div class="phase-strip" id="phase-strip" aria-label="Interview progress">${strip}</div>
    <div id="iv-banner" class="banner-slot" hidden></div>
    <div class="transcript live" id="iv-transcript" aria-live="polite"></div>
    <div class="answer-box card" id="answer-box">
      <div class="answer-head"><b>Your answer</b><span class="mic-state" id="mic-state"></span><span class="note" id="answer-timer"></span></div>
      <textarea id="iv-answer" rows="4" placeholder="${I.voiceMode ? 'Start speaking — your words appear here and you can edit them. Or just type.' : 'Type your answer…'}" disabled></textarea>
      ${I.voiceMode ? '<div class="note">Speech recognition runs in your browser; Chrome sends the audio to Google. Press Space or the button when you are done.</div>' : ''}
      <div class="answer-actions">
        <button type="button" class="btn" id="btn-done" disabled>Done answering <kbd>Space</kbd></button>
        <button type="button" class="btn ghost" id="btn-skip" disabled>Skip question</button>
        <button type="button" class="btn ghost" id="btn-pause">Pause</button>
        <button type="button" class="btn ghost danger" id="btn-end">End interview early</button>
      </div>
    </div>
    <div class="pause-overlay" id="pause-overlay" hidden><div class="card"><h3>Paused</h3><p class="note">The clock is stopped.</p><button type="button" class="btn" id="btn-resume">Resume</button></div></div>`;
  updateStrip();
}

function wireInterview() {
  const root = $('#view-interview');
  root.addEventListener('click', e => {
    const id = e.target.closest('button') && e.target.closest('button').id;
    if (id === 'btn-done') submitAnswer({ skipped: false });
    else if (id === 'btn-skip') submitAnswer({ skipped: true });
    else if (id === 'btn-pause') togglePause();
    else if (id === 'btn-resume') togglePause();
    else if (id === 'btn-end') endEarly();
    else if (id === 'stop-voice') { I.speaker.cancel(); }
    else if (e.target.closest('[data-retry]')) { const k = e.target.closest('[data-retry]').dataset.retry; if (k === 'turn') interviewerTurn(); else if (k === 'skip-refusal') skipRefusedTurn(); }
  });
  root.addEventListener('input', e => {
    if (e.target.id !== 'iv-answer' || !I || !I.answer) return;
    I.answer.committed = e.target.value; I.answer.interim = '';
    markAnswerStarted();
  });
  document.addEventListener('keydown', e => {
    if (!I || I.done || I.paused || e.code !== 'Space' || I.stage !== 'answering') return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.tagName === 'A' || t.isContentEditable)) return;
    e.preventDefault();
    submitAnswer({ skipped: false });
  });
}

/* ---------- status, clocks, strip ---------- */
function setStage(stage) { I.stage = stage; updateStatus(); updateControls(); }

function updateStatus() {
  if (!I) return;
  const dot = $('#status-dot'), txt = $('#status-text');
  if (!dot) return;
  let cls = 'idle', label = '';
  if (I.paused) { cls = 'idle'; label = 'Paused'; }
  else if (I.stage === 'thinking') { cls = 'thinking'; label = 'Thinking…'; }
  else if (I.speaking) { cls = 'speaking'; label = 'Speaking'; }
  else if (I.stage === 'answering') { cls = 'listening'; label = I.voiceMode && I.micOn ? 'Listening to you' : 'Your turn'; }
  else if (I.stage === 'error') { cls = 'idle'; label = 'Waiting for you'; }
  else if (I.stage === 'done') { cls = 'idle'; label = 'Interview finished'; }
  dot.className = 'dot ' + cls;
  txt.textContent = label;
  const mic = $('#mic-state');
  if (mic) mic.textContent = I.voiceMode ? (I.micOn ? '● mic on' : '○ mic off') : '';
}

function updateControls() {
  const answering = I.stage === 'answering';
  const ta = $('#iv-answer');
  if (!ta) return;
  ta.disabled = !answering && !(I.stage === 'speaking');
  $('#btn-done').disabled = !(answering || I.stage === 'speaking') || I.paused;
  $('#btn-skip').disabled = !(answering || I.stage === 'speaking') || I.paused;
}

function tick() {
  if (!I || I.done) return;
  const eng = I.eng;
  $('#clock-total').textContent = fmtClock(eng.elapsedSec());
  $('#clock-phase').textContent = fmtClock(eng.phaseElapsedSec());
  $('#clock-phase-name').textContent = eng.phase.label;
  $('#clock-phase-budget').textContent = '/ ' + fmtClock(eng.phase.budgetMin * 60);
  $('#clock-total').classList.toggle('over', eng.elapsedSec() > S.length * 60);
  $('#clock-phase').classList.toggle('over', eng.overBudget());
  updateStrip();
  if (I.answer && I.answer.startAt && I.stage === 'answering') $('#answer-timer').textContent = fmtClock((Date.now() - I.answer.startAt) / 1000);
}
function updateStrip() {
  const eng = I.eng;
  $$('#phase-strip .pseg').forEach(seg => {
    const i = Number(seg.dataset.i), ph = eng.phases[i];
    const used = i < eng.idx ? ph.usedSec : i === eng.idx ? eng.phaseElapsedSec() : 0;
    const pct = Math.min(100, (used / (ph.budgetMin * 60)) * 100);
    seg.classList.toggle('current', i === eng.idx);
    seg.classList.toggle('past', i < eng.idx);
    seg.classList.toggle('over', used > ph.budgetMin * 60);
    $('.fill', seg).style.width = pct + '%';
    $('.ptime', seg).textContent = fmtClock(i === eng.idx || i < eng.idx ? used : ph.budgetMin * 60);
  });
}

/* ---------- transcript DOM ---------- */
function appendTurn(t) {
  const box = $('#iv-transcript');
  const wrap = document.createElement('div');
  wrap.innerHTML = turnHTML(t);
  const el = wrap.firstElementChild;
  box.appendChild(el);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return el;
}
function addDivider(label, before) {
  const d = document.createElement('div');
  d.className = 'phase-divider'; d.innerHTML = `<span>${esc(label)}</span>`;
  if (before) before.before(d); else $('#iv-transcript').appendChild(d);
}
function showBanner(html) {
  const b = $('#iv-banner'); b.innerHTML = html; b.hidden = false;
}
function clearBanner() { const b = $('#iv-banner'); if (b) { b.hidden = true; b.innerHTML = ''; } }

/* ---------- interviewer turn ---------- */
function mockMeta() {
  const eng = I.eng;
  return {
    phaseId: eng.phase.id, nextPhaseId: eng.nextPhase && eng.nextPhase.id, turnsInPhase: eng.turnsInPhase,
    name: I.pack.persona.name, casePrompt: I.pack.caseObj && I.pack.caseObj.prompt,
    behavQuestion: I.pack.behavQs[0] && I.pack.behavQs[0].question,
  };
}

async function interviewerTurn() {
  const seq = ++I.turnSeq;
  clearBanner();
  setStage('thinking');
  I.speaker.cancel();
  I.speaker.warned = false;

  // Placeholder bubble that fills in as the stream arrives.
  const phaseBefore = I.eng.phase.id;
  const el = appendTurn({ role: 'interviewer', name: I.pack.persona.name, text: '…', t: I.eng.elapsedSec(), phase: phaseBefore });
  const txt = $('.txt', el);
  el.classList.add('streaming');
  let shown = 0;
  I.abort = new AbortController();
  const ctx = {
    apiKey: getKey(KEY_ANTHROPIC), mock: MOCK, signal: I.abort.signal, meta: MOCK ? mockMeta() : null,
    onText: (_d, full) => {
      if (seq !== I.turnSeq) return;
      const safe = streamSafe(full);
      if (safe.length > shown) {
        I.speaker.feed(safe.slice(shown));
        shown = safe.length;
        txt.textContent = safe;
        el.scrollIntoView({ block: 'nearest' });
      }
    },
    onRetry: () => { I.speaker.cancel(); shown = 0; txt.textContent = '…'; },
  };

  let result;
  try {
    result = await runInterviewer(ctx, I.system, I.messages);
  } catch (e) {
    if (seq !== I.turnSeq) return;
    el.remove();
    if (e && e.name === 'AbortError') return;
    I.speaker.cancel();
    setStage('error');
    const msg = e instanceof LLMError ? e.message : 'Something went wrong: ' + (e && e.message ? e.message : e);
    showBanner(`<div class="banner err"><b>The interviewer could not respond.</b> ${esc(msg)} <button type="button" class="btn small" data-retry="turn">Retry</button></div>`);
    return;
  }
  if (seq !== I.turnSeq) return;
  el.classList.remove('streaming');

  if (result.stopReason === 'refusal') {
    el.remove(); I.speaker.cancel(); setStage('error');
    showBanner(`<div class="banner err"><b>The model declined to answer that turn.</b> This can happen with sensitive case topics. <button type="button" class="btn small" data-retry="turn">Retry</button> <button type="button" class="btn small ghost" data-retry="skip-refusal">Move on</button></div>`);
    return;
  }
  if (!result.text.trim()) {
    el.remove(); setStage('error');
    showBanner(`<div class="banner err"><b>Empty response.</b> <button type="button" class="btn small" data-retry="turn">Retry</button></div>`);
    return;
  }
  if (result.stopReason === 'max_tokens') toast('The interviewer’s reply was cut off at the length limit.');

  // The raw reply (with any control tokens) goes into history unchanged so the prefix stays stable.
  I.messages.push({ role: 'assistant', content: result.text });
  const res = I.eng.applyReply(result.text);
  txt.textContent = res.text;
  if (!shown) I.speaker.feed(res.text);
  I.speaker.flush();

  const entry = { role: 'interviewer', name: I.pack.persona.name, phase: res.phase.id, text: res.text, t: I.eng.elapsedSec() };
  I.transcript.push(entry);
  if (res.advanced) addDivider(res.phase.label, el);
  else if (I.transcript.length === 1) addDivider(res.phase.label, el);

  // Real interviewers paste the case into chat when it starts.
  if (res.advanced && res.phase.id === 'case' && I.pack.caseObj) {
    const cp = { kind: 'case_prompt', role: 'system', phase: 'case', text: I.pack.caseObj.prompt, t: I.eng.elapsedSec() };
    I.transcript.push(cp);
    appendTurn(cp);
  }

  if (res.ended) {
    setStage('speaking');
    await I.speaker.whenIdle();
    if (seq !== I.turnSeq || I.done) return;
    finishInterview(false);
    return;
  }

  setStage('speaking');
  beginAnswering(seq);
  await I.speaker.whenIdle();
  if (seq !== I.turnSeq || I.done) return;
  // Voice finished: this is the real start of the candidate's thinking time.
  if (I.answer) I.answer.questionEndAt = Date.now();
  if (I.stage === 'speaking') setStage('answering');
  startMic();
}

function skipRefusedTurn() {
  clearBanner();
  const line = "Let's move on.";
  I.messages.push({ role: 'assistant', content: line });
  I.eng.applyReply(line);
  const entry = { role: 'interviewer', name: I.pack.persona.name, phase: I.eng.phase.id, text: line, t: I.eng.elapsedSec() };
  I.transcript.push(entry);
  appendTurn(entry);
  beginAnswering(I.turnSeq);
  setStage('answering');
  startMic();
}

/* ---------- answering ---------- */
function beginAnswering() {
  I.answer = { questionEndAt: Date.now(), startAt: null, committed: '', interim: '' };
  const ta = $('#iv-answer');
  ta.value = '';
  $('#answer-timer').textContent = '';
  updateControls();
  ta.disabled = false;
  if (!I.voiceMode) ta.focus();
}
function startMic() {
  if (!I || !I.voiceMode || I.paused || I.stage !== 'answering') return;
  if (!I.listener.start(S.sttLang)) { I.voiceMode = false; toast('Speech recognition is not available here. Please type your answer.'); }
}
function markAnswerStarted() {
  if (I.answer && !I.answer.startAt) I.answer.startAt = Date.now();
}
function onSpeechResult(fin, interim) {
  if (!I || !I.answer || I.stage !== 'answering') return;
  const a = I.answer;
  if (fin.trim() || interim.trim()) markAnswerStarted();
  if (fin) a.committed = (a.committed + (a.committed && !/\s$/.test(a.committed) ? ' ' : '') + fin.trim()).trim() + ' ';
  a.interim = interim;
  const ta = $('#iv-answer');
  ta.value = a.committed + a.interim;
  ta.scrollTop = ta.scrollHeight;
}

function submitAnswer({ skipped }) {
  if (!I || I.done || I.paused || (I.stage !== 'answering' && I.stage !== 'speaking')) return;
  const ta = $('#iv-answer');
  const text = skipped ? '(skipped)' : ta.value.trim();
  if (!skipped && !text) { toast('Say or type your answer first, or use Skip question.'); return; }
  if (!skipped && text.toLowerCase() === '/pause') { ta.value = ''; togglePause(); return; }

  I.turnSeq++;                    // invalidates any pending speech-idle continuation
  I.listener.stop();
  I.speaker.cancel();
  if (I.abort) I.abort.abort();
  const a = I.answer || { questionEndAt: Date.now(), startAt: null };
  const now = Date.now();
  const startAt = a.startAt || now;
  const metrics = answerMetrics({
    text: skipped ? '' : text,
    durationSec: skipped ? 0 : (now - startAt) / 1000,
    ttfwSec: skipped || !a.startAt ? null : Math.max(0, (a.startAt - a.questionEndAt) / 1000),
    mode: I.voiceMode ? 'voice' : 'text',
  });
  const phase = I.eng.phase.id;
  I.messages.push({ role: 'user', content: I.eng.buildUserMessage({ text, words: metrics.words, durationSec: metrics.durationSec, skipped }) });
  const entry = { role: 'candidate', phase, text, t: I.eng.elapsedSec(), metrics, skipped };
  I.transcript.push(entry);
  I.answers.push({ phase, metrics, skipped });
  appendTurn(entry);
  I.answer = null;
  ta.value = '';
  interviewerTurn();
}

function togglePause() {
  if (!I || I.done) return;
  I.paused = !I.paused;
  $('#pause-overlay').hidden = !I.paused;
  $('#btn-pause').textContent = I.paused ? 'Resume' : 'Pause';
  if (I.paused) { I.eng.pause(); I.speaker.pause(); I.listener.stop(); }
  else { I.eng.resume(); I.speaker.resume(); startMic(); }
  updateStatus(); updateControls();
}

function endEarly() {
  if (!I || I.done) return;
  if (!confirm('End the interview now and get feedback on what you have done so far?')) return;
  I.turnSeq++;
  if (I.abort) I.abort.abort();
  I.listener.stop(); I.speaker.cancel();
  if (!I.answers.length) {
    teardownInterview();
    toast('Nothing to grade yet — you had not answered anything.');
    showView('setup');
    return;
  }
  finishInterview(true);
}

function teardownInterview() {
  if (!I) return;
  I.done = true;
  clearInterval(I.timer);
  I.listener.stop(); I.speaker.cancel();
  document.body.classList.remove('in-interview');
}

/* ============================== Report / feedback ============================== */
let currentRec = null;

function finishInterview(endedEarly) {
  I.eng.finish();
  teardownInterview();
  setStage('done');
  const metrics = sessionMetrics({ answers: I.answers, phases: I.eng.phases, totalSec: I.eng.elapsedSec() });
  const phaseLabels = {};
  I.eng.phases.forEach(p => { phaseLabels[p.id] = p.label; });
  currentRec = {
    id: uid(), ts: Date.now(), mock: MOCK, endedEarly,
    roundLabel: I.pack.roundLabel, lengthMin: S.length, level: S.level, style: S.style, personaName: I.pack.persona.name,
    caseId: I.pack.caseObj && I.pack.caseObj.id, caseTitle: I.pack.caseObj && I.pack.caseObj.title,
    behavQIds: I.pack.behavQs.map(q => q.id),
    transcript: I.transcript, metrics, phaseLabels, report: null, rawFeedback: '', score: null, verdict: null,
  };
  saveRecord(currentRec);
  showView('report');
  generateFeedback();
}

function normalizeReport(r) {
  const arrKeys = ['strengths', 'improvements', 'sections', 'caseRubric', 'caseStageGap', 'behavioural'];
  arrKeys.forEach(k => { if (!Array.isArray(r[k])) r[k] = []; });
  r.overall = r.overall || { verdict: 'Unrated', score: 0, headline: '', summary: '' };
  r.behavioural = r.behavioural.map(b => Object.assign({ star: { situation: 'missing', task: 'missing', action: 'missing', result: 'missing' } }, b));
  r.nextPractice = r.nextPractice || { caseIds: [], questionIds: [], drills: [] };
  ['caseIds', 'questionIds', 'drills'].forEach(k => { if (!Array.isArray(r.nextPractice[k])) r.nextPractice[k] = []; });
  r.communication = r.communication || { observations: [], fillerVerdict: '', pacingVerdict: '' };
  if (!Array.isArray(r.communication.observations)) r.communication.observations = [];
  return r;
}
function parseFeedback(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  if (!obj || typeof obj !== 'object' || !obj.overall) throw new Error('Missing "overall" in feedback JSON');
  return normalizeReport(obj);
}

async function generateFeedback() {
  const view = $('#view-report');
  view.innerHTML = `<div class="card feedback-wait"><div class="spinner" aria-hidden="true"></div>
    <div><b>Writing your feedback…</b><div class="note" id="fb-progress">Opus is reading the transcript against the rubric. This can take a minute or two.</div></div>
    <button type="button" class="btn small ghost" data-fb="cancel">Cancel</button></div>`;
  const rec = currentRec;
  const { system, user } = buildFeedbackRequest({ pack: I.pack, transcript: rec.transcript, metrics: rec.metrics, endedEarly: rec.endedEarly });
  const firstAns = rec.transcript.find(t => t.role === 'candidate' && !t.skipped);
  const fw = I.pack.framework;
  const meta = {
    firstQuote: firstAns ? firstAns.text.split(/\s+/).slice(0, 14).join(' ') : '',
    rubric: fw ? fw.rubric : [], stages: fw ? fw.stages : [], behavQs: I.pack.behavQs.filter(q => rec.transcript.some(t => t.phase === 'behavioural')),
    hasCase: rec.transcript.some(t => t.phase === 'case' && t.role === 'candidate'),
    phasesRun: [...new Set(rec.transcript.map(t => t.phase))], storyIds: D.stories.slice(0, 3).map(s => s.id),
    practiceCaseIds: D.cases.filter(c => c.id !== rec.caseId).slice(0, 2).map(c => c.id), practiceQuestionIds: D.behav.questions.slice(0, 2).map(q => q.id),
  };
  const ac = new AbortController();
  I.fbAbort = ac;
  let chars = 0;
  try {
    const result = await runFeedback({
      apiKey: getKey(KEY_ANTHROPIC), mock: MOCK, signal: ac.signal, meta,
      onText: (d) => { chars += d.length; const p = $('#fb-progress'); if (p) p.textContent = `Receiving report… ${chars.toLocaleString()} characters`; },
      onRetry: () => { chars = 0; },
    }, system, user);
    if (result.stopReason === 'refusal') return feedbackFailed('The model declined to grade this transcript (a safety refusal). You can retry, or export the transcript below.', '');
    let report;
    try { report = parseFeedback(result.text); } catch (e) {
      const why = result.stopReason === 'max_tokens' ? 'The report hit the length limit before finishing.' : 'The report was not valid JSON.';
      return feedbackFailed(why + ' (' + e.message + ')', result.text);
    }
    rec.report = report; rec.score = report.overall.score; rec.verdict = report.overall.verdict; rec.rawFeedback = '';
    saveRecord(rec);
    showReport(rec);
  } catch (e) {
    if (e && e.name === 'AbortError') { showReport(rec); return; }
    feedbackFailed(e instanceof LLMError ? e.message : 'Something went wrong: ' + (e && e.message ? e.message : e), '');
  }
}

function feedbackFailed(message, raw) {
  const rec = currentRec;
  $('#view-report').innerHTML = `<div class="banner err"><b>Feedback did not complete.</b> ${esc(message)}
    <div class="btn-row"><button type="button" class="btn small" data-fb="retry">Retry feedback</button><button type="button" class="btn small ghost" data-fb="skip">Skip, show transcript</button></div></div>
    ${raw ? `<details open><summary>Raw model output</summary><pre class="raw">${esc(raw)}</pre></details>` : ''}`;
  rec.rawFeedback = raw;
}

function reportToolbar(rec) {
  return `<div class="toolbar">
    <button type="button" class="btn small" data-rep="new">New interview</button>
    <button type="button" class="btn small ghost" data-rep="copy">Copy Markdown</button>
    <button type="button" class="btn small ghost" data-rep="md">Download .md</button>
    <button type="button" class="btn small ghost" data-rep="json">Download .json</button>
    <button type="button" class="btn small ghost" data-rep="history">History</button>
    ${!rec.report && I && I.pack && currentRec && currentRec.id === rec.id ? '<button type="button" class="btn small" data-fb="retry">Retry feedback</button>' : ''}</div>`;
}
function showReport(rec) {
  currentRec = rec;
  const view = $('#view-report');
  view.innerHTML = reportToolbar(rec) + renderReport(rec);
  showView('report');
}

function wireReport() {
  $('#view-report').addEventListener('click', async e => {
    const fb = e.target.closest('[data-fb]');
    if (fb) {
      if (fb.dataset.fb === 'retry') generateFeedback();
      else if (fb.dataset.fb === 'skip') showReport(currentRec);
      else if (fb.dataset.fb === 'cancel') { if (I && I.fbAbort) I.fbAbort.abort(); }
      return;
    }
    const rep = e.target.closest('[data-rep]');
    if (!rep) return;
    const k = rep.dataset.rep;
    if (k === 'new') { showView('setup'); }
    else if (k === 'history') openHistory();
    else if (k === 'copy') {
      try { await navigator.clipboard.writeText(toMarkdown(currentRec)); toast('Markdown copied.'); } catch (err) { toast('Could not copy — use Download .md instead.'); }
    } else if (k === 'md') download(`mock-interview-${new Date(currentRec.ts).toISOString().slice(0, 10)}.md`, toMarkdown(currentRec), 'text/markdown');
    else if (k === 'json') download(`mock-interview-${new Date(currentRec.ts).toISOString().slice(0, 10)}.json`, toJSON(currentRec), 'application/json');
  });
}

/* ============================== History ============================== */
function openHistory() {
  $('#view-history').innerHTML = `<div class="sec-head"><h2>History</h2><span class="hint">Saved only in this browser</span></div>${renderHistory(loadHistory())}`;
  showView('history');
}
function wireHistory() {
  $('#view-history').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'open-report') {
      const rec = loadHistory().find(r => r.id === id);
      if (rec) showReport(rec);
    } else if (b.dataset.act === 'delete-report') {
      if (confirm('Delete this saved interview?')) { deleteRecord(id); openHistory(); }
    }
  });
}

/* ============================== Theme + boot ============================== */
function wireTheme() {
  const saved = lsGet(LS_THEME, null);
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    lsSet(LS_THEME, next);
  });
}

async function boot() {
  wireTheme();
  $('#tab-nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    if (I && !I.done && document.body.classList.contains('in-interview')) { toast('Finish or end the interview first.'); return; }
    if (b.dataset.view === 'history') openHistory(); else showView('setup');
  });
  const root = $('#view-setup');
  root.innerHTML = '<div class="empty">Loading Case Lab data…</div>';
  try {
    await loadAll();
  } catch (e) {
    root.innerHTML = `<div class="banner err"><b>Could not load Case Lab data.</b> ${esc(e.message)}<br>Serve the site over http (for example <code>python3 -m http.server</code> from the repo root); opening the file directly will not work.</div>`;
    return;
  }
  const deep = params.get('case');
  if (deep && caseById(deep)) { S.caseMode = 'pick'; S.casePick = deep; if (!ROUNDS[S.round].phases.includes('case')) S.round = 'case'; }
  voiceList = await loadVoices();
  wireSetup(); wireInterview(); wireReport(); wireHistory();
  renderSetup();
  // Voices can arrive late in some browsers.
  if (ttsSupported()) speechSynthesis.addEventListener('voiceschanged', async () => { voiceList = await loadVoices(); if (!$('#view-setup').hidden && $('#voice-list')) $('#voice-list').innerHTML = voiceOptions(); });
  window.addEventListener('beforeunload', e => { if (I && !I.done && document.body.classList.contains('in-interview')) { e.preventDefault(); e.returnValue = ''; } });
}
boot();
