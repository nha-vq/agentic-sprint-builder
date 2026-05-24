---
agent_id: dev
name: Project DEV Skill Template
role: project-dev-template
temperature: 0.1
---
# Project-Specific DEV Skill

## Project Identity
- Project ID: {{PROJECT_ID}}
- Generated code workspace: generated-code
- Skill file: project-skills/{{PROJECT_ID}}/dev.md
- Generated/updated at: {{UPDATED_AT}}

## Template Lineage
This skill follows the existing SDLC workflow pattern used by the referenced project:

- Requirement Context
- Technical Specification Context
- Shared Contracts
- Task Context
- Implementation
- Audit/Self-Check

Use this project-specific skill for feature work, bug fixes, and repairs after the first generated-code scaffold exists. It supplements the overall DEV skill. The overall DEV skill still controls JSON output, safety, and generic runnable-project requirements.

## Requirements Contract
Treat the current user requirements and BA output as the acceptance contract. Preserve existing behavior that satisfies that contract. Do not remove pages, API routes, data models, seed/sample data, environment variables, scripts, or runtime wiring unless the new requirement explicitly changes them or a validation log proves that exact file is the defect.

### Requirements Excerpt
{{REQUIREMENTS_EXCERPT}}

### BA Output Excerpt
{{BA_OUTPUT_EXCERPT}}

### Frontend Visual Design Contract
{{VISUAL_CONTRACT_EXCERPT}}

## Prepared Tech Stack
This section is produced by the prepare-tech-stack flow and is the source of truth for stack decisions unless later user requirements explicitly change it.

```json
{{PREPARED_TECH_STACK}}
```

## Actual Tech Stack
- Frontend framework: {{FRONTEND_STACK}}
- Backend framework: {{BACKEND_STACK}}
- Database technology: {{DATABASE_STACK}}
- ORM or migration system: {{ORM_STACK}}
- Package manager: {{PACKAGE_MANAGER}}
- Container/runtime setup: {{CONTAINER_STACK}}

## Project Structure
{{PROJECT_OVERVIEW}}

## Commands
{{COMMANDS}}

## Environment Variables
{{ENV_KEYS}}

## API And Routing Conventions
{{ROUTES}}

## Component And Source Conventions
{{CONVENTIONS}}

## Specialized DEV Ownership
- DEV Lead owns planning, file ownership, cross-service contracts, and final integration.
- Frontend DEV owns frontend routes, components, styles, browser API clients, visual fidelity, and App Router client/server correctness.
- Backend DEV owns APIs, models, persistence, seed data, health endpoints, CORS, and backend runtime behavior.
- Integration DEV owns Dockerfiles, Compose, env examples, README commands, service ports, health checks, and frontend/backend wiring.
- During repairs, keep changes inside the smallest ownership area proven by the validation log.

## Visual Fidelity Rules
- Preserve the current frontend visual direction captured in the BA Frontend Visual Design Contract unless a later user request explicitly changes it.
- For future frontend changes, map each visual requirement to concrete pages, components, styling/theme files, and seed media choices before generating files.
- Visible mockup elements that are outside functional scope may be rendered as static or disabled UI only when they are needed to preserve the visual match; do not add unsupported backend workflows for them.
- Do not regress the established header, navigation, footer, spacing, typography, color palette, product imagery treatment, responsive behavior, or component states when making focused feature or repair changes.

## Database Conventions
{{MIGRATIONS}}

## Requirement-To-File Mapping Rules
- For each future request, map every major requirement to existing or new files before generating changes.
- Reuse existing functions, utilities, entities, DTOs, routes, components, migrations, and configuration whenever they are visible in generated-code.
- Preserve the selected stack and existing folder structure unless the user explicitly requests a stack/architecture change.
- Do not regenerate the whole project for a focused feature or repair.

## Implemented Features
- Features must be traced against the latest requirements and BA output above.
- Existing generated routes, pages, models, seed files, and UI flows are considered implemented behavior unless the user asks to replace them.
- New feature work should extend the current app incrementally and keep the selected stack unless the user explicitly asks for a stack change.

## Files That Should Not Be Manually Patched
- Do not patch files under generated-code as a one-off workaround outside the multi-agent flow.
- Repairs must be produced through the DEV agent and written by the orchestrator.
- Do not edit generated validation workspaces except as temporary build artifacts.

## Recurring Build Lessons
- In App Router projects, components importing client-only UI libraries such as `react-icons`, using hooks, browser APIs, event handlers, or client navigation must begin with `'use client';`.
- Do not import `next/document` from `app/` files or shared components.
- Dockerfile `COPY --from=builder` sources must exist in the builder output. Do not copy `/app/public` unless the generated frontend includes a `public/` directory/file.
- Browser-facing API URLs must be reachable from the user's browser; Compose-only service DNS such as `http://backend:8000` is not valid for client-side code unless a browser-reachable proxy is generated.

## Future Feature Rules
- Load this skill before planning future DEV work for this project.
- Start from Requirement Context, Technical Specification Context, Shared Contracts, and Task Context.
- Preserve the current technology stack, folder structure, API style, and database choice.
- Add new files inside existing frontend/backend/database/runtime directories when possible.
- If a new convention is introduced, update this skill after the generated-code snapshot is written.
- If validation fails, diagnose from the exact log and generated project overview before selecting files.

## Known Limitations And Latest Validation
{{FINAL_STATUS}}
