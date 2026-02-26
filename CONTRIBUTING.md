# Contributing to Zup

Thanks for your interest in contributing to Zup! Here's how to get started.

## Development setup

```bash
git clone https://github.com/beepsdev/zup.git
cd zup
bun install
```

## Running checks

```bash
bun run typecheck    # Type check the project
bun test             # Run the test suite
bun run check        # Both at once
```

## Making changes

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Add or update tests if applicable.
4. Run `bun run check` and make sure everything passes.
5. Open a pull request.

## Code style

- TypeScript strict mode is enabled. Avoid `any`.  Use `unknown` and type guards instead.
- Use Bun APIs where available (`Bun.serve`, `Bun.file`, `bun:sqlite`, etc.).
- Keep things simple. Don't add abstractions for one-time operations.

## Writing plugins

If you're adding a new built-in plugin, follow the existing pattern in `packages/plugins/`. Each plugin should:

- Export a factory function that returns a `ZupPlugin`
- Include tests in an `index.test.ts` file
- Include documentation in `apps/docs/src/content/docs/plugins/`

## Commit messages

Write clear commit messages that describe _why_, not just _what_. No specific format is enforced.

## Reporting bugs

Open an issue at https://github.com/beepsdev/zup/issues with steps to reproduce.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
