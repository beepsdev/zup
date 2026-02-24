# Vercel Deploys Plugin

Observes recent deployments from Vercel and feeds that context into the OODA loop. This plugin is part of the **OBSERVE** phase, providing deployment context for the **ORIENT** phase to correlate with incidents and system state.

## Features

- Monitor deployments across multiple Vercel projects
- Track deployment state changes (building, ready, error, canceled)
- Capture git metadata (commit SHA, message, branch, author) for incident correlation
- REST API endpoints for querying deployment status
- Automatic severity classification based on deployment state and environment

## Installation

The plugin is included in the Zup monorepo. Import it from `zupdev/plugins/vercel-deploys`.

## Configuration

### Authentication

**Phase 1 (Current)**: Personal Access Token (PAT) authentication

1. Go to [Vercel Account Tokens](https://vercel.com/account/tokens)
2. Create a new token with appropriate scope
3. Set the token in your environment or pass it directly to the plugin

```typescript
import { createAgent } from 'zupdev';
import { vercelDeploys } from 'zupdev/plugins/vercel-deploys';

const agent = await createAgent({
  plugins: [
    vercelDeploys({
      auth: {
        token: process.env.VERCEL_TOKEN!,
      },
      projects: [
        {
          id: 'prj_xyz123',           // Vercel project ID
          serviceName: 'payments-api', // Human-readable name for SRE context
          teamId: 'team_abc',          // Optional: team scope
          environments: ['production', 'preview'], // Optional: filter by environment
        },
      ],
      pollIntervalMs: 60000,        // Optional: how often to poll (default: 60s)
      maxDeploysPerProject: 20,     // Optional: max deployments to track (default: 20)
    }),
  ],
});
```

### Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `auth.token` | `string` | Yes | - | Vercel Personal Access Token |
| `projects` | `VercelProjectConfig[]` | Yes | - | Projects to monitor |
| `pollIntervalMs` | `number` | No | `60000` | Polling interval in milliseconds |
| `maxDeploysPerProject` | `number` | No | `20` | Max deployments to fetch per project |
| `apiBaseUrl` | `string` | No | `https://api.vercel.com` | Vercel API base URL |

### Project Configuration

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `id` | `string` | Yes | Vercel project ID (e.g., `prj_xyz`) |
| `serviceName` | `string` | Yes | Human-readable service name for SRE context |
| `teamId` | `string` | No | Team ID for team-scoped projects |
| `environments` | `string[]` | No | Filter by environment (`production`, `preview`, `development`) |

## OODA Loop Integration

### OBSERVE Phase

The plugin provides a `recentDeploys` observer that:

- Fetches deployments from Vercel API (`GET /v6/deployments`)
- Tracks "last seen deployment" per project for incremental fetching
- Emits `Observation` objects with source `vercel-deploys/deployment`

**Observation Data:**

```typescript
{
  deploymentId: string;
  projectId: string;
  projectName: string;
  serviceName: string;
  teamId?: string;
  environment: 'production' | 'preview' | 'development';
  state: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
  url: string;
  inspectorUrl?: string;
  createdAt: string;
  readyAt?: string;
  git: {
    commitSha?: string;
    commitMessage?: string;
    branch?: string;
    author?: string;
    repoUrl?: string;
  };
  creator?: {
    uid: string;
    email?: string;
    username?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  timeSincePreviousDeploy?: number;
}
```

### ORIENT Phase

The plugin includes an `analyzeDeployments` orienter that:

- Groups deployments by service
- Reports recent production deployments with git context
- Identifies failed deployments and patterns
- Detects deployments in progress

**Example Findings:**

- "payments-api: production deployment 7m ago - READY (commit abc123d by Developer)"
- "checkout-frontend: 3 failed deployment(s) in recent history"
- "api-gateway: 1 deployment(s) in progress"

## API Endpoints

All endpoints require authentication via API key.

### GET /vercel/projects

List configured projects with their last deployment status.

**Response:**

```json
{
  "projects": [
    {
      "id": "prj_xyz",
      "serviceName": "payments-api",
      "teamId": "team_abc",
      "environments": ["production"],
      "lastFetchTime": "2024-01-15T10:30:00Z",
      "lastDeployment": {
        "uid": "dpl_123",
        "state": "READY",
        "target": "production",
        "url": "payments-api-abc123.vercel.app",
        "createdAt": "2024-01-15T10:25:00Z",
        "git": {
          "commitSha": "abc123def456",
          "branch": "main"
        }
      },
      "recentDeploymentCount": 5
    }
  ]
}
```

### GET /vercel/projects/:projectId/deployments

Get recent deployments for a specific project.

**Response:**

```json
{
  "project": {
    "id": "prj_xyz",
    "serviceName": "payments-api"
  },
  "deployments": [
    {
      "uid": "dpl_123",
      "projectId": "prj_xyz",
      "projectName": "payments-api",
      "state": "READY",
      "target": "production",
      "url": "payments-api-abc123.vercel.app",
      "createdAt": "2024-01-15T10:25:00Z",
      "readyAt": "2024-01-15T10:27:00Z",
      "git": {
        "commitSha": "abc123def456",
        "commitMessage": "feat: add new endpoint",
        "branch": "main",
        "author": "Developer"
      }
    }
  ],
  "lastFetchTime": "2024-01-15T10:30:00Z"
}
```

## State Management

The plugin stores the following state per project:

- `lastSeenTimestamp`: Timestamp of the most recent deployment (for incremental fetching)
- `recentDeployments`: Cache of recent deployments
- `lastFetchTime`: When deployments were last fetched

**Note:** The current state store is in-memory and does not persist across restarts. For production use with OAuth (Phase 2), a persistent state store (e.g., SQLite) will be required.

## Roadmap

### Phase 1 (Current)
- PAT-based authentication
- Basic deployment observer
- REST API endpoints

### Phase 2 (Planned)
- OAuth integration support
- Token refresh handling
- Persistent state storage

### Phase 3 (Future)
- Actions for rollbacks
- Manual redeploy triggers
- Deployment promotion workflows

## Example Usage

```typescript
import { createAgent } from 'zupdev';
import { vercelDeploys } from 'zupdev/plugins/vercel-deploys';

async function main() {
  const agent = await createAgent({
    name: 'SRE Agent',
    plugins: [
      vercelDeploys({
        auth: { token: process.env.VERCEL_TOKEN! },
        projects: [
          { id: 'prj_frontend', serviceName: 'web-app' },
          { id: 'prj_api', serviceName: 'api-server', teamId: 'team_xyz' },
        ],
      }),
    ],
  });

  // Start API server
  const api = agent.startApi({
    port: 3000,
    apiKeys: ['your-api-key'],
  });

  // Run OODA loop
  const result = await agent.runLoop();

  // Check deployment observations
  const deployments = result.observations.filter(
    (obs) => obs.source === 'vercel-deploys/deployment'
  );

  console.log(`Observed ${deployments.length} deployments`);

  // Check situation assessment
  const assessment = result.situation?.assessments.find(
    (a) => a.source === 'vercel-deploys/analyze-deployments'
  );

  console.log('Findings:', assessment?.findings);
}

main();
```
