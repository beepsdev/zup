---
title: Fly Machines
description: Monitor Fly.io machines, detect deployments via image digest changes, and track machine health.
---

The `fly-machines` plugin monitors Fly.io machines across multiple apps. It tracks machine state, health checks, and detects deployments by watching for instance ID and image digest changes. Unlike platforms with a dedicated deployments API, Fly.io deployments are inferred from machine-level changes -- when a machine's `instance_id` changes, a new deployment has occurred.

## Installation

```ts
import { createAgent } from '@beepsdev/zup';
import { flyMachines } from '@beepsdev/zup/plugins/fly-machines';

const agent = await createAgent({
  name: 'fly-agent',
  plugins: [
    flyMachines({
      auth: { token: process.env.FLY_API_TOKEN! },
      apps: [
        {
          name: 'my-app',
          serviceName: 'My App',
        },
      ],
    }),
  ],
});
```

## Requirements

A Fly.io API token is required. Generate one with `fly tokens create` from the Fly CLI.

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `auth` | `FlyAuthConfig` | -- | **Required.** Authentication configuration. |
| `auth.token` | `string` | -- | **Required.** Fly.io API token. |
| `apps` | `FlyAppConfig[]` | -- | **Required.** Apps to monitor. At least one app must be configured. |
| `pollIntervalMs` | `number` | `60000` | Polling interval in milliseconds. |
| `maxMachinesPerApp` | `number` | `50` | Maximum machines to track per app. |
| `apiBaseUrl` | `string` | `'https://api.machines.dev'` | Fly Machines API base URL. |

## App configuration

Each app describes a Fly.io application to monitor:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Fly.io app name (as shown in `fly apps list`). |
| `serviceName` | `string` | Yes | Human-readable service name for SRE context (used in observations and findings). |
| `regions` | `string[]` | No | Filter machines by specific regions (e.g., `['ord', 'cdg']`). If not set, all regions are included. |
| `metadata` | `Record<string, string>` | No | Filter machines by metadata key-value pairs. |

## OODA phase contributions

### Observe: `fly-machine-status`

The observer polls the Fly Machines API for each configured app and produces two types of observations:

**Deployment events** (`fly-machines/deployment`): Emitted when machines are updated (detected via `instance_id` changes). Each deployment event includes:
- App and service names
- New image digest, repository, and tag
- Machines and regions affected
- Deployment status: `completed` (all machines started), `in_progress`, `partial` (mixed success/failure), or `failed`
- Severity: `info` for completed, `critical` for failed, `error` for partial

**Machine state** (`fly-machines/machine`): One observation per machine with:
- Machine ID, name, state, region, and instance ID
- Image reference (digest, repository, tag)
- Guest configuration (CPU, memory)
- Health check results
- Most recent machine event
- Severity: `warning` if the machine is stopped, destroyed, or has failing health checks; `info` otherwise

**API errors** (`fly-machines/error`): Emitted when the Fly API call fails for an app, with `warning` severity.

### Orient: `analyze-fly-machines`

Analyzes Fly.io observations to provide deployment and health context:

- Reports deployment status (completed, in progress, partial, failed) with machine counts and affected regions
- Groups machines by service and reports running/total counts per region
- Identifies stopped or suspended machines
- Reports machines with failing health checks
- Sets `contributingFactor` when deployment failures or health check failures are detected
- Confidence: `0.85`

## REST API endpoints

All endpoints require authentication by default.

### GET /fly/apps

Lists all configured Fly.io apps with machine status summary.

**Response:**

```json
{
  "apps": [
    {
      "name": "my-app",
      "serviceName": "My App",
      "configuredRegions": ["ord", "cdg"],
      "activeRegions": ["ord", "cdg"],
      "lastFetchTime": "2025-06-15T10:30:00.000Z",
      "machineCount": 4,
      "runningCount": 4,
      "isConsistent": true,
      "currentImageDigest": "sha256:abc123...",
      "imageDigestCount": 1
    }
  ]
}
```

The `isConsistent` field indicates whether all machines are running the same image digest. When `false`, a deployment may be in progress or partially failed.

### GET /fly/apps/:appName/machines

Returns detailed machine information for a specific app.

**Response:**

```json
{
  "app": {
    "name": "my-app",
    "serviceName": "My App"
  },
  "machines": [
    {
      "id": "e784079b449483",
      "name": "my-app-machine-1",
      "state": "started",
      "region": "ord",
      "instanceId": "01HXYZ...",
      "imageRef": {
        "repository": "registry.fly.io/my-app",
        "tag": "deployment-01HXYZ",
        "digest": "sha256:abc123..."
      },
      "guest": {
        "cpu_kind": "shared",
        "cpus": 1,
        "memory_mb": 256
      },
      "checks": {
        "http": {
          "name": "http",
          "status": "passing",
          "output": "HTTP 200",
          "updated_at": "2025-06-15T10:29:00.000Z"
        }
      },
      "recentEvents": [
        {
          "type": "start",
          "status": "started",
          "timestamp": "2025-06-15T10:00:00.000Z"
        }
      ],
      "createdAt": "2025-06-01T00:00:00.000Z",
      "updatedAt": "2025-06-15T10:00:00.000Z"
    }
  ],
  "lastFetchTime": "2025-06-15T10:30:00.000Z"
}
```

## Deployment detection

The plugin detects deployments by comparing each machine's `instance_id` against its previously known value. When an instance ID changes, the machine has been updated -- typically as part of a deployment.

Machines with the same new image digest are grouped into a single deployment event. The deployment status is determined by the states of the affected machines:

| Status | Condition |
|---|---|
| `completed` | All affected machines are in the `started` state |
| `in_progress` | Machines are still transitioning (not all started, none failed) |
| `partial` | Some machines started, some failed (destroyed or replacing) |
| `failed` | All affected machines failed |

## Full example

```ts
import { createAgent } from '@beepsdev/zup';
import { flyMachines } from '@beepsdev/zup/plugins/fly-machines';

const agent = await createAgent({
  name: 'fly-monitor',
  mode: 'continuous',
  loopInterval: 30000,
  api: {
    port: 3000,
    auth: {
      apiKeys: [{ key: process.env.API_KEY!, name: 'admin' }],
    },
  },
  plugins: [
    flyMachines({
      auth: { token: process.env.FLY_API_TOKEN! },
      pollIntervalMs: 60000,
      maxMachinesPerApp: 50,
      apps: [
        {
          name: 'api-prod',
          serviceName: 'API (Production)',
          regions: ['ord', 'cdg', 'nrt'],
        },
        {
          name: 'worker-prod',
          serviceName: 'Background Worker',
          metadata: { role: 'worker' },
        },
        {
          name: 'api-staging',
          serviceName: 'API (Staging)',
          regions: ['ord'],
        },
      ],
    }),
  ],
});

const server = agent.startApi({ port: 3000 });
await agent.start();
```

Three Fly.io apps are monitored across multiple regions. The API production app is filtered to three specific regions; the worker app filters by metadata. Deployments are detected automatically when machines update their instance IDs. Machine health checks are tracked and surfaced as observations. The REST API on port 3000 provides on-demand machine and deployment status.
