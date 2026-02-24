---
title: Plugin Overview
description: Catalog of built-in plugins and plugin architecture summary.
---

## Plugin architecture

Plugins are the primary extension mechanism in Zup. Each plugin is a function that returns a `ZupPlugin` object containing components for one or more OODA phases.

```ts
import { definePlugin, createObserver } from 'zupdev';

export const myPlugin = (options?: MyPluginOptions) => definePlugin({
  id: 'my-plugin',
  observers: { ... },
  orienters: { ... },
  decisionStrategies: { ... },
  actions: { ... },
  endpoints: { ... },
  onLoopStart: async (ctx) => { ... },
  onLoopComplete: async (result, ctx) => { ... },
});
```

Plugins are initialized sequentially in the order they appear in the `plugins` array. A plugin's `init` hook can modify the agent context and options, which subsequent plugins will see.

Import plugins from their subpath:

```ts
import { httpMonitor } from 'zupdev/plugins/http-monitor';
import { historianPlugin } from 'zupdev/plugins/historian';
import { investigationOrienter } from 'zupdev/plugins/investigation-orienter';
import { kubernetes } from 'zupdev/plugins/kubernetes';
import { cloudRun } from 'zupdev/plugins/cloud-run';
import { flyMachines } from 'zupdev/plugins/fly-machines';
import { vercelDeploys } from 'zupdev/plugins/vercel-deploys';
import { githubActivity } from 'zupdev/plugins/github-activity';
```

## Built-in plugins

| Plugin | What it does | Requires LLM? | Requires SQLite? |
|---|---|---|---|
| [http-monitor](/docs/plugins/http-monitor/) | Monitors HTTP endpoints for availability. Detects failures, analyzes patterns, restarts services via configurable strategies. | No | No |
| [historian](/docs/plugins/historian/) | Stores incident resolutions in SQLite. Uses text search or sqlite-vec for RAG to recall similar past incidents during the orient phase. | No (embeddings optional) | Yes |
| [investigation-orienter](/docs/plugins/investigation-orienter/) | Runs a deep investigation sub-loop with LLM tool calling when observations exceed a severity threshold. | Yes | No |
| [kubernetes](/docs/plugins/kubernetes/) | Observes Kubernetes cluster state (pods, deployments, nodes, events). Provides restart, scale, delete, and log retrieval actions. | No | No |
| [cloud-run](/docs/plugins/cloud-run/) | Monitors Google Cloud Run services and revisions. Tracks rollouts and can shift traffic for auto-rollback. | No | No |
| [fly-machines](/docs/plugins/fly-machines/) | Monitors Fly.io machines across apps. Detects deployments via instance/image changes and tracks machine state. | No | No |
| [vercel-deploys](/docs/plugins/vercel-deploys/) | Monitors Vercel deployments across projects. Tracks build status, git metadata, and deployment state changes. | No | No |
| [github-activity](/docs/plugins/github-activity/) | Monitors GitHub repositories for recent commits and merged PRs. Provides change context for incident correlation. | No | No |
| example | Reference implementation demonstrating all plugin phases with a simulated service health check. | No | No |

## Plugin phases at a glance

Each plugin can contribute to multiple phases:

| Plugin | Observers | Orienters | Decision Strategies | Actions | Endpoints |
|---|---|---|---|---|---|
| http-monitor | Health checks | Failure analysis | Restart unhealthy | Restart service | List, check, restart |
| historian | -- | Historical context | -- | -- | -- |
| investigation-orienter | -- | Deep investigation | -- | -- | -- |
| kubernetes | Cluster state | Health analysis | -- | Restart, scale, delete, logs | Cluster status, namespaces |
| cloud-run | Service status | Rollout analysis | Auto-rollback | Rollback traffic | Services, revisions |
| fly-machines | Machine state | Deployment analysis | -- | -- | Apps, machines |
| vercel-deploys | Deploy status | Deploy analysis | -- | -- | Projects, deployments |
| github-activity | Commits & PRs | Change correlation | -- | -- | Repos, commits, PRs, diffs |

## Writing your own

See [Writing a Plugin](/docs/plugins/authoring/) for a step-by-step guide to building a custom plugin.
