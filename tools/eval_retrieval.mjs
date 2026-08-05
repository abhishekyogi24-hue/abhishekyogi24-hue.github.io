// Quantitative lexical-retrieval eval for Abhi AI's BM25 retrieval (retrieve.js).
//
// The plan's bar: lexical recall >= 0.85 before v2 (embeddings) is needed.
// "Recall" here means: for a realistic visitor question, does the context
// that would actually be sent to the LLM (canonical chunks + BM25-retrieved
// chunks, exactly as selectContext() assembles it for /chat) contain a chunk
// carrying the fact needed to answer? That's the metric that matters
// end-to-end, since canonical facts are always injected alongside retrieval.
//
// Because canonical (core.md) chunks are always included regardless of the
// query, testing only against canonical-covered facts would trivially score
// 1.0 and tell us nothing about whether BM25 itself works. So most cases
// below deliberately target facts that live ONLY in site/resume chunks
// (non-canonical) — this isolates real retrieval quality. A few canonical-
// covered cases are included too, to match a realistic query mix. We report
// both the overall (product-relevant) recall and a retrieval-only subset
// recall (excluding canonical hits) so the BM25 mechanism's own hit rate is
// visible, not masked by canonical always being present.
//
// Run: node tools/eval_retrieval.mjs

import { readFileSync } from "fs";
import { selectContext } from "../chatbot-worker/src/retrieve.js";

const { chunks } = JSON.parse(readFileSync(new URL("../kb/kb-index.json", import.meta.url)));

// Each case: a realistic visitor question, plus a predicate identifying the
// chunk(s) that must be present in canonical+retrieved for the question to
// be answerable. `onlyNonCanonical: true` cases specifically probe BM25
// (the fact does not appear, even paraphrased, in core.md).
const cases = [
  {
    q: "How did he drive app downloads for the CheapOair app?",
    match: (c) => c.text.includes("110 daily app downloads"),
    onlyNonCanonical: true,
  },
  {
    q: "Did he do anything about airline schedule changes reducing complaints?",
    match: (c) => c.text.includes("airline schedule change flows"),
    onlyNonCanonical: true,
  },
  {
    q: "Did he build any auto-dialer or callback tools for leads?",
    match: (c) => c.text.includes("auto-dialer"),
    onlyNonCanonical: true,
  },
  {
    q: "How did he use FullStory session recordings?",
    match: (c) => c.text.includes("FullStory session recordings"),
    onlyNonCanonical: true,
  },
  {
    q: "What were Oli's success criteria for conversion rate?",
    match: (c) => c.headingPath.includes("The bet, written down first") && c.text.includes("≥20% conversion"),
    onlyNonCanonical: true,
  },
  {
    q: "What CORS constraint did Ship Gate have to work around?",
    match: (c) => c.text.includes("CORS constraint that forced two connection modes"),
    onlyNonCanonical: true,
  },
  {
    q: "Is Abhishek open to new roles right now?",
    match: (c) => c.headingPath === "Get in touch" && c.text.includes("Open to Product Manager"),
    onlyNonCanonical: true,
  },
  {
    q: "Why did CheapOair need a chatbot instead of just phone and email support?",
    match: (c) => c.headingPath.includes("CheapOair AI Chatbot › Problem") && c.text.includes("60%"),
    onlyNonCanonical: true,
  },
  {
    q: "What bug did he find at the Fareportal Bug Hunt?",
    match: (c) => c.text.includes("Fareportal Bug Hunt"),
    onlyNonCanonical: false, // in core.md too
  },
  {
    q: "Tell me about the Priority Leads Tool",
    match: (c) => c.headingPath.toLowerCase().includes("priority leads"),
    onlyNonCanonical: false,
  },
  {
    q: "What is Ship Gate?",
    match: (c) => c.headingPath.toLowerCase().includes("ship gate") || c.text.includes("Ship Gate"),
    onlyNonCanonical: false,
  },
  {
    q: "How does the arthritis app screen for inflammation?",
    match: (c) => c.text.toLowerCase().includes("inflammatory signal") || c.text.toLowerCase().includes("morning stiffness"),
    onlyNonCanonical: false,
  },
  {
    q: "What did he study in college?",
    match: (c) => c.text.includes("IIT") || c.text.includes("Civil Engineering"),
    onlyNonCanonical: false,
  },
  {
    q: "Has he managed a team before?",
    match: (c) => c.text.includes("12 SDEs"),
    onlyNonCanonical: false,
  },
  {
    q: "Tell me about Assisted Selling and Search Explorer",
    match: (c) => c.headingPath.toLowerCase().includes("assisted selling") || c.headingPath.toLowerCase().includes("search explorer"),
    onlyNonCanonical: false,
  },
  {
    q: "What did he do at OYO?",
    match: (c) => c.headingPath.includes("OYO") || c.text.includes("OYO"),
    onlyNonCanonical: false,
  },
  {
    q: "What's his email?",
    match: (c) => c.text.includes("abhishekyogi.24@gmail.com"),
    onlyNonCanonical: false,
  },
  {
    q: "What personas does Oli serve?",
    match: (c) => c.text.includes("Explorer") && c.text.includes("Shopper"),
    onlyNonCanonical: false,
  },
  {
    q: "How was the reduction in analyst effort achieved with Google Analytics?",
    match: (c) => c.text.includes("Reduced analyst effort by 20%"),
    onlyNonCanonical: true,
  },
  {
    q: "What engineering pods worked on Oli?",
    match: (c) => c.text.includes("Chatbot, RPA, App") || (c.text.includes("RPA") && c.text.includes("engineering pods")),
    onlyNonCanonical: false,
  },
  // --- Harder paraphrases: weak keyword overlap with the source text, no
  // aliasing help. These stress-test whether pure lexical BM25 is enough,
  // or whether v2 (embeddings/semantic) would meaningfully help.
  {
    q: "Did he ever cut manual work for the ops team through automating connected calls to leads?",
    match: (c) => c.text.includes("auto-dialer"),
    onlyNonCanonical: true,
    hard: true,
  },
  {
    q: "Has he worked on anything related to keeping travel bookings compliant with government transportation rules?",
    match: (c) => c.text.includes("DOT guidelines"),
    onlyNonCanonical: true,
    hard: true,
  },
  {
    q: "What kind of accessibility considerations went into the arthritis tracker's touch targets?",
    match: (c) => c.text.includes("44px floor") || c.text.includes("one-handed tapping"),
    onlyNonCanonical: false,
    hard: true,
  },
  {
    q: "How does the eval harness decide when a rubric needs a human instead of a model?",
    match: (c) => c.headingPath.includes("Ship Gate › Scoring"),
    onlyNonCanonical: true,
    hard: true,
  },
  {
    q: "What made him confident Oli wasn't just cannibalizing bookings that would've happened anyway?",
    match: (c) => c.text.includes("cannibaliz"),
    onlyNonCanonical: false,
    hard: true,
  },
];

let hits = 0;
let nonCanHits = 0;
let nonCanTotal = 0;
let hardHits = 0;
let hardTotal = 0;
const misses = [];

for (const tc of cases) {
  const { canonical, retrieved } = selectContext(chunks, tc.q);
  const combined = [...canonical, ...retrieved];
  const hit = combined.some(tc.match);
  const hitNonCanonical = retrieved.some(tc.match); // BM25 retrieval only, no canonical credit

  if (hit) hits++;
  else misses.push(tc.q + (tc.hard ? "  [hard/paraphrase]" : ""));

  if (tc.onlyNonCanonical) {
    nonCanTotal++;
    if (hitNonCanonical) nonCanHits++;
  }
  if (tc.hard) {
    hardTotal++;
    if (hit) hardHits++;
  }
}

const overallRecall = hits / cases.length;
const retrievalOnlyRecall = nonCanTotal ? nonCanHits / nonCanTotal : null;
const hardRecall = hardTotal ? hardHits / hardTotal : null;

console.log(`Cases: ${cases.length}`);
console.log(`Overall recall (canonical + BM25-retrieved, matches what /chat actually sends the LLM): ${hits}/${cases.length} = ${overallRecall.toFixed(3)}`);
console.log(`Retrieval-only recall (BM25 hits alone, on the ${nonCanTotal} cases whose fact is NOT in canonical): ${nonCanHits}/${nonCanTotal} = ${retrievalOnlyRecall.toFixed(3)}`);
console.log(`Hard-paraphrase subset recall (weak keyword overlap, ${hardTotal} cases): ${hardHits}/${hardTotal} = ${hardRecall.toFixed(3)}`);
if (misses.length) {
  console.log("\nMisses:");
  for (const m of misses) console.log(`  - ${m}`);
}
console.log(`\nBar: lexical recall >= 0.85 before v2 (embeddings) is needed. ${overallRecall >= 0.85 ? "PASS" : "FAIL"} on overall recall.`);
