---
title: Quickstart
description: Install Zup and run your first loop.
---

# Quickstart

## Install

```bash
bun install
```

## Create an agent

```ts
import { createAgent } from '@beepsdev/zup';
import { httpMonitor } from '@beepsdev/zup/plugins/http-monitor';
import { historianPlugin } from '@beepsdev/zup/plugins/historian';

const agent = await createAgent({
  name: 'my-agent',
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-3-5-sonnet-20241022',
  },
  sqlite: { path: './zup.db' },
  plugins: [
    httpMonitor({
      endpoints: [{ id: 'api', name: 'API', url: 'https://api.example.com/health' }],
    }),
    historianPlugin({ minConfidence: 0.75 }),
  ],
});

// Run single loop
const result = await agent.runLoop();

// Or run continuously
await agent.start({ intervalMs: 30000 });
```

## Next steps

- Add plugins for your infrastructure.
- Configure approvals for risky actions.
- Persist state in SQLite for durable approvals and observer state.
