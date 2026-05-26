---
agent_id: base-fullstack
name: Base Full-Stack Skill
role: template
---
# Base Full-Stack Skill Template

## Description
Generic reusable skill template for full-stack web application generation. This template is NOT tied to any specific tech stack. It defines architecture patterns, generation standards, and validation checklists that apply to any full-stack project.

## Architecture Patterns

### 3-Container Architecture
Every full-stack project must contain:
- frontend container
- backend container
- database container
- docker-compose.yml

Default project structure:
```
frontend/
backend/
database/ or db/
docker-compose.yml
README.md
.env.example
```

### Service Communication
- Frontend communicates with backend via HTTP REST or GraphQL
- Backend communicates with database via ORM or direct driver
- All inter-service communication uses environment variables for configuration
- Browser-facing API URLs must be browser-reachable (localhost/127.0.0.1), not internal Docker hostnames
- Server-side frontend code running inside Docker must use internal Compose service URLs such as `http://backend:8000`, not `localhost`, when calling the backend container
- Full-stack frontends with server rendering must document both public/browser API URLs and internal/server API URLs

### Port Conventions
- Frontend: host port configurable (default 3001), container port configurable (default 3000)
- Backend: host port configurable (default 8000), container port configurable (default 8000)
- Database: host port configurable, container port per database standard

## Generation Standards

### Required Root Files
- README.md with setup, build, run, health-check, and smoke-check commands
- .env.example with safe local defaults for every required environment variable
- docker-compose.yml with all services, healthchecks, depends_on, and volumes

### Frontend Requirements
- Source under frontend/
- Dockerfile for containerized deployment
- Package manager config with dev, build, and start scripts
- API base URL from environment variable
- Separate public/browser API URL from server/internal API URL when SSR/server components call the backend from inside Docker
- At least one navigable page demonstrating requirements

### Backend Requirements
- Source under backend/
- Dockerfile for containerized deployment
- Dependency manifest with start/dev commands
- Health endpoint (GET /health)
- API endpoints matching requirements
- CORS configuration allowing frontend origins
- Database connection via environment variables

### Database Requirements
- Schema/migrations/init scripts for project-owned databases
- Seed data when useful for demonstration
- Credentials through environment variables
- Named volume for persistence in Docker Compose
- Healthcheck in Docker Compose

### Docker Compose Requirements
- All services defined with build contexts
- Environment variables from .env file
- Port mappings documented
- Healthchecks for database and backend
- depends_on with health conditions
- Named volumes for persistence
- Must be runnable with: docker compose up --build

## Coding Standards

### General
- No hardcoded credentials or secrets
- Environment variables for all configuration
- Clear separation of concerns
- Minimal, readable, demo-friendly code
- No debugging code in final output
- No TODO/TBD comments
- Complete file contents, never snippets

### API Design
- RESTful conventions
- Consistent error handling
- Input validation
- Proper HTTP status codes
- Health endpoint for monitoring

### Security Basics
- No real secrets in generated code
- CORS properly configured
- Input validation on all endpoints
- Environment-based configuration
- No destructive scripts

## Validation Checklist
- [ ] All required root files exist
- [ ] Frontend builds and starts
- [ ] Backend builds and starts
- [ ] Database initializes with schema
- [ ] Docker Compose builds all services
- [ ] Health endpoint responds
- [ ] Frontend can reach backend API
- [ ] Server-rendered frontend routes can reach backend API from inside Docker
- [ ] Frontend visible pages render data and images, not only HTTP 200
- [ ] Backend can connect to database
- [ ] All environment variables documented
- [ ] README has complete setup instructions
- [ ] No hardcoded credentials
- [ ] Ports are consistent across configs

## README Rules
- Exact commands for: install, build, start, docker compose
- Port documentation for all services
- Environment variable documentation
- Health check URL
- Frontend smoke URL
- Troubleshooting section
- Requirement Traceability table

## .env Rules
- Every required variable listed with safe default
- Comments explaining each variable
- No real credentials
- Grouped by service
- DATABASE_URL or equivalent connection string

## Testing Rules
- Smoke tests prioritized over unit tests for initial generation
- Health endpoint verification
- Frontend page load verification
- API endpoint basic response verification
- Database connectivity verification
