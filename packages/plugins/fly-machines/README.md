# Fly.io Machines Plugin

Observes Fly.io machines and their state changes to track deployments and feed that context into the OODA loop. This plugin is part of the **OBSERVE** phase, providing deployment and machine health context for the **ORIENT** phase to correlate with incidents and system state.

## Features

- Monitor machines across multiple Fly.io apps
- Track machine state changes and detect deployments via instance_id changes
- Capture image metadata (registry, repository, tag, digest) for correlation
- Track machine events (launch, start, stop, update)
- Monitor health check status
- REST API endpoints for querying machine status

## Key Difference from Vercel

Fly.io doesn't have a dedicated "deployments" endpoint. Instead, this plugin detects deployments by monitoring machine `instance_id` changes and image digest updates. When machines are updated to a new image, the plugin aggregates these changes into deployment events.

## Installation

The plugin is included in the Zup monorepo. Import it from `@beepsdev/zup/plugins/fly-machines`.

## Configuration

### Authentication

Create a Fly.io API token using the `fly` CLI:

```bash
fly tokens create
```

Then configure the plugin with the token:

```typescript
import { createAgent } from '@beepsdev/zup';
import { flyMachines } from '@beepsdev/zup/plugins/fly-machines';

const agent = await createAgent({
  plugins: [
    flyMachines({
      auth: {
        token: process.env.FLY_API_TOKEN!,
      },
      apps: [
        {
          name: 'my-app-name',           // Fly.io app name
          serviceName: 'payments-api',    // Human-readable name for SRE context
          regions: ['ord', 'cdg'],        // Optional: filter by region
          metadata: { env: 'production' }, // Optional: filter by metadata
        },
      ],
      pollIntervalMs: 60000,        // Optional: how often to poll (default: 60s)
      maxMachinesPerApp: 50,        // Optional: max machines to track (default: 50)
    }),
  ],
});
```

### Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `auth.token` | `string` | Yes | - | Fly.io API token |
| `apps` | `FlyAppConfig[]` | Yes | - | Apps to monitor |
| `pollIntervalMs` | `number` | No | `60000` | Polling interval in milliseconds |
| `maxMachinesPerApp` | `number` | No | `50` | Max machines to fetch per app |
| `apiBaseUrl` | `string` | No | `https://api.machines.dev` | Fly Machines API base URL |

### App Configuration

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Fly.io app name |
| `serviceName` | `string` | Yes | Human-readable service name for SRE context |
| `regions` | `string[]` | No | Filter by specific regions (e.g., `['ord', 'cdg']`) |
| `metadata` | `Record<string, string>` | No | Filter by metadata key-value pairs |

## OODA Loop Integration

### OBSERVE Phase

The plugin provides a `machineStatus` observer that:

- Fetches machines from Fly.io API (`GET /v1/apps/{app_name}/machines`)
- Tracks `instance_id` per machine to detect updates (deployments)
- Emits `Observation` objects for both machines and detected deployments

**Machine Observation Data:**

```typescript
{
  machineId: string;
  machineName: string;
  appName: string;
  serviceName: string;
  state: 'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'suspended' | 'destroyed';
  region: string;
  instanceId: string;
  imageDigest: string;
  imageRepository: string;
  imageTag?: string;
  guest?: {
    cpu_kind: string;
    cpus: number;
    memory_mb: number;
  };
  checks?: Record<string, { status: string; output?: string }>;
  recentEvent?: {
    type: string;
    status: string;
    timestamp: string;
  };
  createdAt: string;
  updatedAt: string;
}
```

**Deployment Observation Data:**

```typescript
{
  deploymentId: string;
  appName: string;
  serviceName: string;
  imageDigest: string;
  imageRepository: string;
  imageTag?: string;
  machinesAffected: string[];
  regionsAffected: string[];
  status: 'in_progress' | 'completed' | 'failed' | 'partial';
  successCount: number;
  failureCount: number;
}
```

### ORIENT Phase

The plugin includes an `analyzeMachines` orienter that:

- Groups machines by service
- Reports machine counts and regions
- Identifies deployment status (completed, in progress, failed, partial)
- Detects unhealthy machines and failing health checks

**Example Findings:**

- "payments-api: deployment completed - 3 machine(s) updated in ord, cdg (v1.2.4)"
- "payments-api: 3/3 machines running across ord, cdg"
- "api-gateway: 1 machine(s) with failing health checks"

## API Endpoints

All endpoints require authentication via API key.

### GET /fly/apps

List configured apps with their machine status.

**Response:**

```json
{
  "apps": [
    {
      "name": "my-app",
      "serviceName": "payments-api",
      "configuredRegions": ["ord", "cdg"],
      "activeRegions": ["ord", "cdg"],
      "lastFetchTime": "2024-01-15T10:30:00Z",
      "machineCount": 3,
      "runningCount": 3,
      "isConsistent": true,
      "currentImageDigest": "sha256:abc123...",
      "imageDigestCount": 1
    }
  ]
}
```

### GET /fly/apps/:appName/machines

Get machines for a specific app.

**Response:**

```json
{
  "app": {
    "name": "my-app",
    "serviceName": "payments-api"
  },
  "machines": [
    {
      "id": "machine_123",
      "name": "my-app-machine-1",
      "state": "started",
      "region": "ord",
      "instanceId": "instance_abc123",
      "imageRef": {
        "repository": "my-app",
        "tag": "v1.2.3",
        "digest": "sha256:abc123..."
      },
      "guest": {
        "cpu_kind": "shared",
        "cpus": 1,
        "memory_mb": 256
      },
      "checks": {
        "http-check": {
          "status": "passing"
        }
      },
      "recentEvents": [
        {
          "type": "start",
          "status": "started",
          "timestamp": "2024-01-15T10:25:00Z"
        }
      ],
      "createdAt": "2024-01-14T10:00:00Z",
      "updatedAt": "2024-01-15T10:25:00Z"
    }
  ],
  "lastFetchTime": "2024-01-15T10:30:00Z"
}
```

## Deployment Detection

Unlike Vercel which has explicit deployment objects, Fly.io deployments are detected by monitoring machine changes:

1. **Instance ID Tracking**: Each machine has an `instance_id` that changes when the machine is updated
2. **Image Digest Comparison**: When machines are updated to a new image digest, it indicates a deployment
3. **Aggregation**: Multiple machine updates with the same new digest are grouped into a single deployment event

**Deployment Status:**

- `completed`: All affected machines are in `started` state
- `in_progress`: Some machines are still updating
- `partial`: Some machines succeeded, some failed
- `failed`: All machines failed to update

## State Management

The plugin stores the following state per app:

- `lastKnownInstanceIds`: Map of machine ID to last known instance ID (for detecting updates)
- `recentMachines`: Cache of recent machines
- `lastFetchTime`: When machines were last fetched

**Note:** The current state store is in-memory and does not persist across restarts.

## Example Usage

```typescript
import { createAgent } from '@beepsdev/zup';
import { flyMachines } from '@beepsdev/zup/plugins/fly-machines';

async function main() {
  const agent = await createAgent({
    name: 'SRE Agent',
    plugins: [
      flyMachines({
        auth: { token: process.env.FLY_API_TOKEN! },
        apps: [
          { name: 'web-app', serviceName: 'frontend' },
          { name: 'api-server', serviceName: 'backend', regions: ['ord'] },
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

  // Check machine observations
  const machines = result.observations.filter(
    (obs) => obs.source === 'fly-machines/machine'
  );

  console.log(`Observed ${machines.length} machines`);

  // Check for deployments
  const deployments = result.observations.filter(
    (obs) => obs.source === 'fly-machines/deployment'
  );

  if (deployments.length > 0) {
    console.log(`Detected ${deployments.length} deployment(s)`);
  }

  // Check situation assessment
  const assessment = result.situation?.assessments.find(
    (a) => a.source === 'fly-machines/analyze-machines'
  );

  console.log('Findings:', assessment?.findings);
}

main();
```

## Machine States

The plugin tracks the following Fly.io machine states:

| State | Description |
|-------|-------------|
| `created` | Machine has been created but not yet started |
| `starting` | Machine is starting up |
| `started` | Machine is running |
| `stopping` | Machine is shutting down |
| `stopped` | Machine is stopped |
| `suspended` | Machine is suspended (memory snapshot taken) |
| `replacing` | Machine is being replaced |
| `destroying` | Machine is being destroyed |
| `destroyed` | Machine has been destroyed |

## Health Checks

The plugin monitors Fly.io health check status:

- `passing`: Health check is passing
- `warning`: Health check has warnings
- `critical`: Health check is failing

Machines with `critical` health checks are flagged in the orienter analysis.
