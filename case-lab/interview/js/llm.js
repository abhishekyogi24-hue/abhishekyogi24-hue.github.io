/* Mock interview — LLM transports.
   Real: raw fetch to the Messages API (SSE stream) with the user's own key.
   Mock (?mock=1): deterministic canned interviewer lines + a canned schema-valid report. */

import { FEEDBACK_SCHEMA } from './prompts.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const MODEL_INTERVIEWER = 'claude-sonnet-5-5';
export const MODEL_FEEDBACK = 'claude-opus-5-5';

export class LLMError extends Error {
  constructor(message, { kind = 'error', status = 0, retriable = false } = {}) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;       // auth | rate_limit | overloaded | bad_request | network | server | error
    this.status = status;
    this.retriable = retriable;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/* ============================== SSE parsing ============================== */
/* feed(chunk) accepts arbitrary text slices; calls onEvent({event, data}) per complete SSE event. */
export function createSSEParser(onEvent) {
  let buf = '';
  const flushBlock = (block) => {
    let event = 'message', data = [];
    block.split('\n').forEach(line => {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    });
    if (!data.length) return;
    let parsed = null;
    try { parsed = JSON.parse(data.join('\n')); } catch (e) { return; }
    onEvent({ event: event || (parsed && parsed.type), data: parsed });
  };
  return {
    feed(chunk) {
      buf += chunk.replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        flushBlock(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    },
    end() { if (buf.trim()) flushBlock(buf); buf = ''; },
  };
}

/* Turns stream events into text + stop_reason. Only text blocks feed onText (thinking is ignored). */
export function createStreamState(onText) {
  const blockTypes = {};
  const st = { text: '', stopReason: null, usage: null, error: null };
  st.handle = ({ event, data }) => {
    const type = (data && data.type) || event;
    if (type === 'message_start') { st.usage = data.message && data.message.usage; }
    else if (type === 'content_block_start') { blockTypes[data.index] = data.content_block && data.content_block.type; }
    else if (type === 'content_block_delta') {
      const isText = blockTypes[data.index] === 'text' || (data.delta && data.delta.type === 'text_delta');
      if (isText && data.delta && data.delta.type === 'text_delta' && blockTypes[data.index] !== 'thinking') {
        st.text += data.delta.text;
        if (onText) onText(data.delta.text, st.text);
      }
    } else if (type === 'message_delta') {
      if (data.delta && data.delta.stop_reason) st.stopReason = data.delta.stop_reason;
      if (data.usage) st.usage = Object.assign({}, st.usage, data.usage);
    } else if (type === 'error') {
      st.error = data.error || { type: 'error', message: 'Stream error' };
    }
  };
  return st;
}

function httpError(status, bodyText) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j.error && j.error.message) || ''; } catch (e) { detail = (bodyText || '').slice(0, 200); }
  if (status === 401) return new LLMError('The API key was rejected (401). Check it in Setup and try again.', { kind: 'auth', status });
  if (status === 403) return new LLMError('That key is not allowed to use this model (403). ' + detail, { kind: 'auth', status });
  if (status === 429) return new LLMError('Rate limited (429). Wait a moment and retry. ' + detail, { kind: 'rate_limit', status, retriable: true });
  if (status === 529) return new LLMError('The API is overloaded (529). Retry in a few seconds.', { kind: 'overloaded', status, retriable: true });
  if (status >= 500) return new LLMError(`Server error (${status}). ${detail}`, { kind: 'server', status, retriable: true });
  return new LLMError(`Request rejected (${status}). ${detail}`, { kind: 'bad_request', status });
}

/* One streaming request with a single automatic retry on 429 / 5xx / overloaded / network blips.
   onText(delta, full) fires for text deltas; onRetry() lets the UI discard partial text. */
export async function streamMessages(body, { apiKey, signal, onText, onRetry }) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) { if (onRetry) onRetry(); await sleep(1500 + Math.random() * 500, signal); }
    const state = createStreamState(onText);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw httpError(res.status, await res.text());
      const parser = createSSEParser(state.handle);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(dec.decode(value, { stream: true }));
      }
      parser.end();
      if (state.error) {
        const t = state.error.type || '';
        const retriable = t === 'overloaded_error' || t === 'api_error' || t === 'rate_limit_error';
        throw new LLMError(`The API reported an error: ${state.error.message || t}`, { kind: t === 'overloaded_error' ? 'overloaded' : 'server', retriable });
      }
      return { text: state.text, stopReason: state.stopReason, usage: state.usage };
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lastErr = e instanceof LLMError ? e : new LLMError('Network error: could not reach api.anthropic.com. ' + (e && e.message ? e.message : ''), { kind: 'network', retriable: true });
      if (!lastErr.retriable || attempt === 1) throw lastErr;
    }
  }
  throw lastErr;
}

/* ============================== Real calls ============================== */
export function interviewerBody(system, messages) {
  return {
    model: MODEL_INTERVIEWER,
    max_tokens: 600,
    stream: true,
    thinking: { type: 'between_tools' },
    output_config: { effort: 'low' },
    fallbacks: 'default',
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
}

export function feedbackBody(system, userText) {
  return {
    model: MODEL_FEEDBACK,
    max_tokens: 32000,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: FEEDBACK_SCHEMA } },
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: userText }],
  };
}

/* ctx = { apiKey, mock, signal, onText, onRetry, meta (mock only) } */
export function runInterviewer(ctx, system, messages) {
  if (ctx.mock) return mockInterviewer(ctx.meta || {}, ctx);
  return streamMessages(interviewerBody(system, messages), ctx);
}
export function runFeedback(ctx, system, userText) {
  if (ctx.mock) return mockFeedbackStream(ctx.meta || {}, ctx);
  return streamMessages(feedbackBody(system, userText), ctx);
}

/* ============================== Mock transport ============================== */
const OPENERS = {
  intro: 'Thanks, nice to meet you properly. To start, could you walk me through your background and what brought you into product?',
  resume: "Thanks for that. Let's go deeper on your resume. Pick the project you are proudest of: what was your specific role, and what was the headline result?",
  behavioural: 'Let me switch to a few behavioural questions. {BQ}',
  case: "Alright, now a product case. {CASE} Before you start, is anything unclear?",
  candidate_qs: 'That is what I had on my side. What questions do you have for me about the role or the team?',
  close: 'Okay, that covers everything from my side. Thanks for your time today. Is there anything you would like to add before we wrap up?',
};
const FOLLOW = {
  opening: [],
  intro: ['Mm-hm. What was the hardest part of that transition for you?'],
  resume: ['Got it. And what was your own contribution versus the team\'s there?', 'Okay. How did you measure that number, and what did you give up to get it?'],
  behavioural: ['Understood. What was the concrete result, and how did you measure it?', 'Okay. What would you do differently if you faced it again?'],
  case: ['Okay. Who is the primary user you would focus on, and why them?', 'Hm. What metric would tell you this is working, and what would be the counter-metric?', 'Got it. We have about five minutes left. What would you ship first?'],
  candidate_qs: ['Good question. We are growing the team this year and the roadmap leans toward retention. Anything else?'],
  close: [],
};

const delay = (ms, signal) => sleep(ms, signal);

async function streamChars(text, { signal, onText, perChar = 6 }) {
  let full = '';
  for (let i = 0; i < text.length; i += 3) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const piece = text.slice(i, i + 3);
    full += piece;
    if (onText) onText(piece, full);
    await delay(perChar * 3, signal);
  }
  return full;
}

export function mockInterviewerLine(meta) {
  const phase = meta.phaseId || 'opening';
  const turns = meta.turnsInPhase || 0;
  const name = meta.name || 'your interviewer';
  if (phase === 'close') return 'Thanks again. The team will be in touch about next steps. Take care. [[END]]';
  if (phase === 'opening' && turns === 0) return `Hi, I'm ${name}. Thanks for making the time. Today we will cover your background, a few deeper questions, and a case, and I will leave time for yours at the end. Ready to get started?`;
  const transitionAt = phase === 'opening' ? 1 : 2;
  if (turns >= transitionAt && meta.nextPhaseId) {
    const opener = (OPENERS[meta.nextPhaseId] || 'Let us continue.')
      .replace('{BQ}', meta.behavQuestion || 'Tell me about a time you made a hard call with incomplete data.')
      .replace('{CASE}', meta.casePrompt || 'Imagine you own a consumer app whose retention has dropped. How would you approach it?');
    return `Okay. ${opener} [[NEXT]]`;
  }
  const list = FOLLOW[phase] || ['Okay, tell me more.'];
  return list[Math.max(0, turns - 1) % list.length] || 'Okay, tell me more.';
}

export async function mockInterviewer(meta, ctx) {
  const text = await streamChars(mockInterviewerLine(meta), ctx);
  return { text, stopReason: 'end_turn', usage: null };
}

/* Canned, schema-valid report built from the real pack so rubric names and ids line up. */
export function buildMockFeedback(meta) {
  const quote = meta.firstQuote || '';
  const rubric = (meta.rubric || []).map(r => r.dimension);
  const stages = (meta.stages || []).map(s => s.name || s);
  const bq = meta.behavQs || [];
  const phases = meta.phasesRun || ['intro'];
  const rating = ['solid', 'weak', 'solid', 'strong'];
  return {
    overall: {
      verdict: 'Lean Hire', score: 3,
      headline: '[MOCK] Solid structure and ownership, but thin quantification under pressure.',
      summary: '[MOCK DATA — no model was called.] The candidate communicated clearly and showed ownership, but answers were light on numbers and the case lacked an explicit prioritisation step. With sharper metrics and tighter trade-offs this moves to a Hire at the selected level.',
    },
    strengths: [1, 2, 3].map(i => ({ title: `Mock strength ${i}`, evidenceQuote: quote, why: 'Canned example of why this stood out to the committee.' })),
    improvements: [1, 2, 3].map(i => ({ title: `Mock improvement ${i}`, why: 'Canned explanation of the gap.', evidenceQuote: quote, howToFix: 'State the metric and its baseline before describing the action.', exampleRewrite: 'I raised week-4 retention from 18% to 24% by cutting onboarding to three steps.' })),
    sections: phases.filter(p => p !== 'opening' && p !== 'close').map((p, i) => ({ phase: p, score: 3 + (i % 2), verdict: 'Meets the bar with gaps', wentWell: ['Clear opening', 'Direct answers'], improve: ['Quantify impact', 'Name the trade-off'] })),
    caseRubric: meta.hasCase ? rubric.map((d, i) => ({ dimension: d, rating: rating[i % rating.length], why: 'Canned rationale for this rating.', toReachNext: rating[i % rating.length] === 'strong' ? '' : 'Show one explicit trade-off with numbers.' })) : [],
    caseStageGap: meta.hasCase ? stages.map((s, i) => ({ stage: s, youDid: 'Covered at a high level.', strongAnswerWould: 'Make the assumption explicit and tie it to a metric.', gap: ['none', 'minor', 'major'][i % 3] })) : [],
    behavioural: bq.map((q, i) => ({
      questionId: q.id,
      star: { situation: 'solid', task: i % 2 ? 'weak' : 'solid', action: 'solid', result: i % 2 ? 'missing' : 'weak' },
      issue: 'The result was not quantified and the personal action was blended with the team.',
      betterStoryId: (meta.storyIds || [])[i] || null,
      strongerVersion: 'I owned the decision, tested it on 10% of traffic, and it lifted conversion by 4 points.',
    })),
    resume: { ownershipClarity: 'Mock: mostly "I", occasional "we".', metricsRigor: 'Mock: numbers given but not their measurement.', depthUnderProbing: 'Mock: held up for two levels of probing.', notes: 'Canned notes.' },
    communication: { observations: ['Mock: clear signposting.', 'Mock: a few long answers.'], fillerVerdict: 'Mock: filler use is acceptable.', pacingVerdict: 'Mock: pacing is conversational.' },
    nextPractice: { caseIds: (meta.practiceCaseIds || []).slice(0, 2), questionIds: (meta.practiceQuestionIds || []).slice(0, 2), drills: ['Retell one project with baseline, action, and result in 90 seconds.', 'Do two cases out loud with a timer.'] },
  };
}

export async function mockFeedbackStream(meta, ctx) {
  const json = JSON.stringify(buildMockFeedback(meta));
  let full = '';
  for (let i = 0; i < json.length; i += 60) {
    if (ctx.signal && ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const piece = json.slice(i, i + 60);
    full += piece;
    if (ctx.onText) ctx.onText(piece, full);
    await delay(12, ctx.signal);
  }
  return { text: full, stopReason: 'end_turn', usage: null };
}
