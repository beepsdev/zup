---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```


## TypeScript

**Avoid `any` types.** Use `unknown` for truly unknown types, or define proper types.

- Use `unknown` instead of `any` for type-safe handling of unknown data
- Use proper type guards when narrowing `unknown` types
- Use type assertions sparingly and only when necessary
- Use `bun run typecheck` to validate types before committing

Good examples:
```ts
// Good: Use unknown
function process(data: unknown) {
  if (typeof data === 'string') {
    return data.toUpperCase();
  }
}

// Good: Proper types
type User = {
  id: string;
  name: string;
};
```

Bad examples:
```ts
// Bad: Using any
function process(data: any) {
  return data.toUpperCase();
}

// Bad: Index signature with any
type Config = {
  [key: string]: any;
};
```
