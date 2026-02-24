# HTTP Monitor Plugin

Production-ready plugin for monitoring HTTP endpoints and automatically restarting services when they become unhealthy.

## Features

- **Configurable health checks** with expected status codes and timeouts
- **Failure threshold** to avoid false positives (default: 3 consecutive failures)
- **Cooldown period** to prevent restart loops (default: 5 minutes)
- **Multiple restart strategies**: Shell command, HTTP endpoint, or custom function
- **Pattern analysis** for detecting cascading vs. isolated failures
- **REST API** for manual endpoint checks and restarts
- **Health check history** tracking for debugging

## Installation

```typescript
import { createAgent } from '@beepsdev/zup';
import { httpMonitor } from '@beepsdev/zup/plugins/http-monitor';

const agent = await createAgent({
  plugins: [
    httpMonitor({
      endpoints: [/* ... */],
      checkInterval: 30000, // Optional: check every 30s
    }),
  ],
});
```

## Configuration

### Basic Example

```typescript
httpMonitor({
  endpoints: [
    {
      id: 'api-service',
      name: 'API Service',
      url: 'http://localhost:3000/health',
      restartStrategy: {
        type: 'command',
        command: 'systemctl restart api-service',
      },
    },
  ],
})
```

### Full Configuration

```typescript
httpMonitor({
  endpoints: [
    {
      // Required
      id: 'my-service',              // Unique identifier
      name: 'My Service',            // Human-readable name
      url: 'http://localhost:3000/health',

      // Optional
      method: 'GET',                 // HTTP method (default: GET)
      expectedStatus: 200,           // Expected status code (default: 200)
      timeout: 5000,                 // Request timeout in ms (default: 5000)
      headers: {                     // Custom headers
        'X-Health-Check': 'true',
      },

      // Restart behavior
      restartStrategy: {             // How to restart (required for auto-restart)
        type: 'command',             // 'command' | 'http' | 'function'
        command: 'systemctl restart my-service',
      },
      failureThreshold: 3,           // Consecutive failures before restart (default: 3)
      cooldownPeriod: 300000,        // Min time between restarts in ms (default: 300000 = 5min)
      critical: false,               // If true, requires approval for restart (default: false)
    },
  ],

  // Global options
  checkInterval: 30000,              // How often to check in ms (default: 30000 = 30s)
  maxHistorySize: 50,                // Max health check results to keep (default: 50)
})
```

## Restart Strategies

### Shell Command

Execute a shell command to restart the service:

```typescript
restartStrategy: {
  type: 'command',
  command: 'systemctl restart my-service',
  cwd: '/opt/services',  // Optional working directory
}
```

### HTTP Request

Make an HTTP request to restart the service:

```typescript
restartStrategy: {
  type: 'http',
  url: 'http://localhost:9000/restart',
  method: 'POST',  // Optional (default: POST)
  headers: {       // Optional
    'Authorization': 'Bearer token',
  },
  body: {          // Optional
    service: 'my-service',
  },
}
```

### Custom Function

Execute a custom async function:

```typescript
restartStrategy: {
  type: 'function',
  handler: async () => {
    // Your custom restart logic
    await myDockerClient.restartContainer('my-service');
  },
}
```

## REST API Endpoints

The plugin exposes these endpoints under `/api/v0/http-monitor/`:

### List Endpoints

```bash
GET /api/v0/http-monitor/endpoints
Authorization: Bearer <api-key>
```

Returns all monitored endpoints with their current state.

**Response:**
```json
{
  "endpoints": [
    {
      "id": "api-service",
      "name": "API Service",
      "url": "http://localhost:3000/health",
      "consecutiveFailures": 0,
      "lastRestartTime": null,
      "recentChecks": [...]
    }
  ]
}
```

### Manual Health Check

```bash
POST /api/v0/http-monitor/endpoints/:endpointId/check
Authorization: Bearer <api-key>
```

Manually trigger a health check for a specific endpoint.

**Response:**
```json
{
  "endpointId": "api-service",
  "url": "http://localhost:3000/health",
  "success": true,
  "statusCode": 200,
  "responseTime": 45,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Manual Restart

```bash
POST /api/v0/http-monitor/endpoints/:endpointId/restart
Authorization: Bearer <api-key>
```

Manually trigger a service restart (bypasses failure threshold and cooldown).

**Response:**
```json
{
  "action": "restart-service",
  "success": true,
  "output": "Successfully restarted service for API Service",
  "duration": 1234
}
```

## How It Works

### OODA Loop Integration

The plugin integrates into Zup's OODA loop:

1. **OBSERVE**: Health check observer runs periodically
   - Checks each endpoint with HTTP request
   - Records success/failure, status code, response time
   - Updates consecutive failure count

2. **ORIENT**: Failure analysis orienter analyzes patterns
   - Identifies unhealthy endpoints
   - Detects cascading vs. isolated failures
   - Provides findings and root cause analysis

3. **DECIDE**: Restart decision strategy determines action
   - Checks if endpoint exceeds failure threshold
   - Verifies cooldown period has elapsed
   - Proposes restart if criteria met

4. **ACT**: Restart action executes the strategy
   - Executes configured restart strategy
   - Resets failure count after successful restart
   - Records restart time for cooldown tracking

### Failure Handling

**Consecutive Failures:**
- Each failed health check increments the counter
- Successful health check resets counter to 0
- Only acts when threshold is reached (default: 3 failures)

**Cooldown Period:**
- After restart, endpoint enters cooldown
- No auto-restarts during cooldown (default: 5 minutes)
- Prevents restart loops for persistently failing services

**Pattern Detection:**
- **Isolated failure**: <50% of endpoints failing
- **Cascading failure**: ≥50% of endpoints failing simultaneously
- Helps identify infrastructure vs. service-specific issues

## Example Use Cases

### Monitor Multiple Microservices

```typescript
httpMonitor({
  endpoints: [
    {
      id: 'api',
      name: 'API Gateway',
      url: 'http://api:3000/health',
      critical: true,  // Requires approval before restart
      restartStrategy: { type: 'command', command: 'kubectl rollout restart deployment/api' },
    },
    {
      id: 'worker',
      name: 'Background Worker',
      url: 'http://worker:3001/health',
      restartStrategy: { type: 'command', command: 'kubectl rollout restart deployment/worker' },
    },
  ],
})
```

### Monitor with Custom Headers

```typescript
httpMonitor({
  endpoints: [
    {
      id: 'auth-service',
      name: 'Auth Service',
      url: 'https://auth.example.com/health',
      headers: {
        'X-Health-Check-Token': process.env.HEALTH_CHECK_TOKEN,
      },
      restartStrategy: {
        type: 'http',
        url: 'https://auth.example.com/restart',
        headers: {
          'Authorization': `Bearer ${process.env.RESTART_TOKEN}`,
        },
      },
    },
  ],
})
```

### Development with Short Intervals

```typescript
httpMonitor({
  endpoints: [
    {
      id: 'dev-api',
      name: 'Development API',
      url: 'http://localhost:3000/health',
      failureThreshold: 2,     // Faster response in dev
      cooldownPeriod: 10000,   // 10 seconds
      restartStrategy: {
        type: 'command',
        command: 'npm run dev',
        cwd: '/path/to/project',
      },
    },
  ],
  checkInterval: 5000,  // Check every 5 seconds
})
```

## Testing

Run the plugin tests:

```bash
bun test packages/plugins/http-monitor/index.test.ts
```

Run the interactive demo:

```bash
bun run http-monitor-demo.ts
```

The demo will:
1. Start a test HTTP server
2. Monitor the endpoint
3. Simulate the service becoming unhealthy after 10 seconds
4. Automatically restart after 3 failures (15 seconds)
5. Show you how to use the REST API

## Best Practices

1. **Set appropriate thresholds**: Don't set `failureThreshold: 1` in production (too aggressive)

2. **Use cooldown periods**: Prevent restart loops by allowing time for service to stabilize

3. **Monitor restart counts**: If a service restarts frequently, investigate the root cause

4. **Mark critical services**: Use `critical: true` for services that require approval before restart

5. **Test restart strategies**: Verify your restart commands work before deploying

6. **Monitor cascading failures**: If multiple services fail simultaneously, investigate infrastructure issues

7. **Use appropriate check intervals**: Balance between fast detection and avoiding excessive requests

## Troubleshooting

### Service keeps restarting in a loop

- Check if `cooldownPeriod` is too short
- Verify restart strategy actually fixes the issue
- Service may need more time to start (increase timeout)

### False positives (healthy service marked as unhealthy)

- Increase `failureThreshold` (require more consecutive failures)
- Increase `timeout` (slow responses timing out)
- Check `expectedStatus` matches what service returns

### Restarts not happening

- Verify `restartStrategy` is configured
- Check logs for cooldown warnings
- Ensure `failureThreshold` is being reached
- Test restart strategy manually

### Permission errors on restart

- For shell commands: ensure process has appropriate permissions
- For systemctl: may need sudo privileges
- For Kubernetes: ensure RBAC permissions are configured

## License

MIT
