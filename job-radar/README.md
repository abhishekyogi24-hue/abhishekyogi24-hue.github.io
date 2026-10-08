# PM Job Radar

A self-updating personal job-hunt system that surfaces **fully-remote Product Manager & AI-PM roles** open to India-based applicants — freshest first, every link verified live.

**Live demo:** https://abhishekyogi.in/job-radar/ (auto-refreshing daily — the Netlify copy of this project is retired/frozen and no longer maintained)

## Why
Job hunting means re-running the same searches across a dozen sites daily, and most "remote" listings are secretly on-site or already swamped with applicants by the time you find them. A role posted an hour ago has far fewer applicants than one that's been up two weeks — so freshness is the edge.

## What it does
- **Pulls candidates every weekday morning** (~8am IST, via a scheduled GitHub Actions workflow) from LinkedIn, We Work Remotely, RemoteOK, and 15 remote-first companies checked by name — keeping a **rolling 7-day board**.
- **Deep-paginates LinkedIn's guest API** across keyword variants to go well beyond page one.
- **Verifies every posting** — reads the posting's own description to confirm it's actually remote, because job boards mislabel on-site roles as "remote." On-site, hybrid, and "work mode not stated" roles are dropped, so the board is small but honest.
- **Ranks freshest-first** on a single dashboard, with filters for AI-only and India-eligibility. Every card can be marked Applied, Ignored, or Deleted; roles that age off the board unapplied are kept in an **Archive** for review.
- **Emails a daily digest** so a fresh opening never slips past.

## Files
- `index.html` — the standalone dashboard (open it in any browser; no build step).
- `DailyJobRadarEmail.gs` — Google Apps Script that emails the day's fresh roles via your own Gmail. Set `CONFIG.to` to your address, paste into [script.google.com](https://script.google.com), and run `setupDailyTrigger` once.

## Stack
Vanilla HTML/CSS/JS (client-side, themeable) · LinkedIn guest API · Google Apps Script (MailApp + time-driven triggers) · a scheduled GitHub Actions workflow (`.github/workflows/refresh-jobs.yml`) for the morning refresh.

Built solo with Claude Code — the engineering was the easy part; the product judgment (freshness as the edge, verify-before-listing, honest "couldn't confirm" over confident-wrong) was the work.
