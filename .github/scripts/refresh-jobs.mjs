// Refreshes job-radar/jobs.json with fresh, verified fully-remote PM/AI-PM roles.
// Source: LinkedIn's unauthenticated guest API. Each candidate posting is opened and only
// kept if its structured data marks it remote (jobLocationType: TELECOMMUTE). Free-to-apply
// only (LinkedIn direct). Never overwrites with an empty/tiny list, so a bad LinkedIn day
// keeps yesterday's board instead of emptying it.

import { writeFileSync, readFileSync } from "node:fs";

const OUT = "job-radar/jobs.json";
const KEYWORDS = [
  "AI product manager", "product manager", "senior product manager",
  "technical product manager", "growth product manager", "product owner",
];
const UA = { "User-Agent": "Mozilla/5.0 (compatible; JobRadarBot/1.0; +https://abhishekyogi.in)" };
const MAX_VERIFY = 60;      // cap posting fetches to stay polite / avoid rate limits
const WINDOW_H = 168;       // rolling board window: keep verified-remote roles from the last 7 days
const F_TPR = "r604800";    // LinkedIn "posted in last 7 days" filter
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) =>
  (s || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#x2013;|&#8211;/g, "–").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// Lowercased plain text of the job-description block only (scoped so page nav/footer
// "remote jobs" links don't cause false positives).
function descText(html) {
  const i = html.indexOf("show-more-less-html__markup");
  if (i < 0) return "";
  return html.slice(i, i + 6000).replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").toLowerCase();
}

const senOf = (t) => /principal|staff|\blead\b|group|head/i.test(t) ? "Lead"
  : /senior|\bsr[.\s]/i.test(t) ? "Senior" : "PM";
const aiOf = (t) => /\bAI\b|\bML\b|agentic|\bLLM\b|machine learning|generative/i.test(t);

const TITLE_OK = /product manager|product owner/i;
const TITLE_BAD = /intern|internship|director|vice president|\bVP\b|head of/i;

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return { posted: "recent", hrs: 99 };
  const hrs = (Date.now() - then) / 3.6e6;
  const posted = hrs < 1 ? "just now" : hrs < 24 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
  return { posted, hrs };
}

async function search(kw, start) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=India&f_TPR=${F_TPR}&start=${start}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return [];
  const html = await res.text();
  const cards = html.split("<li>").slice(1);
  const out = [];
  for (const c of cards) {
    const u = (c.match(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1];
    const title = clean((c.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
    if (!u || !title) continue;
    const id = (u.match(/(\d+)$/) || [])[1] || u;
    out.push({ id, url: u, title });
  }
  return out;
}

// Open a posting and keep it only if its JSON-LD marks it remote (TELECOMMUTE) and it's <48h old.
async function verify(job) {
  let res;
  try { res = await fetch(job.url, { headers: UA }); } catch { return null; }
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let ld;
  try { ld = JSON.parse(m[1]); } catch { return null; }
  if (Array.isArray(ld)) ld = ld.find((x) => x["@type"] === "JobPosting") || ld[0];
  if (!ld || ld["@type"] !== "JobPosting") return null;

  const { posted, hrs } = relTime(ld.datePosted);
  if (hrs > WINDOW_H) return null; // window guard (7 days)

  // Remote check: structured TELECOMMUTE flag OR explicit remote phrasing in the description
  // (and no hybrid/on-site wording). Calibrated against known remote & on-site postings.
  const d = descText(html);
  const strong = /\bfully remote\b|100%\s*remote|work from home|\bwfh\b|remote[- ]first|work from anywhere|remote\s*\(?\s*(india|anywhere|global|worldwide)|this (is|role is)[^.]{0,40}remote|position is remote|is a remote/i.test(d);
  const bad = /\bhybrid\b|on[- ]?site|in[- ]?office|in office|work from office/i.test(d);
  const remote = ld.jobLocationType === "TELECOMMUTE" || (strong && !bad);
  if (!remote) return null; // not confirmably remote -> drop

  const title = clean(ld.title || job.title);
  const company = clean(ld.hiringOrganization?.name || "");
  // Region: if the posting states applicant-location requirements, respect them; else assume India-eligible
  // (the search is India-scoped). Worldwide-remote -> "world".
  let region = "india";
  const alr = ld.applicantLocationRequirements;
  const alrName = Array.isArray(alr) ? alr.map((a) => a?.name).join(", ") : alr?.name;
  if (alrName && !/india/i.test(alrName)) region = /worldwide|anywhere/i.test(alrName) ? "world" : "india";

  return {
    title, company: company || "—", sen: senOf(title), ai: aiOf(title),
    region, workplace: "remote", days: hrs < 24 ? 0 : 1, new24: hrs < 24,
    posted, dt: ld.datePosted, verified: true, note: "", source: "LinkedIn", url: job.url,
  };
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
      await sleep(800);
    }
  }
  console.log("candidates:", cands.length);

  const jobs = [];
  for (const j of cands.slice(0, MAX_VERIFY)) {
    const v = await verify(j);
    if (v) jobs.push(v);
    await sleep(700);
  }
  // Dedupe by company+title, freshest first.
  const uniq = [];
  const key = new Set();
  jobs.sort((a, b) => (a.days - b.days));
  for (const j of jobs) {
    const k = (j.company + "|" + j.title).toLowerCase();
    if (!key.has(k)) { key.add(k); uniq.push(j); }
  }
  console.log("verified fully-remote (this run):", uniq.length);

  // Rolling board: merge with the existing file, age out anything older than the window, and
  // recompute the relative "posted" label from the absolute date so labels never go stale.
  // Fresh data wins on duplicate URLs.
  let existing = [];
  try { existing = JSON.parse(readFileSync(OUT, "utf8")).jobs || []; } catch { /* none */ }
  const byUrl = new Map();
  for (const j of existing) if (j.url) byUrl.set(j.url, j);
  for (const j of uniq) byUrl.set(j.url, j);
  const now = Date.now();
  const merged = [];
  for (const j of byUrl.values()) {
    if (!j.dt) continue;                                 // drop legacy entries with no timestamp
    const hrs = (now - new Date(j.dt).getTime()) / 3.6e6;
    if (hrs > WINDOW_H) continue;                         // age out beyond the 7-day window
    const posted = hrs < 1 ? "just now" : hrs < 24 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
    merged.push({ ...j, posted, new24: hrs < 24, days: hrs < 24 ? 0 : 1 });
  }
  merged.sort((a, b) => new Date(b.dt) - new Date(a.dt));
  const board = merged.slice(0, 40);
  if (!board.length) { console.log("nothing within window — leaving jobs.json untouched."); return; }
  const payload = { generatedAt: new Date().toISOString(), source: "github-action", jobs: board };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`published ${board.length} roles (${uniq.length} newly verified this run)`);
}

// Exit 0 even on error so the workflow doesn't fail loudly; no write => no commit => yesterday's board stays.
main().catch((e) => { console.error("refresh failed:", e); });
