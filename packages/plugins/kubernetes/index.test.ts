import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { kubernetes } from './index';
import type { AgentContext, Observation } from '../../core/src/index';

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};

function createMockContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    logger: mockLogger,
    state: { get: mock(() => undefined), set: mock(() => {}) },
    ...overrides,
  } as unknown as AgentContext;
}

const mockPodList = {
  items: [
    {
      metadata: { name: 'healthy-pod', namespace: 'default', creationTimestamp: new Date(Date.now() - 3600000).toISOString() },
      spec: { nodeName: 'node-1' },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
      },
    },
    {
      metadata: { name: 'crash-pod', namespace: 'default', creationTimestamp: new Date(Date.now() - 3600000).toISOString() },
      spec: { nodeName: 'node-1' },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff', message: 'Back-off' } } }],
      },
    },
  ],
};

const mockDeploymentList = {
  items: [
    {
      metadata: { name: 'healthy-deploy', namespace: 'default', creationTimestamp: new Date(Date.now() - 86400000).toISOString() },
      spec: { replicas: 3 },
      status: { readyReplicas: 3, unavailableReplicas: 0, updatedReplicas: 3 },
    },
    {
      metadata: { name: 'degraded-deploy', namespace: 'default', creationTimestamp: new Date(Date.now() - 86400000).toISOString() },
      spec: { replicas: 3 },
      status: { readyReplicas: 1, unavailableReplicas: 2, updatedReplicas: 1 },
    },
  ],
};

const mockNodeList = {
  items: [
    {
      metadata: { name: 'node-1', creationTimestamp: new Date(Date.now() - 604800000).toISOString() },
      spec: { unschedulable: false },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    },
    {
      metadata: { name: 'node-2', creationTimestamp: new Date(Date.now() - 604800000).toISOString() },
      spec: { unschedulable: false },
      status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'Node not responding' }] },
    },
  ],
};

const mockEventList = {
  items: [
    {
      metadata: { name: 'event-1', namespace: 'default' },
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      involvedObject: { kind: 'Pod', name: 'crash-pod', namespace: 'default' },
      count: 5,
      lastTimestamp: new Date().toISOString(),
    },
  ],
};

const mockNamespaceList = {
  items: [
    { metadata: { name: 'default' }, status: { phase: 'Active' } },
    { metadata: { name: 'kube-system' }, status: { phase: 'Active' } },
  ],
};

function createMockStream(content: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

function createMockSpawnResult(stdout: string, stderr: string, exitCode: number) {
  return {
    stdout: createMockStream(stdout),
    stderr: createMockStream(stderr),
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
  };
}

function setupMockSpawn() {
  // @ts-expect-error - Bun.spawn mock type is complex
  Bun.spawn = mock((args: string[]) => {
    const cmd = args.join(' ');

    if (cmd.includes('get pods')) {
      return createMockSpawnResult(JSON.stringify(mockPodList), '', 0);
    } else if (cmd.includes('get deployments')) {
      return createMockSpawnResult(JSON.stringify(mockDeploymentList), '', 0);
    } else if (cmd.includes('get nodes')) {
      return createMockSpawnResult(JSON.stringify(mockNodeList), '', 0);
    } else if (cmd.includes('get events')) {
      return createMockSpawnResult(JSON.stringify(mockEventList), '', 0);
    } else if (cmd.includes('get namespaces')) {
      return createMockSpawnResult(JSON.stringify(mockNamespaceList), '', 0);
    } else if (cmd.includes('version')) {
      return createMockSpawnResult('{"clientVersion":{"major":"1","minor":"28"}}', '', 0);
    } else if (cmd.includes('rollout restart')) {
      return createMockSpawnResult('deployment.apps/test-deploy restarted', '', 0);
    } else if (cmd.includes('scale')) {
      return createMockSpawnResult('deployment.apps/test-deploy scaled', '', 0);
    } else if (cmd.includes('delete pod')) {
      return createMockSpawnResult('pod "test-pod" deleted', '', 0);
    } else if (cmd.includes('logs')) {
      return createMockSpawnResult('log line 1\nlog line 2\nlog line 3', '', 0);
    }

    return createMockSpawnResult('', '', 0);
  });
}

function setupErrorMockSpawn(stderr: string, exitCode: number) {
  // @ts-expect-error - Bun.spawn mock type is complex
  Bun.spawn = mock(() => createMockSpawnResult('', stderr, exitCode));
}

describe('kubernetes plugin', () => {
  beforeEach(() => {
    setupMockSpawn();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  describe('plugin initialization', () => {
    it('should create plugin with default options', () => {
      const plugin = kubernetes({});
      expect(plugin.id).toBe('kubernetes');
      expect(plugin.observers).toBeDefined();
      expect(plugin.orienters).toBeDefined();
      expect(plugin.actions).toBeDefined();
      expect(plugin.endpoints).toBeDefined();
    });

    it('should initialize with custom cluster name', async () => {
      const plugin = kubernetes({ clusterName: 'prod-cluster' });
      const ctx = createMockContext();
      const result = await plugin.init?.(ctx);
      expect(result?.context?.kubernetes).toBeDefined();
    });

    it('should log error if kubectl is not available', async () => {
      setupErrorMockSpawn('command not found: kubectl', 127);

      const plugin = kubernetes({});
      const ctx = createMockContext();
      await plugin.init?.(ctx);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('clusterHealth observer', () => {
    it('should detect unhealthy pods', async () => {
      const plugin = kubernetes({ namespaces: ['default'] });
      const ctx = createMockContext();
      await plugin.init?.(ctx);

      const observer = plugin.observers?.clusterHealth;
      expect(observer).toBeDefined();

      const ctxWithK8s = {
        ...ctx,
        kubernetes: {
          options: { namespaces: ['default'] },
          state: {
            unhealthyPods: [],
            degradedDeployments: [],
            notReadyNodes: [],
            recentEvents: [],
            summary: {
              clusterName: 'default',
              namespaces: ['default'],
              pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
              deployments: { total: 0, healthy: 0, degraded: 0 },
              nodes: { total: 0, ready: 0, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      };

      const observations = await observer!.observe(ctxWithK8s as unknown as AgentContext);
      expect(observations.length).toBeGreaterThan(0);

      const unhealthyPodObs = observations.find((o) => o.source === 'kubernetes/unhealthy-pod');
      expect(unhealthyPodObs).toBeDefined();
      expect((unhealthyPodObs?.data as { issue: string }).issue).toBe('CrashLoopBackOff');
      expect((unhealthyPodObs?.data as { pod: string }).pod).toBe('crash-pod');
    });

    it('should detect degraded deployments', async () => {
      const plugin = kubernetes({ namespaces: ['default'] });
      const ctx = createMockContext();
      await plugin.init?.(ctx);

      const observer = plugin.observers?.clusterHealth;
      const ctxWithK8s = {
        ...ctx,
        kubernetes: {
          options: { namespaces: ['default'] },
          state: {
            unhealthyPods: [],
            degradedDeployments: [],
            notReadyNodes: [],
            recentEvents: [],
            summary: {
              clusterName: 'default',
              namespaces: ['default'],
              pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
              deployments: { total: 0, healthy: 0, degraded: 0 },
              nodes: { total: 0, ready: 0, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      };

      const observations = await observer!.observe(ctxWithK8s as unknown as AgentContext);
      const degradedDepObs = observations.find((o) => o.source === 'kubernetes/degraded-deployment');
      expect(degradedDepObs).toBeDefined();
      expect((degradedDepObs?.data as { deployment: string }).deployment).toBe('degraded-deploy');
      expect((degradedDepObs?.data as { readyReplicas: number }).readyReplicas).toBe(1);
      expect((degradedDepObs?.data as { replicas: number }).replicas).toBe(3);
    });

    it('should detect not-ready nodes', async () => {
      const plugin = kubernetes({ namespaces: ['default'] });
      const ctx = createMockContext();
      await plugin.init?.(ctx);

      const observer = plugin.observers?.clusterHealth;
      const ctxWithK8s = {
        ...ctx,
        kubernetes: {
          options: { namespaces: ['default'] },
          state: {
            unhealthyPods: [],
            degradedDeployments: [],
            notReadyNodes: [],
            recentEvents: [],
            summary: {
              clusterName: 'default',
              namespaces: ['default'],
              pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
              deployments: { total: 0, healthy: 0, degraded: 0 },
              nodes: { total: 0, ready: 0, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      };

      const observations = await observer!.observe(ctxWithK8s as unknown as AgentContext);
      const nodeObs = observations.find((o) => o.source === 'kubernetes/node-not-ready');
      expect(nodeObs).toBeDefined();
      expect((nodeObs?.data as { node: string }).node).toBe('node-2');
    });

    it('should emit connection error observation on kubectl failure', async () => {
      setupErrorMockSpawn('connection refused', 1);

      const plugin = kubernetes({ namespaces: ['default'] });
      const ctx = createMockContext();
      await plugin.init?.(ctx);

      const observer = plugin.observers?.clusterHealth;
      const ctxWithK8s = {
        ...ctx,
        kubernetes: {
          options: { namespaces: ['default'] },
          state: {
            unhealthyPods: [],
            degradedDeployments: [],
            notReadyNodes: [],
            recentEvents: [],
            summary: {
              clusterName: 'default',
              namespaces: ['default'],
              pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
              deployments: { total: 0, healthy: 0, degraded: 0 },
              nodes: { total: 0, ready: 0, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      };

      const observations = await observer!.observe(ctxWithK8s as unknown as AgentContext);
      const errorObs = observations.find((o) => o.source === 'kubernetes/connection-error');
      expect(errorObs).toBeDefined();
      expect((errorObs?.data as { errorType: string }).errorType).toBe('unreachable');
    });
  });

  describe('analyzeClusterHealth orienter', () => {
    it('should produce findings from observations', async () => {
      const plugin = kubernetes({});
      const ctx = createMockContext();

      const observations: Observation[] = [
        {
          source: 'kubernetes/cluster-health',
          timestamp: new Date(),
          type: 'metric',
          data: {
            summary: {
              clusterName: 'test-cluster',
              namespaces: ['default'],
              pods: { total: 10, healthy: 8, unhealthy: 2, byPhase: { Running: 8, Pending: 2 } },
              deployments: { total: 5, healthy: 4, degraded: 1 },
              nodes: { total: 3, ready: 2, notReady: 1 },
              recentWarningEvents: 3,
            },
          },
        },
        {
          source: 'kubernetes/unhealthy-pod',
          timestamp: new Date(),
          type: 'event',
          severity: 'error',
          data: { namespace: 'default', pod: 'crash-pod', issue: 'CrashLoopBackOff', restarts: 5 },
        },
      ];

      const orienter = plugin.orienters?.analyzeClusterHealth;
      expect(orienter).toBeDefined();

      const assessment = await orienter!.orient(observations, ctx);
      expect(assessment.findings.length).toBeGreaterThan(0);
      expect(assessment.findings.some((f) => f.includes('crash-pod'))).toBe(true);
      expect(assessment.contributingFactor).toContain('crashes');
    });

    it('should report no issues when cluster is healthy', async () => {
      const plugin = kubernetes({});
      const ctx = createMockContext();

      const observations: Observation[] = [
        {
          source: 'kubernetes/cluster-health',
          timestamp: new Date(),
          type: 'metric',
          data: {
            summary: {
              clusterName: 'test-cluster',
              namespaces: ['default'],
              pods: { total: 10, healthy: 10, unhealthy: 0, byPhase: { Running: 10 } },
              deployments: { total: 5, healthy: 5, degraded: 0 },
              nodes: { total: 3, ready: 3, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      ];

      const orienter = plugin.orienters?.analyzeClusterHealth;
      const assessment = await orienter!.orient(observations, ctx);
      // When cluster is healthy, orienter reports summary without issue counts
      expect(assessment.findings.some((f) => f.includes('test-cluster'))).toBe(true);
      expect(assessment.findings.some((f) => f.includes('unhealthy'))).toBe(false);
      expect(assessment.findings.some((f) => f.includes('degraded'))).toBe(false);
      expect(assessment.findings.some((f) => f.includes('not ready'))).toBe(false);
    });
  });

  describe('actions', () => {
    describe('restartDeployment', () => {
      it('should restart deployment when readOnly is false', async () => {
        const plugin = kubernetes({ readOnly: false });
        const ctx = createMockContext();
        await plugin.init?.(ctx);

        const action = plugin.actions?.restartDeployment;
        expect(action).toBeDefined();

        const ctxWithK8s = {
          ...ctx,
          kubernetes: { options: { readOnly: false } },
        };

        const result = await action!.execute({ namespace: 'default', deployment: 'test-deploy' }, ctxWithK8s as unknown as AgentContext);
        expect(result.success).toBe(true);
        expect(result.output).toContain('restart initiated');
      });

      it('should fail when readOnly is true', async () => {
        const plugin = kubernetes({ readOnly: true });
        const ctx = createMockContext();
        await plugin.init?.(ctx);

        const action = plugin.actions?.restartDeployment;
        const ctxWithK8s = {
          ...ctx,
          kubernetes: { options: { readOnly: true } },
        };

        await expect(
          action!.execute({ namespace: 'default', deployment: 'test-deploy' }, ctxWithK8s as unknown as AgentContext)
        ).rejects.toThrow('read-only mode');
      });
    });

    describe('scaleDeployment', () => {
      it('should scale deployment when readOnly is false', async () => {
        const plugin = kubernetes({ readOnly: false });
        const ctx = createMockContext();
        await plugin.init?.(ctx);

        const action = plugin.actions?.scaleDeployment;
        const ctxWithK8s = {
          ...ctx,
          kubernetes: { options: { readOnly: false } },
        };

        const result = await action!.execute(
          { namespace: 'default', deployment: 'test-deploy', replicas: 5 },
          ctxWithK8s as unknown as AgentContext
        );
        expect(result.success).toBe(true);
        expect(result.output).toContain('scaled to 5 replicas');
      });
    });

    describe('deletePod', () => {
      it('should delete pod when readOnly is false', async () => {
        const plugin = kubernetes({ readOnly: false });
        const ctx = createMockContext();
        await plugin.init?.(ctx);

        const action = plugin.actions?.deletePod;
        const ctxWithK8s = {
          ...ctx,
          kubernetes: { options: { readOnly: false } },
        };

        const result = await action!.execute({ namespace: 'default', pod: 'test-pod' }, ctxWithK8s as unknown as AgentContext);
        expect(result.success).toBe(true);
        expect(result.output).toContain('deleted');
      });

      it('should treat not-found as success', async () => {
        setupErrorMockSpawn('Error from server (NotFound): pods "test-pod" not found', 1);

        const plugin = kubernetes({ readOnly: false });
        const ctx = createMockContext();
        await plugin.init?.(ctx);

        const action = plugin.actions?.deletePod;
        const ctxWithK8s = {
          ...ctx,
          kubernetes: { options: { readOnly: false } },
        };

        const result = await action!.execute({ namespace: 'default', pod: 'test-pod' }, ctxWithK8s as unknown as AgentContext);
        expect(result.success).toBe(true);
        expect(result.output).toContain('already deleted');
      });
    });

    describe('getLogs', () => {
      it('should get logs without readOnly restriction', async () => {
        const plugin = kubernetes({ readOnly: true });
        const ctx = createMockContext();
        await plugin.init?.(ctx);

        const action = plugin.actions?.getLogs;
        const ctxWithK8s = {
          ...ctx,
          kubernetes: { options: { readOnly: true } },
        };

        const result = await action!.execute({ namespace: 'default', pod: 'test-pod', tailLines: 50 }, ctxWithK8s as unknown as AgentContext);
        expect(result.success).toBe(true);
        expect((result.output as { logs: string }).logs).toContain('log line');
      });

      it('should truncate large logs', async () => {
        const largeLogs = 'x'.repeat(60000);
        // @ts-expect-error - Bun.spawn mock type is complex
        Bun.spawn = mock(() => createMockSpawnResult(largeLogs, '', 0));

        const plugin = kubernetes({ readOnly: true });
        const ctx = createMockContext();
        await plugin.init?.(ctx);

        const action = plugin.actions?.getLogs;
        const ctxWithK8s = {
          ...ctx,
          kubernetes: { options: { readOnly: true } },
        };

        const result = await action!.execute({ namespace: 'default', pod: 'test-pod' }, ctxWithK8s as unknown as AgentContext);
        expect(result.success).toBe(true);
        expect((result.output as { truncated: boolean }).truncated).toBe(true);
      });
    });
  });

  describe('error handling', () => {
    it('should detect kubectl not installed', async () => {
      setupErrorMockSpawn('command not found', 127);

      const plugin = kubernetes({});
      const ctx = createMockContext();
      await plugin.init?.(ctx);

      const observer = plugin.observers?.clusterHealth;
      const ctxWithK8s = {
        ...ctx,
        kubernetes: {
          options: {},
          state: {
            unhealthyPods: [],
            degradedDeployments: [],
            notReadyNodes: [],
            recentEvents: [],
            summary: {
              clusterName: 'default',
              namespaces: ['default'],
              pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
              deployments: { total: 0, healthy: 0, degraded: 0 },
              nodes: { total: 0, ready: 0, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      };

      const observations = await observer!.observe(ctxWithK8s as unknown as AgentContext);
      const errorObs = observations.find((o) => o.source === 'kubernetes/connection-error');
      expect(errorObs).toBeDefined();
      expect((errorObs?.data as { errorType: string }).errorType).toBe('not-installed');
    });

    it('should detect auth failure', async () => {
      setupErrorMockSpawn('error: You must be logged in to the server (Unauthorized)', 1);

      const plugin = kubernetes({});
      const ctx = createMockContext();
      await plugin.init?.(ctx);

      const observer = plugin.observers?.clusterHealth;
      const ctxWithK8s = {
        ...ctx,
        kubernetes: {
          options: {},
          state: {
            unhealthyPods: [],
            degradedDeployments: [],
            notReadyNodes: [],
            recentEvents: [],
            summary: {
              clusterName: 'default',
              namespaces: ['default'],
              pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
              deployments: { total: 0, healthy: 0, degraded: 0 },
              nodes: { total: 0, ready: 0, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      };

      const observations = await observer!.observe(ctxWithK8s as unknown as AgentContext);
      const errorObs = observations.find((o) => o.source === 'kubernetes/connection-error');
      expect(errorObs).toBeDefined();
      expect((errorObs?.data as { errorType: string }).errorType).toBe('auth-failed');
    });
  });

  describe('namespace filtering', () => {
    it('should exclude system namespaces by default when using all namespaces', async () => {
      const mockPodsWithSystem = {
        items: [
          {
            metadata: { name: 'user-pod', namespace: 'default', creationTimestamp: new Date().toISOString() },
            spec: {},
            status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] },
          },
          {
            metadata: { name: 'system-pod', namespace: 'kube-system', creationTimestamp: new Date().toISOString() },
            spec: {},
            status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] },
          },
        ],
      };

      // @ts-expect-error - Bun.spawn mock type is complex
      Bun.spawn = mock((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes('get pods')) {
          return createMockSpawnResult(JSON.stringify(mockPodsWithSystem), '', 0);
        } else if (cmd.includes('get deployments')) {
          return createMockSpawnResult(JSON.stringify({ items: [] }), '', 0);
        } else if (cmd.includes('get nodes')) {
          return createMockSpawnResult(JSON.stringify({ items: [] }), '', 0);
        } else if (cmd.includes('get events')) {
          return createMockSpawnResult(JSON.stringify({ items: [] }), '', 0);
        }
        return createMockSpawnResult('{}', '', 0);
      });

      const plugin = kubernetes({ namespaces: ['*'] });
      const ctx = createMockContext();
      await plugin.init?.(ctx);

      const observer = plugin.observers?.clusterHealth;
      const ctxWithK8s = {
        ...ctx,
        kubernetes: {
          options: { namespaces: ['*'], excludeSystemNamespaces: true },
          state: {
            unhealthyPods: [],
            degradedDeployments: [],
            notReadyNodes: [],
            recentEvents: [],
            summary: {
              clusterName: 'default',
              namespaces: ['*'],
              pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
              deployments: { total: 0, healthy: 0, degraded: 0 },
              nodes: { total: 0, ready: 0, notReady: 0 },
              recentWarningEvents: 0,
            },
          },
        },
      };

      const observations = await observer!.observe(ctxWithK8s as unknown as AgentContext);
      const summaryObs = observations.find((o) => o.source === 'kubernetes/cluster-health');
      const summary = (summaryObs?.data as { summary: { pods: { total: number } } }).summary;
      expect(summary.pods.total).toBe(1);
    });
  });
});
