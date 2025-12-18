# Contributing to opencode-zellij-namer

Thank you for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/opencode-zellij-namer
cd opencode-zellij-namer
npm install
npm run build
npm test
```

## Making Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run tests: `npm test`
5. Run type check: `npm run typecheck`
6. Commit with a descriptive message
7. Push and open a Pull Request

## Code Style

- TypeScript strict mode
- No `any` types without justification
- Meaningful variable names over comments
- Keep functions small and focused

## Commit Messages

Use conventional commits:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `refactor:` Code changes that don't fix bugs or add features
- `test:` Adding or updating tests
- `chore:` Maintenance tasks

## Security

If you discover a security vulnerability, please email the maintainer directly instead of opening a public issue.

## Questions?

Open an issue for discussion.
