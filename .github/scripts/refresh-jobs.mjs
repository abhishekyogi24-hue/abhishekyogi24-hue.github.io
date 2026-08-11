// Refreshes job-radar/jobs.json with fresh, remote PM/AI-PM roles for India.
//
// Remote signal: LinkedIn's own remote filter (f_WT=2) on the search. LinkedIn's guest DETAIL
// pages do not expose a workplace-type field, so we trust the search-level remote classification
// and additionally DROP a role only if its description explicitly says hybrid / on-site / in-person
// / non-remote (catches the occasional mis-tag). Date comes from the card's <time datetime>.
// Rolling 7-day window; never publishes an empty board.

import { writeFileSync, readFileSync } from "node:fs";

const OUT = "job-radar/jobs.json";
const KEYWORDS = [
  "AI product manager", "product manager", "senior product manager",
  "technical product manager", "growth product manager", "product owner",
];
const UA = { "User-Agent": "Mozilla/5.0 (compatible; JobRadarBot/1.0; +https://abhishekyogi.in)" };
const F_TPR = "r604800";  // posted in last 7 days
const WINDOW_H = 168;     // rolling window (7 days)
const MAX_CHECK = 80;     // cap description-contradiction fetches
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) =>
  (s || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#x2013;|&#8211;/g, "–").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

const senOf = (t) => /principal|staff|\blead\b|group|head/i.test(t) ? "Lead"
  : /senior|\bsr[.\s]/i.test(t) ? "Senior" : "PM";
const aiOf = (t) => /\bAI\b|\bML\b|agentic|\bLLM\b|machine learning|generative/i.test(t);

const TITLE_OK = /product manager|product owner/i;
const TITLE_BAD = /intern|internship|director|vice president|\bVP\b|head of/i;

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return { posted: "recent", hrs: 24 };
  const hrs = (Date.now() - then) / 3.6e6;
  const posted = hrs < 1 ? "just now" : hrs < 24 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
  return { posted, hrs: hrs < 0 ? 0 : hrs };
}

// Parse the remote-filtered (f_WT=2) search cards into candidates with date + company.
async function search(kw, start) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`
    + `?keywords=${encodeURIComponent(kw)}&location=India&f_WT=2&f_TPR=${F_TPR}&start=${start}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return [];
  const cards = (await res.text()).split("<li>").slice(1);
  const out = [];
  for (const c of cards) {
    const u = (c.match(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1];
    const title = clean((c.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
    if (!u || !title) continue;
    const company = clean((c.match(/base-search-card__subtitle[\s\S]*?>([\s\S]*?)<\/h4>/) || [])[1]);
    const dt = (c.match(/datetime="([^"]+)"/) || [])[1] || "";
    const id = (u.match(/(\d+)$/) || [])[1] || u;
    out.push({ id, url: u, title, company, dt });
  }
  return out;
}

// Fetch the posting and return false only if the description explicitly contradicts remote.
// If the page can't be read, trust the f_WT=2 remote classification and keep it.
async function notContradicted(u) {
  let res;
  try { res = await fetch(u, { headers: UA }); } catch { return true; }
  if (!res.ok) return true;
  const html = await res.text();
  const i = html.indexOf("show-more-less-html__markup");
  if (i < 0) return true;
  const d = html.slice(i, i + 6000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const contradicts = /\bhybrid\b|on[- ]?site|in[- ]?office|in office|work from office|in[- ]person|non[- ]remote/i.test(d);
  return !contradicts;
}

async function main() {
  const seen = new Set();
  const cands = [];
  for (const kw of KEYWORDS) {
    for (const start of [0, 25, 50]) {
      let list = [];
      try { list = await search(kw, start); } catch { /* ignore */ }
      if (!list.length) break;
      for (const j of list) {
        if (!seen.has(j.id) && TITLE_OK.test(j.title) && !TITLE_BAD.test(j.title)) {
          seen.add(j.id); cands.push(j);
        }
      }
      await sleep(500);
    }
  }
  console.log("remote-tagged candidates:", cands.length);

  const fresh = [];
  let checked = 0;
  for (const j of cands) {
    const { posted, hrs } = relTime(j.dt);
    if (hrs > WINDOW_H) continue; // outside 7-day window
    let keep = true;
    if (checked < MAX_CHECK) { keep = await notContradicted(j.url); checked++; await sleep(400); }
    if (!keep) continue;
    const title = j.title;
    fresh.push({
      title, company: j.company || "—", sen: senOf(title), ai: aiOf(title),
      region: "india", workplace: "remote", days: hrs < 24 ? 0 : 1, new24: hrs < 24,
      posted, dt: j.dt, verified: true, note: "", source: "LinkedIn", url: j.url,
    });
  }
  console.log("kept (remote, in-window, not contradicted):", fresh.length);

  // Rolling merge: combine with existing, age out > window, recompute labels from dt.
  let existing = [];
  try { existing = JSON.parse(readFileSync(OUT, "utf8")).jobs || []; } catch { /* none */ }
  const byUrl = new Map();
  for (const j of existing) if (j.url) byUrl.set(j.url, j);
  for (const j of fresh) byUrl.set(j.url, j);
  const now = Date.now();
  const merged = [];
  for (const j of byUrl.values()) {
    if (!j.dt) continue;
    const hrs = (now - new Date(j.dt).getTime()) / 3.6e6;
    if (hrs > WINDOW_H) continue;
    const posted = hrs < 1 ? "just now" : hrs < 24 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
    merged.push({ ...j, posted, new24: hrs < 24, days: hrs < 24 ? 0 : 1 });
  }
  merged.sort((a, b) => new Date(b.dt) - new Date(a.dt));
  const board = merged.slice(0, 60);
  if (!board.length) { console.log("nothing within window — leaving jobs.json untouched."); return; }
  const payload = { generatedAt: new Date().toISOString(), source: "github-action", jobs: board };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`published ${board.length} roles (${fresh.length} from this run)`);
}

main().catch((e) => { console.error("refresh failed:", e); });
