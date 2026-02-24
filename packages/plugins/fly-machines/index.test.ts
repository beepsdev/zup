/**
 * Fly.io Machines Plugin Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createAgent } from '../../core/src/index';
import { flyMachines } from './index';
import type { FlyApiMachine } from './types';

describe('Fly.io Machines Plugin', () => {
  let mockServer: ReturnType<typeof Bun.serve>;
  let mockServerUrl: string;
  let mockMachines: FlyApiMachine[];
  let requestCount: number;

  beforeAll(() => {
    requestCount = 0;

    // Default mock machines
    mockMachines = [
      {
        id: 'machine_123',
        name: 'my-app-machine-1',
        state: 'started',
        region: 'ord',
        instance_id: 'instance_abc123',
        private_ip: 'fdaa:0:18:a7b:196:e274:9ce1:2',
        created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
        updated_at: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        image_ref: {
          registry: 'registry.fly.io',
          repository: 'my-app',
          tag: 'v1.2.3',
          digest: 'sha256:abc123def456789',
        },
        config: {
          guest: {
            cpu_kind: 'shared',
            cpus: 1,
            memory_mb: 256,
          },
          metadata: {
            fly_platform_version: 'v2',
            fly_process_group: 'app',
          },
        },
        events: [
          {
            type: 'start',
            status: 'started',
            source: 'flyd',
            timestamp: Date.now() - 60000,
          },
          {
            type: 'launch',
            status: 'created',
            source: 'user',
            timestamp: Date.now() - 86400000,
          },
        ],
        checks: {
          'http-check': {
            name: 'http-check',
            status: 'passing',
            output: 'HTTP check passed',
            updated_at: new Date().toISOString(),
          },
        },
      },
      {
        id: 'machine_456',
        name: 'my-app-machine-2',
        state: 'started',
        region: 'cdg',
        instance_id: 'instance_def456',
        private_ip: 'fdaa:0:18:a7b:196:e274:9ce1:3',
        created_at: new Date(Date.now() - 86400000).toISOString(),
        updated_at: new Date(Date.now() - 30000).toISOString(),
        image_ref: {
          registry: 'registry.fly.io',
          repository: 'my-app',
          tag: 'v1.2.3',
          digest: 'sha256:abc123def456789',
        },
        config: {
          guest: {
            cpu_kind: 'shared',
            cpus: 1,
            memory_mb: 256,
          },
        },
        events: [
          {
            type: 'start',
            status: 'started',
            source: 'flyd',
            timestamp: Date.now() - 30000,
          },
        ],
      },
    ];

    // Create mock Fly.io API server
    mockServer = Bun.serve({
      port: 0, // Random port
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);

        // Check authorization
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Mock machines endpoint
        if (url.pathname.match(/\/v1\/apps\/[\w-]+\/machines$/)) {
          return new Response(JSON.stringify(mockMachines), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    mockServerUrl = `http://localhost:${mockServer.port}`;
  });

  afterAll(() => {
    mockServer.stop();
  });

  describe('Plugin Initialization', () => {
    test('should initialize with valid configuration', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const ctx = agent.getContext();
      expect(ctx.flyMachines).toBeDefined();

      const pluginCtx = ctx.flyMachines as {
        apps: unknown[];
        appStates: Map<string, unknown>;
      };

      expect(pluginCtx.apps).toHaveLength(1);
      expect(pluginCtx.appStates.size).toBe(1);
    });

    test('should throw error if no token provided', async () => {
      expect(async () => {
        await createAgent({
          plugins: [
            flyMachines({
              auth: { token: '' },
              apps: [{ name: 'my-app', serviceName: 'my-service' }],
            }),
          ],
        });
      }).toThrow('auth.token is required');
    });

    test('should throw error if no apps configured', async () => {
      expect(async () => {
        await createAgent({
          plugins: [
            flyMachines({
              auth: { token: 'test-token' },
              apps: [],
            }),
          ],
        });
      }).toThrow('at least one app must be configured');
    });
  });

  describe('Machine Observer', () => {
    test('should fetch and observe machines', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.observations.length).toBeGreaterThan(0);

      const machineObs = result.observations.filter(
        (obs) => obs.source === 'fly-machines/machine'
      );

      expect(machineObs.length).toBe(2);
    });

    test('should include image metadata in observations', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const machineObs = result.observations.find(
        (obs) => obs.source === 'fly-machines/machine' && obs.data.machineId === 'machine_123'
      );

      expect(machineObs).toBeDefined();
      expect(machineObs?.data.imageDigest).toBe('sha256:abc123def456789');
      expect(machineObs?.data.imageRepository).toBe('my-app');
      expect(machineObs?.data.imageTag).toBe('v1.2.3');
    });

    test('should include machine events in observations', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const machineObs = result.observations.find(
        (obs) => obs.source === 'fly-machines/machine' && obs.data.machineId === 'machine_123'
      );

      expect(machineObs).toBeDefined();
      expect(machineObs?.data.recentEvent).toBeDefined();

      const recentEvent = machineObs?.data.recentEvent as { type: string } | undefined;
      expect(recentEvent?.type).toBe('start');
    });

    test('should detect deployment when instance_id changes', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      // First loop to establish baseline
      await agent.runLoop();

      // Simulate deployment by changing instance_id
      const originalMachines = [...mockMachines];
      mockMachines = mockMachines.map((m) => ({
        ...m,
        instance_id: `new_${m.instance_id}`,
        image_ref: {
          ...m.image_ref,
          tag: 'v1.2.4',
          digest: 'sha256:newdigest789',
        },
      }));

      // Second loop should detect deployment
      const result = await agent.runLoop();

      const deployObs = result.observations.filter(
        (obs) => obs.source === 'fly-machines/deployment'
      );

      expect(deployObs.length).toBeGreaterThan(0);
      expect(deployObs[0]?.data.status).toBeDefined();

      // Restore original machines
      mockMachines = originalMachines;
    });

    test('should set warning severity for stopped machines', async () => {
      // Update mock to include a stopped machine
      const originalMachines = [...mockMachines];
      mockMachines = [
        ...mockMachines,
        {
          id: 'machine_stopped',
          name: 'my-app-stopped',
          state: 'stopped',
          region: 'ord',
          instance_id: 'instance_stopped',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          image_ref: {
            registry: 'registry.fly.io',
            repository: 'my-app',
            digest: 'sha256:abc123',
          },
          events: [],
        },
      ];

      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const stoppedObs = result.observations.find(
        (obs) => obs.source === 'fly-machines/machine' && obs.data.state === 'stopped'
      );

      expect(stoppedObs).toBeDefined();
      expect(stoppedObs?.severity).toBe('warning');

      // Restore original machines
      mockMachines = originalMachines;
    });

    test('should handle API errors gracefully', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'invalid-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            // Use a non-existent endpoint to trigger error
            apiBaseUrl: 'http://localhost:1',
          }),
        ],
      });

      const result = await agent.runLoop();

      // Should have an error observation
      const errorObs = result.observations.find((obs) => obs.source === 'fly-machines/error');

      expect(errorObs).toBeDefined();
      expect(errorObs?.severity).toBe('warning');
    });
  });

  describe('Machine Analysis Orienter', () => {
    test('should analyze machines and produce findings', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.situation).toBeDefined();
      expect(result.situation?.assessments.length).toBeGreaterThan(0);

      const flyAssessment = result.situation?.assessments.find(
        (a) => a.source === 'fly-machines/analyze-machines'
      );

      expect(flyAssessment).toBeDefined();
      expect(flyAssessment?.findings.length).toBeGreaterThan(0);
      expect(flyAssessment?.findings.some((f) => f.includes('my-service'))).toBe(true);
    });

    test('should report machine count and regions', async () => {
      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const flyAssessment = result.situation?.assessments.find(
        (a) => a.source === 'fly-machines/analyze-machines'
      );

      // Should mention machine count and regions
      expect(flyAssessment?.findings.some((f) => f.includes('2/2'))).toBe(true);
      expect(flyAssessment?.findings.some((f) => f.includes('ord') || f.includes('cdg'))).toBe(
        true
      );
    });

    test('should detect unhealthy machines in analysis', async () => {
      // Update mock to include machines with failing health checks
      const originalMachines = [...mockMachines];
      mockMachines = [
        {
          ...mockMachines[0]!,
          checks: {
            'http-check': {
              name: 'http-check',
              status: 'critical',
              output: 'Connection refused',
              updated_at: new Date().toISOString(),
            },
          },
        },
        mockMachines[1]!,
      ];

      const agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const flyAssessment = result.situation?.assessments.find(
        (a) => a.source === 'fly-machines/analyze-machines'
      );

      expect(flyAssessment?.findings.some((f) => f.includes('health check'))).toBe(true);

      // Restore original machines
      mockMachines = originalMachines;
    });
  });

  describe('Plugin Endpoints', () => {
    let agent: Awaited<ReturnType<typeof createAgent>>;
    let apiServer: ReturnType<typeof agent.startApi>;
    const apiKey = 'test-key-123';

    beforeAll(async () => {
      agent = await createAgent({
        plugins: [
          flyMachines({
            auth: { token: 'test-token' },
            apps: [
              {
                name: 'my-app',
                serviceName: 'my-service',
                regions: ['ord', 'cdg'],
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      // Run a loop to populate state
      await agent.runLoop();

      apiServer = agent.startApi({
        port: 3004,
        hostname: 'localhost',
        apiKeys: [apiKey],
      });

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    afterAll(() => {
      apiServer.stop();
    });

    test('GET /fly/apps - should list apps', async () => {
      const response = await fetch('http://localhost:3004/api/v0/fly/apps', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = (await response.json()) as { apps: unknown[] };
      expect(data.apps).toHaveLength(1);

      const app = data.apps[0] as {
        name: string;
        serviceName: string;
        machineCount: number;
        runningCount: number;
      };
      expect(app.name).toBe('my-app');
      expect(app.serviceName).toBe('my-service');
      expect(app.machineCount).toBe(2);
      expect(app.runningCount).toBe(2);
    });

    test('GET /fly/apps/:appName/machines - should get app machines', async () => {
      const response = await fetch('http://localhost:3004/api/v0/fly/apps/my-app/machines', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        app: { name: string };
        machines: unknown[];
      };
      expect(data.app.name).toBe('my-app');
      expect(data.machines.length).toBe(2);
    });

    test('GET /fly/apps/:appName/machines - should return 404 for unknown app', async () => {
      const response = await fetch('http://localhost:3004/api/v0/fly/apps/unknown-app/machines', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(404);
    });

    test('should require authentication', async () => {
      const response = await fetch('http://localhost:3004/api/v0/fly/apps');

      expect(response.status).toBe(401);
    });
  });
});
