# PM Case Lab

A daily PM case-study practice tool. A curated library of real-world product cases, one served per day, emailed each morning at 8am IST, with a practice site at [abhishekyogi.in/case-lab/](https://abhishekyogi.in/case-lab/).

## Why

Most interview prep is either a huge, unstructured list of "practice questions" or a handful of frameworks you read once and forget. Case Lab does neither: it's a fixed library of real cases, each one graded against a published or purpose-built framework, served one a day so prep is a habit rather than a cram session — plus a 75-question behavioural bank for the "tell me about a time" half of the loop.

## The four frameworks

Every case is scored against exactly one of four frameworks, defined once in `data/frameworks.json` — stages, timing, and a weak/solid/strong rubric per dimension. A case never repeats or overrides this; it only supplies a `modelAnswer.stages` walkthrough that maps onto its framework's stages.

- **`product-sense`** — from Lenny Rachitsky's guide to mastering product-sense interviews. Five stages: Clear Communication, Product Motivation, Segmentation, Problem Identification, Solution Development.
- **`analytical`** — from Lenny's guide to mastering analytical-thinking interviews. Four stages: Assumptions & Game Plan, Product Rationale, Metric Framework, Goal-Setting.
- **`rca`** — authored for this tool, because root-cause-analysis cases have no equivalent published framework. Seven stages taking a metric drop from Clarify & Quantify through Is It Real?, Segment the Drop, Internal/External Causes, Converge, and Act.
- **`ai-product`** — also authored for this tool, for the same reason. Its first two stages deliberately mirror `product-sense`/`analytical` for consistency, then diverge into AI-specific stages: Why AI, Segmentation & Error Tolerance, System Design, UX for Probabilistic Output, Evals & Quality Bar, and Metrics/Guardrails/Economics.

There's also a `cross-cutting` framework in the same file — it's not a fifth framework, it just `inherits` the `product-sense` stages and rubric for cases that span multiple products or a platform decision that doesn't fit neatly into one track.

## Adding cases

Drop a new file at `data/packs/<name>.json` shaped like:

```json
{ "pack": "<name>", "cases": [ { ... }, { ... } ] }
```

then rebuild (see below). `data/packs/seed.json` has eight fully worked examples across all four frameworks — copy the closest one as a starting point.

Each case needs these fields:

| Field | Notes |
|---|---|
| `id` | `^[a-z]+-[a-z0-9]+-\d{3}$`, e.g. `ps-improve-001`. Must be globally unique across all packs. |
| `track` | One of `product-sense`, `analytical`, `ai-product`, `cross-cutting`. |
| `framework` | Must exist as a key in `data/frameworks.json`. |
| `type` | One of the fixed case types in `build-cases.mjs` (`rca`, `funnel`, `pricing`, `ai-0to1`, etc.) — see the `VALID_TYPES` set in that file for the full list. |
| `title`, `company` (array), `region`, `industry` | Descriptive fields. `company` must be a non-empty array even for a single company. |
| `difficulty` | Integer 1-3. |
| `timeboxMin` | Minutes allotted. |
| `prompt` | The question as the interviewer would actually ask it. |
| `context` | Non-empty array of **publicly verifiable facts only** — things you could footnote to a launch date, an earnings call, a press release. Nothing invented here. |
| `assumptions` | Array of scoping assumptions the model answer makes. **Any assumption containing a number that isn't public must be prefixed `"assumed: "`** (e.g. `"assumed: roughly a quarter of the active base"`). This is enforced by the build script — anything with a digit and no prefix fails the build. |
| `followUps` | 2-4 interviewer follow-up questions. |
| `modelAnswer.stages` | Array of `{ stage, walkthrough }`, where `stage` names must match, **in order**, the stage names of the case's framework. A mismatch fails the build with a diff of expected vs. actual. |
| `pitfalls` | Array of ways candidates blow this specific case. |
| `related` | Array of related case ids (can be empty). |

The two rules that matter most, worth repeating: **`context` is public record, `assumptions` is invented and must say so.** This is what keeps the library honest — a candidate (or the person emailing themselves this case every morning) should never mistake a made-up number for a real one.

## Rebuilding

Both build scripts are zero-dependency Node ESM — no `npm install` needed.

```bash
node tools/build-cases.mjs
```

Reads `data/frameworks.json` + every file in `data/packs/`, validates every case (required fields, id shape and uniqueness, valid track/framework/type, the `assumed:` prefix rule, and that `modelAnswer.stages` matches its framework's stages in order), then writes:

- `data/cases.json` — the flattened, validated case library.
- `data/schedule.json` — a full day-by-day schedule (see below).

It fails loudly (exit code 1, message prefixed `[build-cases] FAILED:`) on any schema or framework-conformance error, so a bad pack can't silently ship. It also prints a distribution report (cases per track/type/difficulty/region) and schedule stats after a successful build.

```bash
node tools/build-stories.mjs
```

Reads `data/stories.json` (behavioural STAR stories, authored separately) against `data/behavioural.json`'s themes, and writes `data/coverage.json` — for each of the 27 behavioural themes, which story ids cover it and whether it's a gap. Both inputs are optional while the story bank is still being authored; if either file is missing, this script prints a message and exits 0 rather than failing.

## How the daily case is chosen

`data/schedule.json` is a flat array: `days[n]` is the case id (or `null`) for day `n` after the epoch date (`2026-09-15`, in Asia/Kolkata). Both the site (`index.html`) and the Apps Script compute the same `dayIndex` — days elapsed since the epoch, in IST — and index into the same array. Neither one contains scheduling logic beyond that lookup, so they cannot drift apart.

Inside the build script, the schedule is generated deterministically (seeded, so rebuilds are stable): each week's six non-Sunday slots are apportioned across tracks in proportion to the library's actual track mix, difficulty ramps from 1 to 3 across each 4-week block (Saturday is always difficulty 3), and the picker avoids repeating a case `type` two days in a row or a `company` within 14 days, wherever the library is large enough to allow it.

**Sundays are always `null`** — that's a review digest day, not a case day.

## Local testing

```bash
python3 -m http.server 8080
```

then open `http://localhost:8080/case-lab/`.

Don't open `index.html` directly via `file://` — the app uses `localStorage` for notes, scores, and status tracking, and browsers block `localStorage` on the `file://` origin. You won't get an error, you'll just get silent no-ops, which is more confusing than an outright failure. Always serve it over `http://` locally.

## The email

`CaseLabAppsScript.gs` is a Google Apps Script that emails the day's case (or Sunday's review digest) each morning. One-time setup:

1. Paste the script into a new project at [script.google.com](https://script.google.com).
2. Set the **project time zone to India Standard Time** — the script's day-index math and trigger timing both depend on this.
3. Run `setupDailyTrigger` once, manually, from the Apps Script editor.

After that it runs unattended via a time-driven trigger.

## Where data lives

**Everything you write in the app — case notes, self-scores, behavioural-question answers, status tags — lives only in your browser's `localStorage`. Nothing is synced anywhere.** The Export JSON button in the app is the only backup mechanism.

This is a real limitation, not a footnote: clear your browser data, switch browsers, or switch devices, and your history is gone unless you exported it first. Export regularly if you're actually relying on the practice history.

## Stack

Vanilla HTML/CSS/JS (client-side, no build step for the site itself) · zero-dependency Node scripts for data validation and scheduling · Google Apps Script (MailApp + time-driven triggers) for the daily email · `localStorage` for all user state.
