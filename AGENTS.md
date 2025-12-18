# AGENTS.md

This file provides guidance for AI agents (like OpenCode, Claude, GPT, Cursor, etc.) working on this codebase.

## Project Overview

**opencode-zellij-namer** is an OpenCode plugin that automatically renames Zellij terminal sessions based on project context and work activity. It uses AI (Gemini) for intelligent naming with heuristic fallbacks.

## Architecture

```
src/index.ts          # Main plugin file (single-file architecture)
src/index.test.ts     # Test suite (bun test)
dist/                 # Compiled output (do not edit)
```

### Key Components

| Component | Purpose |
|-----------|---------|
| `ZellijNamer` | Main exported plugin factory function |
| `loadConfig()` | Loads configuration from environment variables |
| `inferIntent()` | Heuristic intent detection (feat, fix, debug, etc.) |
| `extractTag()` | Extracts contextual tag from branch, directory, or signals |
| `generateNameWithAI()` | AI-powered name generation via Gemini |
| `buildSessionName()` | Constructs final sanitized session name |
| `renameSession()` | Executes Zellij CLI to rename session |

### State Management

State is scoped inside the `ZellijNamer` factory function (not global) to support multiple instances and easier testing:

```typescript
const state: State = {
  lastRename: 0,      // Timestamp of last rename (cooldown)
  lastCheck: 0,       // Timestamp of last check (debounce)
  currentName: null,  // Current session name
  signals: [],        // Ring buffer of recent activity signals
};
```

## Security Considerations

This plugin handles shell commands and file paths. Security measures in place:

1. **Shell injection prevention**: Uses `execFileSync` with argument arrays, never string interpolation
2. **Path traversal protection**: `safePath()` validates paths stay within expected boundaries
3. **Input validation**: `isValidEvent()` validates event payloads at runtime
4. **Bounded storage**: Signals array capped at `maxSignals` (default 25)
5. **API key handling**: Keys read from env vars, never logged or exposed

### When modifying shell commands

```typescript
// CORRECT - argument array
execFileSync(binary, ['--flag', 'value'], { encoding: 'utf8' });

// WRONG - string interpolation (shell injection risk)
execSync(`${binary} --flag ${value}`);
```

## Code Style

- **TypeScript strict mode** enabled
- **Single-file architecture** - keep everything in `src/index.ts` unless it grows significantly
- **No external runtime dependencies** except `@google/generative-ai` for Gemini
- **Bun** for testing and development
- **Conventional commits** for all changes

### Conventional Commit Format

```
type(scope): description

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`

Examples:
- `feat(naming): add custom instructions support`
- `fix(security): prevent path traversal in safePath`
- `docs(readme): add uniqueness strategy section`
- `test(config): add custom instructions tests`

## Testing

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
```

### Test Structure

Tests mirror the component structure:
- `inferIntent` tests - intent detection logic
- `buildSessionName` tests - name construction
- `sanitize` tests - string sanitization
- `extractProjectName` tests - project detection
- `config` tests - configuration loading
- `custom instructions` tests - AI prompt customization
- `ring buffer behavior` tests - signal management

### Adding Tests

When adding new functionality:
1. Add unit tests for the new functions
2. Add integration tests if it affects the event flow
3. Ensure edge cases are covered (empty input, long strings, invalid chars)

## Configuration

All configuration via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | - | Required for AI naming |
| `OPENCODE_ZN_COOLDOWN_MS` | 300000 | Min ms between renames |
| `OPENCODE_ZN_DEBOUNCE_MS` | 5000 | Min ms between checks |
| `OPENCODE_ZN_MAX_SIGNALS` | 25 | Max signals in ring buffer |
| `OPENCODE_ZN_MODEL` | gemini-3-flash-preview | Gemini model to use |
| `OPENCODE_ZN_DEBUG` | 0 | Enable debug logging (1/0) |
| `OPENCODE_ZN_INSTRUCTIONS` | - | Custom naming instructions |

## Common Tasks

### Adding a new intent type

1. Add to `INTENTS` array in `src/index.ts`
2. Add detection pattern in `inferIntent()`
3. Add tests in `src/index.test.ts`
4. Update README.md with the new intent

### Adding a new configuration option

1. Add to `PluginConfig` interface
2. Add to `loadConfig()` with env var and default
3. Use in relevant functions
4. Add tests for the new config
5. Update README.md configuration table

### Modifying AI prompt

The AI prompt is in `generateNameWithAI()`. When modifying:
1. Keep the format rules strict (they ensure valid output)
2. Test with various signal combinations
3. Consider adding to custom instructions instead of hardcoding

## Release Process

1. Make changes with conventional commits
2. Run tests: `bun test`
3. Build: `npm run build`
4. Bump version: `npm version patch|minor|major`
5. Push with tags: `git push && git push --tags`
6. Create GitHub release (triggers npm publish via GHA)

## Debugging

Enable debug mode:
```bash
export OPENCODE_ZN_DEBUG=1
```

Debug output includes:
- Configuration loaded
- Event processing
- Intent inference results
- AI generation attempts
- Rename operations

## Dependencies

### Runtime
- `@google/generative-ai` - Gemini API client

### Development
- `bun` - Runtime, test runner, package manager
- `typescript` - Type checking and compilation

## File Locations

- Plugin source: `src/index.ts`
- Tests: `src/index.test.ts`
- Config: `package.json`, `tsconfig.json`
- CI: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`
- Docs: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`
