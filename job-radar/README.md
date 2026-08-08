# PM Job Radar

A self-updating personal job-hunt system that surfaces **fully-remote Product Manager & AI-PM roles** open to India-based applicants — freshest first, every link verified live.

**Live demo:** https://jobraderabhii.netlify.app

## Why
Job hunting means re-running the same searches across a dozen sites daily, and most "remote" listings are secretly on-site or already swamped with applicants by the time you find them. A role posted an hour ago has far fewer applicants than one that's been up two weeks — so freshness is the edge.

## What it does
- **Sweeps ~30 job portals + LinkedIn** every weekday morning, keeping only roles posted in the **last 48 hours**.
- **Deep-paginates LinkedIn's guest API** across keyword variants to go well beyond page one.
- **Verifies every posting** — opens each link to confirm it's live and to check the real workplace type, because job boards mislabel on-site roles as "remote." Anything it can't confirm is flagged, not hidden.
- **Ranks freshest-first** on a single dashboard, with filters for AI-only, confirmed-remote, and India-eligibility.
- **Emails a daily digest** so a fresh opening never slips past.

## Files
- `index.html` — the standalone dashboard (open it in any browser; no build step).
- `DailyJobRadarEmail.gs` — Google Apps Script that emails the day's fresh roles via your own Gmail. Set `CONFIG.to` to your address, paste into [script.google.com](https://script.google.com), and run `setupDailyTrigger` once.

## Stack
Vanilla HTML/CSS/JS (client-side, themeable) · LinkedIn guest API · Google Apps Script (MailApp + time-driven triggers) · a scheduled cloud agent for the morning sweep.

Built solo with Claude Code — the engineering was the easy part; the product judgment (freshness as the edge, verify-before-listing, honest "couldn't confirm" over confident-wrong) was the work.
