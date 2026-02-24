/**
 * API Server Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createAgent } from '../agent';
import { definePlugin, createObserver, createAction, createEndpoint } from '../plugin';
import { json } from './helpers';
import type { Observation } from '../types/index';

describe('API Server', () => {
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let server: ReturnType<typeof agent.startApi>;
  const baseUrl = 'http://localhost:3001/api/v0';
  const apiKey = 'test-key-123';

  beforeAll(async () => {
    // Create agent with a test plugin
    const testPlugin = definePlugin({
      id: 'test',
      observers: {
        testObserver: createObserver({
          name: 'test-observer',
          description: 'Test observer',
          observe: async () => {
            const obs: Observation = {
              source: 'test/observer',
              timestamp: new Date(),
              type: 'state',
              severity: 'info',
              data: { test: true },
            };
            return [obs];
          },
        }),
      },
      actions: {
        testAction: createAction({
          name: 'test-action',
          description: 'Test action',
          execute: async () => ({
            action: 'test-action',
            success: true,
            duration: 10,
          }),
        }),
      },
      endpoints: {
        customEndpoint: createEndpoint({
          method: 'GET',
          path: '/custom/test',
          handler: async (ctx) => {
            return json({
              message: 'Plugin endpoint works!',
              agentName: ctx.context.agent.name,
            });
          },
          auth: true,
        }),
        publicEndpoint: createEndpoint({
          method: 'POST',
          path: '/custom/public',
          handler: async (ctx) => {
            return json({ public: true });
          },
          auth: false,
        }),
      },
    });

    agent = await createAgent({
      plugins: [testPlugin],
    });

    server = agent.startApi({
      port: 3001,
      apiKeys: [apiKey],
    });
  });

  afterAll(() => {
    server.stop();
  });

  describe('Health Check', () => {
    test('GET /health - should return ok without auth', async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);

      const data = await response.json() as { status: string };
      expect(data.status).toBe('ok');
    });
  });

  describe('Authentication', () => {
    test('should reject requests without Authorization header', async () => {
      const response = await fetch(`${baseUrl}/state`);
      expect(response.status).toBe(401);

      const data = await response.json() as { error: string };
      expect(data.error).toContain('Authorization');
    });

    test('should reject requests with invalid Bearer token', async () => {
      const response = await fetch(`${baseUrl}/state`, {
        headers: {
          Authorization: 'Bearer invalid-token',
        },
      });
      expect(response.status).toBe(401);

      const data = await response.json() as { error: string };
      expect(data.error).toContain('Invalid API key');
    });

    test('should accept requests with valid Bearer token', async () => {
      const response = await fetch(`${baseUrl}/state`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      expect(response.status).toBe(200);
    });
  });

  describe('Core Endpoints', () => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    test('GET /state - should return agent state', async () => {
      const response = await fetch(`${baseUrl}/state`, { headers });
      expect(response.status).toBe(200);

      const data = await response.json() as { agent: { name: string }; capabilities: unknown };
      expect(data.agent.name).toBe('Zup');
      expect(data.capabilities).toBeDefined();
    });

    test('GET /actions - should list available actions', async () => {
      const response = await fetch(`${baseUrl}/actions`, { headers });
      expect(response.status).toBe(200);

      const data = await response.json() as { actions: unknown[] };
      expect(Array.isArray(data.actions)).toBe(true);
      expect(data.actions.length).toBeGreaterThan(0);
    });

    test('GET /loop/status - should return loop status', async () => {
      const response = await fetch(`${baseUrl}/loop/status`, { headers });
      expect(response.status).toBe(200);

      const data = await response.json() as { phase: string; iteration: number };
      expect(data.phase).toBeDefined();
      expect(typeof data.iteration).toBe('number');
    });

    test('POST /loop/trigger - should trigger OODA loop', async () => {
      const response = await fetch(`${baseUrl}/loop/trigger`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ context: 'test run' }),
      });
      expect(response.status).toBe(200);

      const data = await response.json() as { success: boolean; result: { observations: number } };
      expect(data.success).toBe(true);
      expect(data.result.observations).toBeGreaterThan(0);
    });

    test('GET /observations - should return observations', async () => {
      // First trigger a loop to generate observations
      await fetch(`${baseUrl}/loop/trigger`, {
        method: 'POST',
        headers,
      });

      const response = await fetch(`${baseUrl}/observations`, { headers });
      expect(response.status).toBe(200);

      const data = await response.json() as { observations: unknown[]; total: number };
      expect(Array.isArray(data.observations)).toBe(true);
      expect(typeof data.total).toBe('number');
    });

    test('GET /observations?limit=1 - should respect limit parameter', async () => {
      const response = await fetch(`${baseUrl}/observations?limit=1`, { headers });
      expect(response.status).toBe(200);

      const data = await response.json() as { observations: unknown[]; filtered: number };
      expect(data.observations.length).toBeLessThanOrEqual(1);
    });

    test('POST /actions/:actionId - should execute action', async () => {
      const response = await fetch(`${baseUrl}/actions/test:testAction`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ params: {} }),
      });
      expect(response.status).toBe(200);

      const data = await response.json() as { success: boolean };
      expect(data.success).toBe(true);
    });
  });

  describe('Plugin Endpoints', () => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    test('should register and call authenticated plugin endpoint', async () => {
      const response = await fetch(`${baseUrl}/custom/test`, { headers });
      expect(response.status).toBe(200);

      const data = await response.json() as { message: string; agentName: string };
      expect(data.message).toBe('Plugin endpoint works!');
      expect(data.agentName).toBe('Zup');
    });

    test('should require auth for authenticated plugin endpoint', async () => {
      const response = await fetch(`${baseUrl}/custom/test`);
      expect(response.status).toBe(401);
    });

    test('should allow public access to unauthenticated plugin endpoint', async () => {
      const response = await fetch(`${baseUrl}/custom/public`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);

      const data = await response.json() as { public: boolean };
      expect(data.public).toBe(true);
    });
  });

  describe('Error Handling', () => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
    };

    test('should return 404 for unknown routes', async () => {
      const response = await fetch(`${baseUrl}/unknown-route`, { headers });
      expect(response.status).toBe(404);

      const data = await response.json() as { error: string };
      expect(data.error).toContain('Not found');
    });

    test('should return 404 for unknown action', async () => {
      const response = await fetch(`${baseUrl}/actions/unknown:action`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ params: {} }),
      });
      expect(response.status).toBe(404);

      const data = await response.json() as { error: string };
      expect(data.error).toContain('not found');
    });
  });
});
