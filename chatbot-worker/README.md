# Portfolio Chatbot Worker

A tiny Cloudflare Worker that proxies the portfolio chatbot to the Anthropic
(Claude) API. It exists so the `ANTHROPIC_API_KEY` stays a server-side secret
and never ships to the browser on the public GitHub Pages site.

Model: **Claude Sonnet 5** (`claude-sonnet-5`). The worker injects a system
prompt grounding every answer in Abhishek's resume/portfolio, restricts calls
to the portfolio origin, and caps conversation length.

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

Commit and push. That's it — the chatbot now returns real Opus answers.

Until `WORKER_URL` is set (or if the worker is ever unreachable), the chatbot
automatically falls back to its built-in scripted knowledge base, so the site
never breaks.

## Cost

Pay-per-use on your Anthropic key. Each chat is a few hundred to ~2K tokens;
at Sonnet 5 pricing ($3 / $15 per 1M input/output tokens — currently $2 / $10
introductory through 2026-08-31) that's a fraction of a cent per conversation.
The `MAX_MESSAGES` / `MAX_TOKENS` caps in `worker.js` bound the spend per
request. Cloudflare Workers' free tier covers 100,000 requests/day.

## Security notes

- The API key is a Cloudflare secret, never in the repo or the browser.
- `ALLOWED_ORIGINS` in `worker.js` restricts who can call the worker — update
  it if your site's domain changes.
- Messages are sanitized and length-capped before being forwarded upstream.
