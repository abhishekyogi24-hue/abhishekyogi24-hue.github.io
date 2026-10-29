// Case Lab — instant, offline "checklist" feedback for a written case answer.
//
// This is NOT an expert judgment. It scans each section of the user's notes for the signals that
// section is supposed to contain (per the interview frameworks in data/frameworks.json) and reports
// what it did and didn't see. It can miss a point that was covered in unusual wording, and it can't
// judge whether a point is *good* — so every message is phrased as "I didn't see X" and the UI labels
// the whole thing a checklist. Real evaluation is the AI review (see POST /case-feedback in the worker).
//
// Pure functions only (no DOM) so it can be unit-tested in Node. Loaded before script.js.

var FEEDBACK_MIN_NOTE_WORDS = 8;

// sig(id, label, re, fix [, warn]) — a signal. `re` matching means the point was covered (strength).
// A `warn` signal flips it: matching means a known failure mode is present (improvement).
function sig(id, label, re, fix) { return { id: id, label: label, re: re, fix: fix }; }
function warn(id, re, message) { return { id: id, re: re, warn: message }; }

var FEEDBACK_RULES = {
  'product-sense': {
    communication: [
      sig('assume', 'States assumptions or scope', /assum|scope|let me (clarify|set|start)|i('| wi)ll focus|focus(ing)? on|narrow/i, 'State 2–4 assumptions up front (role, geography, platform, constraints) so the interviewer can see your scope.'),
      sig('plan', 'Lays out a game plan', /plan|structure|first[^.]{0,60}(then|next)|walk (you )?through|step|agenda|framework|i('| wi)ll (start|begin|cover)/i, 'Say your plan in one breath before diving in: “I’ll cover X, then Y, then Z.”'),
    ],
    motivation: [
      sig('mission', 'States a mission or purpose', /mission|purpose|vision|exists to|we exist|north star/i, 'Give the product a one-line mission — the purpose that will guide every later decision.'),
      sig('need', 'Connects the product to a human need', /need|value|help(s|ing)? (users|people|customers|them)|solve|job to be done|jtbd|want to|so that/i, 'Say what deeper human need the product serves, beyond its feature list.'),
      sig('strategy', 'Places it in company strategy / competition', /strateg|compet|moat|differentiat|alternative|advantage|ecosystem|company|core business|monetis|monetiz|revenue/i, 'Tie it to what the company is trying to do and where it wins against alternatives.')
    ],
    segmentation: [
      sig('ecosystem', 'Maps the ecosystem / stakeholders', /ecosystem|stakeholder|players?|\b(buyers?|sellers?|riders?|drivers?|hosts?|guests?|creators?|viewers?|merchants?|advertisers?|learners?|users?|customers?|partners?)\b[^.]{0,40}\b(and|,)\b/i, 'List the players in the ecosystem first, then pick one group to focus on.'),
      sig('behaviour', 'Segments on behaviour / motivation, not just demographics', /behaviou?r|motivat|context|intent|frequency|how often|usage|occasion|goal|need(s)?|habit|power user|casual/i, 'Cut segments by behaviour or motivation (what they’re trying to do, how often) — not only age/gender/income.'),
      sig('persona', 'Builds a concrete persona', /persona|meet [A-Z]|for example|someone (like|who)|(a|an) [a-z-]+ (who|named|called)|\b(priya|rahul|asha|ravi|sam|maya|raj|ananya|karan)\b|\b(she|he|they) (is|are|has|have|lives?|works?|logs?|uses?|wants?|needs?|worries|calls?)\b|(i'd|i would|i'll) (prioriti[sz]e|focus on|choose|pick) (the )?[a-z -]{3,40}(because|:)/i, 'Make the chosen segment a specific person (name, situation, goal) so the rest of your answer has a anchor.'),
      sig('prioritise', 'Prioritises one segment, with a reason', /reach|underserved|prioriti[sz]|focus on|2\s?x\s?2|matrix|biggest|most (under|impact|valuable)|choose|pick|because/i, 'Choose one segment and justify it (e.g. reach × how underserved they are).')
    ],
    problem: [
      sig('journey', 'Walks the user journey', /journey|stages?|steps?|before|during|after|discover|onboard|first (time|use)|then/i, 'Walk the persona’s journey in a specific context, stage by stage, before listing problems.'),
      sig('pain', 'Names concrete pain points', /pain|struggl|friction|problem|frustrat|drop.?off|can'?t|cannot|difficult|confus|hard to|annoy/i, 'Name problems as obstacles (“I struggle with X”), not wants (“I want X”).'),
      sig('severity', 'Prioritises problems (severity × frequency)', /severity|frequency|how often|how (bad|painful)|impact|prioriti[sz]|most (painful|important|frequent)|biggest/i, 'Rank the problems — how painful and how frequent — and pick one to solve.'),
      sig('mission-link', 'Ties the problem back to the mission', /mission|purpose|aligns?|connect|ladder|goal|tie[sd]? (back|to)/i, 'Close the loop: show the chosen problem serves your mission statement.')
    ],
    solution: [
      sig('options', 'Brainstorms multiple options', /options?|ideas?|approach(es)?|alternatives?|\b1[.)]|\b2[.)]|\ba[.)]\s|\bb[.)]\s|first[^.]{0,80}(second|another|also)|another/i, 'Generate several distinct solutions (different angles) before picking one.'),
      sig('prioritise', 'Prioritises on impact × effort', /impact|effort|prioriti[sz]|trade.?off|quick win|2\s?x\s?2|rice|cost|complexity|feasib/i, 'Score the options on impact vs effort and say why the winner wins.'),
      sig('v1', 'Defines a concrete V1', /\bv1\b|mvp|first version|launch|pilot|phase|roll.?out|ship|minimum|initial/i, 'Describe a concrete V1: what exactly ships first, to whom.'),
      sig('risks', 'Names risks and mitigations', /risk|mitigat|downside|concern|what could go wrong|challenge|trade.?off|failure|worry/i, 'Name the main risk to your V1 and how you’d de-risk it.')
    ]
  },

  'analytical': {
    assumptions: [
      sig('assume', 'States scoping assumptions', /assum|scope|focus|constraint|let me|clarif|i('| wi)ll (take|treat|assume)/i, 'State 2–3 scoping assumptions to narrow the exercise.'),
      sig('plan', 'Outlines the plan', /plan|structure|first[^.]{0,60}(then|next)|step|walk|i('| wi)ll (start|cover|begin)|framework/i, 'Say the structure you’ll follow before you start.')
    ],
    rationale: [
      sig('context', 'Describes the product and what problem it solves', /feature|business model|revenue|monetis|monetiz|how (it )?makes money|matur|launched|users?|customers?|solves?|problem|helps?/i, 'Summarise the product: what it does, its business model and maturity, and the problem it solves.'),
      sig('market', 'Covers market / competitive positioning', /compet|market|position|alternative|rival|vs\.?\b|differentiat|share/i, 'Place it in its market — who else solves this and how it differs.'),
      sig('mission', 'Gives a mission statement', /mission|purpose|vision|exists to|north star/i, 'Write a one-line mission that connects the company’s vision to this product.')
    ],
    metrics: [
      sig('ecosystem', 'Identifies ecosystem players', /ecosystem|stakeholder|players?|\b(buyers?|sellers?|riders?|drivers?|hosts?|guests?|creators?|viewers?|merchants?|advertisers?|learners?|users?|customers?|partners?)\b[^.]{0,50}\b(and|,|&)\b|supply|demand/i, 'List every player in the ecosystem and what value each gets, before choosing metrics.'),
      sig('northstar', 'Names a North Star metric', /north star|nsm|one metric|primary metric|key metric|top.?line/i, 'Name one North Star metric explicitly and say why it reflects ecosystem health.'),
      sig('guardrail', 'Names guardrail metrics', /guardrail|counter.?metric|health metric|trade.?off|protect|don'?t (hurt|degrade|harm)|watch out for|balanc/i, 'Add 2+ guardrail metrics that catch the North Star being gamed or hurting something else.'),
      sig('timeframe', 'Gives metrics a timeframe', /\b(per|within|in the|over|last|every)\s+(day|week|month|quarter|\d+[- ]?(day|days|d|week|weeks|w|month|months|hours?))|weekly|daily|monthly|7[- ]?day|30[- ]?day|\bd7\b|\bd30\b|rolling|wow|mom/i, 'Attach a timeframe to each metric (e.g. “in the first 7 days”, “weekly”).'),
      sig('implement', 'Says how the metrics could be implemented', /event|table|logs?|instrument|sql|dashboard|data (scientist|team|pipeline)|tracked|count of|number of|distinct|session|cohort/i, 'Make at least the North Star implementable: which event or table would a data scientist compute it from?'),
      warn('avg-ratio', /(north star|nsm)[^.\n]{0,90}(average|avg|\bmean\b|ratio|per user|per session|\brate\b|%)/i, 'Your North Star reads like an average or ratio — the framework’s classic failure mode. Prefer a count or sum (e.g. weekly users completing X), and keep ratios as guardrails.')
    ],
    goals: [
      sig('target', 'Sets a specific target', /target|goal|okr|commit|by (q[1-4]|end of|next quarter|year)|\b\d+\s?%|\b\d{2,}\b|from [^.]{0,20} to /i, 'Give a concrete number and deadline for the team goal.'),
      sig('bridge', 'Bridges to team execution', /team|squad|owner|roadmap|initiative|experiment|launch|ship|build|prioriti[sz]|lever|drive/i, 'Say what the team would do to move the metric — the bridge from strategy to execution.'),
      sig('defend', 'Defends the number', /because|defend|baseline|benchmark|historical|based on|trend|realistic|stretch|assum/i, 'Defend the number: baseline, benchmark, or why it’s ambitious but achievable.')
    ]
  },

  'rca': {
    clarify: [
      sig('define', 'Defines the metric precisely', /defin|measured as|numerator|denominator|per\b|metric is|calculated|count of|rate of/i, 'Restate the exact metric definition (numerator / denominator).'),
      sig('magnitude', 'Quantifies the size of the change', /\d+\s?%|by \d+|from \d+|dropped|fell|declin|down|decreas/i, 'Quantify the change — by how much, from what baseline.'),
      sig('window', 'Pins when it started and the trend', /week|day|since|started|began|when|trend|still (falling|dropping|down)|recover|sudden|gradual|overnight/i, 'Pin down when it started and whether it is still falling or has stabilised.')
    ],
    validity: [
      sig('artefact', 'Considers whether it is a data artefact', /instrument|logging|tracking|pipeline|data (issue|quality|delay|gap)|definition|bot|sdk|artefact|artifact|is it real|real drop|false alarm/i, 'Before investigating causes, ask whether the drop is real: logging, pipeline delay, definition change, bots.'),
      sig('check', 'Names a specific validity check', /compare|cross.?check|raw|source of truth|backend|another (source|dashboard)|reconcile|verify|validate|sanity/i, 'Name a concrete check — e.g. reconcile against raw backend logs or a second dashboard.')
    ],
    segment: [
      sig('cuts', 'Cuts the drop by sensible dimensions', /platform|ios|android|web|geo|country|region|city|cohort|new vs|existing|channel|device|app version|version|segment|slice/i, 'Segment the drop by platform, geography, cohort (new vs existing), channel, device and version.'),
      sig('pattern', 'Reasons from localised vs uniform patterns', /locali[sz]|isolated|uniform|across (all|the board)|only (in|on|for)|concentrated|specific to|everywhere|all (segments|platforms)/i, 'Say what each pattern implies: a localised drop points internal, a uniform one external.')
    ],
    internal: [
      sig('causes', 'Lists internal causes', /release|deploy|rollout|config|experiment|ramp|a\/b|flag|pricing|policy|bug|regression|upstream|api|dependency|latency|change/i, 'List internal candidates: a release, config change, experiment ramp, pricing/policy change, upstream dependency.'),
      sig('rank', 'Ranks them against the evidence', /most likely|likely|rank|because|fits|consistent with|matches|points to|explains/i, 'Rank the candidates by how well each fits the segmentation evidence.')
    ],
    external: [
      sig('causes', 'Lists external causes', /season|holiday|festival|competitor|launch(ed)? (of|by)|os update|ios \d|android \d|macro|news|regulat|weather|event|ipl|cricket|exam|payday/i, 'List external candidates: seasonality, a competitor move, an OS/platform change, macro conditions, a news event.'),
      sig('tie', 'Weighs them against the same evidence', /because|consistent|fits|would (also|expect)|rule out|unlikely|doesn'?t fit|matches|explain/i, 'Weigh external causes against the same segmentation evidence rather than raising them in the abstract.')
    ],
    converge: [
      sig('hypothesis', 'Commits to a leading hypothesis', /hypothes|my (leading|top|best) (guess|bet|theory)|most likely|i('| wi)ll bet|leading (cause|theory)|i suspect|i believe/i, 'Commit to one leading hypothesis instead of leaving a list.'),
      sig('confirm', 'Names the query that would confirm it', /query|check|look at|pull|validate|confirm|dashboard|segment by|compare|run a/i, 'Name the single query or check that would confirm it.'),
      sig('falsify', 'Says what would disprove it', /disconfirm|rule out|if (it'?s|this is|that'?s) not|would (prove|disprove)|falsif|if wrong|otherwise|if (not|it doesn'?t)/i, 'Say what evidence would show you’re wrong.')
    ],
    act: [
      sig('mitigate', 'Gives an immediate mitigation', /mitigat|rollback|roll back|hotfix|revert|stop.?gap|immediately|short.?term|pause|flag off|first (step|action)/i, 'Give an immediate mitigation (rollback, flag off, hotfix) separate from the real fix.'),
      sig('fix', 'Gives a durable fix', /fix|long.?term|durable|root|permanent|prevent|redesign|process/i, 'Add the durable fix that prevents recurrence.'),
      sig('guardrail', 'Adds a guardrail metric / alert', /guardrail|alert|monitor|anomaly|threshold|early warning|catch (it )?earlier|dashboard/i, 'Add the guardrail metric or alert that would have caught this earlier.')
    ]
  },

  'ai-product': {
    assumptions: [
      sig('scope', 'States scope, surface, user and constraints', /assum|scope|surface|constraint|mobile|web|in.?app|chat|user|for (the )?(user|customer)/i, 'State the surface, the user and the constraints you’re assuming.'),
      sig('plan', 'Outlines the plan', /plan|first[^.]{0,60}(then|next)|structure|step|i('| wi)ll (start|cover)/i, 'Say your plan before diving in.')
    ],
    'why-ai': [
      sig('problem', 'Starts from the user problem', /problem|pain|struggl|need|job to be done|user (wants|needs)|friction/i, 'Start from the user problem, not the model.'),
      sig('baseline', 'Weighs a non-AI baseline', /rules?.?based|deterministic|keyword|search|classical|non.?ai|simple(r)?|template|heuristic|without (ai|an llm)|no need for ai|faq|filters?/i, 'State what a rules-based or classical approach would already achieve — a non-AI baseline.'),
      sig('unique', 'Says what AI uniquely adds (or declines AI)', /unstructured|natural language|personali[sz]|generat|summar|long.?tail|open.?ended|ambigu|variety|scale|not (use|need) ai|don'?t use ai|wouldn'?t use ai|ai (isn'?t|is not)/i, 'Say specifically what AI unlocks here — or argue honestly that it shouldn’t be AI.')
    ],
    segmentation: [
      sig('tolerance', 'Reasons about error tolerance', /toleran|error|mistake|wrong|cost of (a )?wrong|false (positive|negative)|risk|stakes|sensitive/i, 'Say which failure modes each segment tolerates and what a wrong answer costs them.'),
      sig('segments', 'Distinguishes segments', /segment|power users?|novice|new users?|enterprise|casual|expert|first.?time|returning|persona/i, 'Name distinct segments and how their tolerance differs.')
    ],
    'system-design': [
      sig('choice', 'Chooses an approach (prompt / RAG / fine-tune / agent / classical)', /prompt|\brag\b|retriev|fine.?tun|agent|classifier|embedding|llm|model|tool use|function call|orchestrat|classical/i, 'Pick the approach (prompt, RAG, fine-tune, agent, classical ML) and say why.'),
      sig('data', 'Covers data sources and rights', /data|source|knowledge base|\bkb\b|docs?|permission|privacy|rights|pii|index/i, 'Say where the data comes from and whether you have the rights to use it.'),
      sig('loop', 'Describes a feedback loop', /feedback|thumbs|human (in|review)|label|retrain|improve over time|loop|telemetry/i, 'Describe how the system improves — what feedback you capture.'),
      sig('cost', 'Considers latency and cost', /latency|p95|cost|token|budget|cache|speed|fast/i, 'State a latency budget and the cost implications.')
    ],
    ux: [
      sig('transparency', 'Shows sources / confidence', /citation|source|cite|confidence|transparen|show (why|how)|explain|disclos/i, 'Show citations or confidence so users can judge the answer.'),
      sig('correction', 'Lets users correct / undo', /undo|edit|correct|regenerat|override|reject|accept|revert/i, 'Make it easy to correct, undo or regenerate.'),
      sig('fallback', 'Has a graceful fallback / human handoff', /fallback|handoff|hand.?off|human|escalat|graceful|default to/i, 'Define the fallback — human handoff or a deterministic path.'),
      sig('bad5', 'Plans for the “bad 5%”', /bad 5|wrong answer|when (it'?s|the model is|it is) wrong|failure|hallucinat|edge case|goes wrong/i, 'Say what the user sees and how they recover when the model is wrong.')
    ],
    evals: [
      sig('golden', 'Uses a golden / test set', /golden|ground truth|test set|labell?ed|benchmark|eval set|reference (set|answers)/i, 'Name a golden set — labelled examples you grade against.'),
      sig('offon', 'Covers offline and online evals', /offline|online|a\/b|shadow|canary|production|live traffic/i, 'Cover both offline evals and an online measure (A/B, shadow, canary).'),
      sig('judge', 'Mentions human or LLM-as-judge review', /llm.?as.?(a.?)?judge|judge|human eval|rater|annotat|review (by|from)/i, 'Say who grades quality — humans, an LLM judge, and the limits of each.'),
      sig('gate', 'Defines a ship gate / regression check', /regression|gate|threshold|before (ship|launch|release)|release criteria|ship bar|bar to ship/i, 'Define the bar to ship and a regression gate.')
    ],
    metrics: [
      sig('nsm', 'Names an AI-specific North Star', /task completion|acceptance|containment|edit distance|resolution|north star|success rate|deflection/i, 'Name a North Star such as task completion, acceptance rate, containment or edit distance.'),
      sig('guardrail', 'Names guardrail metrics', /hallucination|escalation|latency|p95|safety|complaint|thumbs.?down|guardrail|refusal/i, 'Add guardrails — hallucination rate, escalation rate, p95 latency.'),
      sig('economics', 'Covers unit economics', /cost per|per (successful )?(task|query|resolution)|margin|unit economics|token cost|roi|gross margin/i, 'State the unit economics — cost per successful task and margin.'),
      sig('risks', 'Names safety / privacy / vendor risks', /privacy|dpdp|gdpr|vendor|lock.?in|jailbreak|injection|abuse|drift|compliance/i, 'Name the main risk — privacy (DPDP/GDPR), vendor dependency, abuse, cost drift.')
    ]
  }
};

// Which rubric dimension each stage's evidence supports (a stage may feed more than one dimension).
var FEEDBACK_DIMENSIONS = {
  'product-sense': [
    { dimension: 'Clear communication', stages: ['communication'] },
    { dimension: 'Product motivation', stages: ['motivation'] },
    { dimension: 'Segmentation', stages: ['segmentation'] },
    { dimension: 'Problem identification', stages: ['problem'] },
    { dimension: 'Solution development', stages: ['solution'] }
  ],
  'analytical': [
    { dimension: 'Structured problem-solving', stages: ['assumptions', 'rationale'] },
    { dimension: 'Product & ecosystem understanding', stages: ['rationale'], extra: { metrics: ['ecosystem'] } },
    { dimension: 'Metric rigour', stages: [], extra: { metrics: ['ecosystem', 'timeframe', 'implement'] } },
    { dimension: 'North Star & guardrail judgment', stages: [], extra: { metrics: ['northstar', 'guardrail'] } },
    { dimension: 'Goal-setting and execution bridge', stages: ['goals'] }
  ],
  'rca': [
    { dimension: 'Clarify & quantify', stages: ['clarify'] },
    { dimension: 'Data validity', stages: ['validity'] },
    { dimension: 'Segmentation rigour', stages: ['segment'] },
    { dimension: 'Hypothesis discipline', stages: ['internal', 'external', 'converge'] },
    { dimension: 'Convergence & action', stages: ['converge', 'act'] }
  ],
  'ai-product': [
    { dimension: 'Communication', stages: ['assumptions'] },
    { dimension: 'Why-AI judgment', stages: ['why-ai'] },
    { dimension: 'System design', stages: ['system-design'] },
    { dimension: 'AI UX & trust', stages: ['ux', 'segmentation'] },
    { dimension: 'Eval rigour', stages: ['evals'] },
    { dimension: 'Metrics & economics', stages: ['metrics'] }
  ]
};

function feedbackWords(text) { var t = String(text || '').trim(); return t ? t.split(/\s+/).length : 0; }

// Depth expectations for TYPED NOTES (not a spoken answer): thin below ~8 words per allotted minute,
// comfortably full at ~14 per average minute. Only used for commentary — never blocks anything.
function feedbackDepth(stage, words) {
  var minMin = stage.minMin || 1, avg = ((stage.minMin || 1) + (stage.maxMin || stage.minMin || 1)) / 2;
  var thin = Math.max(20, Math.round(minMin * 8)), full = Math.max(thin + 10, Math.round(avg * 14));
  var depth = words < FEEDBACK_MIN_NOTE_WORDS ? 'missing' : words < thin ? 'thin' : words >= full ? 'full' : 'ok';
  return { depth: depth, thin: thin, full: full };
}

function evaluateStage(frameworkKey, stage, text) {
  var rules = (FEEDBACK_RULES[frameworkKey] || {})[stage.key] || [];
  var words = feedbackWords(text);
  var d = feedbackDepth(stage, words);
  var hits = [], misses = [], warns = [], total = 0;
  rules.forEach(function (r) {
    if (r.warn) { if (r.re.test(text || '')) warns.push({ id: r.id, message: r.warn }); return; }
    total++;
    if (r.re.test(text || '')) hits.push({ id: r.id, label: r.label });
    else misses.push({ id: r.id, label: r.label, fix: r.fix });
  });
  var ratio = total ? hits.length / total : 1;
  var verdict = d.depth === 'missing' ? 'missing' : (d.depth === 'thin' && ratio < 0.75) ? 'thin' : ratio >= 0.75 ? 'strong' : ratio >= 0.4 ? 'ok' : 'light';
  return { key: stage.key, name: stage.name, words: words, depth: d.depth, thinBelow: d.thin, fullAt: d.full, verdict: verdict, ratio: ratio, hits: hits, misses: misses, warns: warns, total: total };
}

// Builds the whole checklist feedback object. `fw` is the resolved framework ({key?, stages, rubric}).
function buildChecklistFeedback(caseObj, frameworkKey, fw, notes) {
  var stages = (fw.stages || []).map(function (st) { return evaluateStage(frameworkKey, st, (notes || {})[st.key]); });
  var byKey = {}; stages.forEach(function (s) { byKey[s.key] = s; });
  var strengths = [], improvements = [];

  stages.forEach(function (s) {
    s.warns.forEach(function (w) { improvements.push({ stage: s.key, stageName: s.name, text: w.message, fix: '', priority: 0 }); });
    if (s.verdict === 'missing') {
      improvements.push({ stage: s.key, stageName: s.name, text: 'This section is empty or very short.', fix: 'Write at least a few sentences covering: ' + (s.misses.map(function (m) { return m.label.toLowerCase(); }).join('; ') || 'the stage’s core points') + '.', priority: 1 });
      return;
    }
    s.hits.forEach(function (h) { strengths.push({ stage: s.key, stageName: s.name, text: h.label }); });
    s.misses.forEach(function (m) { improvements.push({ stage: s.key, stageName: s.name, text: 'I didn’t see: ' + m.label.toLowerCase() + '.', fix: m.fix, priority: 2 }); });
    if (s.depth === 'thin') improvements.push({ stage: s.key, stageName: s.name, text: 'Only ' + s.words + ' words — fairly thin for a ' + (fw.stages.filter(function (x) { return x.key === s.key; })[0].minMin) + '+ minute section.', fix: 'Aim for roughly ' + s.thinBelow + '–' + s.fullAt + ' words of notes here.', priority: 3 });
  });

  // Case-aware: is the answer anchored to the named company/product?
  var companies = (caseObj && caseObj.company) || [];
  if (companies.length) {
    var all = Object.keys(notes || {}).map(function (k) { return notes[k]; }).join(' ').toLowerCase();
    var named = companies.filter(function (co) { return all.indexOf(String(co).toLowerCase()) !== -1; });
    if (named.length) strengths.push({ stage: null, stageName: 'Whole answer', text: 'Anchors the answer to ' + named.join(' / ') + ' by name.' });
    else improvements.push({ stage: null, stageName: 'Whole answer', text: 'Your notes never name ' + companies.join(' / ') + '.', fix: 'Tie your answer to this specific product — use its name and real features.', priority: 2 });
  }

  // Dimension evidence: coverage of the signals that feed each rubric dimension. NOT a weak/solid/strong verdict.
  var dimMap = FEEDBACK_DIMENSIONS[frameworkKey] || [];
  var dimensions = (fw.rubric || []).map(function (r) {
    var def = dimMap.filter(function (d) { return d.dimension === r.dimension; })[0] || { stages: [] };
    var found = [], notSeen = [];
    function take(stageKey, onlyIds) {
      var s = byKey[stageKey]; if (!s) return;
      s.hits.forEach(function (h) { if (!onlyIds || onlyIds.indexOf(h.id) !== -1) found.push(h.label); });
      s.misses.forEach(function (m) { if (!onlyIds || onlyIds.indexOf(m.id) !== -1) notSeen.push(m.label); });
    }
    (def.stages || []).forEach(function (k) { take(k, null); });
    Object.keys(def.extra || {}).forEach(function (k) { take(k, def.extra[k]); });
    var tot = found.length + notSeen.length;
    var ratio = tot ? found.length / tot : 0;
    return { dimension: r.dimension, coverage: ratio >= 0.75 ? 'covered' : ratio >= 0.4 ? 'partial' : 'little', found: found, notSeen: notSeen, descriptors: { weak: r.weak, solid: r.solid, strong: r.strong } };
  });

  var totalSignals = stages.reduce(function (a, s) { return a + s.total; }, 0);
  var totalHits = stages.reduce(function (a, s) { return a + s.hits.length; }, 0);
  var ranked = stages.filter(function (s) { return s.verdict !== 'missing'; }).slice().sort(function (a, b) { return b.ratio - a.ratio; });
  var topImprovements = improvements.slice().sort(function (a, b) { return a.priority - b.priority; }).slice(0, 3);
  var spread = ranked.length > 1 && ranked[0].ratio > ranked[ranked.length - 1].ratio;
  var summary = 'The checklist found ' + totalHits + ' of ' + totalSignals + ' expected points across ' + stages.length + ' sections.' +
    (totalHits === 0 ? ' None of the expected points for these sections showed up — check that each section answers what it is asking.' : '') +
    (totalHits > 0 && spread ? ' Most complete: ' + ranked[0].name + '. Least complete: ' + ranked[ranked.length - 1].name + '.' : '');

  return {
    tier: 'checklist',
    overall: { summary: summary, hits: totalHits, total: totalSignals, words: stages.reduce(function (a, s) { return a + s.words; }, 0) },
    stages: stages, strengths: strengths, improvements: improvements, topImprovements: topImprovements, dimensions: dimensions
  };
}

if (typeof module !== 'undefined') module.exports = { FEEDBACK_RULES: FEEDBACK_RULES, FEEDBACK_DIMENSIONS: FEEDBACK_DIMENSIONS, buildChecklistFeedback: buildChecklistFeedback, evaluateStage: evaluateStage, feedbackWords: feedbackWords };
