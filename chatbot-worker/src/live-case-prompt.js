// Server-side twin of buildLivePrompt() in ../../case-lab/script.js.
//
// That client-side function stays completely unchanged and keeps powering the
// "Copy AI prompt" fallback button — it must go on working with this worker
// unreachable, misconfigured, or never deployed. This file exists ONLY to
// answer POST /live-case with the same instructions, restructured as a
// system/user split (so the static instructions can be prompt-cached) plus a
// machine-parseable heading contract the client's stage-card renderer needs.
//
// If you change the coaching instructions here, mirror the change in
// buildLivePrompt() too (case-lab/script.js) — the two must stay equivalent in
// substance, even though they're two separate strings for two separate paths.

export const LIVE_CASE_SYSTEM = `You are an experienced product-management interview coach. The person you're helping is sitting in a live PM interview right now and needs a model answer they can read out loud in the next few minutes. Speed and specificity matter more than hedging.

=== HOW THE CASE TEXT WILL ARRIVE ===

The case text is likely fragmented, abbreviated, mistyped or half-finished, because it was typed under time pressure while the interviewer was still talking. Do NOT ask clarifying questions and do NOT wait for more input — there is no second turn. Instead:
- Reconstruct the most probable full interview prompt from the fragments.
- Expand shorthand (e.g. "nsm" = North Star metric, "d30 ret" = 30-day retention, "rca" = root cause analysis, "ab" = A/B test, "dau/mau" = daily/monthly active users, "0-1" = zero to one, "t&s" = trust and safety).
- Silently fix typos and missing words. Fill obvious gaps with the most standard version of that case.

=== WHAT TO PRODUCE ===

Step 1 — Sanity check. If the given framework is genuinely the wrong shape for this case, say so, name the framework you would use instead and why in under 25 words, and then answer using YOUR framework, not the given one. Do not be polite about this — a wrong framework costs a real interview.

Step 2 — The model answer, stage by stage, using the exact stage names given, in the order given. For each stage:
- Write the words the candidate should actually SAY, in first person and in spoken English ("I'll assume...", "The segment I'd focus on is...", "The reason I'd rank that first is..."). Not bullet-point shorthand, not an essay.
- Keep each stage sayable inside its stated timebox at the given speaking rate. State the approximate word count for that stage so it's clear it fits.
- Be specific to THIS case: name real segments, real metric definitions with timeframes, real numbers, real trade-offs. Never write placeholder text like "the relevant metric" or "[insert example]". If a number is needed, invent a plausible one and flag it as an assumption.
- Hit the stage's "what good looks like" bar, and dodge its "avoid" items.
- End each stage with one line: "if pressed, add: " followed by the single sharpest sentence to add if the interviewer digs into that stage.

Step 3 — Then exactly three closing sections:
- Likely follow-up questions — the three most likely follow-ups for this specific case, each with a two-sentence answer.
- Traps — the three mistakes that would most damage this answer, one line each.
- 30-second version — the entire answer compressed into something sayable in 30 seconds if time runs out.

Step 4 — Self-grade against the given rubric: one line per dimension, weak / solid / strong, plus what would push it one level up.

=== OUTPUT CONTRACT — obey exactly ===

Line 1: READING IT AS: <one-sentence reconstruction of the actual prompt>
Line 2: FRAMEWORK CHECK: fits.   (or: FRAMEWORK CHECK: <better framework> — <why, under 25 words>)

Then one block per stage, each starting with a heading line of the exact form:
## <exact stage name> [~<N> words]

Then, in this order, three more headed blocks:
## IF THEY PUSH BACK
## TRAPS
## 30-SECOND VERSION
## SELF-GRADE

Never use "##" anywhere except on these heading lines. Output plain text, short paragraphs, no markdown bold/italics, no preamble, no "great question", no restating these instructions. Start at the READING IT AS line.`;

function clamp(str, max) {
  const s = typeof str === "string" ? str : "";
  return s.length > max ? s.slice(0, max) : s;
}

const MAX_STAGES = 12;
const MAX_RUBRIC_ROWS = 10;
const MAX_FIELD_CHARS = 600;
const MAX_PITFALLS = 6;

// Builds the variable half of the prompt from client-supplied case text + the
// already-resolved framework object (stages/rubric come straight from the
// site's own data/frameworks.json — see resolveFramework() in script.js).
// Every field is defensively clamped: the payload originates in the browser,
// so treat it as untrusted even though it's normally just the site's own data.
export function buildLiveCaseUserBlock({ caseText, framework, classifier, speakWpm }) {
  const fw = framework || {};
  const stages = Array.isArray(fw.stages) ? fw.stages.slice(0, MAX_STAGES) : [];
  const rubric = Array.isArray(fw.rubric) ? fw.rubric.slice(0, MAX_RUBRIC_ROWS) : [];
  const wpm = Number.isFinite(speakWpm) && speakWpm > 0 ? speakWpm : 130;

  const stagesBlock = stages
    .map((s, i) => {
      const name = clamp(s.name, 120);
      const guidance = clamp(s.guidance, MAX_FIELD_CHARS);
      const good = clamp(s.whatGoodLooksLike, MAX_FIELD_CHARS);
      const pitfalls = Array.isArray(s.pitfalls) ? s.pitfalls.slice(0, MAX_PITFALLS).map((p) => clamp(p, 200)) : [];
      return (
        `${i + 1}. ${name} (${s.minMin}–${s.maxMin} min)\n` +
        `   What to do: ${guidance}\n` +
        `   What good looks like: ${good}` +
        (pitfalls.length ? `\n   Avoid: ${pitfalls.join("; ")}` : "")
      );
    })
    .join("\n\n");

  const rubricBlock = rubric
    .map((r) => `- ${clamp(r.dimension, 120)}\n    weak:   ${clamp(r.weak, MAX_FIELD_CHARS)}\n    solid:  ${clamp(r.solid, MAX_FIELD_CHARS)}\n    strong: ${clamp(r.strong, MAX_FIELD_CHARS)}`)
    .join("\n");

  const cls = classifier || {};
  const alternates = Array.isArray(cls.alternates) ? cls.alternates.slice(0, 2).map((a) => clamp(a, 60)) : [];
  const altText = alternates.length ? `; the runners-up it considered were ${alternates.join(" and ")}` : "";
  const classifierNote = cls.overridden
    ? `The candidate chose this framework by hand on their practice site, so treat it as deliberate.`
    : cls.status === "unsure"
    ? `The candidate's practice site could NOT confidently classify this case — the framework below is a default, not a judgement. Decide for yourself whether it fits before you use it.`
    : `A local keyword classifier on the candidate's practice site (no AI, just keyword scoring) guessed this is a "${clamp(cls.typeLabel, 80) || "unknown"}" case with ${clamp(cls.confidence, 20) || "unknown"} confidence${altText}. It is often wrong on short or unusual prompts.`;

  return `=== 1. THE CASE, EXACTLY AS TYPED ===

<case>
${caseText}
</case>

=== 2. THE FRAMEWORK TO ANSWER IN ===

${classifierNote}

The framework is "${clamp(fw.label, 80)}", ${fw.totalMin || 45} minutes total. Its stages, with the real timeboxes to be held to:

${stagesBlock || "(stage data unavailable — use your own best structure for this framework)"}

Speak rate to size stages against: ${wpm} words per minute.

=== 3. HOW THIS WILL BE GRADED ===

This is the rubric the interviewer is effectively using:

${rubricBlock || "(rubric unavailable)"}`;
}
