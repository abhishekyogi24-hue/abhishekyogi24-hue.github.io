// Cloudflare Worker — RAG backend for Abhi AI, the portfolio chatbot.
// The ANTHROPIC_API_KEY lives here as a secret (set via `wrangler secret put`),
// never in the browser. See chatbot-worker/README.md for deploy steps.
//
// Routes (deliberately UI-agnostic so a future voice interface can reuse the
// same retrieval/generation without any of this being iframe/chat-specific):
//   POST /chat       { messages[], style?: "text"|"voice" } -> { reply, mode, sources[] }
//   POST /retrieve   { query, k? } -> { chunks[] }   (retrieval only, no LLM call)
//   POST /live-case  { caseText, framework, classifier, speakWpm, stream? } -> { answer } or SSE
//                    Powers Case Lab's Live tab ("Get answer"). See live-case-prompt.js.
//   GET  /health     -> { ok: true }
//   GET  /kb-meta    -> { chunkCount, sources }

import { corsHeaders, originAllowed } from "./cors.js";
import { loadKB } from "./kb.js";
import { selectContext } from "./retrieve.js";
import { buildSystemPrompt, buildUserContextBlock } from "./prompt.js";
import { LIVE_CASE_SYSTEM, buildLiveCaseUserBlock } from "./live-case-prompt.js";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 768;
const VOICE_MAX_TOKENS = 250; // shorter cap for spoken replies — nobody wants TTS reading a monologue
const MAX_MESSAGES = 24; // cap conversation length forwarded upstream
const MAX_CHARS = 4000; // cap per-message length
const RATE_LIMIT_PER_DAY = 60; // per IP, only enforced if RATE_LIMIT_KV is bound

// Live case ("Get answer") is ~10x costlier per call than /chat (a full 45-min
// stage-by-stage answer vs a short chat reply), so it gets its own, much
// tighter daily bucket rather than sharing /chat's counter or limit.
const LIVE_MAX_CASE_CHARS = 4000;
const LIVE_MAX_STAGES = 12;
const LIVE_MAX_RUBRIC_ROWS = 10;
const LIVE_MAX_TOKENS = 8000;
const LIVE_RATE_LIMIT_PER_DAY = 20;

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function extractiveFallback(retrieved, cors) {
  const top = retrieved[0];
  if (!top) {
    return json(
      {
        reply:
          "I'm having trouble reaching my full knowledge base right now — try emailing abhishekyogi.24@gmail.com or checking his LinkedIn.",
        mode: "extractive",
        degraded: true,
        sources: [],
      },
      200,
      cors
    );
  }
  return json(
    {
      reply: top.text,
      mode: "extractive",
      degraded: true,
      sources: [{ id: top.id, headingPath: top.headingPath, sourceUrl: top.sourceUrl }],
    },
    200,
    cors
  );
}

// Rate limiting is optional: if no KV namespace is bound (RATE_LIMIT_KV in
// wrangler.toml), this silently no-ops rather than breaking the worker.
// `prefix` keeps /chat and /live-case in separate buckets with separate
// limits, since a live-case call costs roughly 10x a chat call.
async function checkRateLimit(env, request, prefix = "rl", limit = RATE_LIMIT_PER_DAY) {
  if (!env.RATE_LIMIT_KV) return { ok: true };
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const key = `${prefix}:${ip}:${day}`;
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= limit) return { ok: false };
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // FIX (was a real bug): the old check was
    // `if (origin && !ALLOWED_ORIGINS.includes(origin))`, which let a
    // request with NO Origin header (curl, scripts, server-side callers)
    // skip the check entirely and reach the Anthropic API unrestricted.
    // Every non-OPTIONS request now needs a present, allow-listed Origin.
    if (!originAllowed(origin)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/kb-meta" && request.method === "GET") {
      const chunks = await loadKB();
      const sources = {};
      for (const c of chunks) sources[c.source] = (sources[c.source] || 0) + 1;
      return json({ chunkCount: chunks.length, sources }, 200, cors);
    }

    if (url.pathname === "/retrieve" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400, cors);
      }
      const query = typeof body.query === "string" ? body.query.slice(0, MAX_CHARS) : "";
      if (!query) return json({ error: "Missing query" }, 400, cors);

      const chunks = await loadKB();
      const { canonical, retrieved } = selectContext(chunks, query);
      const combined = [...canonical, ...retrieved].map((c) => ({
        id: c.id,
        headingPath: c.headingPath,
        source: c.source,
        sourceUrl: c.sourceUrl,
        text: c.text,
      }));
      return json({ chunks: combined }, 200, cors);
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      const rl = await checkRateLimit(env, request);
      if (!rl.ok) {
        return json({ error: "Rate limit exceeded — please try again tomorrow." }, 429, cors);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400, cors);
      }

      let messages = Array.isArray(body.messages) ? body.messages : [];
      messages = messages
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim().length > 0
        )
        .slice(-MAX_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

      if (messages.length === 0) {
        return json({ error: "No messages" }, 400, cors);
      }

      const style = body.style === "voice" ? "voice" : "text";
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const query = lastUser ? lastUser.content : "";

      const chunks = await loadKB();
      const { canonical, retrieved } = selectContext(chunks, query);
      const system = buildSystemPrompt(canonical, style);

      // Retrieved context goes into the latest user turn, NOT the system
      // prompt — that keeps the system prompt byte-identical across
      // requests so prompt caching (cache_control below) actually helps.
      const lastIndex = messages.length - 1;
      const messagesWithContext = messages.map((m, i) =>
        i === lastIndex && m.role === "user"
          ? { role: m.role, content: buildUserContextBlock(retrieved, m.content) }
          : m
      );

      let upstream;
      try {
        upstream = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: style === "voice" ? VOICE_MAX_TOKENS : MAX_TOKENS,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            messages: messagesWithContext,
          }),
        });
      } catch (e) {
        // Network failure reaching Anthropic — degrade to extractive rather
        // than erroring, per the "never breaks" principle.
        return extractiveFallback(retrieved, cors);
      }

      if (!upstream.ok) {
        return extractiveFallback(retrieved, cors);
      }

      const data = await upstream.json();
      const reply = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      return json(
        {
          reply: reply || "Sorry, I couldn't generate a response.",
          mode: "rag",
          sources: retrieved.map((c) => ({ id: c.id, headingPath: c.headingPath, sourceUrl: c.sourceUrl })),
        },
        200,
        cors
      );
    }

    if (url.pathname === "/live-case" && request.method === "POST") {
      const rl = await checkRateLimit(env, request, "rlc", LIVE_RATE_LIMIT_PER_DAY);
      if (!rl.ok) {
        return json({ error: "Daily limit reached for live case answers. Try again tomorrow.", code: "rate_limited" }, 429, cors);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON", code: "bad_json" }, 400, cors);
      }

      const caseText = typeof body.caseText === "string" ? body.caseText.trim().slice(0, LIVE_MAX_CASE_CHARS) : "";
      if (!caseText) return json({ error: "Missing case text", code: "empty_case" }, 400, cors);

      const framework = body.framework && typeof body.framework === "object" ? body.framework : {};
      if (!Array.isArray(framework.stages) || framework.stages.length === 0) {
        return json({ error: "Missing framework stages", code: "bad_framework" }, 400, cors);
      }
      // Defensive clamps on top of live-case-prompt.js's own per-field clamping —
      // this payload comes from the browser, even though it's normally just the
      // site's own data/frameworks.json passed straight through.
      framework.stages = framework.stages.slice(0, LIVE_MAX_STAGES);
      if (Array.isArray(framework.rubric)) framework.rubric = framework.rubric.slice(0, LIVE_MAX_RUBRIC_ROWS);

      const classifier = body.classifier && typeof body.classifier === "object" ? body.classifier : {};
      const speakWpm = typeof body.speakWpm === "number" ? body.speakWpm : 130;
      const wantsStream = body.stream !== false; // default true

      const userBlock = buildLiveCaseUserBlock({ caseText, framework, classifier, speakWpm });

      let upstream;
      try {
        upstream = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: LIVE_MAX_TOKENS,
            thinking: { type: "disabled" }, // avoid a long silent stall before the first token — see comment below
            system: [{ type: "text", text: LIVE_CASE_SYSTEM, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: userBlock }],
            stream: wantsStream,
          }),
        });
      } catch (e) {
        return json({ error: "Couldn't reach the answer service.", code: "upstream_unreachable" }, 502, cors);
      }

      if (!upstream.ok || !upstream.body) {
        let detail = "";
        try { detail = await upstream.text(); } catch {}
        return json({ error: "The answer service returned an error.", code: "upstream_failed", upstreamStatus: upstream.status, detail: detail.slice(0, 500) }, 502, cors);
      }

      if (wantsStream) {
        // Pass the Anthropic SSE body straight through — the client parses
        // content_block_delta events itself. No transformation needed.
        return new Response(upstream.body, {
          status: 200,
          headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }

      const data = await upstream.json();
      const answer = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!answer) return json({ error: "No answer generated.", code: "empty_answer" }, 502, cors);
      return json({ answer, model: MODEL }, 200, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  },
};
