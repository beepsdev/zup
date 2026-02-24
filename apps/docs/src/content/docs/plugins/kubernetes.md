---
title: Kubernetes
description: Monitor Kubernetes cluster health and manage workloads with automated restart, scale, and log retrieval actions.
---

The `kubernetes` plugin monitors Kubernetes clusters by querying pod, deployment, node, and event state via kubectl. It detects unhealthy pods (CrashLoopBackOff, OOMKilled, ImagePullBackOff), degraded deployments, and not-ready nodes. It provides actions for restarting deployments, scaling replicas, deleting pods, and retrieving logs.

## Installation

```ts
import { createAgent } from '@beepsdev/zup';
import { kubernetes } from '@beepsdev/zup/plugins/kubernetes';

const agent = await createAgent({
  name: 'k8s-agent',
  plugins: [
    kubernetes({
      clusterName: 'production',
      namespaces: ['default', 'app'],
      pollIntervalMs: 60000,
      readOnly: false,
    }),
  ],
});
```

## Requirements

The plugin requires `kubectl` to be installed and available in the system PATH. It uses `Bun.spawn` to execute kubectl commands.

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `kubeconfigPath` | `string` | -- | Path to a kubeconfig file. Sets the `KUBECONFIG` environment variable for kubectl commands. If not set, kubectl uses its default resolution. |
| `context` | `string` | -- | kubectl context name. Passed as `--context` to all kubectl commands. |
| `namespaces` | `string[]` | `['default']` | Namespaces to monitor. Use `['*']` for all namespaces. |
| `clusterName` | `string` | `'default'` | Human-readable cluster name used in observations and API responses. |
| `pollIntervalMs` | `number` | `60000` | Polling interval in milliseconds for the cluster health observer. |
| `readOnly` | `boolean` | -- | When truthy (or undefined), mutating actions (restart, scale, delete) are disabled and return an error. Set to `false` to enable write actions. |
| `labelSelector` | `string` | -- | Kubernetes label selector applied to pod queries (e.g., `'app=myservice'`). |
| `maxPodsPerNamespace` | `number` | -- | Limit the number of pods tracked per namespace to avoid large payloads. |
| `maxEventsPerPoll` | `number` | `50` | Maximum warning events to fetch per poll cycle. |
| `excludeSystemNamespaces` | `boolean` | -- | When using `namespaces: ['*']`, exclude system namespaces (`kube-system`, `kube-public`, `kube-node-lease`, `istio-system`, `cert-manager`). Enabled by default unless explicitly set to `false`. |
| `timeoutMs` | `number` | `30000` | Timeout in milliseconds for individual kubectl commands. |

## OODA phase contributions

### Observe: `k8s-cluster-health`

The observer polls the cluster for pods, deployments, nodes, and warning events. It produces observations for:

- **Cluster health summary** (`kubernetes/cluster-health`): Overall counts of pods, deployments, nodes, and warning events. Severity is `warning` if any issues are detected, `info` otherwise.
- **Unhealthy pods** (`kubernetes/unhealthy-pod`): One observation per unhealthy pod. Detects CrashLoopBackOff, ImagePullBackOff, OOMKilled, Error states, and pods stuck in Pending for more than 5 minutes. Severity is `error` for CrashLoopBackOff and OOMKilled, `warning` for other issues.
- **Degraded deployments** (`kubernetes/degraded-deployment`): One observation per deployment with unavailable or not-ready replicas. Severity is `error` if zero replicas are ready, `warning` otherwise.
- **Not-ready nodes** (`kubernetes/node-not-ready`): One observation per node that is not in the Ready condition. Severity is `error`.
- **Connection errors** (`kubernetes/connection-error`): Emitted when kubectl commands fail (not installed, auth failed, cluster unreachable).

### Orient: `analyze-cluster-health`

Analyzes Kubernetes observations and produces findings about cluster state:

- Summarizes pod, deployment, and node counts
- Lists each unhealthy pod with its issue type and restart count
- Lists each degraded deployment with its ready/total replica count
- Lists not-ready nodes
- Sets `contributingFactor` based on the most significant issue (connection errors, node health, CrashLoopBackOff)
- Confidence is `0.9` normally, `0.5` when there are connection errors

### Act: `restart-deployment`

Restarts a Kubernetes deployment using `kubectl rollout restart`.

- **Risk:** medium
- **Autonomy:** approval-required (minConfidence 0.8)
- **Parameters:** `namespace` (string), `deployment` (string)
- Requires `readOnly: false`

### Act: `scale-deployment`

Scales a deployment to a specified number of replicas.

- **Risk:** medium
- **Autonomy:** approval-required (minConfidence 0.8)
- **Parameters:** `namespace` (string), `deployment` (string), `replicas` (number)
- Requires `readOnly: false`

### Act: `delete-pod`

Deletes a pod to force a restart (the controller will recreate it).

- **Risk:** medium
- **Autonomy:** approval-required (minConfidence 0.8)
- **Parameters:** `namespace` (string), `pod` (string), `gracePeriodSeconds` (number, optional)
- Requires `readOnly: false`
- Returns success if the pod is already deleted

### Act: `get-logs`

Retrieves logs from a pod. This is a read-only action and does not require `readOnly: false`.

- **Risk:** low
- **Autonomy:** auto (minConfidence 0.5)
- **Parameters:** `namespace` (string), `pod` (string), `container` (string, optional), `tailLines` (number, optional, 1-1000), `sinceSeconds` (number, optional)
- Truncates output to 50KB if logs are large

## REST API endpoints

All endpoints require authentication (Bearer token) by default.

### GET /k8s/status

Returns the current cluster state summary from the most recent poll.

**Response:**

```json
{
  "clusterName": "production",
  "lastPollTime": "2025-06-15T10:30:00.000Z",
  "summary": {
    "clusterName": "production",
    "namespaces": ["default", "app"],
    "pods": { "total": 42, "healthy": 40, "unhealthy": 2, "byPhase": { "Running": 40, "Pending": 2 } },
    "deployments": { "total": 12, "healthy": 11, "degraded": 1 },
    "nodes": { "total": 3, "ready": 3, "notReady": 0 },
    "recentWarningEvents": 5
  },
  "unhealthyPods": 2,
  "degradedDeployments": 1,
  "notReadyNodes": 0
}
```

### GET /k8s/namespaces

Lists all namespaces in the cluster.

**Response:**

```json
{
  "namespaces": [
    { "name": "default", "status": "Active" },
    { "name": "app", "status": "Active" }
  ]
}
```

### GET /k8s/namespaces/:namespace/pods

Lists pods in a specific namespace with their status, containers, and restart counts.

### GET /k8s/namespaces/:namespace/deployments

Lists deployments in a specific namespace with replica counts.

### GET /k8s/namespaces/:namespace/pods/:pod/logs

Retrieves logs for a specific pod.

**Query parameters:**
- `container` -- container name (optional)
- `tail` -- number of lines to return (default: 100)

### POST /k8s/namespaces/:namespace/deployments/:deployment/restart

Triggers a rollout restart for a deployment. Requires `readOnly: false`.

### POST /k8s/namespaces/:namespace/deployments/:deployment/scale

Scales a deployment. Requires `readOnly: false`.

**Request body:**

```json
{ "replicas": 3 }
```

### DELETE /k8s/namespaces/:namespace/pods/:pod

Deletes a pod. Requires `readOnly: false`.

## Full example

```ts
import { createAgent } from '@beepsdev/zup';
import { kubernetes } from '@beepsdev/zup/plugins/kubernetes';

const agent = await createAgent({
  name: 'k8s-monitor',
  mode: 'continuous',
  loopInterval: 30000,
  api: {
    port: 3000,
    auth: {
      apiKeys: [{ key: process.env.API_KEY!, name: 'admin' }],
    },
  },
  plugins: [
    kubernetes({
      clusterName: 'production',
      kubeconfigPath: '/home/deploy/.kube/config',
      context: 'prod-cluster',
      namespaces: ['default', 'app', 'workers'],
      pollIntervalMs: 60000,
      readOnly: false,
      excludeSystemNamespaces: true,
      maxPodsPerNamespace: 100,
      maxEventsPerPoll: 50,
      timeoutMs: 30000,
    }),
  ],
});

const server = agent.startApi({ port: 3000 });
await agent.start();
```

This monitors three namespaces every 60 seconds, detecting CrashLoopBackOff pods, degraded deployments, and not-ready nodes. Write actions (restart, scale, delete) are enabled but require approval since their autonomy mode is `approval-required`. The REST API on port 3000 allows on-demand queries and manual interventions. The `excludeSystemNamespaces` flag only has an effect when using `namespaces: ['*']`.
