# Abhi AI Worker

A Cloudflare Worker that powers **Abhi AI**, the RAG-backed assistant on
Abhishek's portfolio. It retrieves relevant chunks from a knowledge base built
from the site, resume, and other sources, then calls the Anthropic (Claude)
API to generate an answer grounded in that context. The `ANTHROPIC_API_KEY`
stays a server-side secret and never ships to the browser on the public
GitHub Pages site.

Model: **Claude Sonnet 5** (`claude-sonnet-5`).

## How the knowledge base works

The Worker does **not** stuff the whole corpus into every request. Instead:

1. `../tools/build_kb.py` extracts and chunks every source (site pages, resume
   PDF, hand-curated `kb/sources/core.md`, and any manually-added sources like
   `kb/sources/experience-in-detail.md` or `kb/sources/linkedin-profile.md`)
   into `../kb/kb-index.json` — a static JSON file, no database.
2. On each `/chat` or `/retrieve` request, the Worker fetches that JSON
   (cached in-memory per isolate for 5 minutes) and runs real BM25 lexical
   search over it in `src/retrieve.js` — no vector DB, no external embedding
   call, sub-millisecond at this corpus size.
3. `core.md`'s facts are tier `"canonical"` and always included in full,
   regardless of retrieval ranking — they're the verified ground truth
   ingested/uncurated sources (LinkedIn, GitHub) can never override.

**A knowledge refresh is just re-running the build script and `git push` —
no `wrangler deploy` needed**, since the Worker fetches the live JSON from the
site on its own. You only need to redeploy the Worker when the *code* changes.

```bash
# from the repo root, whenever core.md or the site content changes:
python3 tools/build_kb.py
git add kb/ && git commit -m "Refresh Abhi AI knowledge base" && git push
```

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/chat` | POST | `{ messages[], style?: "text"\|"voice" }` → `{ reply, mode, sources[] }`. Main chat endpoint. |
| `/retrieve` | POST | `{ query }` → `{ chunks[] }`. Retrieval only, no LLM call — the reusable knowledge layer for a future voice interface. |
| `/health` | GET | Liveness check. |
| `/kb-meta` | GET | `{ chunkCount, sources }` — what the Worker currently has loaded. |

## One-time deploy (~5 minutes)

Prerequisites: a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
and an [Anthropic API key](https://console.anthropic.com/).

```bash
# 1. Install the Cloudflare CLI (once)
npm install -g wrangler

# 2. Log in to Cloudflare (opens a browser)
wrangler login

# 3. From this directory, deploy the worker
cd chatbot-worker
wrangler deploy

# 4. Store your Anthropic API key as a secret (paste it when prompted)
wrangler secret put ANTHROPIC_API_KEY
```

`wrangler deploy` prints the worker URL, e.g.
`https://portfolio-chatbot.<your-subdomain>.workers.dev`.

## Wire it to the site

Open `../chatbot.html`, find the `WORKER_URL` constant near the top of the
`<script>`, and set it to the URL from step 3:

```js
var WORKER_URL = "https://portfolio-chatbot.<your-subdomain>.workers.dev";
```

Commit and push. That's it — Abhi AI now answers with real, retrieval-grounded
Sonnet 5 responses.

Until `WORKER_URL` is set (or if the Worker is ever unreachable), the widget
degrades gracefully instead of breaking — see "Never breaks" below.

## Never breaks: the fallback ladder

1. **RAG** (normal) — retrieve → Claude → answer with sources.
2. **Extractive** — if the Anthropic call fails/times out but the Worker
   itself is reachable, it returns the single best-matching chunk verbatim
   instead of erroring. Still a real, correct answer from the KB, just
   unsynthesized (`mode: "extractive"` in the response).
3. **Client-side lite KB** — if the Worker itself is unreachable (DNS, CORS,
   `WORKER_URL` unset, timeout), `chatbot.html` fetches `../kb/kb-lite.json`
   (~35 chunks) directly and scores it client-side with the same lexical
   approach.
4. **Inline floor** — if even that fetch fails, a ~15-line hardcoded bio,
   project list, and contact links in `chatbot.html` are the last resort.

## Cost

Pay-per-use on your Anthropic key. Each chat is roughly 4-6K input tokens
(canonical facts + retrieved context + conversation) and a few hundred output
tokens — at Sonnet 5 pricing ($3 / $15 per 1M input/output tokens, $2 / $10
introductory through 2026-08-31) that's a little over a cent per message.
**Set an explicit monthly spend cap in the Anthropic Console** — nothing in
this Worker enforces one on its own. The `MAX_MESSAGES` / `MAX_TOKENS` caps in
`src/worker.js` bound the size of any single request. Cloudflare Workers'
free tier covers 100,000 requests/day.

## Rate limiting (optional but recommended)

Without it, anyone who finds the Worker URL can send unlimited requests
against your API key. To enable a per-IP daily cap:

```bash
wrangler kv:namespace create RATE_LIMIT_KV
```

Then uncomment the `[[kv_namespaces]]` block in `wrangler.toml` with the id
it prints, and `wrangler deploy` again. Without this binding the Worker still
works fine (`checkRateLimit()` no-ops) — it's just unprotected.

## Security notes

- The API key is a Cloudflare secret, never in the repo or the browser.
- `ALLOWED_ORIGINS` in `src/cors.js` restricts who can call the Worker —
  update it if your site's domain changes. Every non-OPTIONS request must
  present a valid, allow-listed `Origin` header — a request with no Origin
  (curl, scripts) is rejected, not silently let through.
- Messages are sanitized and length-capped before being forwarded upstream.

## Source layout

```
chatbot-worker/
  wrangler.toml
  src/
    worker.js    entry point — routes, CORS, sanitization, upstream call
    kb.js        loads/caches kb-index.json (live fetch, bundled fallback)
    retrieve.js  BM25 retrieval, canonical-tier handling, context budgeting
    prompt.js    persona + system-prompt assembly (text/voice styles)
    cors.js      allowed-origins + CORS headers
```
