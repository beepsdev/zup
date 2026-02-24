# Kubernetes Plugin for Zup

Monitor Kubernetes cluster health and perform operations like restarting deployments, scaling, and fetching logs.

## Prerequisites

- `kubectl` must be installed and available in PATH
- Valid kubeconfig with access to the target cluster

## Installation

```typescript
import { kubernetes } from '@beepsdev/zup/plugins/kubernetes';

const agent = createAgent({
  plugins: [
    kubernetes({
      clusterName: 'prod-cluster',
      namespaces: ['default', 'production'],
      readOnly: false, // Enable write operations
    }),
  ],
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kubeconfigPath` | `string` | `~/.kube/config` | Path to kubeconfig file |
| `context` | `string` | current-context | Kubernetes context to use |
| `namespaces` | `string[]` | `['default']` | Namespaces to monitor. Use `['*']` for all |
| `clusterName` | `string` | `'default'` | Friendly name for observations |
| `pollIntervalMs` | `number` | `60000` | How often to poll cluster health |
| `readOnly` | `boolean` | `true` | When true, disables write operations |
| `labelSelector` | `string` | - | Filter pods by label selector |
| `maxPodsPerNamespace` | `number` | - | Cap pods fetched per namespace |
| `maxEventsPerPoll` | `number` | `50` | Max warning events to track |
| `excludeSystemNamespaces` | `boolean` | `true` | Exclude kube-system, etc. when using `['*']` |
| `timeoutMs` | `number` | `30000` | Timeout for kubectl commands |

## Observer

### clusterHealth

Polls the cluster and emits observations for:

- **Unhealthy pods**: CrashLoopBackOff, ImagePullBackOff, OOMKilled, Error, long-Pending
- **Degraded deployments**: Unavailable replicas, not ready
- **Not-ready nodes**: Nodes with Ready condition False
- **Warning events**: Recent warning events from the cluster

Observation sources:
- `kubernetes/cluster-health` - Summary metrics
- `kubernetes/unhealthy-pod` - Individual unhealthy pod details
- `kubernetes/degraded-deployment` - Individual degraded deployment details
- `kubernetes/node-not-ready` - Individual not-ready node details
- `kubernetes/connection-error` - Cluster connectivity issues

## Orienter

### analyzeClusterHealth

Analyzes Kubernetes observations and produces findings like:

- "Cluster 'prod-cluster': 50 pods, 10 deployments, 3 nodes"
- "2 unhealthy pod(s) detected"
- "Pod default/api-server: CrashLoopBackOff (5 restarts)"
- "Deployment default/web: 1/3 replicas ready"

## Actions

All write actions require `readOnly: false` in configuration.

### restart-deployment

Restart a deployment using `kubectl rollout restart`.

```typescript
await agent.executeAction('restart-deployment', {
  namespace: 'default',
  deployment: 'api-server',
});
```

### scale-deployment

Scale a deployment to a specified number of replicas.

```typescript
await agent.executeAction('scale-deployment', {
  namespace: 'default',
  deployment: 'api-server',
  replicas: 5,
});
```

### delete-pod

Delete a pod to force a restart (controller will recreate it).

```typescript
await agent.executeAction('delete-pod', {
  namespace: 'default',
  pod: 'api-server-abc123',
  gracePeriodSeconds: 30, // optional
});
```

### get-logs

Fetch logs from a pod. Always available regardless of readOnly setting.

```typescript
await agent.executeAction('get-logs', {
  namespace: 'default',
  pod: 'api-server-abc123',
  container: 'app', // optional
  tailLines: 100, // optional, default 100
  sinceSeconds: 3600, // optional
});
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/k8s/status` | Get cluster status summary |
| GET | `/k8s/namespaces` | List all namespaces |
| GET | `/k8s/namespaces/:ns/pods` | List pods in namespace |
| GET | `/k8s/namespaces/:ns/deployments` | List deployments in namespace |
| GET | `/k8s/namespaces/:ns/pods/:pod/logs` | Get pod logs |
| POST | `/k8s/namespaces/:ns/deployments/:dep/restart` | Restart deployment |
| POST | `/k8s/namespaces/:ns/deployments/:dep/scale` | Scale deployment |
| DELETE | `/k8s/namespaces/:ns/pods/:pod` | Delete pod |

### Example: Get pod logs

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/k8s/namespaces/default/pods/api-server-abc123/logs?tail=50&container=app"
```

### Example: Scale deployment

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"replicas": 5}' \
  "http://localhost:3000/k8s/namespaces/default/deployments/api-server/scale"
```

## Security Considerations

- **Read-only by default**: Set `readOnly: false` explicitly to enable write operations
- **Namespace scoping**: Limit `namespaces` to only what's needed
- **No credential logging**: Plugin never logs kubeconfig contents or tokens
- **Command injection prevention**: All user inputs are passed as args, never interpolated

## Error Handling

The plugin distinguishes between error types:

- `not-installed`: kubectl is not available
- `auth-failed`: Authentication/authorization failed
- `unreachable`: Kubernetes API server is unreachable
- `not-found`: Resource not found (treated as success for delete operations)
- `timeout`: kubectl command timed out

## Example: Full Configuration

```typescript
kubernetes({
  kubeconfigPath: '/home/user/.kube/prod-config',
  context: 'prod-cluster',
  clusterName: 'Production',
  namespaces: ['default', 'api', 'web'],
  pollIntervalMs: 30000,
  readOnly: false,
  labelSelector: 'app.kubernetes.io/managed-by=helm',
  maxPodsPerNamespace: 100,
  maxEventsPerPoll: 100,
  excludeSystemNamespaces: true,
  timeoutMs: 60000,
});
```
