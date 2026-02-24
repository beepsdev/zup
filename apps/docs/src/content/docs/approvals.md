---
title: Approval Queue
description: How Zup's approval system gates action execution, when approvals are required, and how to approve or deny pending actions via the REST API.
---

Zup includes a built-in approval queue that gates action execution. When an action requires human review, it is queued instead of executed. Pending approvals can be listed, approved, or denied through the REST API.

## When approvals are required

During the Act phase, the framework checks whether the chosen action needs approval before executing it. An action is queued for approval if **any** of these conditions are true:

| Condition | How it is set |
|---|---|
| `decision.requiresApproval === true` | A decision strategy sets this flag, or an `onDecide` hook adds it. |
| `action.autonomy.mode === 'approval-required'` | The action definition requires approval for every invocation. |
| `action.autonomy.mode === 'human-only'` | The action can never run autonomously. |
| `decision.confidence < action.autonomy.minConfidence` | The decision's confidence is below the action's minimum threshold. |

If none of these conditions are met, the action executes immediately.

## Action autonomy modes

Each action can declare an `autonomy` field that controls when it runs automatically:

```ts
createAction({
  name: 'restart-service',
  description: 'Restart a service',
  risk: 'medium',
  autonomy: {
    mode: 'auto',
    minConfidence: 0.7,
  },
  execute: async (params, ctx) => { ... },
});
```

The three modes:

### `auto`

The action runs automatically when selected by a decision strategy. If `minConfidence` is set, the action is only auto-executed when the decision's confidence meets or exceeds that threshold. Below the threshold, the action is queued for approval.

```ts
autonomy: { mode: 'auto', minConfidence: 0.8 }
// Auto-executes when decision.confidence >= 0.8
// Queued for approval when decision.confidence < 0.8
```

### `approval-required`

The action always requires human approval, regardless of confidence.

```ts
autonomy: { mode: 'approval-required' }
// Always queued -- never auto-executes
```

### `human-only`

The action is reserved for human execution. Like `approval-required`, it is always queued, but the semantic intent is that this action should only ever be performed by a person through the approval flow.

```ts
autonomy: { mode: 'human-only' }
// Always queued -- intended for human operators only
```

Actions without an `autonomy` field default to auto-execution with no confidence threshold.

## Approval lifecycle

```
Action selected by Decide phase
         |
         v
  Approval check
    /         \
 passes       fails
   |            |
   v            v
 Execute    enqueueApproval()
   |            |
   v            v
ActionResult  Approval item (status: 'pending')
                |
          +-----------+------------+
          |           |            |
          v           v            v
       Approve      Deny       Expires
          |           |            |
          v           v            v
    Execute action  Move to     Move to
    Move to         history     history
    history         (denied)    (expired)
    (approved)
```

### Pending state

When an action is queued, `enqueueApproval()` creates an `ApprovalItem` in the `pending` list:

```ts
type ApprovalItem = {
  id: string;              // UUID
  status: 'pending';
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
  expiresAt?: string;      // ISO timestamp (if TTL is configured)
  decision: Decision;      // The full decision that produced this action
  actionId: string;        // Action to execute
  actionName?: string;     // Human-readable action name
  params: Record<string, unknown>;  // Action parameters
  risk?: RiskLevel;        // Action risk level
  confidence?: number;     // Decision confidence
  autonomy?: { mode: string; minConfidence?: number };
  loopIteration: number;   // Which loop iteration created this
  situationSummary?: string;  // Context from the Orient phase
};
```

### Approved

When an approval is approved via the API, the framework:

1. Executes the action with the stored parameters.
2. Moves the item from `pending` to `history` with `status: 'approved'`.
3. Attaches the `ActionResult` to the history entry.

### Denied

When an approval is denied via the API, the item is moved from `pending` to `history` with `status: 'denied'`. The action is not executed.

### Expired

If `autoExpire` is enabled (the default), pending approvals are purged at the start of every loop iteration. Items past their `expiresAt` timestamp (or past `createdAt + ttlMs` if no explicit `expiresAt` was set) are moved to `history` with `status: 'expired'`.

## Configuration

Configure the approval queue in agent options:

```ts
const agent = await createAgent({
  approvals: {
    autoExpire: true,    // Default: true
    ttlMs: 3600000,      // Default: 3600000 (1 hour)
  },
  plugins: [...],
});
```

| Field | Type | Default | Description |
|---|---|---|---|
| `approvals.autoExpire` | `boolean` | `true` | Automatically expire stale pending approvals. |
| `approvals.ttlMs` | `number` | `3600000` | Time-to-live for pending approvals in milliseconds. Approvals not acted on within this window are expired. |

Setting `autoExpire: false` disables automatic expiry. Pending approvals will remain in the queue indefinitely until manually approved or denied.

## REST API

### List approvals

```
GET /approvals
GET /approvals?includeHistory=false
```

Returns the approval queue. By default, both pending and resolved items are returned. Set `includeHistory=false` to only get pending items.

**Response:**

```json
{
  "pending": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "pending",
      "createdAt": "2025-06-15T10:00:00.000Z",
      "updatedAt": "2025-06-15T10:00:00.000Z",
      "expiresAt": "2025-06-15T11:00:00.000Z",
      "decision": {
        "action": "http-monitor:restartService",
        "params": { "endpointId": "api" },
        "rationale": "Endpoint API Server has failed 5 consecutive times",
        "confidence": 0.85,
        "risk": "medium",
        "requiresApproval": true
      },
      "actionId": "http-monitor:restartService",
      "actionName": "restart-service",
      "params": { "endpointId": "api" },
      "risk": "medium",
      "confidence": 0.85,
      "loopIteration": 12,
      "situationSummary": "1 endpoint(s) are unhealthy | API Server: 5 consecutive failures"
    }
  ],
  "history": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "status": "approved",
      "createdAt": "2025-06-15T09:30:00.000Z",
      "updatedAt": "2025-06-15T09:31:00.000Z",
      "result": {
        "action": "restart-service",
        "success": true,
        "duration": 3200
      },
      "actedBy": "operator@example.com",
      "note": "Approved after verifying no active deployments"
    }
  ]
}
```

Before returning the queue, this endpoint purges expired approvals (if `autoExpire` is enabled).

### Approve an action

```
POST /approvals/:approvalId/approve
```

Approves a pending item and immediately executes the associated action. The action result is stored on the approval history entry.

**Request body (optional):**

```json
{
  "note": "Approved after verifying no active deployments",
  "actedBy": "operator@example.com"
}
```

**Response:**

```json
{
  "success": true,
  "approval": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "approved",
    "updatedAt": "2025-06-15T10:05:00.000Z",
    "result": {
      "action": "restart-service",
      "success": true,
      "output": "Successfully restarted service for API Server",
      "duration": 3200
    },
    "note": "Approved after verifying no active deployments",
    "actedBy": "operator@example.com"
  },
  "result": {
    "action": "restart-service",
    "success": true,
    "output": "Successfully restarted service for API Server",
    "duration": 3200,
    "sideEffects": ["Service restart triggered for https://api.example.com/health"]
  }
}
```

Returns `404` if the approval is not found in the pending queue (it may have already been resolved or expired).

### Deny an action

```
POST /approvals/:approvalId/deny
```

Denies a pending item. The action is not executed. The item is moved to history.

**Request body (optional):**

```json
{
  "note": "Denied -- deployment in progress, will retry after",
  "actedBy": "operator@example.com"
}
```

**Response:**

```json
{
  "success": true,
  "approval": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "denied",
    "updatedAt": "2025-06-15T10:05:00.000Z",
    "note": "Denied -- deployment in progress, will retry after",
    "actedBy": "operator@example.com"
  }
}
```

### Direct action execution with approval

When executing an action directly via `POST /actions/:actionId`, the approval system is also checked. If the action's autonomy mode requires approval, the request returns `202 Accepted` with a queued approval:

```
POST /actions/http-monitor:restartService
Content-Type: application/json

{
  "params": { "endpointId": "api" },
  "rationale": "Manual restart request"
}
```

**Response (queued):**

```json
{
  "success": false,
  "queued": true,
  "approvalId": "770e8400-e29b-41d4-a716-446655440002"
}
```

You can also force the approval gate on any action by including `"requiresApproval": true` in the request body.

## Approval queue internals

The approval queue is stored in the agent's `StateStore` under the key `approvals`. It consists of two arrays:

```ts
type ApprovalQueue = {
  pending: ApprovalItem[];
  history: ApprovalItem[];
};
```

### State store functions

These utility functions are exported from `zupdev` for advanced use cases:

| Function | Description |
|---|---|
| `getApprovalQueue(state)` | Returns the current queue. Creates an empty queue if none exists. |
| `enqueueApproval(state, input, ttlMs?)` | Adds a new pending approval. Returns the created `ApprovalItem`. |
| `resolveApproval(state, id, status, updates?)` | Moves a pending item to history with the given status. Returns the resolved item or `undefined` if not found. |
| `purgeExpiredApprovals(state, ttlMs, nowMs?)` | Removes expired items from pending and moves them to history. Returns the expired items. |

### Expiry mechanics

The `purgeExpiredApprovals` function checks each pending item:

1. If the item has an `expiresAt` field, that timestamp is used directly.
2. Otherwise, expiry is calculated as `createdAt + ttlMs`.
3. Items where the expiry time has passed are moved to history with `status: 'expired'`.

Purging happens in two places:

- At the start of every loop iteration (before the Observe phase).
- Before every approval-related API request (`GET /approvals`, `POST /approvals/:id/approve`, `POST /approvals/:id/deny`).

## Forcing approval via plugins

Plugins can force actions to require approval through the `onDecide` hook:

```ts
definePlugin({
  id: 'approval-policy',
  onDecide: async (decision, ctx) => {
    // Require approval for all high-risk actions
    if (decision.risk === 'high' || decision.risk === 'critical') {
      return { decision: { requiresApproval: true } };
    }

    // Require approval outside business hours
    const hour = new Date().getUTCHours();
    if (hour < 8 || hour > 18) {
      return { decision: { requiresApproval: true } };
    }
  },
});
```

This pattern lets you implement organization-wide approval policies without modifying individual action definitions.

## Queued action results

When an action is queued for approval (rather than executed), the Act phase returns an `ActionResult` that signals the queuing:

```ts
{
  action: 'http-monitor:restartService',
  success: false,
  error: 'Approval required',
  duration: 0,
  metrics: {
    approvalId: '550e8400-e29b-41d4-a716-446655440000',
  },
}
```

The `success: false` indicates the action did not execute. The `metrics.approvalId` lets you track the approval item. Subsequent loop iterations will continue to assess the situation, and may create new approval requests if the underlying issue persists.
