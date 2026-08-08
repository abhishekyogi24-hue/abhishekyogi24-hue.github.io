/**
 * PM Job Radar — Daily reminder email
 * Runs on Google's servers via your own Gmail. No paid service, no Claude needed.
 *
 * ONE-TIME SETUP (2 min):
 *  1. Go to https://script.google.com  →  New project.
 *  2. Delete the sample code, paste ALL of this file, click Save (disk icon).
 *  3. Project Settings (gear, left)  →  set Time zone to "(GMT+05:30) India Standard Time".
 *  4. Run the function `setupDailyTrigger` once (pick it in the toolbar dropdown → Run).
 *     Google will ask you to authorize sending email as yourself — approve it.
 *  5. Done. You'll get an email every morning ~8am IST. To test now, run `sendDailyJobEmail`.
 *
 * To stop: Triggers (clock icon, left) → delete the trigger. To change time: edit ATHOUR below.
 */

const CONFIG = {
  to: 'your-email@gmail.com',
  dashboardUrl: 'https://claude.ai/code/artifact/130fd4c6-0eba-4d3e-9184-beb5eab9e65a',
  routineUrl:   'https://claude.ai/code/routines/trig_01JtNDngibVpne9WTT8htG5K',
  keywords: ['AI product manager', 'product manager', 'senior product manager'],
  hoursWindow: 48,   // 24 or 48 — how fresh postings must be
  maxRoles: 25,      // cap so the email stays skimmable
  ATHOUR: 8          // send around 8am (script time zone)
};

/** Run this ONCE to schedule the daily email. */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyJobEmail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyJobEmail').timeBased().everyDays(1).atHour(CONFIG.ATHOUR).create();
  Logger.log('Scheduled: sendDailyJobEmail daily at ~' + CONFIG.ATHOUR + ':00 (script time zone).');
}

/** The daily job. Fetches fresh LinkedIn roles and emails them to you. */
function sendDailyJobEmail() {
  var jobs = [];
  try { jobs = fetchFreshLinkedInJobs(); } catch (e) { Logger.log('fetch failed: ' + e); }
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE d MMM');
  var subject = '🎯 PM Job Radar — ' + (jobs.length ? jobs.length + ' fresh roles' : 'daily check') + ' · ' + today;
  MailApp.sendEmail({ to: CONFIG.to, subject: subject, htmlBody: buildEmailHtml(jobs, today) });
}

/** Hit LinkedIn's unauthenticated guest API across keywords + pages; parse the job cards. */
function fetchFreshLinkedInJobs() {
  var tpr = CONFIG.hoursWindow >= 48 ? 'r172800' : 'r86400';
  var seen = {}, out = [];
  CONFIG.keywords.forEach(function (kw) {
    for (var start = 0; start <= 50; start += 25) {
      var url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'
        + '?keywords=' + encodeURIComponent(kw) + '&location=India&f_TPR=' + tpr + '&start=' + start;
      var res;
      try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } }); }
      catch (e) { break; }
      if (res.getResponseCode() !== 200) break;
      var body = res.getContentText();
      var cards = body.split('<li>').slice(1);
      if (!cards.length) break;
      cards.forEach(function (c) {
        var link  = pick(c, /href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/);
        var title = clean(pick(c, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/));
        var comp  = clean(pick(c, /hidden-nested-link[^>]*>([\s\S]*?)<\/a>/) || pick(c, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/));
        var loc   = clean(pick(c, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/));
        var when  = clean(pick(c, /<time[^>]*>([\s\S]*?)<\/time>/));
        var dt    = pick(c, /datetime="([^"]+)"/) || '';
        if (!link || !title) return;
        var id = (link.match(/(\d+)(?:\/)?$/) || [])[1] || link;
        if (seen[id]) return; seen[id] = true;
        out.push({ title: title, company: comp || '—', loc: loc || '', when: when || '', dt: dt, url: link });
      });
    }
  });
  out.sort(function (a, b) { return (b.dt || '').localeCompare(a.dt || ''); });
  return out.slice(0, CONFIG.maxRoles);
}

function pick(s, re) { var m = s.match(re); return m ? m[1] : ''; }
function clean(s) {
  return (s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#x2013;|&#8211;/g, '–').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function buildEmailHtml(jobs, today) {
  var A = '#0f766e';
  var rows = jobs.map(function (j) {
    var ai = /\bAI\b|agentic|\bLLM\b|machine learning|\bML\b/i.test(j.title) ? ' · <b style="color:' + A + '">AI</b>' : '';
    var fresh = /hour|minute|just/i.test(j.when) ? ' 🔥' : '';
    return '<tr><td style="padding:10px 0;border-bottom:1px solid #eee;font:14px system-ui">'
      + '<a href="' + j.url + '" style="color:' + A + ';font-weight:600;text-decoration:none">' + j.title + '</a>' + fresh
      + '<br><span style="color:#555">' + j.company + '</span>'
      + '<span style="color:#999"> · ' + (j.loc || '') + ' · ' + (j.when || '') + ai + '</span></td></tr>';
  }).join('');

  var list = jobs.length
    ? '<table style="width:100%;border-collapse:collapse;margin:8px 0 4px">' + rows + '</table>'
    : '<p style="font:14px system-ui;color:#555;background:#faf7f0;padding:12px 14px;border-radius:8px">'
      + 'No postings came back from the live pull this morning (LinkedIn occasionally rate-limits automated fetches). '
      + 'Open your dashboard and the morning digest below — both still have your latest roles.</p>';

  return ''
    + '<div style="max-width:640px;margin:0 auto;font:14px system-ui;color:#1c1b18">'
    + '<p style="font:600 12px system-ui;letter-spacing:.1em;text-transform:uppercase;color:' + A + ';margin:0 0 4px">Personal Job Radar</p>'
    + '<h1 style="font:700 22px system-ui;margin:0 0 2px">Your remote PM roles — ' + today + '</h1>'
    + '<p style="color:#666;margin:0 0 16px">Fresh (last ' + CONFIG.hoursWindow + 'h) Product Manager & AI-PM postings in India. '
    + '<i>LinkedIn tags many as remote that are actually on-site — confirm workplace type on each before applying.</i></p>'
    + '<div style="margin:0 0 18px">'
    + '<a href="' + CONFIG.dashboardUrl + '" style="display:inline-block;background:' + A + ';color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;margin-right:8px">Open dashboard →</a>'
    + '<a href="' + CONFIG.routineUrl + '" style="display:inline-block;background:#fff;color:' + A + ';border:1px solid ' + A + ';text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">Today\'s digest →</a>'
    + '</div>'
    + '<h2 style="font:700 15px system-ui;margin:18px 0 0">Fresh from LinkedIn</h2>'
    + list
    + '<p style="color:#999;font-size:12px;margin-top:20px">Sent by your own Google Apps Script · edit the schedule in script.google.com → Triggers.</p>'
    + '</div>';
}
