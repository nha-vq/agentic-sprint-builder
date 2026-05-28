# Agentic Sprint Builder

A Next.js-only TypeScript project for the AI Agentic Tech Contest Phase 1.

It demonstrates a markdown-skill multi-agent SDLC pipeline:

```text
requirements.md + tech-spec.md
        ↓
Orchestrator
        ↓
BA Agent → user stories + DEV/QA artifacts
        ↓
TA Agent → tech stack analysis + DEV skill upgrade
        ↓
DEV Agent → generated implementation files
        ↓
Code Review → quality gate + fix requests
        ↓
DevOps Agent → containers + Rancher/Desktop deploy validation
        ↓
QA Agent → post-deploy end-to-end validation
        ↓
Contest Dashboard events
```

## Why this project fits the contest

- Uses a real multi-agent workflow: BA, TA, DEV, Code Review, DevOps, QA.
- Agent skills are written in Markdown under `.github/skills/`.
- Uses OpenRouter API as the LLM gateway.
- Emits dashboard events using the provided contest API.
- Generates Phase 1 implementation artifacts from requirements.
- Includes DEV feedback loops for Code Review, DevOps/deploy readiness, run/build readiness, and QA blockers.
- Feeds existing generated code and recent run history back into BA, DEV, Code Review, DevOps, and QA agents for incremental changes.
- Generates and reuses project-specific DEV skills under `project-skills/` so future feature work preserves the generated stack and structure.

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
FALLBACK_LOCAL_VALIDATION_WHEN_COMPOSE_SKIPPED=true
GENERATED_COMPOSE_ENGINE=auto
AUTO_START_RANCHER_DESKTOP=true
RANCHER_DESKTOP_PATH=
RANCHER_RDCTL_PATH=
RANCHER_START_CONTAINER_ENGINE=moby
RANCHER_START_KUBERNETES=true
RANCHER_START_IN_BACKGROUND=true
RANCHER_START_TIMEOUT_MS=600000
RANCHER_READY_POLL_MS=3000
GENERATED_BACKEND_PORT=55080
GENERATED_FRONTEND_PORT=55001
CLEAN_GENERATED_COMPOSE=true
REMOVE_GENERATED_COMPOSE_IMAGES=false
RUN_FULL_QA_AGENT=true
DASHBOARD_BASE_URL=https://aitechcontest.kms-technology.com/api
DASHBOARD_COMPANY_ID=
DASHBOARD_AGENT_IDS=
DASHBOARD_AGENT_BA_ID=
DASHBOARD_AGENT_TECH_STACK_ID=
DASHBOARD_AGENT_DEV_ID=
DASHBOARD_AGENT_CODE_REVIEW_ID=
DASHBOARD_AGENT_DEPLOY_ID=
DASHBOARD_AGENT_QA_ID=
DASHBOARD_AGENT_CREATE_PATH=
DASHBOARD_AGENT_DELETE_PATH=
DASHBOARD_REQUIRE_AGENT_IDS=false
DASHBOARD_COMPANY_NAME=Thermo Mini
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

Registration persists dashboard identity to `.env.local`: `DASHBOARD_COMPANY_ID`, `DASHBOARD_AGENT_IDS`, and individual `DASHBOARD_AGENT_*_ID` values. Events use stored dashboard agent IDs for `agent_id` and `to_agent`, while retaining logical IDs in the event payload.

By default the client creates the company, then tries agent creation at `/companies/{company_id}/agents` and `/agents`. If your dashboard exposes a different endpoint, set:

```bash
DASHBOARD_AGENT_CREATE_PATH=/companies/{company_id}/agents
```

For non-standard agent deletion endpoints, set:

```bash
DASHBOARD_AGENT_DELETE_PATH=/companies/{company_id}/agents/{agent_id}
```

Set `DASHBOARD_REQUIRE_AGENT_IDS=true` to fail registration when remote agent IDs cannot be created or stored.

## How skills work

Each agent has a Markdown skill file:

```text
.github/skills/ba/SKILL.md
.github/skills/tech-stack/SKILL.md
.github/skills/dev/SKILL.md
.github/skills/qa/SKILL.md
```

The loader reads front matter metadata and the markdown body. The markdown body becomes the system prompt. It prefers `.github/skills/{agent}/SKILL.md` and keeps the old root `skills/*.md` location only as a compatibility fallback.

The first generated-code scaffold uses the overall DEV skill at `.github/skills/dev/SKILL.md`. That skill consumes BA structured output directly and owns the first-generation architecture, runtime, traceability, and validation contract. Source code loads that skill and reads its machine-readable contract for static readiness checks instead of duplicating generation rules.

The skill flow borrows the existing SDLC pattern from the referenced Taskflow repository: Requirement Context, Technical Specification Context, Shared Contracts, Task Context, Implementation, and Audit/Self-Check. `.github/skills/tech-stack/SKILL.md` runs after BA and before DEV to prepare the selected stack. Project-specific DEV skills are rendered from `.github/skills/project-dev-template/SKILL.md` so future skill behavior stays in markdown instead of TypeScript source.

Example metadata:

```md
---
agent_id: ba
name: Huy BA
role: analyst
model: google/gemini-2.5-flash
temperature: 0.2
---
```

## Main files

```text
lib/orchestrator.ts              # Controls BA -> TA -> DEV -> CodeReview -> DevOps -> QA workflow
lib/openrouter.ts                # OpenRouter client
lib/dashboard.ts                 # Contest dashboard client
lib/skills/loadSkill.ts          # Markdown skill loader
lib/skills/project-dev-skill.ts  # Dynamic project-specific DEV skill writer/loader using markdown template
.github/agents                   # Agent definition/template library copied from Taskflow style
.github/prompts                  # Prompt template library copied from Taskflow style
.github/rules                    # Shared rule instructions copied from Taskflow style
.github/skills                   # Primary skill library used by this project
.github/skills/tech-stack/SKILL.md             # prepare-tech-stack skill
.github/skills/project-dev-template/SKILL.md   # Project-specific DEV skill template
lib/agents/ba-agent.ts           # BA agent
lib/agents/tech-stack-agent.ts   # prepare-tech-stack agent
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
4. Watch BA create DEV/QA-ready user stories and artifacts.
5. Watch TA analyze the tech stack, prepare the DEV skill, and later upgrade it after feedback.
6. Watch DEV implement from BA output plus TA skill context.
7. Watch Code Review request focused DEV fixes until code is acceptable.
8. Watch DevOps validate containers, Compose, ports, healthchecks, and Rancher/Desktop deploy readiness.
9. Watch QA run post-deploy end-to-end requirement validation and request DEV fixes if behavior does not match the BA artifact.
10. Check dashboard for agent-to-agent events if `ENABLE_DASHBOARD=true`.
11. Run artifacts are written under `generated-runs/{yyyy-MM-dd-HH-mm-ss}`.
12. DEV-generated source files are written to the fixed `generated-code/` workspace.
13. If `VALIDATE_GENERATED_EXECUTION` is not `false`, the generated project is copied into an ignored validation workspace, then built, started, and smoke-checked. Compose validation tries `docker compose` first, then Rancher/containerd `nerdctl compose`; set `GENERATED_COMPOSE_ENGINE=docker` or `GENERATED_COMPOSE_ENGINE=nerdctl` to force one. If Compose is skipped because Docker/Rancher is unavailable, `FALLBACK_LOCAL_VALIDATION_WHEN_COMPOSE_SKIPPED=true` runs local Node/Python validation instead of blocking the whole run.
14. At run start, `AUTO_START_RANCHER_DESKTOP=true` prewarms Rancher/Docker in the background while BA/DEV agents run. Before Compose validation, the orchestrator checks whether the selected Compose engine and container runtime are ready. If not, it starts Rancher Desktop with `rdctl` when available, waits up to `RANCHER_START_TIMEOUT_MS`, then runs Compose. `RANCHER_START_KUBERNETES=true` keeps Rancher Desktop Kubernetes available; omit the variable to preserve the current Rancher setting. Set `RANCHER_RDCTL_PATH` or `RANCHER_DESKTOP_PATH` if Rancher Desktop is installed in a custom location.
15. Before each Compose validation, `CLEAN_GENERATED_COMPOSE=true` runs `compose down --remove-orphans` for the `agentic-sprint-builder-generated` project name to free ports from the previous generated run. It does not remove unrelated containers. Set `REMOVE_GENERATED_COMPOSE_IMAGES=true` to also remove local images for that generated Compose project.
16. By default, QA runs after deploy smoke validation. Set `RUN_FULL_QA_AGENT=false` only when you want deploy smoke validation to be the acceptance gate without full QA review.

On each run, the agents read the current `generated-code/` snapshot plus recent `generated-runs/` history so feature changes can be handled incrementally instead of recreating the project from scratch.

## Dynamic project DEV skills

The first run for an empty `generated-code/` workspace uses the overall DEV skill in `.github/skills/dev/SKILL.md`. After generated files are written, the orchestrator inspects the actual snapshot and writes a project-specific skill to:

```text
project-skills/generated-code/dev.md
```

Later runs load that project skill automatically by `projectId` (default `generated-code`) and append it to the DEV agent system prompt. The generated skill records stack, folder structure, scripts, environment variables, API/routes, database conventions, implemented behavior, and latest validation status. After each generated-code update or repair, the skill is regenerated from the latest snapshot.

## Notes

This project itself is a Next.js app. Generated projects may use whatever stack the user requirements, tech spec, BA output, and loaded DEV skill select.
