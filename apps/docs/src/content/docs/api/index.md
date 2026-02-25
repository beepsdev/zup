---
title: REST API
description: Complete reference for the Zup REST API.
---

All endpoints are under `/api/v0`. Authentication uses Bearer tokens unless noted otherwise.

## Authentication

Pass an API key as a Bearer token:

```
Authorization: Bearer <your-api-key>
```

Configure keys when creating the agent or starting the API:

```ts
agent.startApi({
  port: 3000,
  apiKeys: ['my-secret-key'],
});
```

The `/health` endpoint does not require authentication.

---

## Loop

### POST /loop/trigger

Trigger a single OODA loop iteration.

**Request body** (optional):

```json
{ "context": "optional trigger context string" }
```

**Response:**

```json
{
  "success": true,
  "result": {
    "observations": 3,
    "situation": "All monitored endpoints are healthy",
    "decision": "no-op",
    "actionResults": 0,
    "duration": 412
  },
  "context": null
}
```

```bash
curl -X POST http://localhost:3000/api/v0/loop/trigger \
  -H "Authorization: Bearer my-secret-key"
```

### GET /loop/status

Get the current loop phase, iteration count, and latest situation.

**Response:**

```json
{
  "phase": "idle",
  "iteration": 5,
  "startTime": "2025-01-15T10:30:00.000Z",
  "currentSituation": "All monitored endpoints are healthy",
  "currentDecision": "no-op"
}
```

```bash
curl http://localhost:3000/api/v0/loop/status \
  -H "Authorization: Bearer my-secret-key"
```

---

## Observations

### GET /observations

Get observations from the most recent loop iteration.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `50` | Maximum observations to return. |
| `source` | `string` | -- | Filter by source (substring match). |

**Response:**

```json
{
  "observations": [
    {
      "source": "http-monitor/health-check",
      "timestamp": "2025-01-15T10:30:00.000Z",
      "type": "metric",
      "severity": "info",
      "data": {
        "endpointId": "api",
        "endpointName": "API",
        "url": "https://api.example.com/health",
        "success": true,
        "statusCode": 200,
        "responseTime": 52
      }
    }
  ],
  "total": 3,
  "filtered": 1
}
```

```bash
curl "http://localhost:3000/api/v0/observations?source=http-monitor&limit=10" \
  -H "Authorization: Bearer my-secret-key"
```

---

## Situation

### GET /situation

Get the current situation assessment.

**Response:**

```json
{
  "situation": {
    "summary": "1 endpoint(s) are unhealthy",
    "assessments": [...],
    "anomalies": [],
    "correlations": [],
    "priority": "high",
    "confidence": 0.9
  }
}
```

Returns `404` if no situation has been assessed yet.

```bash
curl http://localhost:3000/api/v0/situation \
  -H "Authorization: Bearer my-secret-key"
```

---

## Actions

### GET /actions

List all registered actions.

**Response:**

```json
{
  "actions": [
    {
      "id": "http-monitor:restartService",
      "name": "restart-service",
      "description": "Restart a service associated with a failed endpoint",
      "risk": "medium",
      "autonomy": { "mode": "auto", "minConfidence": 0.7 }
    }
  ]
}
```

```bash
curl http://localhost:3000/api/v0/actions \
  -H "Authorization: Bearer my-secret-key"
```

### POST /actions/:actionId

Execute an action directly.

**Request body:**

```json
{
  "params": { "endpointId": "api" },
  "rationale": "Manual restart requested",
  "requiresApproval": false
}
```

If the action's autonomy mode is `approval-required` or `human-only`, or if `requiresApproval` is `true`, the action is queued instead of executed immediately. The response returns `202` with an `approvalId`.

**Response (executed):**

```json
{
  "success": true,
  "result": {
    "action": "restart-service",
    "success": true,
    "output": "Successfully restarted service for API",
    "duration": 2340
  }
}
```

**Response (queued, 202):**

```json
{
  "success": false,
  "queued": true,
  "approvalId": "abc-123"
}
```

```bash
curl -X POST http://localhost:3000/api/v0/actions/http-monitor:restartService \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"params": {"endpointId": "api"}}'
```

---

## Approvals

### GET /approvals

List pending approvals and optionally their history.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `includeHistory` | `string` | `'true'` | Set to `'false'` to exclude resolved approvals. |

**Response:**

```json
{
  "pending": [
    {
      "id": "abc-123",
      "actionId": "http-monitor:restartService",
      "actionName": "restart-service",
      "params": { "endpointId": "api" },
      "risk": "medium",
      "confidence": 0.85,
      "situationSummary": "1 endpoint(s) are unhealthy",
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ],
  "history": []
}
```

```bash
curl http://localhost:3000/api/v0/approvals \
  -H "Authorization: Bearer my-secret-key"
```

### POST /approvals/:id/approve

Approve a pending action and execute it.

**Request body** (optional):

```json
{
  "note": "Approved by on-call engineer",
  "actedBy": "alice@example.com"
}
```

**Response:**

```json
{
  "success": true,
  "approval": { "id": "abc-123", "status": "approved", "...": "..." },
  "result": {
    "action": "restart-service",
    "success": true,
    "duration": 2340
  }
}
```

```bash
curl -X POST http://localhost:3000/api/v0/approvals/abc-123/approve \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"actedBy": "alice@example.com"}'
```

### POST /approvals/:id/deny

Deny a pending action.

**Request body** (optional):

```json
{
  "note": "Not safe to restart during peak traffic",
  "actedBy": "alice@example.com"
}
```

**Response:**

```json
{
  "success": true,
  "approval": { "id": "abc-123", "status": "denied", "...": "..." }
}
```

```bash
curl -X POST http://localhost:3000/api/v0/approvals/abc-123/deny \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"note": "Not safe during peak traffic"}'
```

---

## State

### GET /state

Get a summary of the agent's current state.

**Response:**

```json
{
  "agent": {
    "id": "sre-agent-prod",
    "name": "Production SRE",
    "model": "claude-sonnet-4-6"
  },
  "capabilities": {
    "observers": ["http-monitor:healthCheck"],
    "orienters": ["http-monitor:analyzeFailures"],
    "decisionStrategies": ["http-monitor:restartUnhealthyEndpoint"],
    "actions": ["http-monitor:restartService"]
  },
  "history": {
    "totalLoops": 42,
    "lastLoop": { "...": "..." }
  }
}
```

```bash
curl http://localhost:3000/api/v0/state \
  -H "Authorization: Bearer my-secret-key"
```

---

## Health

### GET /health

Health check endpoint. No authentication required.

**Response:**

```json
{ "status": "ok", "timestamp": "2025-01-15T10:30:00.000Z" }
```

```bash
curl http://localhost:3000/api/v0/health
```

---

## Runs

Runs let external systems submit work items that flow through the OODA loop. A run is created, picked up during the next observe phase, investigated, and completed with results.

### POST /runs

Create a new run.

**Request body:**

```json
{
  "title": "Investigate high API latency",
  "description": "P95 latency spiked to 2s in the last 10 minutes",
  "priority": "high",
  "context": { "service": "api", "region": "us-east-1" },
  "source": "pagerduty",
  "callbackUrl": "https://hooks.example.com/zup-results"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | Yes | Short title for the run. |
| `description` | `string` | Yes | Detailed description of what to investigate. |
| `priority` | `'low' \| 'medium' \| 'high' \| 'critical'` | No | Defaults to `'medium'`. |
| `context` | `object` | No | Arbitrary context data. |
| `source` | `string` | No | Where the run came from (e.g., `'pagerduty'`). |
| `callbackUrl` | `string` | No | URL to POST results to when the run completes. |

In `manual` and `event-driven` modes, creating a run automatically triggers an OODA loop.

**Response (201):**

```json
{
  "id": "run-abc-123",
  "status": "pending",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

```bash
curl -X POST http://localhost:3000/api/v0/runs \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Check API latency",
    "description": "Users report slow responses"
  }'
```

### GET /runs

List runs.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `status` | `string` | Filter by status: `pending`, `investigating`, `completed`, `failed`, `cancelled`. |
| `limit` | `number` | Maximum runs to return. |

**Response:**

```json
{
  "runs": [
    {
      "id": "run-abc-123",
      "title": "Check API latency",
      "status": "completed",
      "priority": "medium",
      "createdAt": "2025-01-15T10:30:00.000Z",
      "completedAt": "2025-01-15T10:30:05.000Z",
      "result": {
        "summary": "API latency is within normal bounds",
        "findings": ["P95 latency at 120ms"],
        "actionsPerformed": [],
        "loopIterations": 1,
        "duration": 5000
      }
    }
  ],
  "total": 1
}
```

```bash
curl "http://localhost:3000/api/v0/runs?status=completed&limit=10" \
  -H "Authorization: Bearer my-secret-key"
```

### GET /runs/:id

Get details for a specific run.

**Response:**

```json
{
  "id": "run-abc-123",
  "title": "Check API latency",
  "description": "Users report slow responses",
  "status": "completed",
  "priority": "medium",
  "context": {},
  "source": "api",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "updatedAt": "2025-01-15T10:30:05.000Z",
  "completedAt": "2025-01-15T10:30:05.000Z",
  "result": { "...": "..." }
}
```

```bash
curl http://localhost:3000/api/v0/runs/run-abc-123 \
  -H "Authorization: Bearer my-secret-key"
```

### POST /runs/:id/cancel

Cancel a pending or investigating run.

**Response:**

```json
{
  "id": "run-abc-123",
  "status": "cancelled",
  "updatedAt": "2025-01-15T10:31:00.000Z"
}
```

Returns `400` if the run is already completed, failed, or cancelled.

```bash
curl -X POST http://localhost:3000/api/v0/runs/run-abc-123/cancel \
  -H "Authorization: Bearer my-secret-key"
```
