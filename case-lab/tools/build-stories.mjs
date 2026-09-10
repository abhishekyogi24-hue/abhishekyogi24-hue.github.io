#!/usr/bin/env node
// build-stories.mjs — reads data/stories.json (authored by another agent) and
// data/behavioural.json, and writes data/coverage.json: for each behavioural
// theme, which story ids cover it and whether it's a gap.
//
// Node ESM, zero dependencies. Run with: node tools/build-stories.mjs
//
// Both inputs are optional while the story bank hasn't been authored yet —
// in that case this prints a message and exits 0 rather than failing the
// build.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const STORIES_PATH = path.join(DATA_DIR, "stories.json");
const BEHAVIOURAL_PATH = path.join(DATA_DIR, "behavioural.json");
const COVERAGE_PATH = path.join(DATA_DIR, "coverage.json");

function fail(msg) {
  console.error(`\n[build-stories] FAILED: ${msg}\n`);
  process.exit(1);
}

function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`could not read/parse ${path.relative(ROOT, filePath)}: ${err.message}`);
  }
}

if (!existsSync(STORIES_PATH) || !existsSync(BEHAVIOURAL_PATH)) {
  console.log("[build-stories] data/stories.json and/or data/behavioural.json not yet authored, skipping.");
  process.exit(0);
}

const storiesFile = readJSON(STORIES_PATH);
const behaviouralFile = readJSON(BEHAVIOURAL_PATH);

const stories = Array.isArray(storiesFile) ? storiesFile : storiesFile.stories;
const themes = Array.isArray(behaviouralFile) ? behaviouralFile : behaviouralFile.themes;
const questions = Array.isArray(behaviouralFile) ? [] : (behaviouralFile.questions || []);

if (!Array.isArray(stories)) fail(`data/stories.json must contain an array of stories (or a { "stories": [...] } wrapper)`);
if (!Array.isArray(themes)) fail(`data/behavioural.json must contain an array of themes (or a { "themes": [...] } wrapper)`);

const questionIds = new Set(questions.map((q) => q.id));

// Validate: every story must have a non-empty sourceQuote, and every id in a
// story's questionTags (which behavioural questions this story can answer)
// must reference a real question in data/behavioural.json.
for (const s of stories) {
  const ref = s && s.id ? `story "${s.id}"` : "an unidentified story";
  if (!s || typeof s.sourceQuote !== "string" || s.sourceQuote.trim().length === 0) {
    fail(`${ref}: missing or empty "sourceQuote"`);
  }
  if (s.questionTags !== undefined) {
    if (!Array.isArray(s.questionTags)) fail(`${ref}: "questionTags" must be an array of question ids`);
    for (const qid of s.questionTags) {
      if (!questionIds.has(qid)) fail(`${ref}: questionTags references unknown question id "${qid}"`);
    }
  }
}

// Each theme is expected to look like { "key": "...", "label": "...", ... }
// and each story is expected to carry the theme keys it covers, e.g.
// story.themes = ["ownership", "conflict"].
const coverage = {};
for (const theme of themes) {
  const key = typeof theme === "string" ? theme : theme.key;
  if (!key) continue;
  const coveringStories = stories
    .filter((s) => Array.isArray(s.themes) && s.themes.includes(key))
    .map((s) => s.id);
  coverage[key] = {
    label: typeof theme === "string" ? theme : (theme.label || theme.key),
    storyIds: coveringStories,
    isGap: coveringStories.length === 0
  };
}

// Question-level coverage: for each behavioural question, which stories are
// authored (via questionTags) as usable answers to it. This is the granular
// counterpart to the theme-level coverage above — a story can answer a
// specific question in a theme it isn't the primary fit for.
const questionCoverage = {};
for (const q of questions) {
  const coveringStories = stories.filter((s) => Array.isArray(s.questionTags) && s.questionTags.includes(q.id)).map((s) => s.id);
  questionCoverage[q.id] = { theme: q.theme || null, storyIds: coveringStories, isGap: coveringStories.length === 0 };
}
const taggedStoryCount = stories.filter((s) => Array.isArray(s.questionTags) && s.questionTags.length > 0).length;

const coverageOut = {
  generatedAt: new Date().toISOString(),
  themeCount: Object.keys(coverage).length,
  gapCount: Object.values(coverage).filter((c) => c.isGap).length,
  coverage,
  questionCount: questions.length,
  questionGapCount: Object.values(questionCoverage).filter((c) => c.isGap).length,
  questionCoverage
};

writeFileSync(COVERAGE_PATH, JSON.stringify(coverageOut, null, 2) + "\n");

console.log(`[build-stories] validated ${stories.length} story(ies) against ${themes.length} theme(s)`);
console.log(`[build-stories] wrote data/coverage.json (${coverageOut.gapCount} theme gap(s) out of ${coverageOut.themeCount} theme(s))`);
if (questions.length) {
  console.log(`[build-stories] question-level: ${taggedStoryCount}/${stories.length} stories tagged, ${coverageOut.questionGapCount}/${coverageOut.questionCount} questions have no suggested story`);
}
