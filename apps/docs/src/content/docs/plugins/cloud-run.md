---
title: Cloud Run
description: Monitor Google Cloud Run services, track rollouts, and perform traffic-based rollbacks.
---

The `cloud-run` plugin monitors Google Cloud Run services across multiple projects and regions. It tracks service health, revision rollouts, and can shift traffic for auto-rollback when new revisions fail. It optionally ingests Cloud Logging error logs and Cloud Monitoring metrics as additional observations.

## Installation

```ts
import { createAgent } from '@beepsdev/zup';
import { cloudRun } from '@beepsdev/zup/plugins/cloud-run';

const agent = await createAgent({
  name: 'cloud-run-agent',
  plugins: [
    cloudRun({
      projects: [
        {
          projectId: 'my-project',
          regions: ['us-central1'],
        },
      ],
    }),
  ],
});
```

## Requirements

The plugin uses Google Application Default Credentials (ADC) by default. Ensure credentials are available in the environment (e.g., via `GOOGLE_APPLICATION_CREDENTIALS` or running on GCE/Cloud Shell).

The `google-auth-library` package must be installed for authentication.

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `auth` | `CloudRunAuthConfig` | `{ useADC: true }` | Authentication configuration. Uses Application Default Credentials by default. |
| `auth.useADC` | `boolean` | `true` | Whether to use Application Default Credentials. |
| `auth.scopes` | `string[]` | `['https://www.googleapis.com/auth/cloud-platform']` | OAuth scopes to request when using ADC. |
| `projects` | `CloudRunProjectConfig[]` | -- | **Required.** Projects and regions to monitor. At least one project must be configured. |
| `pollIntervalMs` | `number` | `60000` | Polling interval in milliseconds. |
| `readOnly` | `boolean` | `true` | When `true`, traffic-shifting actions are disabled. Set to `false` to enable rollback actions. |
| `autoRollback` | `boolean` | `false` | Enable automatic rollback when a new revision fails to become ready. |
| `autoRollbackMinReadyMinutes` | `number` | `5` | Minimum minutes a new revision must be ready before a rollout is considered failed. |
| `maxRevisionsPerService` | `number` | `20` | Maximum revisions to fetch per service. |
| `includeLogs` | `boolean` | `false` | Include Cloud Logging error observations. |
| `logQueryWindowMinutes` | `number` | `10` | Time window for log queries in minutes. |
| `logPageSize` | `number` | `50` | Maximum log entries to fetch per service. |
| `includeMetrics` | `boolean` | `false` | Include Cloud Monitoring metrics observations. |
| `metricsWindowMinutes` | `number` | `5` | Time window for metrics queries in minutes. |
| `errorRateWarningThreshold` | `number` | `0.05` | Error rate above which a warning observation is emitted. |
| `errorRateErrorThreshold` | `number` | `0.1` | Error rate above which an error observation is emitted. |

## Project configuration

Each project describes a GCP project and its regions to monitor:

| Field | Type | Required | Description |
|---|---|---|---|
| `projectId` | `string` | Yes | GCP project ID. |
| `regions` | `string[]` | Yes | Regions to monitor (e.g., `['us-central1', 'europe-west1']`). |
| `services` | `string[]` | No | Allowlist of service names. If set, only these services are monitored. |
| `labels` | `Record<string, string>` | No | Label filter. Service labels must include all provided key-value pairs. |
| `serviceNameMap` | `Record<string, string>` | No | Mapping of Cloud Run service name to a human-readable display name. |

## OODA phase contributions

### Observe: service health

The observer polls Cloud Run APIs and produces observations for:

- **Service status**: Tracks each service's conditions (Ready, ConfigurationsReady, RoutesReady), traffic allocation, and latest revision state.
- **Rollout detection**: Detects when a new revision is created (latestCreatedRevision differs from latestReadyRevision), tracks rollout age, and determines rollout status (in_progress, completed, failed).
- **Log observations** (when `includeLogs` is enabled): Fetches recent error-severity log entries from Cloud Logging for each monitored service.
- **Metric observations** (when `includeMetrics` is enabled): Fetches request count and error rate metrics from Cloud Monitoring. Emits warning or error severity based on configured thresholds.

### Orient: rollout analysis

Analyzes Cloud Run observations and produces findings about:

- Service health status and conditions
- Active rollout progress and duration
- Failed rollouts with error messages
- Error rate trends when metrics are enabled

Sets `contributingFactor` when rollout failures or elevated error rates are detected.

### Decide: auto-rollback

When `autoRollback` is enabled and a rollout is detected as failed (the new revision has not become ready within `autoRollbackMinReadyMinutes`), the decision strategy proposes shifting traffic back to the last known good revision.

### Act: traffic management

- **rollback**: Shifts 100% of traffic to the last known good revision. Requires `readOnly: false`.
- **set-traffic**: Sets traffic allocation across revisions. Requires `readOnly: false`.
- **deploy-revision**: Deploys a new revision with a specified image. Requires `readOnly: false`.

## REST API endpoints

All endpoints require authentication by default.

### GET /cloud-run/services

Lists all monitored Cloud Run services with their current state.

**Response:**

```json
{
  "services": [
    {
      "key": "my-project/us-central1/api-service",
      "projectId": "my-project",
      "region": "us-central1",
      "service": "api-service",
      "serviceName": "API Service",
      "url": "https://api-service-xyz.a.run.app",
      "latestReadyRevision": "api-service-00042-abc",
      "latestCreatedRevision": "api-service-00042-abc",
      "traffic": [{ "revision": "api-service-00042-abc", "percent": 100 }],
      "rolloutStatus": "completed",
      "updatedAt": "2025-06-15T10:30:00.000Z"
    }
  ]
}
```

### GET /cloud-run/services/:name

Returns detailed state for a specific service (matched by service name within the key).

### POST /cloud-run/services/:name/rollback

Triggers a rollback to the last known good revision by shifting 100% of traffic. Requires `readOnly: false`.

**Response:**

```json
{
  "success": true,
  "message": "Rolled back api-service to revision api-service-00041-def"
}
```

### POST /cloud-run/services/:name/traffic

Sets traffic allocation for a service. Requires `readOnly: false`.

**Request body:**

```json
{
  "traffic": [
    { "revision": "api-service-00041-def", "percent": 90 },
    { "revision": "api-service-00042-abc", "percent": 10 }
  ]
}
```

## Full example

```ts
import { createAgent } from '@beepsdev/zup';
import { cloudRun } from '@beepsdev/zup/plugins/cloud-run';

const agent = await createAgent({
  name: 'cloud-run-monitor',
  mode: 'continuous',
  loopInterval: 30000,
  api: {
    port: 3000,
    auth: {
      apiKeys: [{ key: process.env.API_KEY!, name: 'admin' }],
    },
  },
  plugins: [
    cloudRun({
      projects: [
        {
          projectId: 'my-production-project',
          regions: ['us-central1', 'europe-west1'],
          services: ['api-service', 'worker-service'],
          serviceNameMap: {
            'api-service': 'API Gateway',
            'worker-service': 'Background Worker',
          },
        },
        {
          projectId: 'my-staging-project',
          regions: ['us-central1'],
          labels: { env: 'staging' },
        },
      ],
      pollIntervalMs: 60000,
      readOnly: false,
      autoRollback: true,
      autoRollbackMinReadyMinutes: 5,
      includeLogs: true,
      logQueryWindowMinutes: 10,
      includeMetrics: true,
      metricsWindowMinutes: 5,
      errorRateWarningThreshold: 0.05,
      errorRateErrorThreshold: 0.1,
    }),
  ],
});

const server = agent.startApi({ port: 3000 });
await agent.start();
```

Two GCP projects are monitored across multiple regions. Production services are explicitly listed; staging services are discovered by label. Auto-rollback is enabled -- if a new revision fails to become ready within 5 minutes, traffic shifts back to the last known good revision. Cloud Logging and Cloud Monitoring are both enabled for additional context. The REST API on port 3000 allows manual rollbacks and traffic adjustments.
