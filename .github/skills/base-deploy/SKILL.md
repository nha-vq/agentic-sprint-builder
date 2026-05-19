---
agent_id: base-deploy
name: Base Deploy Skill
role: template
---
# Base Deploy Skill Template

## Description
Generic reusable skill template for deployment validation. Defines container standards, compose patterns, and deployment readiness checks independent of specific technologies.

## Container Standards

### Dockerfile Best Practices
- Use specific base image tags (not :latest in production)
- Multi-stage builds for compiled/built applications
- Install dependencies before copying source (layer caching)
- Set WORKDIR for all operations
- EXPOSE documented ports
- Define CMD or ENTRYPOINT
- Use .dockerignore to exclude unnecessary files
- Non-root user when security is important

### Docker Compose Standards
- Version 3+ or compose specification
- All services have build or image
- Environment variables from .env file
- Port mappings with host:container format
- Named volumes for persistence
- Healthchecks for stateful services
- depends_on with condition: service_healthy
- Network isolation when appropriate

### Deployment Readiness
- docker compose up --build succeeds
- All services reach healthy state
- Health endpoints respond correctly
- Frontend serves pages
- Backend processes requests
- Database accepts connections

## Port Management Rules
- Document all exposed ports
- No conflicts between services
- Consistent port usage across all configuration files
- Frontend and backend ports differ
- Database uses standard port for its type

## Volume Rules
- Never mount over WORKDIR (shadows application files)
- Use named volumes for database data
- Use bind mounts only for development
- Document volume purposes

## Environment Variable Rules
- All required variables in .env.example
- Safe local defaults
- No real credentials
- Consistent naming (SERVICE_VARIABLE_NAME)
- Database URLs match driver format
