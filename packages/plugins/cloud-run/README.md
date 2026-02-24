# Cloud Run Plugin

Observe Google Cloud Run services and rollouts, with optional auto-rollback via traffic shifting.

## Features

- Monitor Cloud Run services across projects and regions
- Track latest created vs. ready revisions to detect rollouts
- Emit rollout status (in progress / completed / failed)
- Optional auto-rollback (traffic shift) on failed rollouts
- REST API endpoints for service status and traffic updates

## Authentication (ADC)

This plugin uses **Application Default Credentials (ADC)**, which is the idiomatic GCP auth flow.

For local development, you can export a token:

```bash
export GCP_ACCESS_TOKEN="$(gcloud auth application-default print-access-token)"
```

## Installation

```typescript
import { createAgent } from '@beepsdev/zup';
import { cloudRun } from '@beepsdev/zup/plugins/cloud-run';

const agent = await createAgent({
  plugins: [
    cloudRun({
      projects: [
        {
          projectId: 'my-project',
          regions: ['us-central1'],
        },
      ],
      readOnly: true,
      autoRollback: false,
    }),
  ],
});
```

## Configuration

```typescript
cloudRun({
  projects: [
    {
      projectId: 'my-project',
      regions: ['us-central1', 'europe-west1'],
      services: ['api', 'web'], // optional allowlist
      labels: { env: 'prod' },  // optional label filter
      serviceNameMap: { api: 'Payments API' },
    },
  ],
  pollIntervalMs: 60000,
  readOnly: true,
  autoRollback: true,
  autoRollbackMinReadyMinutes: 5,
  includeLogs: false,
  logQueryWindowMinutes: 10,
  logPageSize: 50,
  includeMetrics: false,
  metricsWindowMinutes: 5,
  errorRateWarningThreshold: 0.05,
  errorRateErrorThreshold: 0.1,
});
```

## Rollback Behavior

When `autoRollback` is enabled and `readOnly` is `false`, the plugin will:
- Detect failed rollouts (new revision not ready within the threshold)
- Shift 100% traffic back to the last known good revision

## Logs & Metrics

Enable `includeLogs` to emit `cloud-run/log-errors` observations based on recent
Cloud Logging entries (severity ERROR and above). Enable `includeMetrics` to emit
`cloud-run/metrics` observations based on Cloud Monitoring request counts.

Both are optional and disabled by default.

Required IAM roles when enabling:
- Logs: `roles/logging.viewer`
- Metrics: `roles/monitoring.viewer`

## API Endpoints

All endpoints require authentication via API key.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/cloud-run/services` | List all tracked services |
| GET | `/cloud-run/projects/:projectId/regions/:region/services` | List services for a project/region |
| GET | `/cloud-run/projects/:projectId/regions/:region/services/:service` | Get service snapshot |
| GET | `/cloud-run/projects/:projectId/regions/:region/services/:service/revisions` | List service revisions |
| POST | `/cloud-run/projects/:projectId/regions/:region/services/:service/traffic` | Set traffic targets |
| POST | `/cloud-run/projects/:projectId/regions/:region/services/:service/rollback` | Roll back to last known good revision |
