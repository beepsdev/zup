---
title: Vercel Deploys
description: Monitor Vercel deployments, track build status, and correlate deployment failures with incidents.
---

The `vercel-deploys` plugin monitors Vercel deployments across multiple projects. It tracks deployment state changes (queued, building, ready, error, canceled), captures git metadata (commit SHA, branch, author), and correlates deployment activity with other observations to help identify deployment-related incidents.

## Installation

```ts
import { createAgent } from 'zupdev';
import { vercelDeploys } from 'zupdev/plugins/vercel-deploys';

const agent = await createAgent({
  name: 'vercel-agent',
  plugins: [
    vercelDeploys({
      auth: { token: process.env.VERCEL_TOKEN! },
      projects: [
        {
          id: 'prj_abc123',
          serviceName: 'Marketing Site',
        },
      ],
    }),
  ],
});
```

## Requirements

A Vercel Personal Access Token (PAT) is required. Generate one from the Vercel dashboard under Account Settings > Tokens.

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `auth` | `VercelAuthConfig` | -- | **Required.** Authentication configuration. |
| `auth.token` | `string` | -- | **Required.** Vercel Personal Access Token. |
| `projects` | `VercelProjectConfig[]` | -- | **Required.** Projects to monitor. At least one project must be configured. |
| `pollIntervalMs` | `number` | `60000` | Polling interval in milliseconds. |
| `maxDeploysPerProject` | `number` | `20` | Maximum deployments to fetch per project per poll. |
| `apiBaseUrl` | `string` | `'https://api.vercel.com'` | Vercel API base URL. |

## Project configuration

Each project describes a Vercel project to monitor:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Vercel project ID (e.g., `'prj_xyz'`) or project name. |
| `serviceName` | `string` | Yes | Human-readable service name for SRE context (used in observations and findings). |
| `teamId` | `string` | No | Team ID for team-scoped projects. |
| `environments` | `Array<'production' \| 'preview' \| 'development'>` | No | Environments to monitor. Defaults to all environments. |

## OODA phase contributions

### Observe: `vercel-recent-deploys`

The observer polls the Vercel Deployments API for each configured project and produces observations:

**Deployment events** (`vercel-deploys/deployment`): One observation per deployment with:
- Deployment ID, project name, service name, environment, and state
- Deployment URL and inspector URL
- Git metadata: commit SHA, message, branch, author, repository URL
- Creator information (user who triggered the deployment)
- Error code and message (for failed deployments)
- Time since the previous deployment
- Severity: `critical` for failed production deployments, `error` for failed non-production deployments, `info` for all others

**API errors** (`vercel-deploys/error`): Emitted when the Vercel API call fails for a project, with `warning` severity.

The observer fetches incrementally -- after the first poll, it only fetches deployments created after the most recent one seen.

### Orient: `analyze-vercel-deployments`

Analyzes Vercel deployment observations grouped by service:

- Reports the most recent production deployment with its state, time since deployment, commit SHA, and author
- Counts failed deployments per service. When 3 or more failures are detected, sets `contributingFactor` to indicate a possible build or configuration issue
- Reports deployments currently in progress (building or queued)
- Confidence: `0.85`

## REST API endpoints

All endpoints require authentication by default.

### GET /vercel/projects

Lists all configured Vercel projects with their latest deployment status.

**Response:**

```json
{
  "projects": [
    {
      "id": "prj_abc123",
      "serviceName": "Marketing Site",
      "teamId": "team_xyz",
      "environments": ["production"],
      "lastFetchTime": "2025-06-15T10:30:00.000Z",
      "lastDeployment": {
        "uid": "dpl_abc123",
        "state": "READY",
        "target": "production",
        "url": "marketing-site-abc123.vercel.app",
        "createdAt": "2025-06-15T10:25:00.000Z",
        "git": {
          "commitSha": "a1b2c3d",
          "commitMessage": "Update hero section",
          "branch": "main",
          "author": "alice"
        }
      },
      "recentDeploymentCount": 8
    }
  ]
}
```

### GET /vercel/projects/:projectId/deployments

Returns recent deployments for a specific project with full details.

**Response:**

```json
{
  "project": {
    "id": "prj_abc123",
    "serviceName": "Marketing Site"
  },
  "deployments": [
    {
      "uid": "dpl_abc123",
      "projectId": "prj_abc123",
      "projectName": "marketing-site",
      "state": "READY",
      "target": "production",
      "url": "marketing-site-abc123.vercel.app",
      "inspectorUrl": "https://vercel.com/team/marketing-site/dpl_abc123",
      "createdAt": "2025-06-15T10:25:00.000Z",
      "readyAt": "2025-06-15T10:26:30.000Z",
      "git": {
        "commitSha": "a1b2c3d4e5f6",
        "commitMessage": "Update hero section",
        "branch": "main",
        "author": "alice",
        "repoUrl": "https://github.com/myorg/marketing-site"
      },
      "creator": {
        "uid": "user_abc",
        "email": "alice@example.com",
        "username": "alice"
      },
      "error": null
    }
  ],
  "lastFetchTime": "2025-06-15T10:30:00.000Z"
}
```

## Deployment states

The plugin tracks these Vercel deployment states:

| State | Description |
|---|---|
| `QUEUED` | Deployment is queued, waiting to build |
| `BUILDING` | Deployment is currently building |
| `READY` | Deployment completed successfully |
| `ERROR` | Deployment failed with an error |
| `CANCELED` | Deployment was canceled |
| `INITIALIZING` | Deployment is initializing |

## Full example

```ts
import { createAgent } from 'zupdev';
import { vercelDeploys } from 'zupdev/plugins/vercel-deploys';

const agent = await createAgent({
  name: 'vercel-monitor',
  mode: 'continuous',
  loopInterval: 30000,
  api: {
    port: 3000,
    auth: {
      apiKeys: [{ key: process.env.API_KEY!, name: 'admin' }],
    },
  },
  plugins: [
    vercelDeploys({
      auth: { token: process.env.VERCEL_TOKEN! },
      pollIntervalMs: 60000,
      maxDeploysPerProject: 20,
      projects: [
        {
          id: 'prj_frontend',
          serviceName: 'Frontend App',
          teamId: 'team_myorg',
          environments: ['production'],
        },
        {
          id: 'prj_docs',
          serviceName: 'Documentation Site',
          teamId: 'team_myorg',
          environments: ['production', 'preview'],
        },
        {
          id: 'prj_api',
          serviceName: 'API Functions',
          teamId: 'team_myorg',
        },
      ],
    }),
  ],
});

const server = agent.startApi({ port: 3000 });
await agent.start();
```

Three Vercel projects are monitored, each with a descriptive service name for SRE context. The Frontend App tracks production only. The Documentation Site includes preview deployments. The API Functions project monitors all environments. Deployment failures in production trigger `critical` severity observations. Git metadata (commit SHA, branch, author) is captured with each deployment for incident correlation.
