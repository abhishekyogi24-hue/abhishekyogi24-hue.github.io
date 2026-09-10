/**
 * PM Case Lab — Daily case email
 * Runs on Google's servers via your own Gmail. No paid service, no Claude needed.
 * Reads the same schedule.json / cases.json / frameworks.json the static site reads,
 * so the email and the site always show the same day's case.
 *
 * ONE-TIME SETUP (2 min):
 *  1. Go to https://script.google.com  →  New project.
 *  2. Delete the sample code, paste ALL of this file, click Save (disk icon).
 *  3. Project Settings (gear, left)  →  set Time zone to "(GMT+05:30) India Standard Time".
 *  4. Run the function `sendTest` once from the toolbar dropdown → Run, to see today's
 *     email land in your inbox and check it renders well. Google will ask you to authorize
 *     sending email as yourself and fetching URLs — approve both.
 *  5. Run `setupDailyTrigger` once. You'll get an email every morning ~8am IST from then on.
 *
 * To stop: Triggers (clock icon, left) → delete the trigger. To change the send time: edit
 * CONFIG.ATHOUR below and re-run setupDailyTrigger.
 *
 * OPTIONAL — live "stories" feed:
 *  This file also defines doGet(), which turns your "Experience in Detail" Google Doc into a
 *  small JSON feed. The site ships a checked-in snapshot of your stories and works fine without
 *  this — it only calls this feed if you connect a URL. To turn it on: Deploy → New deployment →
 *  type "Web app" → Execute as "Me" → Who has access "Anyone" → Deploy, then paste the resulting
 *  URL wherever the site's stories feed is configured. Skip this step entirely if you don't need
 *  a live feed; nothing else in this file depends on it.
 */

var CONFIG = {
  to: 'abhishekyogi.24@gmail.com',
  siteUrl: 'https://abhishekyogi.in/case-lab/',
  dataBase: 'https://abhishekyogi.in/case-lab/data/',
  ATHOUR: 8 // send around 8am (script time zone)
};

var ACCENT = '#7c3aed';
var STORIES_DOC_ID = '1oGboRqMFp2fzrz5GC-eu3RPeHM76xKnaiRsrNHo3_YA';

/** Run this ONCE to schedule the daily email. */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyCase') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyCase').timeBased().everyDays(1).atHour(CONFIG.ATHOUR).create();
  Logger.log('Scheduled: sendDailyCase daily at ~' + CONFIG.ATHOUR + ':00 (script time zone).');
}

/** Sends today's email right now, so you can check rendering before installing the trigger. */
function sendTest() {
  Logger.log('Manual test send — running sendDailyCase() now.');
  sendDailyCase();
}

/**
 * The daily job. Figures out which case (or review day) today is, and emails it.
 * Wrapped so a bad fetch/parse never breaks the daily habit — worst case you get a short
 * fallback email pointing at the site instead of silence.
 */
function sendDailyCase() {
  try {
    var schedule = fetchJson(CONFIG.dataBase + 'schedule.json', false);
    var casesData = fetchJson(CONFIG.dataBase + 'cases.json', false);
    var frameworksData = fetchJson(CONFIG.dataBase + 'frameworks.json', false);
    var behaviouralData = fetchJson(CONFIG.dataBase + 'behavioural.json', true); // ok if missing

    var day = resolveDay(schedule);
    var todayLabel = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'EEE d MMM');

    if (day.caseId) {
      var theCase = findCaseById(casesData, day.caseId);
      if (!theCase) {
        throw new Error('schedule.json points at caseId "' + day.caseId + '" but it is not in cases.json');
      }
      sendCaseEmail(theCase, frameworksData, todayLabel);
    } else {
      sendWeeklyReviewEmail(schedule, casesData, behaviouralData, day.dayIndex, todayLabel);
    }
  } catch (err) {
    Logger.log('sendDailyCase failed: ' + err);
    sendFallbackEmail(err);
  }
}

/**
 * Computes which day of the rotation today is — the exact same math the site uses, so the
 * email and the site can never disagree about which case "today" is.
 */
function resolveDay(schedule) {
  var istNow = new Date(Utilities.formatDate(new Date(), 'Asia/Kolkata', "yyyy/MM/dd HH:mm:ss"));
  var epochParts = schedule.epoch.split('-');
  var dayIndex = Math.floor((Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate())
               - Date.UTC(+epochParts[0], +epochParts[1] - 1, +epochParts[2])) / 86400000);
  // Before the epoch (the rotation hasn't started yet) show day 0 rather than wrapping
  // round to an arbitrary case at the end of the schedule.
  if (dayIndex < 0) dayIndex = 0;
  var n = schedule.days.length;
  var caseId = schedule.days[((dayIndex % n) + n) % n];
  return { dayIndex: dayIndex, caseId: caseId };
}

/** Same lookup resolveDay() does, but for an arbitrary day index — used to walk back a week. */
function caseIdForDayIndex(schedule, dayIndex) {
  var n = schedule.days.length;
  return schedule.days[((dayIndex % n) + n) % n];
}

function findCaseById(casesData, id) {
  for (var i = 0; i < casesData.cases.length; i++) {
    if (casesData.cases[i].id === id) return casesData.cases[i];
  }
  return null;
}

/** fetches + parses a JSON URL. If tolerateMissing is true, a 404 returns null instead of throwing. */
function fetchJson(url, tolerateMissing) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 404 && tolerateMissing) return null;
  if (code !== 200) throw new Error('GET ' + url + ' -> HTTP ' + code);
  return JSON.parse(res.getContentText());
}

/** Resolves a case's framework, following frameworks.json's optional "inherits" (e.g. cross-cutting -> product-sense). */
function getFrameworkMeta(frameworksData, key) {
  var fw = frameworksData[key];
  if (!fw) return { label: key, totalMin: null, stages: [] };
  var stages = fw.stages;
  if (!stages && fw.inherits && frameworksData[fw.inherits]) {
    stages = frameworksData[fw.inherits].stages;
  }
  return { label: fw.label || key, totalMin: fw.totalMin || null, stages: stages || [] };
}

// ---------------------------------------------------------------------------
// Email senders
// ---------------------------------------------------------------------------

function sendCaseEmail(theCase, frameworksData, todayLabel) {
  var fw = getFrameworkMeta(frameworksData, theCase.framework);
  var subject = 'PM Case Lab · ' + theCase.title + ' · ' + todayLabel;
  var html = buildCaseEmailHtml(theCase, fw, todayLabel);
  MailApp.sendEmail({ to: CONFIG.to, subject: subject, htmlBody: html });
  Logger.log('Sent daily case email: ' + theCase.id + ' — ' + theCase.title);
}

function sendWeeklyReviewEmail(schedule, casesData, behaviouralData, dayIndex, todayLabel) {
  var subject = 'PM Case Lab · Weekly Review · ' + todayLabel;
  var html = buildWeeklyReviewHtml(schedule, casesData, behaviouralData, dayIndex, todayLabel);
  MailApp.sendEmail({ to: CONFIG.to, subject: subject, htmlBody: html });
  Logger.log('Sent weekly review email for dayIndex ' + dayIndex);
}

function sendFallbackEmail(err) {
  var todayLabel = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'EEE d MMM');
  var subject = 'PM Case Lab · today’s case (couldn’t load automatically) · ' + todayLabel;
  var message = 'Today’s case couldn’t be fetched or parsed automatically, so this is a short '
    + 'placeholder instead of silence. Head to the site to grab today’s case directly.';
  var detail = err && err.message ? err.message : String(err);
  var inner = ''
    + eyebrow('PM Case Lab')
    + '<h1 style="' + H1_STYLE + '">Couldn’t load today’s case</h1>'
    + '<p style="' + P_STYLE + '">' + escapeHtml(message) + '</p>'
    + buttonRow([{ label: 'Open PM Case Lab', url: CONFIG.siteUrl, primary: true }])
    + '<p style="' + MUTED_STYLE + 'margin-top:24px">Technical detail (for you, not the interviewer): '
    + escapeHtml(detail) + '</p>';
  MailApp.sendEmail({ to: CONFIG.to, subject: subject, htmlBody: emailShell(inner) });
}

// ---------------------------------------------------------------------------
// HTML builders — every style is inline; email clients strip <style> blocks
// and don't support CSS variables.
// ---------------------------------------------------------------------------

var H1_STYLE = 'font:700 22px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
  + 'color:#18181b;margin:0 0 14px';
var H2_STYLE = 'font:700 15px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
  + 'color:#18181b;margin:24px 0 8px';
var P_STYLE = 'font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
  + 'color:#3f3f46;margin:0 0 12px';
var MUTED_STYLE = 'font:12px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
  + 'color:#a1a1aa;';
var LI_STYLE = 'font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
  + 'color:#3f3f46;margin:0 0 6px';

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatLabel(s) {
  if (!s) return '';
  return String(s).replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function eyebrow(text) {
  return '<p style="font:700 11px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
    + 'letter-spacing:.12em;text-transform:uppercase;color:' + ACCENT + ';margin:0 0 8px">'
    + escapeHtml(text) + '</p>';
}

function buildChip(text) {
  if (!text) return '';
  return '<span style="display:inline-block;background:#f3e8ff;color:' + ACCENT + ';'
    + 'font:600 11px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
    + 'padding:5px 10px;border-radius:999px;margin:0 6px 6px 0">' + escapeHtml(text) + '</span>';
}

function buildBulletList(items, liStyleExtra) {
  if (!items || !items.length) return '';
  var style = LI_STYLE + (liStyleExtra || '');
  var rows = items.map(function (item) {
    return '<li style="' + style + '">' + escapeHtml(item) + '</li>';
  }).join('');
  return '<ul style="margin:0 0 4px;padding-left:20px">' + rows + '</ul>';
}

/** One row per button — stacked, not side-by-side, so they stay tappable on a phone. */
function buttonRow(buttons) {
  var rows = buttons.map(function (b) {
    var bg = b.primary ? ACCENT : '#ffffff';
    var color = b.primary ? '#ffffff' : ACCENT;
    var border = b.primary ? '' : 'border:1px solid ' + ACCENT + ';';
    return '<tr><td style="padding:0 0 10px 0">'
      + '<a href="' + b.url + '" style="display:inline-block;background:' + bg + ';color:' + color + ';'
      + border + 'text-decoration:none;font:600 14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
      + 'padding:11px 18px;border-radius:8px">' + escapeHtml(b.label) + ' →</a>'
      + '</td></tr>';
  }).join('');
  return '<table role="presentation" style="margin:18px 0 4px;border-collapse:collapse">' + rows + '</table>';
}

/** Wraps inner content in a centred, max-width-640 table shell — the safe pattern for email clients. */
function emailShell(innerHtml) {
  return ''
    + '<table role="presentation" width="100%" style="background:#faf9fb;padding:24px 0;border-collapse:collapse">'
    + '<tr><td align="center">'
    + '<table role="presentation" width="640" style="max-width:640px;width:100%;background:#ffffff;'
    + 'border-radius:12px;border-collapse:collapse"><tr><td style="padding:28px 28px 22px 28px">'
    + innerHtml
    + '<p style="' + MUTED_STYLE + 'margin-top:22px;border-top:1px solid #f0eef2;padding-top:14px">'
    + 'Sent by your own Google Apps Script · to change the send time, edit CONFIG.ATHOUR in script.google.com.</p>'
    + '</td></tr></table>'
    + '</td></tr></table>';
}

function buildCaseEmailHtml(theCase, fw, todayLabel) {
  var company = (theCase.company || []).join(', ');
  var chips = [
    buildChip(formatLabel(theCase.track)),
    buildChip(formatLabel(theCase.type)),
    buildChip('Difficulty ' + theCase.difficulty),
    buildChip(company),
    buildChip(formatLabel(theCase.region)),
    buildChip(theCase.timeboxMin + ' min')
  ].join('');

  var contextHtml = buildBulletList(theCase.context);

  var assumptionsHtml = '';
  if (theCase.assumptions && theCase.assumptions.length) {
    var assumptionItems = theCase.assumptions.map(function (a) {
      return '<li style="font:italic 14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,'
        + 'Arial,sans-serif;color:#7c2d92;margin:0 0 6px">' + escapeHtml(a) + '</li>';
    }).join('');
    assumptionsHtml = '<div style="background:#faf5ff;border-left:3px solid ' + ACCENT + ';'
      + 'border-radius:6px;padding:12px 14px;margin:0 0 4px">'
      + '<p style="font:700 11px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
      + 'letter-spacing:.06em;text-transform:uppercase;color:' + ACCENT + ';margin:0 0 8px">'
      + 'Assumptions — given, not facts</p>'
      + '<ul style="margin:0;padding-left:18px">' + assumptionItems + '</ul></div>';
  }

  var stagesHtml = '';
  if (fw.stages && fw.stages.length) {
    var stageItems = fw.stages.map(function (s) {
      return '<li style="' + LI_STYLE + '">'
        + '<span style="color:#d4d4d8">☐</span> <b style="color:#18181b">' + escapeHtml(s.name) + '</b>'
        + ' <span style="' + MUTED_STYLE + '">(' + s.minMin + '–' + s.maxMin + ' min)</span>'
        + '<br><span style="color:#71717a">' + escapeHtml(s.guidance) + '</span>'
        + '</li>';
    }).join('');
    var totalNote = fw.totalMin ? ' · ' + fw.totalMin + ' min total' : '';
    stagesHtml = '<h2 style="' + H2_STYLE + '">Framework: ' + escapeHtml(fw.label) + totalNote + '</h2>'
      + '<ul style="margin:0 0 4px;padding-left:6px;list-style:none">' + stageItems + '</ul>';
  }

  var buttons = buttonRow([
    { label: 'Practice this case', url: CONFIG.siteUrl + '?c=' + encodeURIComponent(theCase.id) + '&practice=1', primary: true },
    { label: 'Show model answer', url: CONFIG.siteUrl + '?c=' + encodeURIComponent(theCase.id) + '&reveal=1' },
    { label: 'Browse library', url: CONFIG.siteUrl }
  ]);

  var inner = ''
    + eyebrow('PM Case Lab · ' + todayLabel)
    + '<h1 style="' + H1_STYLE + '">' + escapeHtml(theCase.title) + '</h1>'
    + '<div style="margin:0 0 16px">' + chips + '</div>'
    + '<p style="' + P_STYLE + 'font-weight:600">' + escapeHtml(theCase.prompt) + '</p>'
    + '<h2 style="' + H2_STYLE + '">Context</h2>'
    + contextHtml
    + assumptionsHtml
    + stagesHtml
    + buttons;

  return emailShell(inner);
}

function buildWeeklyReviewHtml(schedule, casesData, behaviouralData, dayIndex, todayLabel) {
  var links = [];
  for (var back = 6; back >= 1; back--) {
    var id = caseIdForDayIndex(schedule, dayIndex - back);
    if (!id) continue; // skip if a previous review day falls in the 6-day window
    var c = findCaseById(casesData, id);
    var title = c ? c.title : id;
    links.push('<li style="' + LI_STYLE + '">'
      + '<a href="' + CONFIG.siteUrl + '?c=' + encodeURIComponent(id) + '" style="color:' + ACCENT + ';'
      + 'text-decoration:none;font-weight:600">' + escapeHtml(title) + '</a></li>');
  }
  var casesHtml = links.length
    ? '<ul style="margin:0 0 4px;padding-left:20px">' + links.join('') + '</ul>'
    : '<p style="' + P_STYLE + '">No cases logged for this window yet.</p>';

  var behaviouralHtml = '';
  var questions = getBehaviouralQuestions(behaviouralData);
  if (questions.length) {
    var weekNum = Math.floor(dayIndex / 7);
    var qIndex = ((weekNum % questions.length) + questions.length) % questions.length;
    var q = questions[qIndex];
    var qText = q.question || q.text || q.prompt || '';
    // probes is usually a single descriptive string in behavioural.json, but tolerate an array too.
    var probesLine = '';
    if (Object.prototype.toString.call(q.probes) === '[object Array]') {
      probesLine = q.probes.join(' · ');
    } else if (q.probes) {
      probesLine = String(q.probes);
    }
    behaviouralHtml = '<h2 style="' + H2_STYLE + '">Behavioural warm-up</h2>'
      + '<p style="' + P_STYLE + 'font-weight:600">' + escapeHtml(qText) + '</p>'
      + (probesLine ? '<p style="' + MUTED_STYLE + '">Probes: ' + escapeHtml(probesLine) + '</p>' : '')
      + '<p style="' + P_STYLE + '">Draft a STAR answer for this before next week’s review.</p>';
  }

  var buttons = buttonRow([{ label: 'Browse library', url: CONFIG.siteUrl, primary: true }]);

  var inner = ''
    + eyebrow('PM Case Lab · Weekly Review · ' + todayLabel)
    + '<h1 style="' + H1_STYLE + '">Your week in cases</h1>'
    + '<h2 style="' + H2_STYLE + '">This week’s cases</h2>'
    + casesHtml
    + behaviouralHtml
    + buttons;

  return emailShell(inner);
}

/** Normalizes behavioural.json into a flat array of {question, probes} — tolerant of shape, and of the file not existing. */
function getBehaviouralQuestions(data) {
  if (!data) return [];
  if (Object.prototype.toString.call(data) === '[object Array]') return data;
  if (data.questions && Object.prototype.toString.call(data.questions) === '[object Array]') return data.questions;
  return [];
}

// ---------------------------------------------------------------------------
// doGet — optional live "stories" JSON feed (see header comment)
// ---------------------------------------------------------------------------

function doGet(e) {
  var doc = DocumentApp.openById(STORIES_DOC_ID);
  var body = doc.getBody();
  var sections = [];
  var current = null;
  var numChildren = body.getNumChildren();

  for (var i = 0; i < numChildren; i++) {
    var el = body.getChild(i);
    if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    var para = el.asParagraph();
    var text = para.getText();
    var isHeading = para.getHeading() !== DocumentApp.ParagraphHeading.NORMAL;

    if (isHeading && text) {
      current = { heading: text, text: '' };
      sections.push(current);
    } else if (current && text) {
      current.text = current.text ? (current.text + '\n' + text) : text;
    }
  }

  var payload = { generatedAt: new Date().toISOString(), sections: sections };
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
