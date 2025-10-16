# AGENTS.md

## Commands
- **Build**: `npm run build`
- **Release**: `npm run release`
- **No lint/test commands defined** - check package.json for available scripts

## Code Style Guidelines

### TypeScript
- Strict mode enabled (`"strict": true`)
- Target ES2022, CommonJS modules
- Use explicit types, avoid `any`
- Prefer interfaces over types for object shapes

### Imports
- External imports first, then internal
- Group related imports together
- Use absolute imports for internal modules

### Functions & Readability
- Keep functions short and focused
- Break long functions into smaller, named functions
- Avoid Chinese comments
- Make logical groups of changes together in commits

### Naming Conventions
- camelCase for variables, functions, methods
- PascalCase for components, types, interfaces
- snake_case for constants (if any)

### Error Handling
- Use defensive programming with null/undefined checks
- Handle edge cases explicitly
- Avoid throwing errors in normal flow

### React Components
- Use functional components with hooks
- Follow React hooks rules and ESLint recommendations
- Use TypeScript for props and state

### Formatting
- Follow ESLint recommended rules
- Consistent indentation and spacing
- Use semicolons