---
agent_id: base-frontend
name: Base Frontend Skill
role: template
---
# Base Frontend Skill Template

## Description
Generic reusable skill template for frontend application generation. This template defines frontend architecture patterns, component standards, and validation rules independent of any specific framework.

## Architecture Patterns

### Project Structure
```
frontend/
  Dockerfile
  package.json (or equivalent)
  src/ or app/
    pages or routes/
    components/
    lib/ or utils/
    types/ (if typed language)
  public/ (static assets)
  config files (framework-specific)
```

### State Management
- Keep state close to where it is used
- Lift state only when necessary
- Use framework-native state management first
- External state libraries only for complex cross-cutting state

### Data Fetching
- API base URL from environment variable
- Centralized API client or fetch utility
- Loading and error states for all data fetches
- Type-safe API responses when using typed languages

## Generation Standards

### Required Files
- package.json with name, scripts (dev, build, start), dependencies
- Dockerfile with multi-stage build when appropriate
- Entry point page/component
- API client utility
- At least one data-fetching page demonstrating requirements

### Component Standards
- Reusable, composable components
- Props-driven configuration
- Responsive layout
- Accessible markup (semantic HTML)
- Error boundaries or error handling

### Styling Standards
- Consistent styling approach (CSS modules, utility classes, or styled components)
- Responsive design
- Consistent spacing and typography
- Dark/light mode support when specified

### Build and Runtime
- Dev server with hot reload
- Production build optimization
- Environment variable injection at build/runtime
- Static asset handling

## Docker Standards
- Multi-stage build when beneficial (build + runtime stages)
- EXPOSE the container port
- Non-root user when possible
- .dockerignore for node_modules and build artifacts
- Health check via HTTP request to the app

## Coding Standards
- Consistent file naming convention
- Import organization (external, internal, relative)
- Type safety when using TypeScript
- No unused imports or variables
- Proper error handling in data fetching
- Loading states for async operations

## Validation Checklist
- [ ] package.json has dev, build, start scripts
- [ ] Dockerfile builds successfully
- [ ] Dev server starts without errors
- [ ] Production build completes
- [ ] Pages render without runtime errors
- [ ] API calls use environment variable for base URL
- [ ] No hardcoded API URLs
- [ ] Responsive on mobile and desktop
- [ ] All required pages/routes exist
- [ ] Components handle loading and error states
