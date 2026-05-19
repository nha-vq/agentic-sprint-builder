---
agent_id: base-qa
name: Base QA Skill
role: template
---
# Base QA Skill Template

## Description
Generic reusable skill template for QA validation. Defines validation categories, test strategies, and acceptance criteria patterns independent of specific frameworks.

## Validation Categories

### Requirement Coverage
- Every user story has implementation
- Every acceptance criterion is traceable to code
- No missing features from scope
- No extra features outside scope
- Business logic correctly implemented

### Integration Validation
- Frontend successfully calls backend APIs
- Backend successfully queries database
- Data flows end-to-end correctly
- Error states propagate appropriately
- Authentication/authorization works when required

### Runtime Validation
- Application starts without errors
- Health endpoints respond
- Pages render correctly
- API endpoints return expected data
- Database operations complete successfully

### Deployment Validation
- Docker Compose builds all services
- Services reach healthy state
- Port bindings work correctly
- Environment variables are injected
- Volumes persist data

## Test Strategy

### Smoke Tests (Priority 1)
- Health endpoint responds 200
- Frontend page loads
- Backend accepts requests
- Database is accessible

### Functional Tests (Priority 2)
- CRUD operations work
- Data validation works
- Error handling works
- Navigation works

### Integration Tests (Priority 3)
- Frontend-to-backend communication
- Backend-to-database queries
- Cross-service data consistency

## Acceptance Criteria Rules
- Each criterion must be verifiable
- Include expected input and output
- Include success and failure conditions
- Map to specific implementation files
- Include commands to validate locally

## QA Decision Rules

### PASS Conditions
- All blocking requirements implemented
- Application runs successfully
- No critical bugs or security issues
- Documentation is complete and accurate

### NEEDS_FIX Conditions
- Missing required functionality
- Runtime/build errors
- Security vulnerabilities
- Broken integrations
- Missing critical configuration
- Data integrity issues
