import { createAgent } from '../packages/core/src/index';
import { httpMonitor } from '../packages/plugins/http-monitor/index';

let serviceHealthy = true;
let restartCount = 0;

async function main() {
  console.log('=== HTTP Monitor Plugin Demo ===\n');

  const testServer = Bun.serve({
    port: 8080,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/health') {
        if (serviceHealthy) {
          return new Response('OK', { status: 200 });
        } else {
          return new Response('Service Unavailable', { status: 503 });
        }
      }

      if (url.pathname === '/restart') {
        console.log(`\nService restart triggered (restart #${++restartCount})`);
        serviceHealthy = true;
        return new Response('Service restarted', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`Test server started on http://localhost:8080`);
  console.log('   - http://localhost:8080/health (monitored endpoint)');
  console.log('   - http://localhost:8080/restart (restart endpoint)\n');

  const agent = await createAgent({
    name: 'HTTP Monitor Demo',
    plugins: [
      httpMonitor({
        endpoints: [
          {
            id: 'test-service',
            name: 'Test Service',
            url: 'http://localhost:8080/health',
            method: 'GET',
            expectedStatus: 200,
            timeout: 5000,
            failureThreshold: 3, // Restart after 3 consecutive failures
            cooldownPeriod: 10000, // 10 second cooldown between restarts
            critical: false,
            restartStrategy: {
              type: 'http',
              url: 'http://localhost:8080/restart',
              method: 'POST',
            },
          },
        ],
        checkInterval: 5000, // Check every 5 seconds
      }),
    ],
  });

  const apiServer = agent.startApi({
    port: 3000,
    hostname: 'localhost',
    apiKeys: ['demo-key-123'],
  });

  console.log('\nZup agent started with HTTP monitoring!');
  console.log('\nMonitoring:');
  console.log('  • Test Service: http://localhost:8080/health');
  console.log('  • Check interval: 5 seconds');
  console.log('  • Failure threshold: 3 consecutive failures');
  console.log('  • Auto-restart: Enabled\n');

  console.log('API Endpoints:');
  console.log('  GET  http://localhost:3000/api/v0/http-monitor/endpoints');
  console.log('  POST http://localhost:3000/api/v0/http-monitor/endpoints/test-service/check');
  console.log('  POST http://localhost:3000/api/v0/http-monitor/endpoints/test-service/restart');
  console.log('  (Auth: Bearer demo-key-123)\n');

  console.log('Demo Scenario:');
  console.log('  1. Service starts healthy');
  console.log('  2. In 10 seconds, service will become unhealthy');
  console.log('  3. After 3 failures (15 seconds), service will auto-restart');
  console.log('  4. Service becomes healthy again\n');

  console.log('Try these commands:');
  console.log('  # Check monitored endpoints');
  console.log('  curl http://localhost:3000/api/v0/http-monitor/endpoints \\');
  console.log('    -H "Authorization: Bearer demo-key-123"\n');
  console.log('  # Manually check endpoint');
  console.log('  curl -X POST http://localhost:3000/api/v0/http-monitor/endpoints/test-service/check \\');
  console.log('    -H "Authorization: Bearer demo-key-123"\n');
  console.log('  # Manually restart service');
  console.log('  curl -X POST http://localhost:3000/api/v0/http-monitor/endpoints/test-service/restart \\');
  console.log('    -H "Authorization: Bearer demo-key-123"\n');

  setTimeout(() => {
    console.log('\nMaking service unhealthy...');
    serviceHealthy = false;
  }, 10000);

  let loopCount = 0;
  const runLoop = async () => {
    loopCount++;
    console.log(`\n--- OODA Loop #${loopCount} ---`);

    try {
      const result = await agent.runLoop();

      // Display observations
      const healthObs = result.observations.find(
        obs => obs.source === 'http-monitor/health-check'
      );

      if (healthObs) {
        const status = healthObs.data.success ? 'HEALTHY' : 'UNHEALTHY';
        const details = healthObs.data.success
          ? `${healthObs.data.statusCode} (${healthObs.data.responseTime}ms)`
          : `${healthObs.data.error} (failures: ${healthObs.data.consecutiveFailures})`;

        console.log(`Status: ${status} - ${details}`);
      }

      if (result.decision && result.decision.action !== 'no-op') {
        console.log(`Decision: ${result.decision.rationale}`);
        console.log(`Action: ${result.decision.action}`);
      }

      if (result.actionResults.length > 0) {
        for (const actionResult of result.actionResults) {
          if (actionResult.success) {
            console.log(`Success: ${actionResult.output}`);
          } else {
            console.log(`Action failed: ${actionResult.error}`);
          }
        }
      }
    } catch (err) {
      console.error('Error in OODA loop:', err);
    }
  };

  const loopInterval = setInterval(runLoop, 5000);

  const cleanup = () => {
    console.log('\n\nShutting down...');
    clearInterval(loopInterval);
    apiServer.stop();
    testServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await new Promise(() => {});
}

main().catch(console.error);
