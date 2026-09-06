<!-- .slide: data-background-image="assets/ben-stage-monologue.png" data-background-size="cover" data-background-position="center" -->

<div style="position: absolute; left: 7%; top: 9%; width: 53%; text-align: left; color: #ffffff; text-shadow: 0 2px 14px rgba(0,0,0,.9);">
  <h1 style="font-size: 1.35em; line-height: 1.05; margin: 0 0 .35em;">The Distance Between an Idea<br><br>&<br><br>a Working Thing Just Collapsed</h1><br><br>
  <p style="font-size: .45em; margin: 0; opacity: .9;"><b>AI as a Management Operating System</b></p>
  <p style="font-size: .45em; margin: 0; opacity: .9;">Purdue MEM · August 2026 Orientation · Ben Cochran</p>
</div>

Notes: NOTE CARD · 0–5 MIN · Start still. No bio, no tool names. Tell one true story: you saw a worthwhile idea stall in meetings, translation, handoffs, or waiting for someone to build it. “Most ideas do not die because they are bad; they die because the distance is too long.” Pause. “That distance just collapsed.” First versions now arrive before the old meeting would end. Do not hype: cheap creation means expensive consequences. Land: “If we can build almost anything, management judgment matters more—not less.”

---

<!-- .slide: data-background-image="assets/ben-stage-monologue.png" data-background-size="cover" data-background-position="center" -->

<div style="position: absolute; left: 7%; top: 12%; width: 50%; text-align: left; color: #ffffff; text-shadow: 0 2px 14px rgba(0,0,0,.9);">
  <h1 style="font-size: 1.28em; line-height: 1.08; margin: 0;">AI makes doing cheaper.<br><br>It makes deciding more valuable.</h1>
</div>

Notes: NOTE CARD · Finish the monologue. “The question is no longer only Can we build it? It is What should exist? Who is it for? What evidence can it trust? And who owns the consequence?” Then: “That is the management opportunity of AI—not replacing people with chatbots, but helping organizations see, decide, learn, and follow through faster without losing trust.” Move into the deck: “Let me make that practical.”

---

<div class="about-slide">
  <img class="about-portrait" src="assets/ben.jpg" alt="Ben">
  <div class="about-copy">
    <h2>I build systems that make good work easier to repeat</h2>
    <p>Builder · operator · wrangler of organizational friction</p>
    <p class="about-line">I care about the systems around the model: the context, workflow, evidence, and judgment that make good work repeatable.</p>
  </div>
  <div class="about-connect">
    <img src="assets/linkedin-qr.png" alt="LinkedIn QR code">
    <p>Connect on LinkedIn</p>
  </div>
</div>

Notes: 5–7 MIN · Make this personal and credible, not exhaustive. Pick three specific anchors: (1) where you learned to ship or operate under real constraints; (2) an example of organizational friction you have tried to remove; (3) why AI systems became your current focus. Give one sentence each. Name Statewright only as one example of work you are doing, not as a pitch. End: “I am interested in the systems around the model—the part that makes good work repeatable.”

---

<div class="indy-slide">
  <img class="indy-logo" src="assets/indy-hackers-logo.png" alt="Indy Hackers">
  <div class="indy-copy">
    <h2>Good work gets better<br>when the community is generous</h2>
    <p class="indy-role">Vice President · Indy Hackers</p>
    <p>Indy Hackers is a volunteer-run home for people who build things in Indiana: a place to meet collaborators, share what is working, and lower the barrier to entry into the broader statewide tech community</p>
  </div>
  <div class="indy-stats">
    <div><strong>3,000+</strong><span>members on Slack</span></div>
    <div><strong>42+</strong><span>meetups a year</span></div>
    <div><strong>2008</strong><span>building community since</span></div>
  </div>
</div>

Notes: 7–8 MIN · One human beat before we get technical. “This is one of the places I get my optimism: people showing up for one another, trading context, and making it easier for the next person to build.” Identify yourself as vice president, then make the bridge: “The tooling changes quickly. A strong local habit of sharing what works is the durable advantage.” Do not turn this into an advertisement; invite anyone new to Indianapolis to find the community afterward.

[Sources]
- https://indyhackers.org/

---

## LLMs create possibilities.<br>Agency changes the shape of the work.

| | It can do | You still own |
|---|---|---|
| **Chat** | explain, draft, explore | the question and judgment |
| **Agent** | inspect, use tools, create artifacts, iterate | the goal and boundary |
| **Agentic system** | coordinate specialized work against a shared contract | the decision, risk, and acceptance standard |

Notes: 7–9 MIN · Keep this human. Chat gives an answer; an agent can go look, make something, run a check, and revise; an agentic system coordinates several bounded jobs. “The scary part is not that it can type. The important part is that it can act across a workflow.” Do not imply autonomy without responsibility.

---

## Codex can work where the work happens

| Surface | It can work with | Management question |
|---|---|---|
| **Codebase** | local folders, terminal, tests | Is the work correct? |
| **Browser** | research, local apps, web context | Is the source and account right? |
| **Computer** | desktop applications and visible UI | What action may it take without approval? |

Notes: 9–11 MIN · Explain the surfaces, not a feature list. Codebase: inspect a repo, edit, run tests. Browser: research, review a local build, work through web tasks. Computer: a visible desktop interface, where the agent can click and type. “This is why the idea-to-artifact gap is collapsing.” Then add the boundary: broad surface area requires tighter permission and review.

[Sources]
- https://openai.com/index/introducing-the-codex-app/
- https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex

---

### Browser context is a real boundary

**In-app browser** — separate browser state; good for public pages, local development, and review.

**Chrome / Chromium context** — use when a task genuinely needs existing signed-in sessions, tabs, or extensions.

**Computer Use** — the broadest surface; use it deliberately and review the account, page, and action.

Notes: 11–12 MIN · Say this slowly: “Access is not intelligence. Permissions are policy.” For browser or computer tasks, keep the request narrow, inspect the account, and do not let a web page become an instruction source. This is the practical management lesson: capability and authority are separate design decisions.

[Sources]
- https://help-lb.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app

---

## Agentic engineering makes agency repeatable

| Building block | What it gives you |
|---|---|
| **Instructions** | the context and standards for one job |
| **Skills** | reusable expertise and repeatable workflows |
| **Agents** | focused workers with bounded responsibilities |
| **Plugins** | packaged capabilities, integrations, and defaults |
| **Tools / MCP** | controlled connections to code, data, and systems |
| **Tests / checks** | evidence that the result meets the contract |

Notes: 12–14 MIN · This is the crash course. Use one sentence per row. Skills are “how we do this kind of work”; agents are “who owns this focused task”; plugins package the capability; tools connect to real systems; checks prevent confidence from becoming proof. Mention that tools evolve rapidly, but this architecture is durable.

----

### Skills, agents, and hooks

| Building block | Think of it as | It protects against |
|---|---|---|
| **Skill** | a reusable playbook | re-explaining good work every time |
| **Agent** | a focused specialist | one giant, unfocused task |
| **Hook** | an automatic guardrail | hoping someone remembers the rule |

Notes: OPTIONAL DEPTH · Adapted from the original Data Mine crash course. Skills encode “how we do this”; agents take a bounded job; hooks enforce a mechanical rule after an action. Give a non-code example for each: a meeting-brief template, a finance reviewer, an automatic privacy check.

----

### Give the agent a project, not just a prompt

| Durable layer | Example |
|---|---|
| **Project guidance** | conventions, architecture, review standards |
| **Reusable task** | a skill for research, release, or analysis |
| **Connected tool** | read a system of record or prepare an action |
| **Verification** | a test, reviewer, or acceptance checklist |

> The more consequential the work, the less you should rely on “remember to do the right thing.”

Notes: OPTIONAL DEPTH · This is the modern version of the Data Mine “developer DNA” concept. The value is not memorizing prompts; it is capturing durable context once, then making it available and enforceable wherever the work repeats.

----

### Different creation tools for different work

| Tool shape | Examples | Reach for it when you need… |
|---|---|---|
| Conversation | ChatGPT, Claude | thinking, drafting, synthesis |
| Agentic coding | Codex, Claude Code | code, tests, tools, and iteration |
| Editor-first building | Cursor, Windsurf | a coding partner inside the IDE |
| Fast prototype generation | Lovable, v0, Bolt | a visible product concept quickly |
| Workflow automation | Zapier, Make, n8n | systems that pass work between services |

Notes: OPTIONAL DEPTH · Do not make this a brand contest. “Choose the surface that matches the work.” Generators are excellent at creating a first visual artifact; coding agents are stronger when the work needs tests, system context, and iteration; automation tools connect established systems. The tool landscape will change. The work shapes will not.

----

### A reliable agent loop

<div class="agent-loop" role="img" aria-label="Understand the task, make a change, run a check, inspect the result, then either accept it or revise and return to make a change.">
  <div class="agent-loop-main">
    <div class="agent-step">Understand the task</div>
    <div class="agent-arrow">→</div>
    <div class="agent-step">Make a change</div>
    <div class="agent-arrow">→</div>
    <div class="agent-step">Run a check</div>
    <div class="agent-arrow">→</div>
    <div class="agent-step">Inspect the result</div>
    <div class="agent-arrow">→</div>
    <div class="agent-step agent-accept">Accept</div>
  </div>
  <div class="agent-return">
    <span class="return-to-change" aria-label="Return to make a change">↖</span>
    <div class="agent-step agent-revise">Revise</div>
    <span class="return-from-inspect" aria-label="Return to revise">↙</span>
  </div>
</div>

Notes: OPTIONAL DEPTH · This is the Data Mine TDD lesson compressed for managers. Agents get dramatically more reliable when they can observe a result and try again. The “check” can be a unit test, a visual review, a reconciliation, or a human signoff—not only code.

---

## Five rules I learned the hard way

1. Make agents write things down.
2. Make repeatable work executable.
3. Start with evidence, not confidence.
4. Give every agent a clear boundary.
5. Treat “done” as a testable condition.

Notes: 14–17 MIN · Deliver these as maxims, with one concrete sentence each. The connective tissue: a good prompt is a conversation; a good system is a repeatable agreement. Statewright belongs here as the example of the fifth rule: workflows make authority, state, transitions, and validation visible. Do not explain its internals yet.

---

## Reverse panel: where has AI changed the work already?

Bring 6–10 volunteers forward.

1. What did you use AI for in school, work, research, or an internship?
2. Where did it make you faster?
3. Where did it make something worse, riskier, or less trustworthy?
4. What work still needs a human in the loop?

Notes: 17–29 MIN · Invite a mix of hands. Keep each answer to 45–60 seconds. Capture repeated nouns on a whiteboard: decisions, meetings, handoffs, research, quality, customers, compliance. Do not litigate a bad answer; ask “What made that risky?” The output is raw material for the build challenge.

---

## Today’s challenge

**Build a management tool that helps an organization move from ambiguity to accountable action.**

Your group will choose the problem, define what a good first version delivers, and tell us what the AI must not do.

Notes: 29–31 MIN · Explain the assignment: not an entire startup, one thin but consequential workflow. The winning group will direct a live build.

---

## Five possible builds

1. Monday-Morning Decision Brief
2. Project Rescue Room
3. AI Adoption Council
4. Management Accelerator
5. AI Make-vs-Buy Studio

Pick the one you would most want professionally.

Notes: 31–33 MIN · Give a 15–20 second spoken description of each from `content/challenge-menu.md`. Assign one option per group where practical; let two groups work the same option only if the room is large.

---

## Breakout sprint

In your group, decide:

- Who is stuck?
- What decision must they make?
- What inputs do they have today?
- What output would materially help?
- What must the AI never decide alone?
- What evidence would show the first version helped?

**You have 12 minutes. Choose one spokesperson.**

Notes: 33–45 MIN · Hand out `content/breakout-worksheet.md`. Circulate. Keep pulling groups toward one user, one decision, one first-version outcome, and one non-negotiable boundary. Ask: “What could this improve by Friday?”

---

## Pitch the room

You have 60 seconds:

> “For **[user]**, we will help them decide **[decision]** by turning **[inputs]** into **[output]**, while keeping **[risk]** under human control.”

Notes: 45–52 MIN · Enforce the minute. Write the compact version of each pitch somewhere visible. Applaud clarity, not feature count.

---

## Vote on the live build

Vote for the idea that is:

1. most valuable in a real organization
2. most interesting to see built now
3. specific enough for a first version today

Notes: 52–54 MIN · Show of hands is enough. If the vote ties, choose the idea with the clearest decision and usable source inputs. The goal is a strong live demonstration, not democratic perfection.

---

## Turn the pitch into a build brief

| Build question |  |
|---|---|
| **Who is the user?** |  |
| **What decision are they making?** |  |
| **What inputs do they have?** |  |
| **What first-version outcome would help?** |  |
| **What is non-negotiable?** |  |
| **Where is human approval required?** |  |
| **What evidence proves the first version helped?** |  |

Notes: 54–57 MIN · Fill this in live with the winning group. This is the shared contract for the agents. Do not start the build until every blank has a short answer.

---

## A live build needs more than one clever prompt

<div class="build-flow" role="img" aria-label="A shared build brief branches into product contract, experience, implementation, and quality and governance before converging on a working vertical slice.">
  <div class="build-node build-brief">Shared build brief</div>
  <div class="flow-arrow">↓</div>
  <div class="build-streams">
    <div>Product contract</div>
    <div>Experience</div>
    <div>Implementation</div>
    <div>Quality &amp; governance</div>
  </div>
  <div class="flow-arrow">↓</div>
  <div class="build-node build-slice">Working vertical slice</div>
</div>

Notes: 57–59 MIN · Parallelism is not “make many bots improvise.” It is independent work against a shared contract. Point to the brief on the preceding slide.

---

## What Statewright adds

Statewright makes the workflow visible and bounded:

- a state tells an agent what it may do now
- a transition records what must be true before it moves on
- tests and checks are gates, not afterthoughts
- model and agent roles can fit the kind of work

Notes: 59–61 MIN · This is the Statewright introduction. “When you give agents more ability, you need a better operating system around them.” Keep it practical: explicit authority, observable progress, and evidence before acceptance.

---

## The live build

Watch for four streams:

| Stream | Deliverable |
|---|---|
| Product | A small, testable definition of done |
| Experience | A decision-oriented interface |
| Implementation | Working data and behavior |
| Quality & governance | Checks, edge cases, and approval boundaries |

Notes: 61–76 MIN on the 75-minute plan; 61–83 MIN on the 90-minute plan. Start from your Sassy Copier/Skaffold and infrastructure. Narrate decisions and checks, not every token. Ask the room when the system proposes something the human should own. Use synthetic data and a thin vertical slice.

---

## What just happened?

- Made a first pass from a structured brief
- Split work that could happen independently
- Converted feedback into changes quickly
- Produced artifacts we could inspect

It did **not** supply organizational judgment, source truth, or accountability.

Notes: Use this slide if the build completes early, while checks run, or if you need to switch to Plan B. It preserves the teaching moment without pretending the demo went exactly as planned.

---

## The trust test

Before an AI-enabled workflow is real, ask:

1. What source is this grounded in?
2. What can it get wrong?
3. Who sees and approves its output?
4. What happens when the evidence is missing?
5. How do we know it worked?

Notes: 76–79 MIN · Ask the winning group to answer one question each. Turn any technical wobble into a governance lesson: production trust comes from process, evidence, and review—not a beautiful prototype.

---

## Your advantage is not “prompting”

Your advantage is learning to:

- find the decision worth improving
- define the constraints that matter
- design human judgment into the loop
- turn one good solution into a repeatable operating system

Notes: 79–81 MIN · Close decisively. “Use AI generously for exploration; use it carefully for consequential action.” Thank panelists and groups.

---

## One final question

### What is a decision or handoff in your future organization that should never again depend on someone remembering to follow up?

Notes: OPTIONAL · 81–90 MIN · Use for Q&A or a reflective close. If the session is 60 minutes, skip this and compress directly to the trust test after a shorter live build.

---

<div class="qa-slide">
  <div>
    <h2>Questions?</h2>
    <p>Let’s talk about the work you want to make more possible.</p>
    <p class="qa-prompt">Connect, compare notes, or send me the management problem you think AI should help solve.</p>
  </div>
  <div class="qa-connect">
    <img src="assets/linkedin-qr.png" alt="LinkedIn QR code">
    <p>LinkedIn</p>
  </div>
</div>

Notes: OPTIONAL FINAL SLIDE · Leave this up for Q&A. Do not fill the silence; let students scan, ask, or approach after the session.
