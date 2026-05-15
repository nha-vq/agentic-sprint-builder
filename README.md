# Agentic Sprint Builder

A Next.js-only TypeScript project for the AI Agentic Tech Contest Phase 1.

It demonstrates a markdown-skill multi-agent SDLC pipeline:

```text
requirements.md + tech-spec.md
        ↓
Orchestrator
        ↓
BA Agent → PRD + stories + acceptance criteria
        ↓
DEV Agent → architecture + generated implementation files
        ↓
QA Agent → test cases + QA report
        ↓
Contest Dashboard events
```

## Why this project fits the contest

- Uses a real multi-agent workflow: BA, DEV, QA.
- Agent skills are written in Markdown under `skills/`.
- Uses OpenRouter API as the LLM gateway.
- Emits dashboard events using the provided contest API.
- Generates Phase 1 implementation artifacts from requirements.
- Includes a DEV feedback loop for run/build readiness and QA blockers.
- Feeds existing generated code and recent run history back into BA, DEV, and QA agents for incremental changes.

## Setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Run history:

```text
http://localhost:3000/runs
```

## Required environment variables

```bash
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=google/gemini-2.5-flash
OPENROUTER_MAX_TOKENS=32768
AUTO_RUN_GENERATED_APP=true
VALIDATE_GENERATED_EXECUTION=true
ALLOW_GENERATED_DOCKER=true
GENERATED_COMPOSE_ENGINE=auto
GENERATED_BACKEND_PORT=8000
GENERATED_FRONTEND_PORT=3001
DASHBOARD_BASE_URL=https://aitechcontest.kms-technology.com/api
DASHBOARD_COMPANY_ID=
DASHBOARD_COMPANY_NAME=Agentic Sprint Builder
```

## Dashboard registration

Option 1: use UI button **Register Dashboard Company**.

Option 2: call API:

```bash
curl -X POST http://localhost:3000/api/dashboard/register
```

Copy the returned `company_id` into `.env.local`:

```bash
DASHBOARD_COMPANY_ID=returned-company-id
```

Restart `npm run dev`.

## How skills work

Each agent has a Markdown skill file:

```text
skills/ba.md
skills/dev.md
skills/qa.md
```

The loader reads front matter metadata and the markdown body. The markdown body becomes the system prompt.

Example metadata:

```md
---
agent_id: ba
name: Alice BA
role: analyst
model: google/gemini-2.5-flash
temperature: 0.2
---
```

## Main files

```text
lib/orchestrator.ts              # Controls BA → DEV → QA workflow
lib/openrouter.ts                # OpenRouter client
lib/dashboard.ts                 # Contest dashboard client
lib/skills/loadSkill.ts          # Markdown skill loader
lib/agents/ba-agent.ts           # BA agent
lib/agents/dev-agent.ts          # DEV agent
lib/agents/qa-agent.ts           # QA agent
app/api/runs/route.ts            # Run endpoint
app/page.tsx                     # Demo UI
app/runs/page.tsx                # Run history UI
app/runs/[runId]/page.tsx        # Per-run output UI
```

## Demo flow

1. Paste `requirements.md`.
2. Optionally paste `tech-spec.md`.
3. Click **Run AI Team**.
4. Watch the BA, DEV, and QA outputs.
5. Check dashboard for events if `ENABLE_DASHBOARD=true` and `DASHBOARD_COMPANY_ID` is set.
6. Run artifacts are written under `generated-runs/{yyyy-MM-dd-HH-mm-ss}`.
7. DEV-generated source files are written to the fixed `generated-code/` workspace.
8. If `VALIDATE_GENERATED_EXECUTION` is not `false`, the generated project is copied into an ignored validation workspace, then set up, built, tested, and health-checked before the final QA review. Compose validation tries `docker compose` first, then Rancher/containerd `nerdctl compose`; set `GENERATED_COMPOSE_ENGINE=docker` or `GENERATED_COMPOSE_ENGINE=nerdctl` to force one.
9. If `AUTO_RUN_GENERATED_APP` is not `false`, the generated FastAPI backend and Next.js frontend are installed and started locally after the final files are written. Defaults are backend `http://127.0.0.1:8000` and frontend `http://127.0.0.1:3001`.

On each run, the agents read the current `generated-code/` snapshot plus recent `generated-runs/` history so feature changes can be handled incrementally instead of recreating the project from scratch.

## Notes

This project itself does not use Python. The DEV agent may generate Python/FastAPI files if the provided tech spec requires that as the target implementation.
