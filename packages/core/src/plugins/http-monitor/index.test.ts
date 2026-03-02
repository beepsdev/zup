/**
 * HTTP Monitor Plugin Tests
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { createAgent } from '../../index';
import { httpMonitor } from './index';

describe('HTTP Monitor Plugin', () => {
  let testServer: ReturnType<typeof Bun.serve>;
  let testServerUrl: string;
  let failingServerUrl: string;
  let requestCount = 0;

  beforeAll(() => {
    // Create test HTTP server
    testServer = Bun.serve({
      port: 0, // Random port
      fetch(req) {
        const url = new URL(req.url);
        requestCount++;

        if (url.pathname === '/healthy') {
          return new Response('OK', { status: 200 });
        }

        if (url.pathname === '/unhealthy') {
          return new Response('Service Unavailable', { status: 503 });
        }

        if (url.pathname === '/restart') {
          return new Response('Restarted', { status: 200 });
        }

        return new Response('Not Found', { status: 404 });
      },
    });

    testServerUrl = `http://localhost:${testServer.port}`;
    failingServerUrl = `http://localhost:${testServer.port}/unhealthy`;
  });

  afterAll(() => {
    testServer.stop();
  });

  describe('Plugin Initialization', () => {
    test('should initialize with valid configuration', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'test-endpoint',
                name: 'Test Endpoint',
                url: `${testServerUrl}/healthy`,
              },
            ],
          }),
        ],
      });

      const ctx = agent.getContext();
      expect(ctx.httpMonitor).toBeDefined();

      const pluginCtx = ctx.httpMonitor as {
        endpoints: unknown[];
        endpointStates: Map<string, unknown>;
      };

      expect(pluginCtx.endpoints).toHaveLength(1);
      expect(pluginCtx.endpointStates.size).toBe(1);
    });

    test('should throw error if no endpoints configured', async () => {
      expect(async () => {
        await createAgent({
          plugins: [
            httpMonitor({
              endpoints: [],
            }),
          ],
        });
      }).toThrow('At least one endpoint must be configured');
    });
  });

  describe('Health Check Observer', () => {
    test('should successfully check healthy endpoint', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'healthy',
                name: 'Healthy Service',
                url: `${testServerUrl}/healthy`,
              },
            ],
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.observations.length).toBeGreaterThan(0);

      const healthObs = result.observations.find(
        obs => obs.source === 'http-monitor/health-check'
      );

      expect(healthObs).toBeDefined();
      expect(healthObs?.data.success).toBe(true);
      expect(healthObs?.data.statusCode).toBe(200);
      expect(healthObs?.severity).toBe('info');
    });

    test('should detect unhealthy endpoint', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'unhealthy',
                name: 'Unhealthy Service',
                url: failingServerUrl,
                failureThreshold: 1, // Fail immediately for testing
              },
            ],
          }),
        ],
      });

      const result = await agent.runLoop();

      const healthObs = result.observations.find(
        obs => obs.source === 'http-monitor/health-check'
      );

      expect(healthObs?.data.success).toBe(false);
      expect(healthObs?.data.statusCode).toBe(503);
      expect(healthObs?.severity).toBe('error');
    });

    test('should track consecutive failures', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'failing',
                name: 'Failing Service',
                url: failingServerUrl,
              },
            ],
          }),
        ],
      });

      // Run loop 3 times to accumulate failures
      await agent.runLoop();
      await agent.runLoop();
      const result = await agent.runLoop();

      const healthObs = result.observations.find(
        obs => obs.source === 'http-monitor/health-check'
      );

      expect(healthObs?.data.consecutiveFailures).toBe(3);
    });
  });

  describe('Failure Analysis Orienter', () => {
    test('should analyze isolated failures', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'healthy-1',
                name: 'Healthy 1',
                url: `${testServerUrl}/healthy`,
              },
              {
                id: 'unhealthy-1',
                name: 'Unhealthy 1',
                url: failingServerUrl,
                failureThreshold: 1, // Trigger on first failure
              },
            ],
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.situation).toBeDefined();

      // Check that the orienter produced findings about the failure
      const findings = result.situation?.assessments[0]?.findings || [];
      expect(findings.some((f: string) => f.includes('unhealthy') || f.includes('failure'))).toBe(true);
    });

    test('should detect cascading failures', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'unhealthy-1',
                name: 'Unhealthy 1',
                url: failingServerUrl,
                failureThreshold: 1,
              },
              {
                id: 'unhealthy-2',
                name: 'Unhealthy 2',
                url: failingServerUrl,
                failureThreshold: 1,
              },
            ],
          }),
        ],
      });

      const result = await agent.runLoop();

      // Check that multiple endpoints were detected as unhealthy
      const findings = result.situation?.assessments[0]?.findings || [];
      expect(findings.length).toBeGreaterThan(1); // Should have findings about multiple endpoints
      expect(findings.some((f: string) => f.includes('unhealthy') || f.includes('failure'))).toBe(true);
    });
  });

  describe('Restart Decision Strategy', () => {
    test('should decide to restart after failure threshold', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'failing',
                name: 'Failing Service',
                url: failingServerUrl,
                failureThreshold: 2,
                restartStrategy: {
                  type: 'http',
                  url: `${testServerUrl}/restart`,
                },
              },
            ],
          }),
        ],
      });

      // Run loop twice to hit threshold
      await agent.runLoop();
      const result = await agent.runLoop();

      expect(result.decision?.action).toBe('http-monitor:restartService');
      expect(result.decision?.params.endpointId).toBe('failing');
    });

    test('should not restart during cooldown period', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'failing',
                name: 'Failing Service',
                url: failingServerUrl,
                failureThreshold: 1,
                cooldownPeriod: 60000, // 1 minute
                restartStrategy: {
                  type: 'http',
                  url: `${testServerUrl}/restart`,
                },
              },
            ],
          }),
        ],
      });

      // First loop - should restart
      const result1 = await agent.runLoop();
      expect(result1.decision?.action).toBe('http-monitor:restartService');

      // Second loop immediately after - should not restart (cooldown)
      const result2 = await agent.runLoop();
      expect(result2.decision?.action).toBe('no-op');
    });
  });

  describe('Restart Action', () => {
    test('should execute HTTP restart strategy', async () => {
      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'test',
                name: 'Test Service',
                url: failingServerUrl,
                failureThreshold: 1,
                restartStrategy: {
                  type: 'http',
                  url: `${testServerUrl}/restart`,
                },
              },
            ],
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.actionResults.length).toBeGreaterThan(0);
      expect(result.actionResults[0]?.success).toBe(true);
    });

    test('should execute function restart strategy', async () => {
      let restartCalled = false;

      const agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'test',
                name: 'Test Service',
                url: failingServerUrl,
                failureThreshold: 1,
                restartStrategy: {
                  type: 'function',
                  handler: async () => {
                    restartCalled = true;
                  },
                },
              },
            ],
          }),
        ],
      });

      await agent.runLoop();

      expect(restartCalled).toBe(true);
    });
  });

  describe('Plugin Endpoints', () => {
    let agent: Awaited<ReturnType<typeof createAgent>>;
    let apiServer: ReturnType<typeof agent.startApi>;
    const apiKey = 'test-key-123';

    beforeAll(async () => {
      agent = await createAgent({
        plugins: [
          httpMonitor({
            endpoints: [
              {
                id: 'test',
                name: 'Test Service',
                url: `${testServerUrl}/healthy`,
              },
            ],
          }),
        ],
      });

      apiServer = agent.startApi({
        port: 3002,
        hostname: 'localhost',
        apiKeys: [apiKey],
      });

      // Wait for server to start
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    afterAll(() => {
      apiServer.stop();
    });

    test('GET /http-monitor/endpoints - should list endpoints', async () => {
      const response = await fetch('http://localhost:3002/api/v0/http-monitor/endpoints', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json() as { endpoints: unknown[] };
      expect(data.endpoints).toHaveLength(1);
    });

    test('POST /http-monitor/endpoints/:id/check - should check endpoint', async () => {
      const response = await fetch('http://localhost:3002/api/v0/http-monitor/endpoints/test/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json() as { success: boolean; statusCode: number };
      expect(data.success).toBe(true);
      expect(data.statusCode).toBe(200);
    });
  });
});
