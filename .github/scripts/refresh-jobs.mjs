// Refreshes job-radar/jobs.json with genuinely fully-remote PM/AI-PM roles for India.
//
// LinkedIn's remote tag (f_WT=2) is unreliable, so we DON'T trust it. For every candidate we open
// the posting, read the FULL job description (from JSON-LD, double-HTML-decoded), and keep it ONLY
// if the description explicitly confirms remote (or JSON-LD marks it TELECOMMUTE) AND does not say
// on-site/hybrid. Roles that merely don't mention work mode are dropped (can't be confirmed).
// Rolling 7-day window; never publishes an empty board.

import { writeFileSync, readFileSync } from "node:fs";

const OUT = "job-radar/jobs.json";
const KEYWORDS = [
  "AI product manager", "product manager", "senior product manager",
  "technical product manager", "growth product manager", "product owner",
];
const UA = { "User-Agent": "Mozilla/5.0 (compatible; JobRadarBot/1.0; +https://abhishekyogi.in)" };
const F_TPR = "r604800";  // last 7 days
const WINDOW_H = 168;     // rolling 7-day window
const MAX_VERIFY = 90;    // cap posting fetches
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

// Decode the double-HTML-encoded JSON-LD description into clean lowercase text.
function descText(descRaw) {
  return (descRaw || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// "remote" | "onsite" | "ambiguous" from the description + JSON-LD.
function classify(d, ld) {
  const onsite = /\bhybrid\b|on-?site|in[- ]office|in the office|from (the )?office|days? (in|from|at) (the )?office|in[- ]person|\brelocat|work from (our )?[a-z]+ office/i.test(d);
  const remote = ld.jobLocationType === "TELECOMMUTE"
    || /\bfully remote\b|100%\s*remote|work from home|\bwfh\b|remote[- ]first|work from anywhere|remote position|work remotely|remote work|this (role|position) is remote|location\s*[:\-]?\s*(remote|anywhere)|remote\s*\(|anywhere in india/i.test(d);
  if (remote && !onsite) return "remote";
  if (onsite) return "onsite";
  return "ambiguous";
}

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return { posted: "recent", hrs: 24 };
  const hrs = Math.max(0, (Date.now() - then) / 3.6e6);
  const posted = hrs < 1 ? "just now" : hrs < 24 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
  return { posted, hrs };
}

async function search(kw, start, wt) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`
    + `?keywords=${encodeURIComponent(kw)}&location=India${wt}&f_TPR=${F_TPR}&start=${start}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return [];
  const cards = (await res.text()).split("<li>").slice(1);
  const out = [];
  for (const c of cards) {
    const u = (c.match(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1];
    const title = clean((c.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
    if (!u || !title) continue;
    out.push({ id: (u.match(/(\d+)$/) || [])[1] || u, url: u, title });
  }
  return out;
}

async function verify(job) {
  let res;
  try { res = await fetch(job.url, { headers: UA }); } catch { return null; }
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let ld; try { ld = JSON.parse(m[1]); } catch { return null; }
  if (Array.isArray(ld)) ld = ld.find((x) => x["@type"] === "JobPosting") || ld[0];
  if (!ld || ld["@type"] !== "JobPosting") return null;

  const { posted, hrs } = relTime(ld.datePosted);
  if (hrs > WINDOW_H) return null;                    // window guard
  if (classify(descText(ld.description), ld) !== "remote") return null; // keep only confirmed-remote

  const title = clean(ld.title || job.title);
  const company = clean(ld.hiringOrganization?.name || "");
  let region = "india";
  const alr = ld.applicantLocationRequirements;
  const alrName = Array.isArray(alr) ? alr.map((a) => a?.name).join(", ") : alr?.name;
  if (alrName && /worldwide|anywhere/i.test(alrName)) region = "world";

  return {
    title, company: company || "—", sen: senOf(title), ai: aiOf(title), region, workplace: "remote",
    days: hrs < 24 ? 0 : 1, new24: hrs < 24, posted, dt: ld.datePosted,
    verified: true, note: "Remote confirmed in description", source: "LinkedIn", url: job.url,
  };
}

async function main() {
  const seen = new Set();
  const cands = [];
  for (const kw of KEYWORDS) {
    for (const wt of ["&f_WT=2", ""]) {         // remote-tagged + all, so filter false-negatives are caught too
      for (const start of [0, 25]) {
        let list = [];
        try { list = await search(kw, start, wt); } catch { /* ignore */ }
        if (!list.length) break;
        for (const j of list) {
          if (!seen.has(j.id) && TITLE_OK.test(j.title) && !TITLE_BAD.test(j.title)) { seen.add(j.id); cands.push(j); }
        }
        await sleep(300);
      }
    }
  }
  console.log("PM candidates:", cands.length);

  const fresh = [];
  for (const j of cands.slice(0, MAX_VERIFY)) {
    const v = await verify(j);
    if (v) fresh.push(v);
    await sleep(300);
  }
  console.log("description-confirmed remote:", fresh.length);

  // Rolling merge: combine with existing, age out > window, recompute labels from dt.
  let existing = [];
  try { existing = JSON.parse(readFileSync(OUT, "utf8")).jobs || []; } catch { /* none */ }
  const byUrl = new Map();
  for (const j of existing) if (j.url) byUrl.set(j.url, j);
  for (const j of fresh) byUrl.set(j.url, j);
  const now = Date.now();
  const merged = [];
  for (const j of byUrl.values()) {
    if (!j.dt || j.note !== "Remote confirmed in description") continue; // only keep confirmed entries
    const hrs = (now - new Date(j.dt).getTime()) / 3.6e6;
    if (hrs > WINDOW_H) continue;
    const posted = hrs < 1 ? "just now" : hrs < 24 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
    merged.push({ ...j, posted, new24: hrs < 24, days: hrs < 24 ? 0 : 1 });
  }
  merged.sort((a, b) => new Date(b.dt) - new Date(a.dt));
  const board = merged.slice(0, 60);
  if (!board.length) { console.log("nothing confirmed within window — leaving jobs.json untouched."); return; }
  const payload = { generatedAt: new Date().toISOString(), source: "github-action", jobs: board };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`published ${board.length} confirmed-remote roles (${fresh.length} from this run)`);
}

main().catch((e) => { console.error("refresh failed:", e); });
