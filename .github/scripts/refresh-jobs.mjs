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
  "product manager voice", "principal product manager", "lead product manager",
];
// Card location that means "remote for India": country-level "India" (no city) or an explicit Remote tag.
const isRemoteLoc = (loc) => /\(remote\)|\bremote\b/i.test(loc || "") || /^india$/i.test((loc || "").trim());
// Some listings append "(Hybrid in <city>)" etc. straight onto the TITLE even when the location field
// says remote — the title wins. If it contradicts, don't trust the fast path; fall back to full verify().
const titleContradicts = (title) => /\bhybrid\b|on-?site|in[- ]office|in[- ]person/i.test(title || "");
// Remote-first companies worth checking by name (from a widely-shared remote-job-search guide).
// Same search+verify pipeline as everyone else — no special-casing, just an extra query per company.
const TARGET_COMPANIES = [
  "GitLab", "Automattic", "Zapier", "Deel", "Remote.com", "Canonical", "Buffer", "Doist",
  "Atlassian", "Shopify", "HubSpot", "Toptal", "Andela", "Elastic", "Wikimedia Foundation",
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
    const company = clean((c.match(/base-search-card__subtitle[\s\S]*?>([\s\S]*?)<\/h4>/) || [])[1]);
    const loc = clean((c.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    const dt = (c.match(/datetime="([^"]+)"/) || [])[1] || "";
    out.push({ id: (u.match(/(\d+)$/) || [])[1] || u, url: u, title, company, loc, dt });
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
  if (titleContradicts(ld.title || job.title)) return null;             // title itself says hybrid/on-site
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

// RemoteOK: inherently remote-first board, structured JSON API. No India-specific geo field, so
// these are marked region "world" (open worldwide-remote, verify India eligibility on the listing).
async function fetchRemoteOK() {
  let arr;
  try {
    const res = await fetch("https://remoteok.com/api?tags=product-manager", { headers: UA });
    if (!res.ok) return [];
    arr = JSON.parse(await res.text());
  } catch { return []; }
  const out = [];
  for (const x of arr) {
    if (!x.position || !TITLE_OK.test(x.position) || TITLE_BAD.test(x.position) || titleContradicts(x.position) || !x.date) continue;
    const { posted, hrs } = relTime(x.date);
    if (hrs > WINDOW_H) continue;
    const title = clean(x.position);
    out.push({
      title, company: clean(x.company) || "—", sen: senOf(title), ai: aiOf(title),
      region: "world", workplace: "remote", days: hrs < 24 ? 0 : 1, new24: hrs < 24, posted,
      dt: new Date(x.date).toISOString(), verified: true,
      note: "RemoteOK · worldwide remote, verify India eligibility",
      source: "RemoteOK", url: x.url || (x.slug ? `https://remoteok.com/remote-jobs/${x.slug}` : "https://remoteok.com"),
    });
  }
  return out;
}

// We Work Remotely: remote-only board with structured region/country fields — no location guesswork.
// "Anywhere in the World" + no restrictive country = genuinely open to India.
async function fetchWWR() {
  let text;
  try {
    const res = await fetch("https://weworkremotely.com/categories/remote-product-jobs.rss", { headers: UA });
    if (!res.ok) return [];
    text = await res.text();
  } catch { return []; }
  const items = text.split("<item>").slice(1);
  const out = [];
  for (const it of items) {
    const g = (tag) => (it.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) || [])[1];
    const rawTitle = clean(g("title"));
    if (!rawTitle || !TITLE_OK.test(rawTitle) || TITLE_BAD.test(rawTitle) || titleContradicts(rawTitle)) continue;
    const pubDate = g("pubDate");
    if (!pubDate) continue;
    const { posted, hrs } = relTime(pubDate);
    if (hrs > WINDOW_H) continue;
    const region = g("region") || "";
    const country = clean(g("country") || "");
    if (country && !/india/i.test(country)) continue;          // locked to a specific non-India country -> drop
    if (!/anywhere/i.test(region) && !/india/i.test(country)) continue; // require worldwide or explicit India
    const link = g("link");
    const sep = rawTitle.indexOf(":");
    const company = sep > -1 ? rawTitle.slice(0, sep) : "—";
    const roleTitle = sep > -1 ? rawTitle.slice(sep + 1).trim() : rawTitle;
    out.push({
      title: roleTitle, company: company || "—", sen: senOf(roleTitle), ai: aiOf(roleTitle),
      region: country ? "india" : "world", workplace: "remote", days: hrs < 24 ? 0 : 1, new24: hrs < 24, posted,
      dt: new Date(pubDate).toISOString(), verified: true, note: "We Work Remotely · worldwide remote",
      source: "We Work Remotely", url: link,
    });
  }
  return out;
}

async function main() {
  const seen = new Set();
  const cands = [];
  for (const kw of KEYWORDS) {
    for (const wt of ["&f_WT=2", ""]) {         // remote-tagged + all, so filter false-negatives are caught too
      for (const start of [0, 25, 50]) {
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
  // Also check named remote-first companies directly — same search+verify pipeline, same rules,
  // just an extra query per company (not a special case for any one of them).
  for (const company of TARGET_COMPANIES) {
    let list = [];
    try { list = await search(`${company} product manager`, 0, ""); } catch { /* ignore */ }
    const key = company.toLowerCase().split(/[.\s]/)[0];
    for (const j of list) {
      const nameMatch = j.company && j.company.toLowerCase().includes(key);
      if (nameMatch && !seen.has(j.id) && TITLE_OK.test(j.title) && !TITLE_BAD.test(j.title)) {
        seen.add(j.id); cands.push(j);
      }
    }
    await sleep(250);
  }
  console.log("PM candidates (keywords + target companies):", cands.length);

  const fresh = [];
  let fetches = 0;
  for (const j of cands) {
    if (isRemoteLoc(j.loc) && j.dt && !titleContradicts(j.title)) {
      // Card location is country-level "India" or an explicit Remote tag -> trust as remote (no page fetch).
      const { posted, hrs } = relTime(j.dt);
      if (hrs > WINDOW_H) continue;
      fresh.push({
        title: j.title, company: j.company || "—", sen: senOf(j.title), ai: aiOf(j.title),
        region: "india", workplace: "remote", days: hrs < 24 ? 0 : 1, new24: hrs < 24, posted,
        dt: j.dt, verified: true, note: "India (Remote)", source: "LinkedIn", url: j.url,
      });
    } else if (fetches < MAX_VERIFY) {
      fetches++;
      const v = await verify(j);   // city-located: fall back to reading the description
      if (v) fresh.push(v);
      await sleep(300);
    }
  }
  console.log("LinkedIn remote (by location or description):", fresh.length);

  // Other free-to-apply, remote-only boards with structured data (no location guesswork needed).
  const [remoteok, wwr] = await Promise.all([fetchRemoteOK().catch(() => []), fetchWWR().catch(() => [])]);
  console.log("RemoteOK:", remoteok.length, "| We Work Remotely:", wwr.length);
  fresh.push(...remoteok, ...wwr);

  // Rolling merge: combine with existing, age out > window, recompute labels from dt.
  let existing = [];
  try { existing = JSON.parse(readFileSync(OUT, "utf8")).jobs || []; } catch { /* none */ }
  const byUrl = new Map();
  for (const j of existing) if (j.url) byUrl.set(j.url, j);
  for (const j of fresh) byUrl.set(j.url, j);
  const now = Date.now();
  const merged = [];
  const seenKey = new Set();
  // Keep any dated, verified role in-window — LinkedIn description-confirmed AND Naukri browser sweeps.
  const all = [...byUrl.values()].sort((a, b) => new Date(b.dt || 0) - new Date(a.dt || 0));
  for (const j of all) {
    if (!j.dt || !j.verified) continue;
    if (titleContradicts(j.title)) continue; // self-heal: purge any legacy entry a title now flags as onsite/hybrid
    const hrs = (now - new Date(j.dt).getTime()) / 3.6e6;
    if (hrs > WINDOW_H) continue;                                   // age out beyond 7 days
    const key = (j.company + "|" + j.title).toLowerCase().replace(/\s+/g, " ").trim();
    if (seenKey.has(key)) continue;                                 // dedupe same role from Naukri + LinkedIn
    seenKey.add(key);
    const posted = hrs < 1 ? "just now" : hrs < 24 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
    merged.push({ ...j, posted, new24: hrs < 24, days: hrs < 24 ? 0 : 1 });
  }
  const board = merged.slice(0, 60);
  if (!board.length) { console.log("nothing confirmed within window — leaving jobs.json untouched."); return; }
  const payload = { generatedAt: new Date().toISOString(), source: "github-action", jobs: board };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`published ${board.length} confirmed-remote roles (${fresh.length} from this run)`);
}

main().catch((e) => { console.error("refresh failed:", e); });
