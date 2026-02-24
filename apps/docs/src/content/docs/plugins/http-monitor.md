---
title: HTTP Monitor
description: Monitor HTTP endpoints, detect failures, and automatically restart unhealthy services.
---

The `http-monitor` plugin watches HTTP endpoints for availability and can automatically restart services when they become unhealthy. It contributes to all four OODA phases: an observer for health checks, an orienter for failure analysis, a decision strategy for restart logic, and an action for executing restarts.

## Installation

```ts
import { createAgent } from 'zupdev';
import { httpMonitor } from 'zupdev/plugins/http-monitor';

const agent = await createAgent({
  name: 'my-agent',
  plugins: [
    httpMonitor({
      endpoints: [
        {
          id: 'api',
          name: 'API Server',
          url: 'https://api.example.com/health',
        },
        {
          id: 'dashboard',
          name: 'Dashboard',
          url: 'https://dashboard.example.com/health',
          expectedStatus: 200,
          timeout: 10000,
          critical: true,
        },
      ],
      checkInterval: 30000,
      maxHistorySize: 50,
    }),
  ],
});
```

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `endpoints` | `EndpointConfig[]` | -- | **Required.** At least one endpoint must be configured. |
| `checkInterval` | `number` | `30000` | How often to check endpoints, in milliseconds. This is set as the observer's `interval`, so it is only enforced in `continuous` mode. |
| `maxHistorySize` | `number` | `50` | Maximum number of health check results to keep per endpoint. Older results are trimmed. |

## Endpoint configuration

Each endpoint describes one HTTP service to monitor:

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | -- | **Required.** Unique identifier for this endpoint. |
| `name` | `string` | -- | **Required.** Human-readable name used in logs and assessments. |
| `url` | `string` | -- | **Required.** URL to check. |
| `method` | `string` | `'GET'` | HTTP method for the health check request. |
| `expectedStatus` | `number` | `200` | The status code that indicates a healthy response. |
| `timeout` | `number` | `5000` | Request timeout in milliseconds. |
| `headers` | `Record<string, string>` | -- | Custom headers sent with every health check request. Useful for auth tokens. |
| `restartStrategy` | `RestartStrategy` | -- | How to restart this service when it fails. If not set, restarts are not attempted. |
| `failureThreshold` | `number` | `3` | Number of consecutive failures before the endpoint is considered unhealthy and eligible for restart. |
| `cooldownPeriod` | `number` | `300000` | Minimum time between restarts in milliseconds (default: 5 minutes). Prevents restart loops. |
| `critical` | `boolean` | `false` | If `true`, failures produce `'critical'` severity observations (instead of `'error'`) and the decision strategy sets `requiresApproval: true` on restart decisions. |

## Restart strategies

The `restartStrategy` field determines how the plugin restarts a service. Three strategy types are available.

### Command strategy

Run a shell command to restart the service:

```ts
{
  id: 'api',
  name: 'API Server',
  url: 'https://api.example.com/health',
  restartStrategy: {
    type: 'command',
    command: 'systemctl restart api-server',
    cwd: '/opt/api',
  },
}
```

The `command` field can be a string (split on spaces) or an array of strings:

```ts
// String form -- split on spaces
restartStrategy: {
  type: 'command',
  command: 'docker compose restart api',
}

// Array form -- no splitting, handles args with spaces
restartStrategy: {
  type: 'command',
  command: ['docker', 'compose', 'restart', 'api'],
  cwd: '/opt/services',
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `'command'` | Yes | Selects the command strategy. |
| `command` | `string \| string[]` | Yes | Command to execute. |
| `cwd` | `string` | No | Working directory for the command. |

The command is executed with `Bun.spawn`. If the process exits with a non-zero exit code, the restart is considered failed and the stderr output is included in the error message.

### HTTP strategy

Call an HTTP endpoint to trigger a restart (for example, a deployment API or orchestrator webhook):

```ts
{
  id: 'worker',
  name: 'Worker Service',
  url: 'https://worker.example.com/health',
  restartStrategy: {
    type: 'http',
    url: 'https://deploy.example.com/api/services/worker/restart',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer deploy-token',
    },
    body: { force: true },
    timeout: 30000,
  },
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `'http'` | Yes | Selects the HTTP strategy. |
| `url` | `string` | Yes | URL to call for the restart. |
| `method` | `string` | No | HTTP method. Defaults to `'POST'`. |
| `body` | `unknown` | No | Request body. Serialized as JSON. |
| `headers` | `Record<string, string>` | No | Additional headers. |
| `timeout` | `number` | No | Request timeout in ms. Defaults to `30000`. |

The restart is considered failed if the response status is not in the 2xx range.

### Function strategy

Call a custom async function for full programmatic control:

```ts
{
  id: 'api',
  name: 'API Server',
  url: 'https://api.example.com/health',
  restartStrategy: {
    type: 'function',
    handler: async () => {
      // Custom restart logic -- call Kubernetes API, Fly.io API, etc.
      await k8s.restartDeployment('api-server', 'production');
    },
  },
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `'function'` | Yes | Selects the function strategy. |
| `handler` | `() => Promise<void>` | Yes | Async function to execute. Throw to signal failure. |

## Failure detection and cooldown

The plugin tracks state for each endpoint independently:

1. **Consecutive failure counter** -- Incremented on each failed health check. Reset to `0` on success or after a successful restart.

2. **Failure threshold** -- When `consecutiveFailures >= failureThreshold`, the endpoint is considered unhealthy and eligible for restart. Below the threshold, failures produce `'warning'` severity observations. At or above the threshold, they produce `'error'` (or `'critical'` if the endpoint is marked `critical`).

3. **Cooldown period** -- After a restart, the endpoint enters a cooldown period (default 5 minutes). During cooldown, no further restarts are attempted even if the endpoint continues to fail. The decision strategy logs a warning and moves on to the next endpoint.

4. **No restart strategy** -- If an endpoint has no `restartStrategy` configured, the decision strategy skips it with a warning. Health checks and failure detection still work.

## OODA phase contributions

### Observe: `http-health-check`

The observer performs HTTP health checks against all configured endpoints. For each endpoint, it produces one `Observation` with:

- `source`: `'http-monitor/health-check'`
- `type`: `'metric'`
- `severity`: `'info'` (healthy), `'warning'` (failing below threshold), `'error'` (failing above threshold), or `'critical'` (critical endpoint above threshold)
- `data`: endpoint ID, name, URL, success status, status code, response time, error message, consecutive failures, last restart time

### Orient: `analyze-endpoint-failures`

The orienter filters observations from the health check observer and produces a `SituationAssessment`:

- **Healthy:** `findings: ['All monitored endpoints are healthy']`, confidence `1.0`
- **Unhealthy:** Lists each failing endpoint with its failure count and error. Sets `contributingFactor` to either `'Cascading failure detected'` (50% or more endpoints failing) or `'Isolated failure'`.

### Decide: `restart-unhealthy-endpoint`

The decision strategy is only applicable when assessments mention "unhealthy" or "failure" in their findings. It scans endpoints to find the first one that:

1. Has `consecutiveFailures >= failureThreshold`
2. Is past the cooldown period
3. Has a `restartStrategy` configured

If found, it returns a decision to execute `http-monitor:restartService` with `confidence: 0.85` and risk based on whether the endpoint is `critical` (medium) or not (low). Critical endpoints set `requiresApproval: true`.

If no endpoints qualify, it returns a `no-op`.

### Act: `restartService`

The action executes the endpoint's configured restart strategy. On success, it resets the consecutive failure counter and records the restart time. The action has default autonomy settings of `mode: 'auto'` with `minConfidence: 0.7`.

## REST API endpoints

The plugin registers three API endpoints:

### GET /http-monitor/endpoints

List all monitored endpoints with their current state.

**Response:**

```json
{
  "endpoints": [
    {
      "id": "api",
      "name": "API Server",
      "url": "https://api.example.com/health",
      "consecutiveFailures": 0,
      "lastRestartTime": null,
      "recentChecks": [
        {
          "endpointId": "api",
          "url": "https://api.example.com/health",
          "success": true,
          "statusCode": 200,
          "responseTime": 45,
          "timestamp": "2025-06-15T10:30:00.000Z"
        }
      ]
    }
  ]
}
```

### POST /http-monitor/endpoints/:endpointId/check

Trigger an immediate health check for a specific endpoint, bypassing the observer interval.

**Response:**

```json
{
  "endpointId": "api",
  "url": "https://api.example.com/health",
  "success": true,
  "statusCode": 200,
  "responseTime": 52,
  "timestamp": "2025-06-15T10:31:00.000Z"
}
```

### POST /http-monitor/endpoints/:endpointId/restart

Manually trigger a restart for a specific endpoint, bypassing the decision strategy and cooldown logic.

**Response (success):**

```json
{
  "action": "restart-service",
  "success": true,
  "output": "Successfully restarted service for API Server",
  "duration": 3200,
  "sideEffects": ["Service restart triggered for https://api.example.com/health"]
}
```

**Response (failure):**

```json
{
  "action": "restart-service",
  "success": false,
  "error": "Command failed with exit code 1: permission denied",
  "duration": 150
}
```

All three endpoints require authentication (Bearer token) by default.

## Full example

```ts
import { createAgent } from 'zupdev';
import { httpMonitor } from 'zupdev/plugins/http-monitor';

const agent = await createAgent({
  name: 'infra-monitor',
  mode: 'continuous',
  loopInterval: 15000,
  api: {
    port: 3000,
    auth: {
      apiKeys: [{ key: process.env.API_KEY!, name: 'admin' }],
    },
  },
  plugins: [
    httpMonitor({
      checkInterval: 30000,
      maxHistorySize: 100,
      endpoints: [
        {
          id: 'api',
          name: 'API Gateway',
          url: 'https://api.example.com/health',
          timeout: 5000,
          failureThreshold: 3,
          cooldownPeriod: 300000,
          restartStrategy: {
            type: 'command',
            command: ['docker', 'compose', 'restart', 'api'],
            cwd: '/opt/services',
          },
        },
        {
          id: 'db',
          name: 'Database Proxy',
          url: 'https://db-proxy.example.com/health',
          critical: true,
          failureThreshold: 5,
          cooldownPeriod: 600000,
          restartStrategy: {
            type: 'http',
            url: 'https://orchestrator.internal/restart/db-proxy',
            method: 'POST',
            headers: { 'Authorization': 'Bearer internal-token' },
          },
        },
        {
          id: 'cache',
          name: 'Cache Layer',
          url: 'http://cache.internal:6379/ping',
          expectedStatus: 200,
          // No restart strategy -- monitor only
        },
      ],
    }),
  ],
});

const server = agent.startApi({ port: 3000 });
await agent.start();
```

What this does:

- The API Gateway is checked every 30 seconds. After 3 consecutive failures, a Docker Compose restart is attempted. 5-minute cooldown between restarts.
- The Database Proxy is marked critical. After 5 failures, a restart is requested but requires human approval (because `critical: true`). 10-minute cooldown.
- The Cache Layer is monitored only -- no restart strategy is configured, so failures are observed and reported but never acted on.
