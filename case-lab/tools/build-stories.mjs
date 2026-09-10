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

if (!Array.isArray(stories)) fail(`data/stories.json must contain an array of stories (or a { "stories": [...] } wrapper)`);
if (!Array.isArray(themes)) fail(`data/behavioural.json must contain an array of themes (or a { "themes": [...] } wrapper)`);

// Validate: every story must have a non-empty sourceQuote.
for (const s of stories) {
  const ref = s && s.id ? `story "${s.id}"` : "an unidentified story";
  if (!s || typeof s.sourceQuote !== "string" || s.sourceQuote.trim().length === 0) {
    fail(`${ref}: missing or empty "sourceQuote"`);
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

const coverageOut = {
  generatedAt: new Date().toISOString(),
  themeCount: Object.keys(coverage).length,
  gapCount: Object.values(coverage).filter((c) => c.isGap).length,
  coverage
};

writeFileSync(COVERAGE_PATH, JSON.stringify(coverageOut, null, 2) + "\n");

console.log(`[build-stories] validated ${stories.length} story(ies) against ${themes.length} theme(s)`);
console.log(`[build-stories] wrote data/coverage.json (${coverageOut.gapCount} gap(s) out of ${coverageOut.themeCount} theme(s))`);
