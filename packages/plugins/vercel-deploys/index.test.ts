/**
 * Vercel Deploys Plugin Tests
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createAgent } from '../../core/src/index';
import { vercelDeploys } from './index';
import type { VercelApiDeploymentsResponse } from './types';

describe('Vercel Deploys Plugin', () => {
  let mockServer: ReturnType<typeof Bun.serve>;
  let mockServerUrl: string;
  let mockDeployments: VercelApiDeploymentsResponse;

  beforeAll(() => {
    // Default mock deployments
    mockDeployments = {
      pagination: { count: 2 },
      deployments: [
        {
          uid: 'dpl_123',
          name: 'my-app',
          projectId: 'prj_test',
          url: 'my-app-abc123.vercel.app',
          inspectorUrl: 'https://vercel.com/team/my-app/dpl_123',
          created: Date.now() - 60000, // 1 minute ago
          ready: Date.now() - 30000, // 30 seconds ago
          state: 'READY',
          readyState: 'READY',
          target: 'production',
          creator: {
            uid: 'user_123',
            email: 'dev@example.com',
            username: 'developer',
          },
          meta: {
            githubCommitSha: 'abc123def456',
            githubCommitMessage: 'feat: add new feature',
            githubCommitRef: 'main',
            githubCommitAuthorName: 'Developer',
            githubRepo: 'org/my-app',
          },
        },
        {
          uid: 'dpl_456',
          name: 'my-app',
          projectId: 'prj_test',
          url: 'my-app-def456.vercel.app',
          created: Date.now() - 120000, // 2 minutes ago
          ready: Date.now() - 90000,
          state: 'READY',
          readyState: 'READY',
          target: 'preview',
          creator: {
            uid: 'user_123',
            email: 'dev@example.com',
            username: 'developer',
          },
          meta: {
            githubCommitSha: 'def456abc789',
            githubCommitMessage: 'fix: bug fix',
            githubCommitRef: 'feature-branch',
            githubCommitAuthorName: 'Developer',
          },
        },
      ],
    };

    // Create mock Vercel API server
    mockServer = Bun.serve({
      port: 0, // Random port
      fetch(req) {
        const url = new URL(req.url);

        // Check authorization
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Mock deployments endpoint
        if (url.pathname === '/v6/deployments') {
          return new Response(JSON.stringify(mockDeployments), {
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
          vercelDeploys({
            auth: { token: 'test-token' },
            projects: [
              {
                id: 'prj_test',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const ctx = agent.getContext();
      expect(ctx.vercelDeploys).toBeDefined();

      const pluginCtx = ctx.vercelDeploys as {
        projects: unknown[];
        projectStates: Map<string, unknown>;
      };

      expect(pluginCtx.projects).toHaveLength(1);
      expect(pluginCtx.projectStates.size).toBe(1);
    });

    test('should throw error if no token provided', async () => {
      expect(async () => {
        await createAgent({
          plugins: [
            vercelDeploys({
              auth: { token: '' },
              projects: [{ id: 'prj_test', serviceName: 'my-service' }],
            }),
          ],
        });
      }).toThrow('auth.token is required');
    });

    test('should throw error if no projects configured', async () => {
      expect(async () => {
        await createAgent({
          plugins: [
            vercelDeploys({
              auth: { token: 'test-token' },
              projects: [],
            }),
          ],
        });
      }).toThrow('at least one project must be configured');
    });
  });

  describe('Deployment Observer', () => {
    test('should fetch and observe deployments', async () => {
      const agent = await createAgent({
        plugins: [
          vercelDeploys({
            auth: { token: 'test-token' },
            projects: [
              {
                id: 'prj_test',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      expect(result.observations.length).toBeGreaterThan(0);

      const deployObs = result.observations.filter(
        (obs) => obs.source === 'vercel-deploys/deployment'
      );

      expect(deployObs.length).toBe(2);
    });

    test('should include git metadata in observations', async () => {
      const agent = await createAgent({
        plugins: [
          vercelDeploys({
            auth: { token: 'test-token' },
            projects: [
              {
                id: 'prj_test',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const deployObs = result.observations.find(
        (obs) => obs.source === 'vercel-deploys/deployment' && obs.data.deploymentId === 'dpl_123'
      );

      expect(deployObs).toBeDefined();
      expect(deployObs?.data.git).toBeDefined();

      const git = deployObs?.data.git as {
        commitSha?: string;
        commitMessage?: string;
        branch?: string;
        author?: string;
      };

      expect(git.commitSha).toBe('abc123def456');
      expect(git.commitMessage).toBe('feat: add new feature');
      expect(git.branch).toBe('main');
      expect(git.author).toBe('Developer');
    });

    test('should set correct severity for failed deployments', async () => {
      // Update mock to return a failed deployment
      const originalDeployments = { ...mockDeployments };
      mockDeployments = {
        pagination: { count: 1 },
        deployments: [
          {
            uid: 'dpl_error',
            name: 'my-app',
            projectId: 'prj_test',
            url: '',
            created: Date.now(),
            state: 'ERROR',
            readyState: 'ERROR',
            target: 'production',
            errorCode: 'BUILD_FAILED',
            errorMessage: 'Build failed due to syntax error',
          },
        ],
      };

      const agent = await createAgent({
        plugins: [
          vercelDeploys({
            auth: { token: 'test-token' },
            projects: [
              {
                id: 'prj_test',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const errorObs = result.observations.find(
        (obs) => obs.source === 'vercel-deploys/deployment' && obs.data.state === 'ERROR'
      );

      expect(errorObs).toBeDefined();
      expect(errorObs?.severity).toBe('critical'); // Production error should be critical

      // Restore original mock
      mockDeployments = originalDeployments;
    });

    test('should handle API errors gracefully', async () => {
      const agent = await createAgent({
        plugins: [
          vercelDeploys({
            auth: { token: 'invalid-token' },
            projects: [
              {
                id: 'prj_test',
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
      const errorObs = result.observations.find((obs) => obs.source === 'vercel-deploys/error');

      expect(errorObs).toBeDefined();
      expect(errorObs?.severity).toBe('warning');
    });
  });

  describe('Deployment Analysis Orienter', () => {
    test('should analyze deployments and produce findings', async () => {
      const agent = await createAgent({
        plugins: [
          vercelDeploys({
            auth: { token: 'test-token' },
            projects: [
              {
                id: 'prj_test',
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

      const vercelAssessment = result.situation?.assessments.find(
        (a) => a.source === 'vercel-deploys/analyze-deployments'
      );

      expect(vercelAssessment).toBeDefined();
      expect(vercelAssessment?.findings.length).toBeGreaterThan(0);
      expect(vercelAssessment?.findings.some((f) => f.includes('my-service'))).toBe(true);
    });

    test('should detect failed deployments in analysis', async () => {
      // Update mock to include failed deployments
      const originalDeployments = { ...mockDeployments };
      mockDeployments = {
        pagination: { count: 3 },
        deployments: [
          ...originalDeployments.deployments,
          {
            uid: 'dpl_error1',
            name: 'my-app',
            projectId: 'prj_test',
            created: Date.now() - 10000,
            state: 'ERROR',
            readyState: 'ERROR',
            target: 'production',
          },
          {
            uid: 'dpl_error2',
            name: 'my-app',
            projectId: 'prj_test',
            created: Date.now() - 20000,
            state: 'ERROR',
            readyState: 'ERROR',
            target: 'preview',
          },
          {
            uid: 'dpl_error3',
            name: 'my-app',
            projectId: 'prj_test',
            created: Date.now() - 30000,
            state: 'ERROR',
            readyState: 'ERROR',
            target: 'preview',
          },
        ],
      };

      const agent = await createAgent({
        plugins: [
          vercelDeploys({
            auth: { token: 'test-token' },
            projects: [
              {
                id: 'prj_test',
                serviceName: 'my-service',
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      const result = await agent.runLoop();

      const vercelAssessment = result.situation?.assessments.find(
        (a) => a.source === 'vercel-deploys/analyze-deployments'
      );

      expect(vercelAssessment?.findings.some((f) => f.includes('failed'))).toBe(true);

      // Restore original mock
      mockDeployments = originalDeployments;
    });
  });

  describe('Plugin Endpoints', () => {
    let agent: Awaited<ReturnType<typeof createAgent>>;
    let apiServer: ReturnType<typeof agent.startApi>;
    const apiKey = 'test-key-123';

    beforeAll(async () => {
      agent = await createAgent({
        plugins: [
          vercelDeploys({
            auth: { token: 'test-token' },
            projects: [
              {
                id: 'prj_test',
                serviceName: 'my-service',
                teamId: 'team_test',
                environments: ['production', 'preview'],
              },
            ],
            apiBaseUrl: mockServerUrl,
          }),
        ],
      });

      // Run a loop to populate state
      await agent.runLoop();

      apiServer = agent.startApi({
        port: 3003,
        hostname: 'localhost',
        apiKeys: [apiKey],
      });

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    afterAll(() => {
      apiServer.stop();
    });

    test('GET /vercel/projects - should list projects', async () => {
      const response = await fetch('http://localhost:3003/api/v0/vercel/projects', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = (await response.json()) as { projects: unknown[] };
      expect(data.projects).toHaveLength(1);

      const project = data.projects[0] as {
        id: string;
        serviceName: string;
        lastDeployment: unknown;
      };
      expect(project.id).toBe('prj_test');
      expect(project.serviceName).toBe('my-service');
      expect(project.lastDeployment).toBeDefined();
    });

    test('GET /vercel/projects/:id/deployments - should get project deployments', async () => {
      const response = await fetch(
        'http://localhost:3003/api/v0/vercel/projects/prj_test/deployments',
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        project: { id: string };
        deployments: unknown[];
      };
      expect(data.project.id).toBe('prj_test');
      expect(data.deployments.length).toBeGreaterThan(0);
    });

    test('GET /vercel/projects/:id/deployments - should return 404 for unknown project', async () => {
      const response = await fetch(
        'http://localhost:3003/api/v0/vercel/projects/unknown/deployments',
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      expect(response.status).toBe(404);
    });

    test('should require authentication', async () => {
      const response = await fetch('http://localhost:3003/api/v0/vercel/projects');

      expect(response.status).toBe(401);
    });
  });
});
