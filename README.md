# abhishekyogi.in

My personal site and PM portfolio — a static site with no framework and no build
step, plus a from-scratch RAG chatbot and a couple of standalone tools that live in
this same repo.

**Live:** https://abhishekyogi.in

## What's in here

- **The site** — `index.html`, `experience.html`, `resume.html`, `project.html`,
  `skills.html`, `contact.html`. Plain HTML/CSS/vanilla JS, shared `style.css` with
  CSS custom-property theming (light/dark, follows system or a manual toggle).
- **`v2/`** — an alternate dark-editorial design of the same site. Its "Selected
  Work" section is fetched live from `project.html` at load, so both designs stay in
  sync from one source of project data instead of two copies that can drift apart.
- **`chatbot-worker/`** — the backend for **Abhi AI**, the chat widget on every
  page. A Cloudflare Worker doing real BM25 retrieval over a knowledge base, not a
  scripted FAQ bot. See below.
- **`kb/` + `tools/build_kb.py`** — the knowledge base pipeline: turns
  `kb/sources/*.md` plus the site's own HTML pages and résumé PDF into the chunked,
  indexed JSON the Worker retrieves from.
- **`job-radar/`** — a self-updating job-hunt dashboard with its own scheduled
  GitHub Actions workflow. [Its own README](job-radar/README.md) has the details.
- **`plant-protector.html`** — a standalone, bring-your-own-API-key plant
  diagnosis tool. Single file, no build step, no backend.

## Abhi AI — the chatbot

Most portfolio chatbots are scripted keyword-matchers. This one actually retrieves:

- **Real BM25 retrieval** (`chatbot-worker/src/retrieve.js`), not a hardcoded
  intent list.
- **Canonical-facts precedence** — a small set of verified facts (`core.md`) is
  *always* included in every request regardless of retrieval ranking, and the
  prompt instructs the model that these silently override anything conflicting
  that got retrieved.
- **A 4-tier fallback ladder** in `chatbot.html`: full RAG via the deployed Worker
  → the Worker's own extractive degrade if the Anthropic API call fails →
  client-side IDF-weighted lexical search over a lite index if the Worker itself is
  unreachable → a hardcoded contact-info floor. The chat never just dies.
- **Prompt caching** on the system-prompt block, since the persona + canonical
  facts stay byte-identical across requests — retrieved context goes in the user
  message instead, specifically so the cacheable block never has to be rebuilt.
- **Voice mode** — browser-native `SpeechRecognition` + `speechSynthesis`, zero
  extra API cost, tap-to-talk.

## Deploy

- **Site:** GitHub Pages, custom domain (`abhishekyogi.in`, apex + `www` both
  routed via `CNAME`), deployed by the default Pages Actions workflow on every push
  to `main`.
- **Job Radar refresh:** a custom scheduled workflow
  (`.github/workflows/refresh-jobs.yml`) — cron on weekday mornings, plus a manual
  `workflow_dispatch` trigger — that sweeps job boards, verifies postings, and
  commits `job-radar/jobs.json` back to the repo if it changed.
- **Chatbot backend:** a Cloudflare Worker (`chatbot-worker/`), deployed with
  `wrangler`. The Anthropic API key is a Worker secret, never in the repo; CORS is
  origin-allowlisted so the API key can't be used from an arbitrary site.

## Stack

Vanilla HTML/CSS/JS · Cloudflare Workers · Anthropic API (Claude) · GitHub Actions ·
GitHub Pages with a custom domain.

## Built solo, vibe-coded

Built and iterated end-to-end with Claude Code — architecture planned up front
(retrieval design, fallback ladder, canonical-facts precedence), then built,
evaluated against real queries, and shipped. Bugs were found the way they'd be
found on any real product: a user-reported screenshot showing the chatbot
misidentifying its own owner led to adding IDF weighting and an identity-question
fast path; a native browser tooltip overlapping the chat CTAs got caught and fixed
the same way. Nothing here shipped on vibes alone — everything customer-facing was
checked against real behavior before being called done.
