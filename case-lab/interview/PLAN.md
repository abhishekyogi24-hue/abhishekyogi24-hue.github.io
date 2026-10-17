# Mock Interview — build plan (Opus 5.5 plan → Sonnet 5.5 build)

A voice-first PM mock interview that runs a realistic loop (intro → resume deep dive → behavioural → product case → your questions), then grades it like a hiring committee. Lives at `case-lab/interview/`, reuses Case Lab's data, no build step.

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Location | `case-lab/interview/` (own page, ES modules) | `case-lab/script.js` is already 2k lines; keep this separable. Served at `abhishekyogi.in/case-lab/interview/`. |
| Data | `../data/cases.json`, `behavioural.json`, `stories.json`, `frameworks.json`, `schedule.json`; resume = `../../kb/sources/core.md` + `experience-in-detail.md` | All already public on the site. Single source of truth stays Case Lab. |
| LLM transport | **BYO Anthropic key, direct browser fetch** (`anthropic-dangerous-direct-browser-access: true`) + **`?mock=1` canned transport** | Worker isn't deployed (`LIVE_WORKER_URL = ''`). A Worker proxy that takes client-built prompts would be an open proxy on the owner's key; a proper Worker route is a follow-up. Raw `fetch` (not SDK) because the site is no-build vanilla JS, same as the existing Worker. |
| Interviewer model | `claude-sonnet-5-5`, `thinking: {type: "between_tools"}`, `output_config: {effort: "low"}`, `max_tokens: 600`, `stream: true` | Latency is everything in a spoken conversation. Stream → start TTS at the first sentence boundary. |
| Feedback model | `claude-opus-5-5`, `thinking: {type: "adaptive"}`, `output_config: {effort: "high", format: {type: "json_schema", schema}}`, `max_tokens: 32000`, `stream: true` | One call per session; quality matters more than speed. |
| Refusals | Both calls send `anthropic-beta: server-side-fallback-2026-07-01` + `fallbacks: "default"`; always check `stop_reason` (`refusal`, `max_tokens`) before using content. | Skill default; mock interviews about e.g. trust & safety cases can trip classifiers. |
| Caching | System prompt = static rules + persona + full interview pack (resume, chosen questions, chosen case) — frozen for the session, `cache_control: {type:"ephemeral"}`. Per-turn "director" note goes inside the newest user message only; history is append-only, never rewritten. | ~40 turns per session × big prefix → caching is the cost lever. |
| TTS | Default: browser `speechSynthesis` (free). Optional: ElevenLabs (BYO key + voice id), falls back to browser on any error. | "Customizable interviewer voice" without forcing a paid key. |
| STT | Web Speech `SpeechRecognition` (continuous, interim, lang default `en-IN`), explicit **Done answering** (button / Space) — no silence auto-submit. Text input always available; Firefox = text only. | Real candidates pause to think; silence detection would cut them off. |
| State | `localStorage`: settings (`mi_settings_v1`), history of reports (`mi_history_v1`). API keys: `sessionStorage` by default, `localStorage` only if "Remember on this device" is ticked. | Matches Case Lab's on-device model. |

## 2. Setup screen (all customizable)

- **Round**: Full loop (default) · Resume screen · Behavioural · Product case · Hiring-manager mix (intro + resume + 1 behavioural + short case).
- **Length**: 30 / 45 / 60 min (phase budgets scale).
- **Level**: APM · PM · Senior PM · Group PM (sets the bar in both prompts).
- **Company style**: FAANG · Indian consumer unicorn · Early-stage startup · Travel / e-commerce · Custom text. Optional **target JD** textarea.
- **Case**: Today's Case Lab case (schedule.json, epoch in IST like script.js `computeDayIndex`) · Random by track + difficulty · Pick specific (searchable list) · deep link `?case=<id>`.
- **Behavioural**: auto (2 questions weighted to themes not practised recently) or pick.
- **Resume**: default = Abhishek's KB; "Use my own resume" textarea override.
- **Interviewer**: presets + full custom —
  - Presets: *Priya* (Bengaluru unicorn PM lead, warm-but-probing, en-IN voice), *Mark* (FAANG GPM, crisp, neutral, en-US), *Sarah* (startup founder, fast, tough, en-GB), *Arjun* (hiring manager, conversational, en-IN).
  - Custom: name, title, company, tone (warm / neutral / tough), pushback (low / med / high), interruptions (off / if rambling / aggressive), follow-up depth (1–4).
  - Voice: engine (Browser / ElevenLabs), voice picker grouped by accent (en-IN, en-US, en-GB, en-AU, other), rate, pitch, volume, **Preview voice** button.
- **Input**: Voice (mic) / Text. STT language.
- **API key** field + "Remember on this device" + clear button. Mock mode banner if `?mock=1`.

## 3. Interview engine (client-side phase machine)

Phases (Full loop, 45 min): `opening` 2 · `intro` 4 · `resume` 10 · `behavioural` 10 · `case` 17 · `candidate_qs` 3 · `close` <1. Each phase: time budget, min/max interviewer turns, goal text.

Per turn:
1. Candidate finishes answer → client computes answer metrics, builds a `<director>` note: current phase + goal, time used / left in phase and overall, turns used, and flags (`rambling` if answer > ~350 words or > 3 min, `short` if < 25 words, `phase_over_budget`).
2. Interviewer call streams back. Spoken text only. If it ends with `[[NEXT]]` the client advances phase (token stripped before display/TTS). Client also force-advances when phase exceeds budget by 25% (director says "wrap this section and transition now").
3. Interviewer may emit `[[END]]` in `close` → session ends.

Case phase specifics: interviewer gets the case `prompt` (read aloud), `context` (shared when relevant), `assumptions` (used to answer clarifying questions; anything not covered → "make a reasonable assumption and state it"), `followUps` (asks 2–3), `pitfalls` + framework stages (hidden; used only to choose probes). Gives a time check around 2/3 through.

Resume phase: interviewer picks the 1–2 most interview-worthy projects from the resume (or JD-relevant ones) and drills: your role vs team, the number and how it was measured, hardest trade-off, what failed, what you'd do differently. Calls out "we" answers.

Behavioural: asks the chosen questions verbatim-ish, uses their `followUps` and probes for missing STAR parts and quantified results.

### Realism rules (in system prompt)
Spoken English, 1–3 sentences, one question at a time, no markdown/lists. Never teach, hint, reveal the rubric, or say "great answer"; neutral acknowledgements ("Okay.", "Got it, and then?"). Probe vague claims. Interrupt politely per persona setting when `rambling`. If candidate asks for a minute, give it. Stay in persona; brief realistic answers in `candidate_qs` (invented but plausible, flagged nowhere). Never break character unless candidate types `/pause`.

## 4. Metrics (client-computed, fed into feedback)
Per answer: duration, words, WPM, filler count (um, uh, like, basically, actually, you know, sort of, kind of, literally, right?), time-to-first-word after a question. Session: talk ratio, time per phase vs budget, longest answer, total fillers/min.

## 5. Feedback (one Opus call, JSON schema)
Inputs: full timestamped transcript by phase, metrics, level, company style, the case + its framework rubric (weak/solid/strong) + model answer stages + pitfalls, behavioural questions with probes/pitfalls, story bank (to suggest a better story id), resume.
Calibration: grade like a real hiring committee at the selected level; framework `passNote` applies ("a solid on every dimension passes"); do not inflate; every claim cites a transcript quote.

Schema (all required):
```
overall { verdict: Strong No Hire|No Hire|Lean No Hire|Lean Hire|Hire|Strong Hire, score 1-5, headline, summary }
strengths [ {title, evidenceQuote, why} ] (top 3)
improvements [ {title, why, evidenceQuote, howToFix, exampleRewrite} ] (top 3, ranked)
sections [ {phase, score 1-5, verdict, wentWell[], improve[]} ]
caseRubric [ {dimension, rating weak|solid|strong, why, toReachNext} ]
caseStageGap [ {stage, youDid, strongAnswerWould, gap: none|minor|major} ]
behavioural [ {questionId, star {situation,task,action,result: missing|weak|solid}, issue, betterStoryId|null, strongerVersion} ]
resume { ownershipClarity, metricsRigor, depthUnderProbing, notes }
communication { observations[], fillerVerdict, pacingVerdict }
nextPractice { caseIds[], questionIds[], drills[] }
```

## 6. Report UI
Verdict banner + score, top 3 strengths / top 3 improvements, per-section cards, case rubric table, stage-gap table, behavioural STAR cards (link to suggested story), communication stats (from metrics, not model), full transcript with phase dividers. Export Markdown + JSON, copy Markdown. History list with score trend. "Practice next" buttons deep-link to Case Lab / a new session with that case.

## 7. Files
```
case-lab/interview/
  index.html        setup · interview · report views
  interview.css     imports ../style.css tokens; light/dark
  js/app.js         views, settings, wiring
  js/data.js        loads Case Lab JSON + resume md, case/question selection, today's case
  js/engine.js      phase machine, timers, director notes, [[NEXT]]/[[END]]
  js/prompts.js     interviewer system prompt, director note, feedback prompt + JSON schema
  js/llm.js         direct + mock transports, SSE parsing, error/refusal handling
  js/voice.js       TTS (browser chunked by sentence; ElevenLabs), STT wrapper
  js/metrics.js     per-answer + session metrics
  js/report.js      render report, export, history
```
Plus: "Mock interview" link in `case-lab/index.html` nav; README section.

## 8. Known gotchas
- Chrome `speechSynthesis` cuts long utterances (~15 s) → speak per sentence; voices load async (`voiceschanged`).
- Chrome `SpeechRecognition` stops after silence → auto-restart while "answering"; it sends audio to Google (say so in the UI).
- Mic needs a secure context (https or localhost); `file://` breaks localStorage too.
- Streaming TTS: queue sentences as they complete; Skip button cancels queue.

## 9. Follow-ups (not in v1)
- Worker routes `/interview/turn` + `/interview/feedback` that rebuild prompts server-side from case/question ids (no open proxy), so visitors can use it without a key.
- Session audio recording + playback alongside transcript.
- Add the tool as a Curiosity Build in `project.html`.
