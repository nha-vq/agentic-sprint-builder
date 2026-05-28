---
agent_id: base-backend
name: Base Backend Skill
role: template
---
# Base Backend Skill Template

## Description
Generic reusable skill template for backend API generation. This template defines backend architecture patterns, API standards, and validation rules independent of any specific framework.

## Architecture Patterns

### Project Structure
```
backend/
  Dockerfile
  dependency manifest (requirements.txt, package.json, etc.)
  entry point (main.py, index.ts, etc.)
  routes/ or routers/
  models/ or schemas/
  services/ or logic/
  database/ or db/
  config/ (optional)
  tests/ (optional for initial gen)
```

### Layered Architecture
- Routes/Controllers: HTTP handling, request validation, response formatting
- Services/Logic: Business logic, orchestration
- Models/Schemas: Data structures, validation schemas
- Database/Repository: Data access, queries, migrations

### API Design
- RESTful resource-based URLs
- Consistent response envelope or direct responses
- Proper HTTP methods (GET, POST, PUT, DELETE, PATCH)
- Input validation on all endpoints
- Error responses with meaningful messages
- Pagination for list endpoints when appropriate

## Generation Standards

### Required Files
- Dependency manifest (requirements.txt, package.json, pyproject.toml)
- Application entry point
- Health endpoint (GET /health returning 200)
- At least one CRUD resource matching requirements
- Database connection setup
- CORS configuration

### Health Endpoint
- GET /health or GET /api/health
- Returns 200 with JSON body indicating service status
- Checks database connectivity when applicable
- Used by Docker healthcheck and monitoring

### CORS Configuration
- Allow frontend origins for generated Compose (`localhost:55001`, `127.0.0.1:55001`) and local dev (`localhost:3000`, `127.0.0.1:3000`)
- Allow required HTTP methods
- Allow required headers
- Configurable via environment variables

### Database Integration
- Connection via DATABASE_URL or individual DB_* variables
- Connection pooling when appropriate
- Schema initialization or migration on startup
- Graceful handling of database unavailability

### Error Handling
- Global error handler
- Consistent error response format
- No stack traces in production responses
- Proper HTTP status codes (400, 401, 403, 404, 500)
- Validation errors return 422 with field details

## Docker Standards
- Appropriate base image for the runtime
- Install dependencies before copying source (layer caching)
- EXPOSE the application port
- Non-root user when possible
- Health check command using native tools (not curl/wget unless installed)
- .dockerignore for unnecessary files

## Coding Standards
- Clear module organization
- Dependency injection or configuration-based setup
- Environment-based configuration (no hardcoded values)
- Type safety where the language supports it
- Input validation at API boundaries
- Proper logging (not print statements)

## Security Standards
- No real secrets in code
- Authentication/authorization when required
- Rate limiting consideration
- SQL injection prevention (parameterized queries)
- CORS properly scoped
- Input sanitization

## Validation Checklist
- [ ] Dependency manifest is complete
- [ ] Application starts without errors
- [ ] Health endpoint returns 200
- [ ] CORS allows frontend origins
- [ ] Database connection works
- [ ] Schema/migrations run successfully
- [ ] API endpoints respond correctly
- [ ] Input validation works
- [ ] Error handling returns proper status codes
- [ ] Dockerfile builds successfully
- [ ] No hardcoded credentials
- [ ] Environment variables documented
