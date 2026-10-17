/* Mock interview — report rendering, Markdown/JSON export, history store.
   All model-written strings go through esc() before touching innerHTML. */

import { D, themeLabel } from './data.js';
import { fmtClock } from './metrics.js';

export const LS_HISTORY = 'mi_history_v1';
const HISTORY_CAP = 40;

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================== History store ============================== */
export function loadHistory() {
  try { const v = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function writeHistory(list) {
  // On quota errors drop the transcripts of the oldest records first, then the oldest records.
  for (let attempt = 0; attempt < 4; attempt++) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(list)); return true; } catch (e) {
      const heavy = list.slice().reverse().find(r => r.transcript && r.transcript.length);
      if (heavy) { heavy.transcript = []; heavy.transcriptDropped = true; } else list.pop();
    }
  }
  return false;
}
export function saveRecord(rec) {
  const list = loadHistory().filter(r => r.id !== rec.id);
  list.unshift(rec);
  writeHistory(list.slice(0, HISTORY_CAP));
}
export function deleteRecord(id) { writeHistory(loadHistory().filter(r => r.id !== id)); }
export function clearHistory() { try { localStorage.removeItem(LS_HISTORY); } catch (e) { /* ignore */ } }

/* Themes of recently asked behavioural questions (newest first), for auto-pick weighting. */
export function recentThemes(limit = 6) {
  const out = [];
  loadHistory().slice(0, limit).forEach(r => (r.behavQIds || []).forEach(id => {
    const q = D.behav.questions.find(x => x.id === id);
    if (q) out.push(q.theme);
  }));
  return out;
}

/* ============================== Small render helpers ============================== */
function verdictClass(v) {
  if (/Strong Hire|^Hire$/.test(v)) return 'v-good';
  if (/Lean Hire/.test(v)) return 'v-ok';
  if (/Lean No/.test(v)) return 'v-warn';
  return 'v-bad';
}
const list = (items) => (items && items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="note">None noted.</p>');
const quote = (q) => (q ? `<blockquote>“${esc(q)}”</blockquote>` : '');
const caseTitle = (id) => { const c = D.cases.find(x => x.id === id); return c ? c.title : id; };
const storyTitle = (id) => { const s = D.stories.find(x => x.id === id); return s ? s.title : id; };
const questionText = (id) => { const q = D.behav.questions.find(x => x.id === id); return q ? q.question : id; };

export function turnHTML(t) {
  if (t.kind === 'case_prompt') return `<div class="turn turn-case"><div class="who">Case prompt (shared in chat)</div><div class="txt">${esc(t.text)}</div></div>`;
  const who = t.role === 'interviewer' ? esc(t.name || 'Interviewer') : 'You';
  const meta = t.role === 'candidate' && t.metrics && !t.skipped
    ? `<span class="tmeta">${t.metrics.words} words · ${t.metrics.durationSec}s${t.metrics.wpm ? ` · ${t.metrics.wpm} wpm` : ''}${t.metrics.fillers ? ` · ${t.metrics.fillers} fillers` : ''}</span>` : '';
  return `<div class="turn turn-${t.role}${t.skipped ? ' skipped' : ''}"><div class="who">${who} <span class="tstamp">${fmtClock(t.t)}</span> ${meta}</div><div class="txt">${esc(t.skipped ? '(skipped)' : t.text)}</div></div>`;
}

export function transcriptHTML(transcript, phaseLabels = {}) {
  let phase = null, out = '';
  (transcript || []).forEach(t => {
    if (t.phase !== phase) { phase = t.phase; out += `<div class="phase-divider"><span>${esc(phaseLabels[phase] || phase)}</span></div>`; }
    out += turnHTML(t);
  });
  return out || '<p class="note">No transcript saved.</p>';
}

function sparkline(points) {
  if (points.length < 2) return '';
  const w = 160, h = 36, pad = 4;
  const xs = i => pad + (i * (w - 2 * pad)) / (points.length - 1);
  const ys = v => h - pad - ((v - 1) / 4) * (h - 2 * pad);
  const d = points.map((v, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Score trend, oldest to newest"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${points.map((v, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(v).toFixed(1)}" r="2.5" fill="currentColor"/>`).join('')}</svg>`;
}

/* ============================== Report ============================== */
function statsHTML(m) {
  if (!m) return '';
  const cell = (n, l) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
  const phaseRows = (m.phases || []).map(p => `<tr><td>${esc(p.label)}</td><td>${p.budgetMin} min</td><td>${p.usedMin} min</td></tr>`).join('');
  return `<div class="stats stats-6">
    ${cell(fmtClock(m.totalSec), 'Total time')}
    ${cell(m.talkRatio + '%', 'Talk ratio')}
    ${cell(m.avgWpm == null ? '—' : m.avgWpm, 'Avg words / min')}
    ${cell(m.fillersPerMin == null ? '—' : m.fillersPerMin, 'Fillers / min')}
    ${cell(m.avgTtfwSec == null ? '—' : m.avgTtfwSec + 's', 'Time to first word')}
    ${cell(m.longestAnswer ? fmtClock(m.longestAnswer.durationSec) : '—', 'Longest answer')}
  </div>
  <div class="table-wrap"><table class="plain"><thead><tr><th>Phase</th><th>Budget</th><th>Used</th></tr></thead><tbody>${phaseRows}</tbody></table></div>
  <p class="note">Computed in your browser from the transcript — not by the model. ${m.answerCount} answers${m.skippedCount ? `, ${m.skippedCount} skipped` : ''}; ${m.fillersTotal} filler words in total.</p>`;
}

export function renderReport(rec) {
  const r = rec.report;
  const head = `<div class="report-head">
    <div><p class="eyebrow">Interview report · ${esc(rec.roundLabel)} · ${esc(rec.level)} · ${esc(new Date(rec.ts).toLocaleString())}</p></div>
    ${rec.mock ? '<span class="pill mock">MOCK DATA — no model was called</span>' : ''}
    ${rec.endedEarly ? '<span class="pill">Ended early</span>' : ''}
  </div>`;
  if (!r) {
    return head + `<div class="card"><h3>No feedback yet</h3><p class="note">The feedback step did not complete. You can retry from the report screen.</p></div>
      <h3 class="sec">Communication stats</h3>${statsHTML(rec.metrics)}
      <h3 class="sec">Transcript</h3><div class="transcript">${transcriptHTML(rec.transcript, rec.phaseLabels)}</div>`;
  }
  const o = r.overall || {};
  const banner = `<div class="verdict-banner ${verdictClass(o.verdict)}">
    <div class="vscore"><span class="n">${esc(o.score)}</span><span class="d">/ 5</span></div>
    <div><div class="vlabel">${esc(o.verdict)}</div><div class="vhead">${esc(o.headline)}</div></div>
  </div><p class="summary">${esc(o.summary)}</p>`;

  const strengths = (r.strengths || []).map(s => `<div class="card good"><h4>${esc(s.title)}</h4>${quote(s.evidenceQuote)}<p>${esc(s.why)}</p></div>`).join('');
  const improvements = (r.improvements || []).map((s, i) => `<div class="card warn"><h4><span class="rank">${i + 1}</span>${esc(s.title)}</h4>${quote(s.evidenceQuote)}<p>${esc(s.why)}</p>
    <p><b>Fix:</b> ${esc(s.howToFix)}</p>${s.exampleRewrite ? `<p class="rewrite"><b>Try saying:</b> ${esc(s.exampleRewrite)}</p>` : ''}</div>`).join('');

  const sections = (r.sections || []).map(s => `<div class="card"><h4>${esc((rec.phaseLabels && rec.phaseLabels[s.phase]) || s.phase)} <span class="pill">${esc(s.score)}/5</span></h4><p class="note">${esc(s.verdict)}</p>
    <div class="two-col"><div><b>Went well</b>${list(s.wentWell)}</div><div><b>To improve</b>${list(s.improve)}</div></div></div>`).join('');

  const rubric = (r.caseRubric || []).length ? `<h3 class="sec">Case rubric</h3><div class="table-wrap"><table class="plain"><thead><tr><th>Dimension</th><th>Rating</th><th>Why</th><th>To reach next level</th></tr></thead><tbody>${
    r.caseRubric.map(x => `<tr><td>${esc(x.dimension)}</td><td><span class="rate rate-${esc(x.rating)}">${esc(x.rating)}</span></td><td>${esc(x.why)}</td><td>${esc(x.toReachNext)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const gaps = (r.caseStageGap || []).length ? `<h3 class="sec">Case stage gaps</h3><div class="table-wrap"><table class="plain"><thead><tr><th>Stage</th><th>You did</th><th>A strong answer would</th><th>Gap</th></tr></thead><tbody>${
    r.caseStageGap.map(x => `<tr><td>${esc(x.stage)}</td><td>${esc(x.youDid)}</td><td>${esc(x.strongAnswerWould)}</td><td><span class="gap gap-${esc(x.gap)}">${esc(x.gap)}</span></td></tr>`).join('')}</tbody></table></div>` : '';

  const starCell = (k, v) => `<span class="star star-${esc(v)}"><b>${k}</b> ${esc(v)}</span>`;
  const behav = (r.behavioural || []).length ? `<h3 class="sec">Behavioural answers</h3>${r.behavioural.map(b => `<div class="card"><h4>${esc(questionText(b.questionId))}</h4>
    <div class="star-row">${starCell('S', b.star.situation)}${starCell('T', b.star.task)}${starCell('A', b.star.action)}${starCell('R', b.star.result)}</div>
    <p>${esc(b.issue)}</p>
    ${b.betterStoryId ? `<p class="note">Better story from your bank: <a href="../" title="Open Case Lab → Stories">${esc(storyTitle(b.betterStoryId))}</a> <code>${esc(b.betterStoryId)}</code></p>` : ''}
    <p class="rewrite"><b>Stronger version:</b> ${esc(b.strongerVersion)}</p></div>`).join('')}` : '';

  const res = r.resume ? `<h3 class="sec">Resume depth</h3><div class="card"><dl class="kv">
    <dt>Ownership clarity</dt><dd>${esc(r.resume.ownershipClarity)}</dd><dt>Metrics rigor</dt><dd>${esc(r.resume.metricsRigor)}</dd>
    <dt>Depth under probing</dt><dd>${esc(r.resume.depthUnderProbing)}</dd></dl><p class="note">${esc(r.resume.notes)}</p></div>` : '';

  const comm = r.communication ? `<div class="card"><b>Observations (model)</b>${list(r.communication.observations)}<p><b>Fillers:</b> ${esc(r.communication.fillerVerdict)}</p><p><b>Pacing:</b> ${esc(r.communication.pacingVerdict)}</p></div>` : '';

  const np = r.nextPractice || {};
  const practice = `<h3 class="sec">Practice next</h3><div class="card">
    ${(np.caseIds || []).length ? `<div class="practice-row"><b>Cases</b>${np.caseIds.map(id => `<a class="btn small ghost" href="./?case=${encodeURIComponent(id)}">${esc(caseTitle(id))}</a><a class="note" href="../?c=${encodeURIComponent(id)}">open in Case Lab</a>`).join('')}</div>` : ''}
    ${(np.questionIds || []).length ? `<div class="practice-row"><b>Questions</b><ul>${np.questionIds.map(id => `<li><span class="note">${esc(themeLabel((D.behav.questions.find(q => q.id === id) || {}).theme || ''))}</span> ${esc(questionText(id))}</li>`).join('')}</ul></div>` : ''}
    ${(np.drills || []).length ? `<div class="practice-row"><b>Drills</b>${list(np.drills)}</div>` : ''}</div>`;

  return head + banner
    + `<h3 class="sec">Top strengths</h3><div class="cards-3">${strengths}</div>`
    + `<h3 class="sec">Top improvements</h3><div class="cards-3">${improvements}</div>`
    + (sections ? `<h3 class="sec">By section</h3><div class="cards-2">${sections}</div>` : '')
    + rubric + gaps + behav + res
    + `<h3 class="sec">Communication</h3>${statsHTML(rec.metrics)}${comm}`
    + practice
    + `<h3 class="sec">Full transcript</h3><div class="transcript">${transcriptHTML(rec.transcript, rec.phaseLabels)}</div>`;
}

/* ============================== Exports ============================== */
export function toMarkdown(rec) {
  const r = rec.report, m = rec.metrics, L = [];
  L.push(`# Mock interview report`);
  L.push(`${rec.roundLabel} · ${rec.level} · ${rec.personaName} · ${new Date(rec.ts).toLocaleString()}${rec.mock ? ' · MOCK DATA' : ''}${rec.endedEarly ? ' · ended early' : ''}`);
  if (rec.caseTitle) L.push(`Case: ${rec.caseTitle}`);
  if (r) {
    const o = r.overall;
    L.push('', `## ${o.verdict} (${o.score}/5)`, `**${o.headline}**`, '', o.summary);
    L.push('', '## Top strengths');
    (r.strengths || []).forEach(s => L.push(`- **${s.title}**${s.evidenceQuote ? ` — “${s.evidenceQuote}”` : ''}. ${s.why}`));
    L.push('', '## Top improvements');
    (r.improvements || []).forEach((s, i) => L.push(`${i + 1}. **${s.title}**${s.evidenceQuote ? ` — “${s.evidenceQuote}”` : ''}. ${s.why}`, `   - Fix: ${s.howToFix}`, `   - Try saying: ${s.exampleRewrite}`));
    if ((r.sections || []).length) {
      L.push('', '## By section');
      r.sections.forEach(s => L.push(`### ${(rec.phaseLabels && rec.phaseLabels[s.phase]) || s.phase} — ${s.score}/5`, s.verdict, '', 'Went well:', ...(s.wentWell || []).map(x => `- ${x}`), 'Improve:', ...(s.improve || []).map(x => `- ${x}`)));
    }
    if ((r.caseRubric || []).length) {
      L.push('', '## Case rubric', '| Dimension | Rating | Why | To reach next |', '|---|---|---|---|');
      r.caseRubric.forEach(x => L.push(`| ${x.dimension} | ${x.rating} | ${x.why} | ${x.toReachNext} |`));
    }
    if ((r.caseStageGap || []).length) {
      L.push('', '## Case stage gaps', '| Stage | You did | Strong answer would | Gap |', '|---|---|---|---|');
      r.caseStageGap.forEach(x => L.push(`| ${x.stage} | ${x.youDid} | ${x.strongAnswerWould} | ${x.gap} |`));
    }
    if ((r.behavioural || []).length) {
      L.push('', '## Behavioural');
      r.behavioural.forEach(b => L.push(`- **${questionText(b.questionId)}** — S:${b.star.situation} T:${b.star.task} A:${b.star.action} R:${b.star.result}. ${b.issue} Stronger: ${b.strongerVersion}${b.betterStoryId ? ` (story: ${storyTitle(b.betterStoryId)})` : ''}`));
    }
    if (r.resume) L.push('', '## Resume', `- Ownership: ${r.resume.ownershipClarity}`, `- Metrics: ${r.resume.metricsRigor}`, `- Depth: ${r.resume.depthUnderProbing}`, `- ${r.resume.notes}`);
    if (r.communication) L.push('', '## Communication (model)', ...(r.communication.observations || []).map(x => `- ${x}`), `- Fillers: ${r.communication.fillerVerdict}`, `- Pacing: ${r.communication.pacingVerdict}`);
    const np = r.nextPractice || {};
    L.push('', '## Practice next', ...(np.caseIds || []).map(id => `- Case: ${caseTitle(id)} (${id})`), ...(np.questionIds || []).map(id => `- Question: ${questionText(id)} (${id})`), ...(np.drills || []).map(d => `- Drill: ${d}`));
  }
  if (m) L.push('', '## Communication stats (client-computed)', `- Total ${fmtClock(m.totalSec)}, talk ratio ${m.talkRatio}%, avg ${m.avgWpm == null ? 'n/a' : m.avgWpm} wpm, ${m.fillersPerMin == null ? 'n/a' : m.fillersPerMin} fillers/min, time to first word ${m.avgTtfwSec == null ? 'n/a' : m.avgTtfwSec + 's'}`);
  L.push('', '## Transcript');
  let phase = null;
  (rec.transcript || []).forEach(t => {
    if (t.phase !== phase) { phase = t.phase; L.push('', `### ${(rec.phaseLabels && rec.phaseLabels[phase]) || phase}`); }
    if (t.kind === 'case_prompt') L.push(`> Case prompt: ${t.text}`);
    else L.push(`**${t.role === 'interviewer' ? (t.name || 'Interviewer') : 'You'}** [${fmtClock(t.t)}]: ${t.skipped ? '(skipped)' : t.text}`);
  });
  return L.join('\n');
}

export function toJSON(rec) { return JSON.stringify(rec, null, 2); }

export function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================== History list ============================== */
export function renderHistory(records) {
  if (!records.length) return '<div class="empty">No interviews yet. Finish one and it will show up here, saved only on this device.</div>';
  const scored = records.filter(r => r.score).slice(0, 12).reverse();
  const trend = scored.length > 1
    ? `<div class="card trend"><div><b>Score trend</b><div class="note">Last ${scored.length} graded sessions, oldest to newest</div></div>${sparkline(scored.map(r => r.score))}</div>` : '';
  return trend + `<div class="history-list">${records.map(r => `<div class="card hist" data-id="${esc(r.id)}">
    <div class="hist-main">
      <div class="hist-title">${esc(r.roundLabel)} · ${esc(r.level)}${r.caseTitle ? ` · ${esc(r.caseTitle)}` : ''}${r.mock ? ' <span class="pill mock">mock</span>' : ''}</div>
      <div class="note">${esc(new Date(r.ts).toLocaleString())} · ${esc(r.personaName)} · ${fmtClock((r.metrics && r.metrics.totalSec) || 0)}</div>
    </div>
    <div class="hist-score">${r.verdict ? `<span class="pill ${verdictClass(r.verdict)}">${esc(r.verdict)} · ${esc(r.score)}/5</span>` : '<span class="pill">no feedback</span>'}</div>
    <div class="hist-actions"><button class="btn small" data-act="open-report" data-id="${esc(r.id)}">Open</button><button class="btn small ghost" data-act="delete-report" data-id="${esc(r.id)}">Delete</button></div>
  </div>`).join('')}</div>`;
}
