// Lightweight BM25 retrieval over the static KB chunk array — no vector DB
// or embedding model needed at this corpus size (~100-200 chunks). Exact
// scan of every chunk on every request is sub-millisecond at this scale.

const K1 = 1.5;
const B = 0.75;
const HEADING_REPEATS = 3; // heading-path tokens counted extra times → boosts their weight
const CONTEXT_TOKEN_BUDGET = 2500;
const MAX_PER_SOURCE = 3;
const MAX_CHUNKS = 8;

// Small alias map so common paraphrases still hit the right chunks even
// though this is lexical, not semantic, retrieval.
const ALIASES = {
  experiment: ["a/b", "testing"],
  experiments: ["a/b", "testing"],
  manage: ["led", "lead"],
  managed: ["led", "lead"],
  management: ["led", "lead"],
  team: ["sdes", "qas", "designers", "analysts"],
  chatbot: ["chatbots", "conversational", "assistant"],
  chatbots: ["chatbot", "conversational", "assistant"],
  ai: ["genai", "llm", "artificial", "intelligence"],
  data: ["analytics", "sql", "python"],
  school: ["education", "iit", "college"],
  college: ["education", "iit", "iitk"],
  university: ["education", "iit"],
  hire: ["contact", "reach", "email"],
  hiring: ["contact", "reach", "email"],
  contact: ["email", "linkedin", "phone"],
  salary: ["compensation"],
  voice: ["conversational"],
};

function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9%$₹→+]+/g) || []).filter((t) => t.length > 1);
}

// Crude prefix-based "stem" for words long enough that a shared 6-char
// prefix reliably means the same root — e.g. inflammation/inflammatory,
// testing/tested/tests. Namespaced with "~" so it never collides with a
// real short token, and only ever supplements exact-token matches, never
// replaces them.
function stemToken(t) {
  return t.length > 6 ? "~" + t.slice(0, 6) : null;
}

function withStems(tokens) {
  const out = tokens.slice();
  for (const t of tokens) {
    const s = stemToken(t);
    if (s) out.push(s);
  }
  return out;
}

function expandQuery(tokens) {
  const expanded = new Set(withStems(tokens));
  for (const t of tokens) {
    const aliases = ALIASES[t];
    if (aliases) for (const a of aliases) expanded.add(a);
  }
  return [...expanded];
}

function buildDocs(chunks) {
  return chunks.map((c) => {
    const bodyTokens = withStems(tokenize(c.text));
    const headingTokens = withStems(tokenize(c.headingPath || ""));
    const allTokens = bodyTokens.concat(Array(HEADING_REPEATS).fill(headingTokens).flat());
    const tf = new Map();
    for (const t of allTokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { chunk: c, tf, length: allTokens.length || 1 };
  });
}

function bm25Search(docs, query, k) {
  const qTokens = expandQuery(tokenize(query));
  if (qTokens.length === 0 || docs.length === 0) return [];

  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N;

  const df = new Map();
  for (const t of qTokens) {
    let count = 0;
    for (const d of docs) if (d.tf.has(t)) count++;
    df.set(t, count);
  }

  const scored = docs.map((d) => {
    let score = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t) || 0;
      if (f === 0) continue;
      const n = df.get(t) || 0;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + B * (d.length / avgdl)));
    }
    return { chunk: d.chunk, score: score * (d.chunk.weight || 1) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Splits chunks into canonical (always included, never ranked/dropped) and
 * retrieved (BM25-ranked, budgeted, diversity-capped across sources).
 */
export function selectContext(chunks, query) {
  const canonical = chunks.filter((c) => c.tier === "canonical");
  const rest = chunks.filter((c) => c.tier !== "canonical");

  const docs = buildDocs(rest);
  const ranked = bm25Search(docs, query, 30);

  const perSourceCount = new Map();
  const picked = [];
  // Canonical facts live in the (separately cached) system prompt; this
  // budget governs only the retrieved context injected into the user
  // message, so the two don't compete for the same token pool.
  let budget = CONTEXT_TOKEN_BUDGET;

  for (const { chunk } of ranked) {
    if (picked.length >= MAX_CHUNKS) break;
    const count = perSourceCount.get(chunk.source) || 0;
    if (count >= MAX_PER_SOURCE) continue;
    if (chunk.tokens > budget) continue;
    picked.push(chunk);
    perSourceCount.set(chunk.source, count + 1);
    budget -= chunk.tokens;
  }

  return { canonical, retrieved: picked };
}
