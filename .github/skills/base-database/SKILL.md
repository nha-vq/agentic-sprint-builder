---
agent_id: base-database
name: Base Database Skill
role: template
---
# Base Database Skill Template

## Description
Generic reusable skill template for database setup and management. This template defines database architecture patterns, schema standards, and validation rules independent of any specific database technology.

## Architecture Patterns

### Project Structure
```
database/ or db/
  init.sql or init.js (initialization script)
  migrations/ (when using migration tool)
  seed.sql or seed data files
  README.md (database documentation)
```

### Database Ownership
- Project-owned: generate schema, migrations, seed data, Docker service
- External/pre-existing: document connection, generate connectivity checks only
- Never destructively overwrite external databases

### Schema Design
- Primary keys on all tables
- Foreign key constraints for relationships
- Indexes on frequently queried columns
- Timestamps (created_at, updated_at) where appropriate
- Consistent naming convention (snake_case for SQL, camelCase for NoSQL)

## Generation Standards

### Required for Project-Owned Database
- Docker Compose service with healthcheck
- Initialization script (schema creation)
- Seed data for demonstration
- Named volume for persistence
- Environment variables for credentials
- Backend connectivity configuration

### Required for External Database
- Connection documentation
- Environment variable configuration
- Connectivity check in backend health endpoint
- No destructive schema operations
- No Docker Compose service for the external database

### Initialization
- Schema creation must be idempotent (CREATE TABLE IF NOT EXISTS or equivalent)
- Seed data must be safe to re-run (UPSERT or conditional inserts)
- Migrations must be ordered and trackable
- Database must be usable immediately after initialization

### Security
- Credentials only via environment variables
- No default production passwords
- Principle of least privilege for application user
- No publicly accessible ports in production

## Docker Standards
- Official database image
- Healthcheck using native tool (pg_isready, mysqladmin ping, mongosh, etc.)
- Named volume for data persistence
- Environment variables for initial credentials
- Initialization scripts mounted via entrypoint directory when supported

## Validation Checklist
- [ ] Database starts in Docker Compose
- [ ] Healthcheck passes
- [ ] Schema initializes correctly
- [ ] Seed data loads without errors
- [ ] Backend can connect and query
- [ ] Credentials are environment-variable based
- [ ] Volume persists data across restarts
- [ ] No hardcoded credentials
