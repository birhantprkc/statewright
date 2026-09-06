# Claude Code

### From Zero to Dangerous

<p class="subtitle">A hands-on tour of the AI-powered CLI that writes, tests, and ships your code</p>

Notes: Welcome everyone. Whether you're here for the hackathon or the workshop, by the end of this talk you'll have a practical understanding of Claude Code and how to wield it like a weapon.

---

## About This Talk

- What Claude Code is and why it matters
- The plugin ecosystem: skills, agents, hooks
- Building and sharing your own plugins
- MCP: connecting Claude to the outside world
- Test-driven development with an AI copilot
- Encoding your workflow DNA into reusable plugins

Notes: This is a practitioner's talk. Minimal slides, maximum signal.

---

## What is Claude Code?

An agentic CLI tool from Anthropic that lives in your terminal

- Reads, writes, and edits files directly
- Runs shell commands with your permission
- Understands your entire codebase contextually
- Plans, executes, and iterates autonomously

```bash
# Install it
npm install -g @anthropic-ai/claude-code

# Run it
claude
```

Notes: It's not an autocomplete. It's not a chatbot bolted onto an IDE. It's an autonomous agent that operates in your terminal with real tools.

----

### How It Differs from Copilot / Cursor / etc.

| Feature | Copilot | Cursor | Claude Code |
|---------|---------|--------|-------------|
| Inline autocomplete | Yes | Yes | No |
| Full file edits | Limited | Yes | Yes |
| Shell access | No | Limited | Yes |
| Autonomous agents | No | No | Yes |
| Plugin ecosystem | No | No | Yes |
| Works in any terminal | N/A | N/A | Yes |

The key difference: Claude Code has **agency**. It doesn't suggest -- it *does*.

Notes: The mental model shift is important. You're not tab-completing. You're delegating.

---

## Why Claude Code?

----

### Speed

A task that takes you 30 minutes of boilerplate, file-hopping, and Stack Overflow can be done in 2 minutes with a well-formed prompt.

You stop being the bottleneck for mechanical work.

----

### Context Window as Superpower

Claude Code reads your entire project structure. It understands:

- How your modules connect
- Your naming conventions
- Your test patterns
- Your dependency graph

You don't have to explain your codebase every time. It figures it out.

----

### The Compound Effect

Each interaction teaches you to:

- Write better prompts
- Structure projects for AI consumption
- Decompose problems into delegatable chunks

**You get better at working with AI, and AI gets better at working with your code.**

----

### Real-World Wins

- Scaffold a full Next.js feature from a one-line description
- Migrate 200 files from one API pattern to another
- Generate and fix tests until they pass -- hands-free
- Refactor a tangled module while preserving behavior

These aren't demos. These are Tuesday.

---

## Skills, Agents, and Hooks

The three pillars of Claude Code's extensibility model.

----

### Skills (Slash Commands)

Skills are user-invocable prompts triggered by `/command` syntax.

```markdown
# /deploy

Deploy the current branch to staging.
1. Run the test suite
2. Build the production bundle
3. Push to the staging remote
4. Verify the deployment health check
```

----

### Skills: Key Details

- Live in `.claude/commands/` or plugin packages
- Can accept arguments: `/deploy production`
- Expanded into the conversation as full prompts
- Each `.md` file becomes a command

----

### Agents (Subagents)

Specialized sub-processes launched to handle focused tasks.

```
Built-in agent types:
- Explore        (codebase navigation)
- Plan           (architecture decisions)
- code-search    (find files/functions)
- oracle         (deep reasoning/debugging)
- testing-expert (test strategy)
- ...and many more
```

Agents run in isolated contexts, return results, and exit. They don't pollute your main conversation.

----

### Hooks

Shell commands that fire on events -- before/after tool calls, on conversation start, etc.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "npx prettier --write $CLAUDE_FILE_PATH"
      }
    ]
  }
}
```

Hooks let you enforce invariants: formatting, linting, custom validation -- automatically.

----

### How They Work Together

```
User: /deploy staging

  Skill expands the /deploy prompt
    -> Claude plans the deployment
      -> Launches test-runner agent
      -> Launches build agent (parallel)
    -> Executes shell commands
      -> Hook: PostToolUse formats output
    -> Reports result
```

Skills define *what*. Agents handle *how*. Hooks enforce *always*.

----

### Skills as MCP Glue

MCP servers give Claude individual tools. Skills orchestrate them.

```markdown
# /ship-feature

1. Get the current branch's open PR from GitHub (MCP)
2. Run the test suite locally
3. If green, merge the PR via GitHub (MCP)
4. Post a summary to #releases in Slack (MCP)
5. Create a follow-up ticket in Linear (MCP)
```

One slash command. Three MCP servers. One cohesive workflow.

---

## Anatomy of a Plugin

----

### What's in the Box?

A Claude Code plugin is an npm package with a conventional structure:

```
my-plugin/
  package.json          # name, version, "claude-code-plugin"
  AGENTS.md             # instructions loaded into context
  commands/
    my-command.md       # slash commands
  hooks/
    pre-commit.sh       # hook scripts
  agents/
    my-agent.md         # custom agent definitions
```

----

### package.json

```json
{
  "name": "claude-code-plugin-example",
  "version": "1.0.0",
  "description": "An example Claude Code plugin",
  "keywords": ["claude-code-plugin"],
  "main": "index.js",
  "claude-code": {
    "commands": "./commands",
    "agents": "./agents",
    "hooks": "./hooks"
  }
}
```

The `claude-code` field tells Claude Code where to find your extensions.

----

### AGENTS.md

The brain of your plugin. Loaded into Claude's context when your plugin is active.

```markdown
# My Plugin

## Instructions
When the user asks about deployment, follow the
company's blue-green deployment protocol.

## Context
- Staging URL: https://staging.example.com
- Production URL: https://prod.example.com
- CI pipeline: GitHub Actions
```

This is where you encode domain knowledge, constraints, and behavioral rules.

----

### Commands (Slash Commands)

Each `.md` file in `commands/` becomes a `/command`.

**commands/scaffold.md:**
```markdown
# /scaffold

Create a new feature module with:
1. A route file
2. A controller
3. A service layer
4. Unit tests for the service
5. An integration test for the route

Use the project's existing patterns.
The feature name is: $ARGUMENTS
```

`$ARGUMENTS` captures whatever the user types after the command.

----

### Hooks

Scripts that execute on Claude Code lifecycle events.

**hooks/post-edit.sh:**
```bash
#!/bin/bash
# Auto-format after every file edit
if [[ "$CLAUDE_FILE_PATH" == *.ts ]]; then
  npx prettier --write "$CLAUDE_FILE_PATH"
  npx eslint --fix "$CLAUDE_FILE_PATH"
fi
```

Hooks are the guardrails. They run whether Claude remembers the rules or not.

---

## Building a Custom Plugin

Let's build one from scratch.

----

### Step 1: Scaffold

```bash
mkdir claude-code-plugin-quickstart
cd claude-code-plugin-quickstart
npm init -y
```

----

### Step 1b: Configure package.json

```json
{
  "name": "claude-code-plugin-quickstart",
  "keywords": ["claude-code-plugin"],
  "claude-code": {
    "commands": "./commands"
  }
}
```

----

### Step 2: Create a Command

**commands/hello.md:**
```markdown
# /hello

Greet the user by name if provided, otherwise
greet them generically. Be warm but professional.

Name: $ARGUMENTS
```

That's it. That's a slash command.

----

### Step 3: Install Locally

```bash
# Inside a Claude Code session
> /plugin install quickstart@my-marketplace

# Or from the shell
claude plugin install quickstart@my-marketplace --scope project
```

Now `/hello` is available in any Claude Code session within this project.

----

### Step 4: Add an Agent

**agents/reviewer.md:**
```markdown
---
name: code-reviewer
description: Reviews code for quality and correctness
tools: [Read, Grep, Glob, Bash]
---

You are a code review expert. When invoked:
1. Read the git diff of staged changes
2. Check for: missing error handling, unused
   imports, security concerns
3. Provide a concise review with actionable feedback
```

----

### Step 5: Add a Hook

**hooks/pre-commit-check.sh:**
```bash
#!/bin/bash
# Ensure no console.log statements in production code
if git diff --cached --name-only | grep -q '\.ts$'; then
  if git diff --cached | grep -q 'console\.log'; then
    echo "WARNING: console.log found in staged files"
    exit 1
  fi
fi
```

Register it in your plugin config and it fires automatically.

----

### Step 6: Test It

```bash
# Start Claude Code
claude

# Test your command
> /hello World

# Test the agent (Claude uses it automatically
# when review tasks arise)

# The hook fires on every commit attempt
> /commit
```

Iterate. The feedback loop is fast.

---

## Publishing Your Plugin

----

### Marketplaces

Plugins are distributed through **marketplaces** -- GitHub repos that index available plugins.

```bash
# Add a marketplace (inside Claude Code session)
> /plugin marketplace add your-org/your-marketplace

# Install a plugin from it
> /plugin install my-plugin@your-marketplace
```

The official Anthropic marketplace (`claude-plugins-official`) is pre-registered.

----

### Best Practices for Publishing

- **Clear README** -- what it does, how to use it, what commands it adds
- **Minimal dependencies** -- plugins load into every session
- **Scoped behavior** -- don't override global settings unless necessary
- **Semantic versioning** -- breaking changes get major bumps
- **Test your commands** -- run them in multiple project types

----

### Discovery

- Browse the official Anthropic marketplace
- Community marketplace repos on GitHub
- The ecosystem is young -- publish early, iterate often

If you build something useful this weekend, publish it. Seriously.

---

## MCP: Model Context Protocol

Connecting Claude to the outside world.

----

### What is MCP?

A standardized protocol for giving AI models access to external tools and data.

```
Claude Code <--MCP--> Your Server <---> Any API
```

- Claude discovers available tools via the MCP server
- Calls them like native tools
- Gets structured responses back

Think of it as a USB port for AI capabilities.

----

### Without MCP

Claude Code can only:

- Read/write local files
- Run shell commands
- Search the web

Powerful, but isolated.

----

### With MCP

Claude Code can also:

- Query your database
- Post to Slack
- Create Jira tickets
- Hit any internal API
- Interact with any service you expose

MCP turns Claude from a local tool into a connected agent.

----

### MCP Server Basics

An MCP server exposes **tools** over stdio or HTTP.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.tool("get_weather", { city: z.string() }, async ({ city }) => {
  const data = await fetch(`https://api.weather.com/${city}`);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
});
```

----

### Registering an MCP Server

In your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["./mcp-servers/weather.js"]
    }
  }
}
```

Claude Code starts the server automatically and discovers its tools.

---

## Writing a Custom MCP Tool

Let's connect Claude to a real API.

----

### The Goal

Build an MCP server that talks to the GitHub API so Claude can:

- List open issues
- Read issue details
- Post comments

----

### Step 1: Setup

```bash
mkdir mcp-github && cd mcp-github
npm init -y
npm install @modelcontextprotocol/sdk zod
```

----

### Step 2: Define Tools

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "github-issues",
  version: "1.0.0",
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const headers = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
};
```

----

### Step 3: Implement the Tools

```typescript
server.tool(
  "list_issues",
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }) => {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      { headers }
    );
    const issues = await res.json();
    const summary = issues.map(
      (i) => `#${i.number}: ${i.title} [${i.state}]`
    );
    return {
      content: [{ type: "text", text: summary.join("\n") }],
    };
  }
);
```

----

### Step 4: Wire It Up

```typescript
server.tool(
  "comment_on_issue",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    body: z.string(),
  },
  async ({ owner, repo, issue_number, body }) => {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}/comments`,
      { method: "POST", headers, body: JSON.stringify({ body }) }
    );
    const comment = await res.json();
    return {
      content: [{ type: "text", text: `Comment posted: ${comment.html_url}` }],
    };
  }
);
```

----

### Step 5: Start the Server

```typescript
import { StdioServerTransport } from
  "@modelcontextprotocol/sdk/server/stdio.js";

const transport = new StdioServerTransport();
await server.connect(transport);
```

Register in settings, restart Claude Code, and now Claude can manage GitHub issues natively.

---

## Cool Plugins Worth Knowing

----

### Graffiti

Visual annotation plugin. Tag code regions with context that persists across sessions.

```bash
# Inside Claude Code
> /plugin install graffiti@claude-plugins-official
```

Mark sections of code with warnings, TODOs, or context that Claude will see and respect in future sessions.

----

### Botmem

Persistent memory management for Claude Code.

- Structured memory storage beyond the built-in system
- Recall across sessions
- Categorized memory banks

Useful when you need Claude to remember complex project-specific context that doesn't fit in AGENTS.md.

----

### Agents in ClaudeKit

Pre-built specialized agents you can drop into your workflow:

- **deploy-agent** -- handles multi-environment deployments
- **review-agent** -- deep code review with configurable rulesets
- **docs-agent** -- generates and maintains documentation

These are reference implementations. Study them to build your own.

---

## Test-Driven Development with Claude Code

This is where it gets fun.

----

### The Core Loop

```
1. Write a test (or have Claude write it)
2. Run the test -- it fails (red)
3. Have Claude write code to make it pass
4. Run the test -- it passes (green)
5. Refactor
6. Repeat
```

Claude Code is *exceptionally* good at this loop because it can run the tests itself and iterate until green.

----

### E2E Tests with Playwright

Have Claude write simple, focused E2E tests:

```typescript
import { test, expect } from "@playwright/test";

test("login flow", async ({ page }) => {
  await page.goto("/login");
  await page.fill('[data-testid="email"]', "user@test.com");
  await page.fill('[data-testid="password"]', "password");
  await page.click('[data-testid="submit"]');
  await expect(page).toHaveURL("/dashboard");
});
```

----

### Running Headless with Diagnostics

Configure Playwright to dump what Claude needs:

```typescript
// playwright.config.ts
export default defineConfig({
  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
```

Claude can read screenshots, parse console output, and diagnose failures autonomously.

----

### The Red/Green TDD Prompt

```
Write a failing test for [feature].
Run it. Confirm it fails.
Now implement the minimum code to make it pass.
Run the test again. If it fails, fix the code.
Repeat until green.
Do not modify the test.
```

This prompt pattern constrains Claude to the TDD discipline. The test is the spec. The code serves the test.

----

### Unit + E2E Together

```
For this feature:
1. Write unit tests for the service layer
2. Write an E2E test for the user-facing flow
3. Implement the service layer until unit tests pass
4. Implement the UI until the E2E test passes
5. Run all tests together to confirm nothing broke
```

Layer your tests. Unit tests catch logic bugs. E2E tests catch integration bugs. Together they catch everything that matters.

----

### agent-browser + Deploy Loop

For rapid UI iteration:

1. Deploy to a preview environment
2. Use agent-browser to navigate the live app
3. Capture console errors, network failures, visual bugs
4. Fix and redeploy
5. Repeat

----

### Deploy Loop: Cloud Preview

```
Deploy this to Vercel preview.
Open the preview URL with agent-browser.
Check for console errors and visual regressions.
Fix any issues and redeploy. Repeat until clean.
```

Fast feedback, catches environment-specific issues.

----

### Deploy Loop: Local with Docker

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports: ["3000:3000"]
    volumes:
      - ./src:/app/src   # hot-reload via bind mount
```

Pair with a dev server (Vite, nodemon, etc.) inside the container. Claude edits files, the container picks up changes instantly.

```
Run docker-compose up.
Open localhost:3000 with agent-browser.
Check for errors. Fix. Changes reload automatically.
```

No cloud account needed. Fully local feedback loop.

----

### Pro Tips for TDD with Claude

- **Keep tests simple.** Complex test setups confuse the agent.
- **Use data-testid attributes.** Reliable selectors beat fragile CSS selectors.
- **One assertion per test** when starting. Expand later.
- **Let Claude see the error.** Don't summarize -- let it read the full output.
- **Commit after green.** Every passing state is a checkpoint.

---

## Codifying Your DNA into a Plugin

The most powerful and personal application.

----

### What is "Developer DNA"?

Your accumulated preferences, patterns, and principles:

- How you name things
- How you structure projects
- What you consider clean code
- Your review checklist
- Your deployment process
- Your debugging approach

All of this can be encoded into a plugin.

----

### Why Bother?

- **Consistency across machines** -- same behavior on your laptop and your workstation
- **Collaboration** -- teammates get your standards without a 40-page style guide
- **Onboarding** -- new team members inherit your patterns instantly
- **Persistence** -- your preferences survive context window resets

----

### AGENTS.md: Code Style

```markdown
# Team Standards

## Code Style
- Use early returns over nested conditionals
- Prefer composition over inheritance
- Name boolean variables as questions: isReady, hasAccess
- Error messages must include the operation that failed

## Architecture
- Services are stateless. State lives in the store.
- API calls go through the client layer, never direct.
```

----

### AGENTS.md: Review Checklist

```markdown
## Review Checklist
Before approving any change:
1. Are there tests?
2. Are error cases handled?
3. Is the change backward compatible?
4. Are there any N+1 queries?
```

This lives in the same file. Claude reads and enforces it every session.

----

### Commands as Workflow Automation

```markdown
# /review

Review the current git diff against our team standards.

Check for:
1. Missing tests for new functions
2. Console.log or debugger statements
3. Direct API calls bypassing the client layer
4. Missing error handling on async operations

Provide feedback as a numbered list with file:line refs.
```

----

### Hooks as Guardrails

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write",
        "command": "echo 'Reminder: new files need tests'" }
    ],
    "PostToolUse": [
      { "matcher": "Edit",
        "command": "./scripts/check-conventions.sh $CLAUDE_FILE_PATH" }
    ]
  }
}
```

Hooks fire whether Claude remembers the rules or not.

----

### Multi-Machine Sync

Publish your plugin to a marketplace, install it everywhere:

```bash
# Inside Claude Code on any machine
> /plugin marketplace add your-org/team-plugins
> /plugin install my-standards@team-plugins

# Or from the shell
claude plugin install my-standards@team-plugins
```

One source of truth. Every environment stays in sync.

----

### Collaboration Pattern

```bash
# In your project's .claude/settings.json
{
  "plugins": ["team-standards@your-org-marketplace"]
}
```

Now every developer who runs Claude Code in the repo automatically gets the team's standards, commands, and hooks.

The plugin *is* the style guide. It's alive and it enforces itself.

---

## Working With an Agent: Hard-Won Tips

----

### Codify What Works

Agents feel their way through problems. They explore, try things, backtrack. Sometimes they get it wrong.

When Claude *does* find the right approach -- **write it down.**

```
"Add what you just learned about our deploy process
to CLAUDE.md so you don't have to rediscover it."
```

Have Claude write the documentation itself. It just lived through the problem -- it knows what to capture.

----

### Build Your Knowledge Base Incrementally

Every session is a chance to grow your project's institutional memory:

- `CLAUDE.md` -- project-level instructions Claude reads on every start
- `AGENTS.md` -- behavioral rules and domain knowledge
- `.claude/commands/` -- repeatable workflows as slash commands

Don't try to write these upfront. Let them accumulate organically from real work. The best documentation comes from solved problems.

----

### Put Repeatable Tasks in Taskfiles

If you find yourself re-explaining a task, it belongs in a file.

```yaml
# Taskfile.yml
tasks:
  test:
    cmds: [npx playwright test --reporter=list]
  lint:
    cmds: [npx eslint . --fix]
  deploy:
    cmds: [npm run build, npx wrangler deploy]
```

Agents guess when they don't have instructions. Taskfiles eliminate the guessing.

----

### Commit Early, Commit Often

Every passing test is a checkpoint. Every working state is a save point.

```
- Green tests?              Commit.
- Feature works?            Commit.
- About to try something?   Commit.
```

Agents wander. Commits give you a place to come back to.

----

### The Meta-Pattern

```
1. Work with Claude on a problem
2. Claude solves it (maybe after a few tries)
3. Have Claude write down what it learned
4. That knowledge is there next session
5. Repeat -- your project gets smarter over time
```

The agent is ephemeral. The markdown files are permanent. Invest in the permanent layer.

---

## Recap

- **Claude Code** is an autonomous agent in your terminal
- **Skills, Agents, Hooks** are the extension model
- **Plugins** package these into shareable, installable units
- **MCP** connects Claude to any external system
- **TDD with Claude** is a superpower -- write tests, let Claude iterate
- **Your DNA as a plugin** makes your standards portable and enforceable

----

## Getting Started Today

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Start using it
claude

# Browse plugins (inside Claude Code)
> /plugin

# Install one
> /plugin install some-plugin@claude-plugins-official
```

----

## Resources

- **Claude Code docs** -- claude.ai/docs/claude-code
- **MCP specification** -- modelcontextprotocol.io
- **Plugin examples** -- github.com/anthropics/claude-code
- **This deck** -- running locally on your machine right now

---

## Go Build Something

You have a hackathon ahead of you.

Claude Code is the multiplier.

The best way to learn it is to use it on a real problem, starting now.
