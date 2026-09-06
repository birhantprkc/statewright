# Facilitator guide

## Session purpose

By the end, MEM students should be able to recognize AI as an operating-system layer for management work: useful when it helps people turn evidence into decisions and decisions into accountable action.

## Opening: the BEN Talk

The first five minutes are deliberately light on slides. Keep the title slide on screen, speak from a rehearsed but conversational monologue, then move into a conventional practitioner crash course.

The speaker notes for the first two slides are intentionally written as a watch-band-sized note card. They give delivery beats—not a script to read. Rehearse the opening around one real story of an idea delayed by organizational friction; do not invent a story or make broad claims about AI replacing people.

The following twelve minutes establish why the facilitator is speaking, then cover chat versus agents, Codex’s codebase/browser/computer work surfaces, the browser-permission boundary, skills, agents, plugins, tools/MCP, and five durable operating principles. The reverse panel starts at minute 17.

## Recommended room setup

- Stage room, large display, reliable HDMI, and strong Wi-Fi.
- Wireless handheld microphone for the reverse panel.
- Groups of four to six with a paper worksheet and a visible timer.
- Whiteboard or easel pad to capture panel themes and group pitches.
- No laptops required from students.

## Timing choices

### 60 minutes

- 17 min: BEN Talk and Codex / agentic-engineering crash course
- 10 min: reverse panel
- 8 min: breakout sprint
- 5 min: pitches and vote
- 15 min: live build
- 5 min: trust-test debrief

Use a preselected starter shape. Let the winning group choose the workflow, outcomes, and constraints—not the entire application surface.

### 75 minutes (recommended)

- 17 min: BEN Talk and Codex / agentic-engineering crash course
- 12 min: reverse panel
- 12 min: breakout sprint
- 9 min: pitches and vote
- 19 min: live build
- 6 min: trust-test debrief and close

### 90 minutes

- 17 min: BEN Talk and Codex / agentic-engineering crash course
- 15 min: reverse panel
- 18 min: breakout sprint
- 10 min: pitches, vote, and build-brief synthesis
- 22 min: live build
- 8 min: demo, trust test, and Q&A

## Reverse-panel prompts

Select 6–10 volunteers. Keep every answer to 45–60 seconds.

1. Where did AI honestly make you faster?
2. Where did it create more work, uncertainty, or risk?
3. What did it change in an internship, research lab, campus organization, or job?
4. What work should remain visibly human-owned?

Capture repeated themes—not verbatim answers. The output is a few candidate management problems, not a debate about whether AI is good.

## Breakout instructions

Assign each group a different challenge when possible. Give every group `content/breakout-worksheet.md` and twelve minutes. Encourage specificity:

- one primary user
- one decision or operating job
- one first-version output
- one explicit boundary

If a pitch sounds like a platform, ask: “What is the smallest decision it could improve by Friday?”

## Selecting the live build

Vote for the idea that is simultaneously useful, understandable, and feasible as a first vertical slice. The facilitator makes the final call if a vote is tied.

Avoid ideas that depend on private data, a third-party account, irreversible actions, or a complex integration. Translate those needs into a synthetic demo dataset or a mocked operating boundary.

## Live-demo staging

Use the presenter’s Sassy Copier/Skaffold and existing infrastructure to bootstrap the prototype. The live brief is the only content the agents need from the room.

Suggested workstreams:

1. Product contract: turn the brief into a small definition of done and acceptance checks.
2. Experience: build the primary decision screen and one clear interaction.
3. Implementation: create the data model and deterministic behavior using synthetic demo data.
4. Quality/governance: check requirements, empty/error states, and the human approval boundary.

Narrate the Statewright lesson: independent tasks can run in parallel, but agents need a shared contract, bounded authority, and an observable check before the work is accepted.

## Recovery path

Bring up the mostly completed Plan B app as a continuation, not an apology:

> “We have a working version of this same class of tool. Let’s use the remaining time to decide what the group would change before a real organization could trust it.”

Ask the room to apply the trust test:

1. What source supports each recommendation?
2. What can be wrong or missing?
3. What should require explicit approval?
4. What would prove this was useful after two weeks?

## Optional material if ahead of time

- A short Chief of Staff / management-operating-system tour.
- A deeper comparison of Claude/Codex terminal agents, Cursor-style environments, and prototype generators such as Lovable.
- A live example of an agent skill, hook, or reusable workflow.
- A discussion of how a prototype becomes a production system: data boundaries, observability, evaluation, approval, and change management.
