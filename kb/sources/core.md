# ABOUT ABHISHEK YOGI

Product Manager and data enthusiast with 7+ years shipping 0→1 and growth-stage products across AI and platform integrations. Has built chatbots driving $1M+ monthly revenue, 55% automation, and a 12% AHT (average handle time) reduction, and led the data ecosystem (2 analysts and a data engineer) behind the Ops Product team's decisions. Note: he has NOT worked in B2B SaaS — his B2B experience is subscription-based monetization of the chatbot to 8 local travel agents ($40K MRR), not building a B2B SaaS product. Owns the full product lifecycle — strategy, GTM, and execution — across Engineering, Data, Marketing, and Operations. Deep experience in conversational AI, RAG systems, monetization, and API-driven platform integrations — including Vertex AI, WhatsApp Cloud API, and NICE CX platform integrations owned end-to-end. Based in Gurugram, Haryana, India.

# PRODUCT PHILOSOPHY / POINT OF VIEW

Abhishek writes and speaks publicly about where product management is headed in the AI era. Core view: conventional PM work (writing stories, running standups, routine coordination) is increasingly automatable, but real PMing is a skill fueled by curiosity, not a job title, and it won't die. What matters going forward: defining what's truly worth solving (not just executing a backlog); navigating people, since product is largely EQ and influence; setting the narrative and vision when there's no product yet; and making contextual, morally-weighted trade-offs — a human judgment call AI can't replace. His take: AI empowers PMs who already have strong fundamentals, but won't rescue weak ones — not becoming AI-enabled, and not sharpening core PM fundamentals, is the real risk, not AI itself.

# EXPERIENCE

## Fareportal — AI Product Manager ← Product Manager ← Associate PM (Aug 2021 – Present)

### AI & Conversational Products
- Built an AI chatbot on Google Vertex AI with robust intent detection, multilingual support, and context handling, lifting CSAT by 29%.
- Architected the AI Trip Planner (internally called "Oli") end-to-end, driving 15% engagement and 65+ daily flight conversions.
- Orchestrated LLM-based evaluation with offline error analysis and continuous live monitoring for reliable outputs.
- Launched a RAG Agent Co-Pilot on the internal knowledge base, cutting AHT by 12% and enabling 5+ concurrent chats per agent.
- Built personal AI agents to sentiment-analyze weekly chat transcripts and auto-triage negative feedback into Azure Board tickets.

### Platform Integrations & B2B
- Partnered with Google to onboard Vertex AI APIs, converting platform capability into a production chatbot.
- Led WhatsApp Cloud API integration for social ads — owned GTM and aligned Marketing and Ops to launch the channel.
- Drove NICE CX platform integration for chat routing, agent workflows, transcripts, and reporting via APIs.
- Spearheaded B2B subscription monetization, scaling chatbot adoption across 8 local travel agents to $40K MRR.

### 0→1 Launches & Growth
- Shipped a Dialogflow-based chatbot handling 10K daily chats — 55% automation, $33.3K daily revenue.
- Initiated WhatsApp support via Meta APIs on social ads, generating 25 new bookings and $3.7K daily revenue.
- Built a Priority Leads Tool: a SQL-driven rules engine (defined with Ops leaders from real support patterns, e.g. flagging users who'd contacted support 3+ times across call/email/chat) that prioritizes high-risk leads in the CRM, each rule with its own SLA tracked via dashboards. Goal was predicting and resolving complaints before they snowballed. Result: complaints down 8%, still running today, fully automated.
- Launched Assisted Selling: a chat option on the flight listing page so travel experts could help users mid-booking-funnel. Identified and tested triggers (low conversion, idle customers, senior travelers, multi-city trips, sold-out/no-results), built rule-based routing sending high-quality leads to top-performing agents, and ran UX experiments on the chat icon (tooltips, unread counters, animation) to lift CTR. Integrated with the agent booking engine (OBE) so a single click carried the customer's exact search and selected flight to the agent, cutting AHT. A companion feature, Search Explorer, used predictive filtering and value-focused UI tiles (e.g. "faster by 3hrs for $20 more") to guide users to better flights, driving 40% higher conversion on flights selected through it — all validated via A/B testing to confirm incremental bookings rather than cannibalized online conversion.
- Led 12 SDEs, 3 QAs, and 2 designers, and served as single POC across Sales, Support, Revenue, and Payments.
- Ran competitive analysis of Trip.com, Expedia, and Mindtrip to shape the Trip Planner roadmap.

Fareportal itself powers travel for 40M+ travelers across 195 countries through CheapOair, OneTravel, and AI-driven platforms.

## OYO Rooms — Sr. Business Analyst ← Business Analyst (Jun 2019 – Jul 2021)
- Increased monthly SHNs (Sold Hotel Nights) by 6% (~$50K) by identifying high-potential areas and optimizing supply.
- Boosted vacation bookings 10% by building the BRIX model, driving execution with 25 account managers.
- Optimized pricing via sensitivity analysis on floor prices, driving ₹2.98 Cr in impact.
- Designed and automated 30+ live dashboards and 100+ reports using Excel, SQL, and Power BI.

# FEATURED PROJECTS

## CheapOair AI Chatbot (professional, live at cheapoair.com/chatbot)
The post-booking flight support chatbot, owned end-to-end. Phase 1: a Dialogflow ES rule-based bot scaled to 50% automation and 62% CSAT across flows like new bookings, cancellations, exchanges, schedule changes, and add-ons. Phase 2: rearchitected onto Vertex AI as a multi-agent Gen AI system (an orchestrator agent plus specialized agents — Intent Classifier, Booking Details, Small Talk, FAQs, Agent Summarization) with digression, flow-switching, flow queries, global queries, and clarification. Evaluated with offline test suites (golden, adversarial, regression) and online LLM-as-judge scoring (groundedness, faithfulness, safety, jailbreak resistance, answer relevancy). Cleared with Legal, InfoSec, and an internal AI committee before rolling out to 5% of traffic. Results: engagement 58%→70%, containment 48%→53%, CSAT 62%→80%. Biggest challenge: prompt engineering mastery.

## Oli — AI Trip Planner (professional, in the CheapOair app)
A conversational, AI-powered trip-planning assistant, owned from problem framing and PRD through a phased roadmap. Solves fragmented travel planning by unifying destination discovery, flight search, itinerary planning, and personalized guidance into one journey-aware conversational interface. Serves three personas — Explorer ("I don't know where to go"), Planner ("I know where I want to go"), and Shopper ("I want the best flight"). Personalization framework spans geolocation (with consent), behavioral signals, and conversation memory. Phased roadmap: Phase 1 discovery/itinerary/flight/sharing; Phase 2 app-behavior syncing, journey intelligence, personalized recs; Phase 3 proactive notifications, recommendation-engine optimization, deep booking-funnel integration.

Origin & execution: the mandate came from leadership to solve trip-planning discovery with AI. Abhishek kicked off with competitive analysis of Trip.com and Mindtrip, circulated internally, then ran a month-long UX design process with multiple leadership-reviewed iterations before locking the interaction model. Execution spanned three engineering pods coordinated via daily requirement-grooming syncs: Chatbot (UI/conversational logic), RPA (the Gen AI content backend), and App (where Oli surfaces).

Rollout: staged and metrics-gated rather than time-boxed — internal UAT, then an org-wide test pass for feedback, then 5% of app traffic (auditing chat transcripts for bugs/gaps while watching A/B metrics to confirm Oli wasn't cannibalizing the app's existing conversion and bookings), advancing to 20% → 50% → 100% only once metrics trended positive. Instrumented via A/B testing, Excel/Power BI dashboards, Google Analytics funnel tracking, and App Insights for technical logging.

Outcome: +15% engagement and 65+ daily flight conversions.

## Arthritis Companion (curiosity build, personal)
A login-free daily PWA for tracking arthritis symptoms and gentle exercises, designed around one real person's arthritic hands (large tap targets, no sliders/drag gestures, voice-friendly notes, one-handed "Done" button, no account). Local-first: all data on-device via IndexedDB, no backend, exportable backups. Built with React 19, TypeScript, Vite, Dexie/IndexedDB, as an installable offline-capable PWA. Notably, Abhishek vibe-coded it solo as the PM — he owned the problem, design constraints, and product decisions, and AI coding tools (Claude Code / Cursor) turned those into shipped code.

It has grown past the original four screens (Today, History, Exercises, Guides) into a fuller health tool:
- Body map: interactive front-view silhouette, 18 tappable joints (shoulders, elbows, wrists, hands, back, hips, knees, ankles, feet), used for both logging and a joint-frequency heatmap on the Today dashboard. Tap targets stay accessible (44px floor) even for tightly-spaced pairs.
- Today dashboard: a stat ring for 7-day logging consistency, sparkline trends for pain and morning stiffness, and the body-map heatmap — replacing an earlier flat trend-card layout.
- Inflammatory signal screening: a conservative, non-diagnostic check that only flags when ≥3 of the last 30 days show both 60+ min morning stiffness and symmetric small-joint pain (e.g. both hands/wrists), and only after ≥10 logged days. A quiet nudge toward a doctor visit, never a diagnosis — deliberately tuned to avoid false positives on sparse data.
- Medications & adherence: medication name, dosage, time-of-day slots, daily dose logging, optional reminders; logged doses roll up into an adherence rate.
- Doctor report: a printable one-page 30-day summary — average pain, good days, stiffness days, top affected joints, medication adherence, any inflammatory-signal flag, and extreme-pain streaks — built to bring to a doctor visit instead of recalling weeks of symptoms from memory.

All of this is live on the deployed demo. Live demo: https://abhishekyogi24-hue.github.io/og-pm/. Source: https://github.com/abhishekyogi24-hue/og-pm.

## Ship Gate (curiosity build, personal)
A PM-operable AI eval harness: turns a product description or a batch of real production traces into a golden and adversarial test suite, runs it against a live conversational AI product, and returns a ship/hold verdict — including checking whether its own LLM judge can be trusted. Two paths into a suite: from real traces (read them, note what went wrong, cluster into failure modes, generate tests that target them) or from a written brief pre-launch. Tests run against any chatbot via a live endpoint, or a manual paste-the-reply mode for hosted bots that block CORS. Deterministic assertions run first and are free; an LLM judge handles the fuzzy rubric only on what assertions can't decide. A judge-alignment panel measures the judge's own hit rate and false-alarm rate against human labels, reported separately rather than averaged into one accuracy figure. Built solo in Claude Code — no PRD, a one-page bet written down first, then shipped and tested against real usage. Live demo: https://ship-gate-abhishek.netlify.app (no public source repo).

# SKILLS
- Gen AI / Tech: Conversational AI, Evals, Vibe Coding, RAG, Prompt Engineering, Error Analysis, Prototyping, Machine Learning
- Analytics: Advanced Excel, SQL, Python, R, Power BI, Google Analytics, FullStory, Tableau, Statistical Analysis, C/C++
- Product: 0→1 Roadmap, Agile/Scrum, A/B Testing, User Research, Wireframing, First Principles Thinking, GTM
- Platform: Cursor, Azure, Google Cloud, Figma, FullStory, SQL Server, NICE CX One, App Insights, WhatsApp Cloud
- Daily AI Tools: Claude Code (vibe coding), Cursor, ChatGPT/Claude chat (daily search), Ghostty (terminal), Obsidian (notes), Whisperflow (voice), Nanobanana (image creation), Microsoft Copilot (PRDs, competitive analysis, day-to-day office tasks, and two custom AI agents — one that sentiment-analyzes weekly chat transcripts, another that auto-triages negative feedback into Azure Board tickets)

# AWARDS
- 1st Prize ($560) — Fareportal Bug Hunt 2024, for identifying the most impactful org-wide bug.
- Top 5 Product Manager (2024) — for WhatsApp and GenAI POCs driving product innovation.
- Certificate of Excellence — OYO, for boosting conversions via data-driven behavioral analysis.

# EDUCATION
B.Tech–M.Tech in Civil Engineering, Indian Institute of Technology (IIT) Kanpur, July 2014 – May 2019, CPI 8.2/10.

# CONTACT
- Email: abhishekyogi.24@gmail.com
- Phone: +91-7755057809
- LinkedIn: https://www.linkedin.com/in/abhiyogi/
- GitHub: https://github.com/abhishekyogi24-hue

# RESUME
A full resume (PDF) is downloadable from the Resume section on the site (nav link or scroll down) — point people there if they want the formal document rather than the condensed on-page summary.
