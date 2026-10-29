// Prompt for POST /case-feedback — AI review of a written PM case answer (Case Lab, "Submit for feedback").
//
// The client has an offline keyword checklist as its floor (case-lab/feedback-rules.js); this is the real
// evaluation. The client also has a copy-paste fallback prompt (buildFeedbackPrompt in case-lab/script.js)
// that asks for the same review in readable form — if you change the grading instructions here, mirror them there.

export const CASE_FEEDBACK_SYSTEM = `You are a tough but fair product-management interview coach reviewing a candidate's WRITTEN case answer. The candidate wrote one set of notes per section of an interview framework. You grade it against that framework's rubric.

How to grade:
- Judge what they wrote, not what you would have written. Quote their own words as evidence (short, verbatim).
- Grade each rubric dimension using the rubric's own weak / solid / strong descriptors. Pick the descriptor that best matches the evidence. Do not flatter and do not be harsh for sport.
- A section that is empty, one line, or generic ("improve engagement") is weak, however polished the rest is.
- Strengths must be real and specific (what they did, and why it works). Improvements must be concrete: say what is missing or wrong, and give a phrase or move they could add.
- If a REFERENCE answer is supplied it is only there to calibrate what "good" looks like for this case. Never reward similarity to it, never quote it, and never penalise a sound approach just because it differs from it.
- Notes are typed shorthand, not a polished speech: don't penalise terseness, typos or fragments if the reasoning is clear.

Output a SINGLE JSON object and nothing else — no prose before or after, no markdown fences. Exact shape:
{
  "overall": { "verdict": "strong" | "solid" | "developing", "summary": "<2-4 sentences: the honest headline verdict>" },
  "strengths": [ { "stage": "<section key or null>", "text": "<what was good and why>" } ],
  "improvements": [ { "stage": "<section key or null>", "text": "<what is missing or weak>", "fix": "<a concrete phrase/move to add>" } ],
  "stages": [ { "key": "<section key>", "verdict": "weak" | "solid" | "strong", "quote": "<short verbatim excerpt from their notes, or empty>", "strengths": ["..."], "improvements": ["..."] } ],
  "dimensions": [ { "dimension": "<exact rubric dimension name>", "rating": "weak" | "solid" | "strong", "why": "<one line citing evidence>", "next_level": "<what would raise it one level>" } ],
  "top_improvements": [ "<the single highest-impact fix>", "<second>", "<third>" ],
  "model_answer_gap": "<2-3 sentences: the biggest gap between this answer and a strong answer to this case>"
}
Rules: use the exact section keys and exact rubric dimension names supplied; include one "stages" entry per section and one "dimensions" entry per rubric dimension; at most 6 strengths, 8 improvements, 3 top_improvements; each string under 280 characters. Never use the character sequence "##".`;

function clamp(s, n) {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? t.slice(0, n) : t;
}

const MAX_STAGES = 12;
const MAX_RUBRIC = 10;
const MAX_NOTE_CHARS = 3500;
const MAX_FIELD = 600;

export function buildCaseFeedbackUserBlock({ caseInfo, framework, notes, reference }) {
  const c = caseInfo || {};
  const fw = framework || {};
  const stages = Array.isArray(fw.stages) ? fw.stages.slice(0, MAX_STAGES) : [];
  const rubric = Array.isArray(fw.rubric) ? fw.rubric.slice(0, MAX_RUBRIC) : [];
  const n = notes && typeof notes === "object" ? notes : {};

  const stagesBlock = stages
    .map((s, i) => `${i + 1}. key="${clamp(s.key, 60)}" — ${clamp(s.name, 100)} (${s.minMin}–${s.maxMin} min)\n   What good looks like: ${clamp(s.whatGoodLooksLike, MAX_FIELD)}`)
    .join("\n");
  const rubricBlock = rubric
    .map((r) => `- "${clamp(r.dimension, 100)}"\n    weak:   ${clamp(r.weak, MAX_FIELD)}\n    solid:  ${clamp(r.solid, MAX_FIELD)}\n    strong: ${clamp(r.strong, MAX_FIELD)}`)
    .join("\n");
  const answerBlock = stages
    .map((s) => `### ${clamp(s.name, 100)} (key="${clamp(s.key, 60)}")\n${clamp(n[s.key], MAX_NOTE_CHARS).trim() || "(left empty)"}`)
    .join("\n\n");
  const refStages = reference && Array.isArray(reference.stages) ? reference.stages.slice(0, MAX_STAGES) : [];
  const refBlock = refStages.length
    ? `\n=== REFERENCE ANSWER (calibration only — do not reward similarity, never quote it) ===\n${refStages.map((r) => `${clamp(r.stage, 100)}: ${clamp(r.walkthrough, 1200)}`).join("\n\n")}\n`
    : "";
  const ctx = Array.isArray(c.context) ? c.context.slice(0, 8).map((x) => clamp(x, 300)).join(" ") : "";
  const asm = Array.isArray(c.assumptions) ? c.assumptions.slice(0, 8).map((x) => clamp(x, 300)).join(" ") : "";

  return `=== THE CASE ===
${clamp(c.title, 300)}
${clamp(c.prompt, 1500)}
${ctx ? "Context: " + ctx : ""}
${asm ? "Assumptions given: " + asm : ""}

=== THE FRAMEWORK: ${clamp(fw.label, 80)} (${fw.totalMin || 45} min) — sections, with the keys to use ===
${stagesBlock}

=== THE RUBRIC (use these exact dimension names) ===
${rubricBlock}

=== THE CANDIDATE'S WRITTEN ANSWER ===
${answerBlock}
${refBlock}
Return the JSON object now.`;
}

// Models occasionally wrap JSON in prose or fences despite instructions — pull out the outermost object.
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
