---
title: Zup
description: Open source AI SRE agent framework built around the OODA loop.
---

Zup is an open-source reliability agent framework that runs the OODA loop (Observe, Orient, Decide, Act) on your production systems. It watches your infrastructure, builds situational awareness, decides on the safest response, and acts -- automatically or with human approval.

## Key capabilities

| Capability | Description |
|---|---|
| **Observe** | Monitor HTTP endpoints, Kubernetes clusters, Fly.io machines, Vercel deployments, Cloud Run services, and GitHub activity through built-in plugins. |
| **Orient** | Correlate observations with historical incidents using RAG-powered pattern matching. Run deep LLM-driven investigations with tool calling. |
| **Decide** | Choose safe remediation actions based on situation assessments, risk levels, and confidence thresholds. |
| **Act** | Execute actions automatically or queue them for human approval. Rollback support and dry-run previews included. |
| **Extend** | Write plugins that hook into any phase. Add custom observers, orienters, strategies, actions, and API endpoints. |
| **Integrate** | REST API for external systems. Submit runs, trigger loops, approve actions, and query state programmatically. |

## Architecture

Zup runs a continuous loop modeled on Boyd's OODA loop:

```
                    +------------------+
                    |                  |
            +-------+  OBSERVE        |
            |       |  (Observers)    |
            |       +--------+---------+
            |                |
            |                v
  +---------+------+  +-----+----------+
  |                |  |                |
  |  ACT           |  |  ORIENT        |
  |  (Actions)     |  |  (Orienters)   |
  |                |  |                |
  +--------+-------+  +------+---------+
           ^                  |
           |                  v
           |         +-------+----------+
           |         |                  |
           +---------+  DECIDE          |
                     |  (Strategies)    |
                     +------------------+
```

Plugins contribute components at each phase. The core framework orchestrates the loop, manages state, handles approvals, and exposes a REST API.

## Who is this for?

- **SRE teams** building automated incident response.
- **Platform engineers** adding self-healing to their infrastructure.
- **Developers** who want an agent framework with structure, not just prompt chains.

## Quick example

```ts
import { createAgent } from 'zupdev';
import { httpMonitor } from 'zupdev/plugins/http-monitor';

const agent = await createAgent({
  name: 'my-sre',
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
      ],
    }),
  ],
});

const result = await agent.runLoop();
console.log(result.situation?.summary);
```

## Next steps

- [Quickstart](/docs/getting-started/) -- install Zup and run your first loop.
- [Core Concepts](/docs/core-concepts/) -- understand the OODA loop and plugin system.
- [Agent Configuration](/docs/agent-config/) -- full reference for all agent options.
- [REST API](/docs/api/) -- integrate Zup with external systems.
- [Plugin Overview](/docs/plugins/) -- catalog of built-in plugins.
