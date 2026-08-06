# Why the CheapOair chatbot was built

Back when call and email were the only options customers could contact CheapOair for support. Use case: 60% of bookings are international (wrt US), so calling was expensive due to roaming and email doesn't get quick support.

Research done to reach that conclusion:
1. Surveys (preferred channel for support)
2. Customer feedback on IVR
3. Agent's (Operations) feedback — conveying voice of customer

Then launched a chatbot for quick support for flight post booking. Initially, it had just 20% automation (i.e. queries which the chatbot handled end-to-end), with basic flows like booking details, billing details, etc. onboarded. For any transactional or extra support, chats were handed off to travel experts.

## Dialogflow ES phase — tech backend

Built on Google's Dialogflow (ES) version, where each intent is defined manually by adding possible training phrases that denote the intent. Dialogflow uses NLP where the keywords of a typed query match the keywords of training phrases — that's how intent matching is done. Each intent has a defined response, CTAs, and sub-intents so the user can converse.

Achieved 50% automation with 62% CSAT and 60% engagement, through onboarding self-serve flows like new bookings, cancellations, exchanges, schedule changes, add-ons, CCD, CCV. Coordinated with different product and business owners to understand the different processes, then supervised end-to-end integrations. Onboarded different agent teams to back the chatbot.

Day-to-day work: chat transcript review, connecting with stakeholders, and pulling insights from feedback to shape the next set of improvements to the chat experience.

## Why it moved to Gen AI (Vertex AI)

After 3 years on Dialogflow ES, and with Gen AI chatbots becoming the norm, customers increasingly typed freely the way they would on ChatGPT. The limitation of Dialogflow ES became clear: it's a basic NLP system that can't understand multi-turn conversation, free-flow casual conversation, or context — so user intent was often misclassified and the wrong flow would run.

As an interim fix, for major flows (exchange, cancel, schedule, add-ons) once intent is identified from CTAs or booking source, the typing box gets blocked and the user follows the fixed defined path — previously, users would type something mid-flow and get diverted, losing conversion and satisfaction.

In parallel, ran a POC of Dialogflow CX (which has Gen AI capabilities) with Google — multiple sessions understanding the architecture (webhook handling, upgraded interface). It didn't proceed due to cost and ROI.

So the team built its own architecture on Google's Vertex AI APIs (an existing billing account made this smoother). Main motivation: improving intent classification and chat experience. Created an orchestrator agent (decides what to do with the customer's query) plus specialized agents with defined jobs: Intent Classifier, Booking Details Query, Small Talk, FAQs, Agent Summarization.

Functionality built:
1. Digression — continue the previous flow after answering an in-between query
2. Flow switch — ask confirmation before transferring from one major intent to another
3. Flow queries — answer side queries within a major flow (e.g. cancel, then continue the cancellation steps)
4. Global queries — answer upfront for any query
5. Clarification — ask for clarification on an ambiguous query and show possible next steps

Evaluation — offline and online:
- Offline: golden sets (ground truth), adversarial sets (edge cases, prompt injections), regression sets (basic testing)
- Online: LLM-as-judge, App Insights logging, metrics on groundedness, faithfulness, safety, jailbreak resistance, answer relevancy

Cleared with Legal, InfoSec, and an AI committee for compliance, following the Gen AI guidelines the committee set. Opened first to internal stakeholders for testing, then org-wide with feedback forms, then live at 5% traffic after resolving feedback.

Result: engagement 70% (AI) vs 58% (Dialogflow), containment 53% (AI) vs 48% (Dialogflow), CSAT 80% (AI) vs 62% (Dialogflow). Biggest challenge: prompt engineering mastery.

# Earlier role: Sr. Business Analyst, Ops Product analytics

Before moving into product, led the analytics team for Operations Product with one data analyst. Work: dashboarding, migrating from Excel to Power BI, automating queries to feed dashboards, extensive SQL and data analysis, coordinating with PMs to review requirements and analyze released items, and helping with target setting.

# Priority Leads Tool — full story

Moved into product with a project to build a Priority Leads Tool: rules-based lead creation, with rules manually defined (on spreadsheets, then in SQL) alongside Operations leaders coordinated with daily. Rules came from experience and from finding loopholes in the system — e.g. prioritizing users who'd contacted support more than 3 times across different mediums (call, email, chat). Rules were then implemented as SQL queries controlling lead generation in the CRM. Every rule has an SLA, driven by Ops leaders for their teams to close before it breaches. Progress tracked via a dashboard of leads created and their status.

Goal: predict a future complaint and resolve it before it snowballs. The system still runs fully automated today.

# Building the chatbot from scratch — team and projects

Initially managed 4 developers and 1 QA, with no dedicated dev manager (team later grew to 12 SDEs, 3 QAs, and 2 designers as scope expanded).

Projects:
1. Enhancing user experience while a customer waits in queue.
2. Increasing engagement by predicting/capturing intent from the source the user arrived on the chatbot from.

## Assisted Selling — full story

Integrated a chat option on the flight listing page to help users during the booking funnel with travel experts on chat. Identified triggers to test the chat option on — starting with low-conversion-rate triggers, then evolving to idle customers, senior segment, multi-city, and no-results/sold-out cases. Built rule-based routing so high-quality leads go to high-performing agents, while pushing Ops to review and improve low-performing agents. Experimented with multiple chat-icon UX variants (tooltips, unread-message counters, animated icon) to increase CTR/chats. Reviewed transcripts daily for action items and improvement areas.

Integrated seamlessly with OBE (the agent booking tool) so a single click opens the same search on OBE that the customer searched online — including highlighting any flight the customer had selected for review — cutting agent handle time.

Also built Search Explorer: narrows the search for the user by anticipating the next filter to apply based on prior selections, with UI tiles clearly explaining why a flight is a better option (e.g. "faster by 3hrs for just $20 more") to give users a clear value comparison. Users who selected a flight via Search Explorer had 40% higher conversion.

Goal throughout: not to cannibalize online conversion/bookings, but to add incremental bookings from the chatbot — validated with A/B tests at every step.

## AI Trip Planner (Oli) — full story

Idea came from leadership to explore how AI could solve trip planning and discovery. Started with competitive analysis on Trip.com and Mindtrip, compiling what they were doing and where there was room to differentiate, and circulated internally to gather ideas on how people plan trips, looking for a common pattern. Then ran a month-long design process with a UX designer, iterating multiple times with leadership review before locking the final version. In parallel, wrote the PRD and scoped what would land in phase 1 vs. later phases.

Three engineering teams involved: Chatbot (UI and chat functionality), RPA (the backend generating AI content), and App (where Oli surfaces). Daily syncs with all three to groom requirements and rework anything missed or unknown.

Oli's features:
1. Destination discovery — intelligently narrows suggestions using personalized info.
2. Day-wise itinerary planning.
3. Flight discovery — the ultimate conversion goal; prompting the right flight options at the right time is key.
4. Hotel/car discovery (phase 2) — same idea of covering every angle: how to travel, when, where to stay, how to commute, what to visit.
5. Booking-funnel assistant — answers questions in context on the listing page, review page, add-travellers page, seat-selection page, and payment page, all aimed at converting the user in-app.
6. Post-booking assistance, linked to the existing chatbot — since pre- and post-booking context come from different APIs, defining how that context carries over was an important design detail.
7. Instrumented via A/B test metrics, Excel/Power BI dashboards, Google Analytics for funnel tracking, and App Insights for technical logging.
8. Phased launch: internal UAT, then org-wide exposure for feedback, then live at 5% of app traffic → 20% → 50% → 100%. At 5%, audited transcripts to confirm real usefulness and watched A/B metrics to make sure the app's existing conversion and bookings weren't being cannibalized — trending positive at each stage before advancing.

## WhatsApp integration — new sales leads from social media ads

Ran a preference survey for communication channels and found significant WhatsApp preference in Asian and LatAm segments, so launched WhatsApp links embedded in Facebook and Instagram ads.

Research covered: the types of messages available on the Meta WhatsApp Cloud Platform, cost, which template messages were needed for the use case, dynamic greeting messages per ad/flow, how an agent would know which ad a user came from (so the value proposition matched), and Agent-to-booking-platform integration to reduce agent handle time (auto-passing search details and opening the listing page for the agent). Also designed a flow to re-engage customers who went inactive.

Started with a POC on how a WhatsApp user connects with an agent on NICE Max UI, working out the mechanism via backend polling. Coordinated with Marketing on ad placement/targeting strategy, and led internal approvals for budget and Meta billing setup.

Objective: connect customers with travel experts to assist with booking. Result: initiated WhatsApp support via Meta APIs on social media ads, generating 25 new bookings and $3.7K daily revenue.

# Daily AI tools — in his own words

Vibe-codes mainly on Claude Code, and uses Cursor to build prototypes for office purposes. Does most daily searches on Claude chat or ChatGPT. Ghostty for terminal, Obsidian for markdown notes, Whisperflow for voice notes, Nanobanana for image creation. Uses Microsoft Copilot (premium) for:
1. Day-to-day tasks — content writing/editing, email drafting, finding info quickly from Outlook/Teams/Excel without manual searching, key insights from Excel.
2. Brainstorming, PRDs, user stories.
3. Competitive analysis.
4. An AI agent that fetches chat transcripts weekly, analyzes sentiment, and surfaces improvement areas and bugs.
5. An AI agent that fetches negative comments weekly, identifies core themes, and auto-creates action items in the Azure Board.
