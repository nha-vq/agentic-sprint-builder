---
agent_id: base-review
name: Base Review Skill
role: template
---
# Base Review Skill Template

## Description
Generic reusable skill template for code review. Defines review categories, quality gates, and validation patterns independent of specific frameworks.

## Review Dimensions

### Structural Completeness
- All required files exist per architecture decisions
- No empty or stub files
- File organization matches project structure
- Import paths resolve correctly
- No circular dependencies

### Functional Correctness
- API endpoints implement required behavior
- Data flows correctly between layers
- Database operations are correct
- Frontend renders expected content
- Error cases are handled

### Integration Correctness
- Frontend can call backend APIs
- Backend can connect to database
- Environment variables are consistent across services
- Docker services can communicate
- Port bindings are correct

### Code Hygiene
- No dead code or unused imports
- No debugging statements
- No placeholder/TODO content
- Consistent formatting
- Meaningful variable and function names

## Severity Levels

### Blocking (NEEDS_FIX)
- Missing required files
- Broken imports or references
- Incorrect API contracts
- Security vulnerabilities
- Build/runtime failures
- Missing environment configuration

### Advisory (informational)
- Style improvements
- Performance suggestions
- Better patterns available
- Documentation improvements
- Test coverage suggestions
