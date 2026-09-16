#!/usr/bin/env node
// build-cases.mjs — reads data/frameworks.json + data/packs/*.json, validates every
// case, then writes data/cases.json and data/schedule.json.
//
// Node ESM, zero dependencies. Run with: node tools/build-cases.mjs

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PACKS_DIR = path.join(DATA_DIR, "packs");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TRACKS = new Set(["product-sense", "analytical", "ai-product", "cross-cutting"]);

const VALID_TYPES = new Set([
  "improve-existing", "design-0to1", "new-segment", "comparative", "new-surface",
  "teardown", "adjacent-expansion", "emerging-tech", "mission-first", "define-metrics",
  "rca", "funnel", "retention", "metric-tradeoff", "goal-setting", "experiment",
  "ai-0to1", "ai-ux-trust", "ai-evals", "ai-metrics", "ai-guardrails", "prioritization",
  "pricing", "growth-loop", "marketplace", "trust-safety", "platform-api"
]);

const ID_RE = /^[a-z]+-[a-z0-9]+-\d{3}$/;

const REQUIRED_FIELDS = [
  "id", "track", "framework", "type", "title", "company", "region", "industry",
  "difficulty", "timeboxMin", "prompt", "context", "assumptions", "followUps",
  "modelAnswer", "pitfalls", "related"
];

const EPOCH_STR = "2026-09-14"; // Monday — day 0 is a Monday so each week runs Mon-Sat cases, Sun review

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`\n[build-cases] FAILED: ${msg}\n`);
  process.exit(1);
}

function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`could not read/parse ${path.relative(ROOT, filePath)}: ${err.message}`);
  }
}

function resolveFrameworkStages(frameworkKey, frameworks) {
  const fw = frameworks[frameworkKey];
  if (!fw) return null;
  if (fw.inherits) {
    const parent = frameworks[fw.inherits];
    return parent ? parent.stages : null;
  }
  return fw.stages;
}

// Deterministic seeded PRNG (mulberry32) so rebuilds are stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const frameworksPath = path.join(DATA_DIR, "frameworks.json");
if (!existsSync(frameworksPath)) fail(`missing ${path.relative(ROOT, frameworksPath)}`);
const frameworks = readJSON(frameworksPath);

if (!existsSync(PACKS_DIR)) fail(`missing packs directory: ${path.relative(ROOT, PACKS_DIR)}`);
const packFiles = readdirSync(PACKS_DIR).filter((f) => f.endsWith(".json")).sort();
if (packFiles.length === 0) fail(`no pack files found in ${path.relative(ROOT, PACKS_DIR)}`);

const allCases = [];
for (const packFile of packFiles) {
  const packPath = path.join(PACKS_DIR, packFile);
  const pack = readJSON(packPath);
  if (!pack.pack || !Array.isArray(pack.cases)) {
    fail(`${packFile}: expected shape { "pack": "<name>", "cases": [...] }`);
  }
  for (const c of pack.cases) {
    allCases.push({ ...c, __sourcePack: packFile });
  }
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

const seenIds = new Set();

for (const c of allCases) {
  const ref = c.id ? `case "${c.id}"` : `an unidentified case in ${c.__sourcePack}`;

  // Required fields present
  for (const field of REQUIRED_FIELDS) {
    if (!(field in c)) fail(`${ref} (${c.__sourcePack}): missing required field "${field}"`);
  }

  // id shape + uniqueness
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) {
    fail(`${ref} (${c.__sourcePack}): id "${c.id}" does not match ^[a-z]+-[a-z0-9]+-\\d{3}$`);
  }
  if (seenIds.has(c.id)) {
    fail(`duplicate case id "${c.id}" (found again in ${c.__sourcePack})`);
  }
  seenIds.add(c.id);

  // track
  if (!VALID_TRACKS.has(c.track)) {
    fail(`${ref}: unknown track "${c.track}" (expected one of ${[...VALID_TRACKS].join(", ")})`);
  }

  // framework
  if (!frameworks[c.framework]) {
    fail(`${ref}: unknown framework "${c.framework}" (not present in data/frameworks.json)`);
  }

  // type
  if (!VALID_TYPES.has(c.type)) {
    fail(`${ref}: unknown type "${c.type}"`);
  }

  // difficulty
  if (!Number.isInteger(c.difficulty) || c.difficulty < 1 || c.difficulty > 3) {
    fail(`${ref}: difficulty must be an integer 1-3, got ${JSON.stringify(c.difficulty)}`);
  }

  // company must be an array
  if (!Array.isArray(c.company) || c.company.length === 0) {
    fail(`${ref}: "company" must be a non-empty array`);
  }

  // prompt non-empty
  if (typeof c.prompt !== "string" || c.prompt.trim().length === 0) {
    fail(`${ref}: "prompt" must be a non-empty string`);
  }

  // context non-empty array
  if (!Array.isArray(c.context) || c.context.length === 0) {
    fail(`${ref}: "context" must be a non-empty array`);
  }

  // followUps: non-empty, 2-4 items
  if (!Array.isArray(c.followUps) || c.followUps.length < 2 || c.followUps.length > 4) {
    fail(`${ref}: "followUps" must be an array of 2-4 items, got ${Array.isArray(c.followUps) ? c.followUps.length : typeof c.followUps}`);
  }

  // assumptions: any item containing a digit must be prefixed "assumed: "
  if (!Array.isArray(c.assumptions)) {
    fail(`${ref}: "assumptions" must be an array (can be empty)`);
  }
  for (const a of c.assumptions) {
    if (typeof a !== "string") fail(`${ref}: every assumption must be a string`);
    if (/\d/.test(a) && !a.startsWith("assumed: ")) {
      fail(`${ref}: assumption "${a}" contains a number but is missing the "assumed: " prefix`);
    }
  }

  // pitfalls / related must be arrays
  if (!Array.isArray(c.pitfalls)) fail(`${ref}: "pitfalls" must be an array`);
  if (!Array.isArray(c.related)) fail(`${ref}: "related" must be an array`);

  // modelAnswer.stages must match, in order, the framework's stage names
  if (!c.modelAnswer || !Array.isArray(c.modelAnswer.stages)) {
    fail(`${ref}: "modelAnswer.stages" must be an array`);
  }
  const expectedStages = resolveFrameworkStages(c.framework, frameworks);
  if (!expectedStages) {
    fail(`${ref}: could not resolve stages for framework "${c.framework}"`);
  }
  const expectedNames = expectedStages.map((s) => s.name);
  const actualNames = c.modelAnswer.stages.map((s) => s.stage);
  if (actualNames.length !== expectedNames.length || expectedNames.some((n, i) => n !== actualNames[i])) {
    fail(
      `${ref}: modelAnswer.stages must match, in order, the "${c.framework}" framework stages.\n` +
      `  expected: ${JSON.stringify(expectedNames)}\n` +
      `  actual:   ${JSON.stringify(actualNames)}`
    );
  }
  for (const stage of c.modelAnswer.stages) {
    if (typeof stage.walkthrough !== "string" || stage.walkthrough.trim().length === 0) {
      fail(`${ref}: stage "${stage.stage}" has an empty walkthrough`);
    }
  }
}

console.log(`[build-cases] validated ${allCases.length} case(s) across ${packFiles.length} pack(s) — OK`);

// ---------------------------------------------------------------------------
// Write cases.json
// ---------------------------------------------------------------------------

const cleanCases = allCases.map(({ __sourcePack, ...c }) => c);

const casesOut = {
  generatedAt: new Date().toISOString(),
  count: cleanCases.length,
  cases: cleanCases
};

writeFileSync(path.join(DATA_DIR, "cases.json"), JSON.stringify(casesOut, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Build schedule.json
// ---------------------------------------------------------------------------

// Schedule length: max(180, library size), rounded up to a whole number of weeks.
const scheduleLength = Math.ceil(Math.max(180, cleanCases.length) / 7) * 7;

// Track proportions in the library (largest-remainder apportionment of the 6
// weekly non-Sunday slots).
const trackCounts = {};
for (const c of cleanCases) trackCounts[c.track] = (trackCounts[c.track] || 0) + 1;
const tracks = Object.keys(trackCounts);

function apportion(total, weights) {
  // weights: { key: count }, returns { key: integer slots } summing to `total`.
  const sumWeights = Object.values(weights).reduce((a, b) => a + b, 0);
  const raw = {};
  const floors = {};
  let flooredSum = 0;
  for (const [k, w] of Object.entries(weights)) {
    raw[k] = (w / sumWeights) * total;
    floors[k] = Math.floor(raw[k]);
    flooredSum += floors[k];
  }
  let remainder = total - flooredSum;
  const byFraction = Object.keys(weights).sort((a, b) => (raw[b] - floors[b]) - (raw[a] - floors[a]));
  for (let i = 0; i < byFraction.length && remainder > 0; i++, remainder--) {
    floors[byFraction[i]] += 1;
  }
  return floors;
}

const weeklySlotCounts = apportion(6, trackCounts); // { track: slots per week (Mon-Sat) }

// Base Mon..Sat multiset of tracks, in the weekly proportions above (order irrelevant —
// it gets reshuffled fresh per week below).
const weeklyTrackPattern = [];
for (const t of tracks) {
  for (let i = 0; i < weeklySlotCounts[t]; i++) weeklyTrackPattern.push(t);
}
while (weeklyTrackPattern.length < 6) weeklyTrackPattern.push(tracks[0]);
weeklyTrackPattern.length = 6;

// A fresh shuffle of that same multiset for EVERY week (seeded by week index, so it's
// deterministic and reproducible across rebuilds) — otherwise the same weekday would
// draw the same track for the entire 26-week schedule (e.g. every single Monday being
// "analytical" forever), which reads as monotonous even though the exact case differs.
// Also nudges away from repeating last week's Saturday track on this week's Monday.
const weekPatternCache = new Map();
function patternForWeek(weekIndex) {
  if (weekPatternCache.has(weekIndex)) return weekPatternCache.get(weekIndex);
  let pattern = seededShuffle(weeklyTrackPattern, hashStringToSeed(`case-lab-weekly-pattern-w${weekIndex}`));
  if (weekIndex > 0) {
    const prevSaturdayTrack = weekPatternCache.get(weekIndex - 1)[5];
    if (pattern[0] === prevSaturdayTrack) {
      const swapIdx = pattern.findIndex((t, i) => i > 0 && t !== prevSaturdayTrack);
      if (swapIdx > 0) [pattern[0], pattern[swapIdx]] = [pattern[swapIdx], pattern[0]];
    }
  }
  weekPatternCache.set(weekIndex, pattern);
  return pattern;
}

// Per-track, deterministically shuffled queues of case ids, cycled as needed.
const queues = {};
for (const t of tracks) {
  const idsForTrack = cleanCases.filter((c) => c.track === t).map((c) => c.id);
  queues[t] = seededShuffle(idsForTrack, hashStringToSeed(`case-lab-track-${t}`));
}
const queuePos = {};
for (const t of tracks) queuePos[t] = 0;

function nextFromQueue(track, predicate, maxAttempts = 50) {
  const q = queues[track];
  if (!q || q.length === 0) return null;
  for (let attempt = 0; attempt < Math.min(maxAttempts, q.length); attempt++) {
    const idx = (queuePos[track] + attempt) % q.length;
    const id = q[idx];
    if (predicate(id)) {
      queuePos[track] = (idx + 1) % q.length;
      return id;
    }
  }
  // No candidate satisfies the predicate — relax and take the next in line anyway.
  const id = q[queuePos[track] % q.length];
  queuePos[track] = (queuePos[track] + 1) % q.length;
  return id;
}

const caseById = new Map(cleanCases.map((c) => [c.id, c]));

// Difficulty ramp: within each 4-week (28-day) block, non-Saturday/non-Sunday
// slots ramp 1 -> 3 across the block; Saturday is always forced to 3.
function targetDifficultyForRamp(posInBlock, blockLen) {
  const frac = posInBlock / blockLen;
  if (frac < 1 / 3) return 1;
  if (frac < 2 / 3) return 2;
  return 3;
}

// Groups of case types that FEEL the same to a candidate even when the exact type
// string (and even the track/framework) differs — e.g. "define a metric" and "define
// an AI metric" are both "a metrics case" back to back. Consecutive-day picking avoids
// repeating a family, not just an exact type, so two flavors of the same drill can't
// land on adjacent days.
const TYPE_FAMILY = {
  "define-metrics": "metrics", "ai-metrics": "metrics", "goal-setting": "metrics", "metric-tradeoff": "metrics",
  "rca": "diagnosis",
  "funnel": "funnel-retention", "retention": "funnel-retention",
  "experiment": "experiment",
  "design-0to1": "zero-to-one", "ai-0to1": "zero-to-one", "new-segment": "zero-to-one",
  "teardown": "zero-to-one", "improve-existing": "zero-to-one",
  "comparative": "comparative",
  "ai-evals": "ai-trust", "ai-guardrails": "ai-trust", "ai-ux-trust": "ai-trust",
  "prioritization": "strategy", "pricing": "strategy", "growth-loop": "strategy",
  "marketplace": "strategy", "trust-safety": "strategy", "platform-api": "strategy"
};
function typeFamily(type) { return TYPE_FAMILY[type] || type; }

function pickCaseForSlot({ track, targetDifficulty, prevType, companyLastSeenDay, dayIndex }) {
  const wantsTrack = track;
  const withinTrack = (id) => caseById.get(id)?.track === wantsTrack;
  const prevFamily = prevType ? typeFamily(prevType) : null;

  // Best-effort predicate: right track, right (or closest) difficulty, different
  // type FAMILY from the previous day (not just exact type), and no company used in
  // the last 14 days.
  const strongPredicate = (id) => {
    const cse = caseById.get(id);
    if (!cse) return false;
    if (cse.difficulty !== targetDifficulty) return false;
    if (prevFamily && typeFamily(cse.type) === prevFamily) return false;
    if (cse.company.some((co) => companyLastSeenDay.has(co) && dayIndex - companyLastSeenDay.get(co) < 14)) return false;
    return true;
  };
  const mediumPredicate = (id) => {
    const cse = caseById.get(id);
    if (!cse) return false;
    if (prevFamily && typeFamily(cse.type) === prevFamily) return false;
    if (cse.company.some((co) => companyLastSeenDay.has(co) && dayIndex - companyLastSeenDay.get(co) < 14)) return false;
    return true;
  };
  // Relax the family check to an exact-type check (the original, narrower guarantee)
  // before relaxing further, so a small library still gets SOME adjacency guard.
  const looserPredicate = (id) => {
    const cse = caseById.get(id);
    if (!cse) return false;
    if (prevType && cse.type === prevType) return false;
    return true;
  };
  const weakPredicate = (id) => {
    const cse = caseById.get(id);
    return !!cse;
  };

  let picked = nextFromQueue(wantsTrack, strongPredicate);
  if (picked && strongPredicate(picked)) return picked;

  picked = nextFromQueue(wantsTrack, mediumPredicate);
  if (picked && mediumPredicate(picked)) return picked;

  picked = nextFromQueue(wantsTrack, looserPredicate);
  if (picked && looserPredicate(picked)) return picked;

  picked = nextFromQueue(wantsTrack, weakPredicate);
  if (picked && weakPredicate(picked)) return picked;

  // Absolute fallback: whatever is next in that track's queue (library too
  // small to satisfy every constraint — expected until the library grows).
  return nextFromQueue(wantsTrack, () => true);
}

const epoch = new Date(`${EPOCH_STR}T00:00:00Z`);
const days = [];
const companyLastSeenDay = new Map();
let prevType = null;
let relaxedSlots = 0;

for (let i = 0; i < scheduleLength; i++) {
  const date = new Date(epoch.getTime() + i * 86400000);
  const weekday = date.getUTCDay(); // 0 = Sunday .. 6 = Saturday

  if (weekday === 0) {
    days.push(null);
    prevType = null; // a review day breaks the "no repeat type" adjacency
    continue;
  }

  // Monday=1 .. Saturday=6 maps to pattern index 0..5; each week gets its own shuffle.
  const weekIndex = Math.floor(i / 7);
  const track = patternForWeek(weekIndex)[weekday - 1];

  const blockLen = 28;
  const posInBlock = i % blockLen;
  const targetDifficulty = weekday === 6 ? 3 : targetDifficultyForRamp(posInBlock, blockLen);

  const id = pickCaseForSlot({ track, targetDifficulty, prevType, companyLastSeenDay, dayIndex: i });
  if (!id) fail(`schedule build: no case available for track "${track}" on day ${i}`);

  const cse = caseById.get(id);
  if (prevType && cse.type === prevType) relaxedSlots++;
  for (const co of cse.company) companyLastSeenDay.set(co, i);
  prevType = cse.type;

  days.push(id);
}

const scheduleOut = { epoch: EPOCH_STR, days };
writeFileSync(path.join(DATA_DIR, "schedule.json"), JSON.stringify(scheduleOut, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Distribution report
// ---------------------------------------------------------------------------

function tally(items, keyFn) {
  const m = {};
  for (const item of items) {
    const k = keyFn(item);
    const keys = Array.isArray(k) ? k : [k];
    for (const kk of keys) m[kk] = (m[kk] || 0) + 1;
  }
  return m;
}

function printTable(title, m) {
  console.log(`\n${title}`);
  const entries = Object.entries(m).sort((a, b) => b[1] - a[1]);
  const width = Math.max(8, ...entries.map(([k]) => String(k).length));
  for (const [k, v] of entries) {
    console.log(`  ${String(k).padEnd(width)}  ${v}`);
  }
}

console.log("\n=================== PM Case Lab: build report ===================");
printTable("Cases per track:", tally(cleanCases, (c) => c.track));
printTable("Cases per type:", tally(cleanCases, (c) => c.type));
printTable("Cases per difficulty:", tally(cleanCases, (c) => `difficulty ${c.difficulty}`));
printTable("Cases per region:", tally(cleanCases, (c) => c.region));

console.log(`\nSchedule:`);
console.log(`  epoch:            ${EPOCH_STR}`);
console.log(`  length:           ${scheduleLength} days (${scheduleLength / 7} weeks)`);
console.log(`  review (null) days: ${days.filter((d) => d === null).length}`);
console.log(`  case days:        ${days.filter((d) => d !== null).length}`);
if (relaxedSlots > 0) {
  console.log(`  note: ${relaxedSlots} slot(s) could not fully satisfy the "no repeat type"/"no company within 14 days" constraints — expected with a library this small; re-run after adding more packs.`);
}
console.log("===================================================================\n");

console.log(`[build-cases] wrote data/cases.json (${cleanCases.length} cases) and data/schedule.json (${scheduleLength} days)`);
