import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { createAgent, type AgentContext, type LoopResult } from '../../index';
import { historianPlugin, type StoredIncident } from './index';

describe('Historian Plugin', () => {
  describe('plugin initialization', () => {
    test('initializes without SQLite configured', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        plugins: [historianPlugin()],
      });

      const capabilities = agent.getCapabilities();
      expect(capabilities.orienters).toContain('historian:historicalContext');
    });

    test('initializes with SQLite configured', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin()],
      });

      const ctx = agent.getContext();
      expect(ctx.sqlite).toBeDefined();

      const capabilities = agent.getCapabilities();
      expect(capabilities.orienters).toContain('historian:historicalContext');
    });

    test('creates incidents table when SQLite is configured', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin()],
      });

      const ctx = agent.getContext();
      const result = ctx.sqlite?.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='historian_incidents'`
      );
      expect(result?.name).toBe('historian_incidents');
    });
  });

  describe('incident storage', () => {
    test('stores incident on successful loop with high confidence', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin({ minConfidence: 0.5 })],
      });

      const ctx = agent.getContext();

      const mockLoopResult: LoopResult = {
        observations: [
          {
            source: 'test/observer',
            timestamp: new Date(),
            type: 'metric',
            severity: 'warning',
            data: { cpu: 90 },
          },
        ],
        situation: {
          summary: 'High CPU usage detected',
          assessments: [
            {
              source: 'test/orienter',
              findings: ['CPU is at 90%'],
              contributingFactor: 'Memory leak in application',
              confidence: 0.9,
            },
          ],
          anomalies: [],
          correlations: [],
          priority: 'high',
          confidence: 0.9,
        },
        decision: {
          action: 'restart-service',
          params: { service: 'api' },
          rationale: 'Restart to clear memory leak',
          confidence: 0.85,
          risk: 'low',
          requiresApproval: false,
        },
        actionResults: [
          {
            action: 'restart-service',
            success: true,
            output: 'Service restarted successfully',
            duration: 1000,
          },
        ],
        duration: 5000,
        success: true,
      };

      ctx.loop.iteration = 1;

      const plugins = (ctx.options.plugins ?? []) as { onLoopComplete?: (result: LoopResult, ctx: AgentContext) => Promise<void> }[];
      for (const plugin of plugins) {
        if (plugin.onLoopComplete) {
          await plugin.onLoopComplete(mockLoopResult, ctx);
        }
      }

      const incidents = ctx.sqlite?.query<StoredIncident>(
        `SELECT * FROM historian_incidents`
      );
      expect(incidents).toHaveLength(1);
      expect(incidents?.[0]?.incident_summary).toContain('High CPU usage');
      expect(incidents?.[0]?.contributing_factor).toBe('Memory leak in application');
      expect(incidents?.[0]?.decision_confidence).toBe(0.85);
    });

    test('skips storage when confidence is below threshold', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin({ minConfidence: 0.9 })],
      });

      const ctx = agent.getContext();

      const mockLoopResult: LoopResult = {
        observations: [],
        situation: {
          summary: 'Test situation',
          assessments: [],
          anomalies: [],
          correlations: [],
          priority: 'low',
          confidence: 0.5,
        },
        decision: {
          action: 'test-action',
          params: {},
          rationale: 'Test rationale',
          confidence: 0.5,
          risk: 'low',
          requiresApproval: false,
        },
        actionResults: [
          {
            action: 'test-action',
            success: true,
            output: 'Done',
            duration: 100,
          },
        ],
        duration: 1000,
        success: true,
      };

      ctx.loop.iteration = 1;

      const plugins = (ctx.options.plugins ?? []) as { onLoopComplete?: (result: LoopResult, ctx: AgentContext) => Promise<void> }[];
      for (const plugin of plugins) {
        if (plugin.onLoopComplete) {
          await plugin.onLoopComplete(mockLoopResult, ctx);
        }
      }

      const incidents = ctx.sqlite?.query<StoredIncident>(
        `SELECT * FROM historian_incidents`
      );
      expect(incidents).toHaveLength(0);
    });

    test('skips storage for no-op decisions', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin({ minConfidence: 0.5 })],
      });

      const ctx = agent.getContext();

      const mockLoopResult: LoopResult = {
        observations: [],
        decision: {
          action: 'no-op',
          params: {},
          rationale: 'Nothing to do',
          confidence: 0.9,
          risk: 'low',
          requiresApproval: false,
        },
        actionResults: [],
        duration: 1000,
        success: true,
      };

      ctx.loop.iteration = 1;

      const plugins = (ctx.options.plugins ?? []) as { onLoopComplete?: (result: LoopResult, ctx: AgentContext) => Promise<void> }[];
      for (const plugin of plugins) {
        if (plugin.onLoopComplete) {
          await plugin.onLoopComplete(mockLoopResult, ctx);
        }
      }

      const incidents = ctx.sqlite?.query<StoredIncident>(
        `SELECT * FROM historian_incidents`
      );
      expect(incidents).toHaveLength(0);
    });

    test('skips storage for high-risk actions by default', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin({ minConfidence: 0.5, includeHighRisk: false })],
      });

      const ctx = agent.getContext();

      const mockLoopResult: LoopResult = {
        observations: [],
        situation: {
          summary: 'Test situation',
          assessments: [],
          anomalies: [],
          correlations: [],
          priority: 'high',
          confidence: 0.9,
        },
        decision: {
          action: 'dangerous-action',
          params: {},
          rationale: 'Risky operation',
          confidence: 0.9,
          risk: 'high',
          requiresApproval: true,
        },
        actionResults: [
          {
            action: 'dangerous-action',
            success: true,
            output: 'Done',
            duration: 100,
          },
        ],
        duration: 1000,
        success: true,
      };

      ctx.loop.iteration = 1;

      const plugins = (ctx.options.plugins ?? []) as { onLoopComplete?: (result: LoopResult, ctx: AgentContext) => Promise<void> }[];
      for (const plugin of plugins) {
        if (plugin.onLoopComplete) {
          await plugin.onLoopComplete(mockLoopResult, ctx);
        }
      }

      const incidents = ctx.sqlite?.query<StoredIncident>(
        `SELECT * FROM historian_incidents`
      );
      expect(incidents).toHaveLength(0);
    });

    test('stores high-risk actions when includeHighRisk is true', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin({ minConfidence: 0.5, includeHighRisk: true })],
      });

      const ctx = agent.getContext();

      const mockLoopResult: LoopResult = {
        observations: [],
        situation: {
          summary: 'Test situation',
          assessments: [],
          anomalies: [],
          correlations: [],
          priority: 'high',
          confidence: 0.9,
        },
        decision: {
          action: 'dangerous-action',
          params: {},
          rationale: 'Risky operation',
          confidence: 0.9,
          risk: 'high',
          requiresApproval: true,
        },
        actionResults: [
          {
            action: 'dangerous-action',
            success: true,
            output: 'Done',
            duration: 100,
          },
        ],
        duration: 1000,
        success: true,
      };

      ctx.loop.iteration = 1;

      const plugins = (ctx.options.plugins ?? []) as { onLoopComplete?: (result: LoopResult, ctx: AgentContext) => Promise<void> }[];
      for (const plugin of plugins) {
        if (plugin.onLoopComplete) {
          await plugin.onLoopComplete(mockLoopResult, ctx);
        }
      }

      const incidents = ctx.sqlite?.query<StoredIncident>(
        `SELECT * FROM historian_incidents`
      );
      expect(incidents).toHaveLength(1);
    });
  });

  describe('historical context orienter', () => {
    test('returns no-history assessment when no incidents exist', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin()],
      });

      const ctx = agent.getContext();
      const orienter = ctx.capabilities.orienters.get('historian:historicalContext');

      const assessment = await orienter?.orient([], ctx);
      expect(assessment?.source).toBe('historian/no-history');
      expect(assessment?.findings).toContain('No historical incidents recorded yet');
    });

    test('finds similar incidents using text search', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        sqlite: { path: ':memory:' },
        plugins: [historianPlugin({ minConfidence: 0.5 })],
      });

      const ctx = agent.getContext();

      ctx.sqlite?.run(
        `INSERT INTO historian_incidents (
          agent_id, loop_iteration, incident_summary, contributing_factor, resolution_summary,
          decision_confidence, decision_risk, action_success,
          observations_json, situation_json, decision_json, action_results_json
        ) VALUES (
          $agent_id, $loop_iteration, $incident_summary, $contributing_factor, $resolution_summary,
          $decision_confidence, $decision_risk, $action_success,
          $observations_json, $situation_json, $decision_json, $action_results_json
        )`,
        {
          agent_id: 'test-agent',
          loop_iteration: 1,
          incident_summary: 'High CPU usage detected on api-server. Restarted service to resolve memory issues.',
          contributing_factor: 'Memory leak in application',
          resolution_summary: 'Restarted the api-server service',
          decision_confidence: 0.9,
          decision_risk: 'low',
          action_success: 1,
          observations_json: '[]',
          situation_json: '{}',
          decision_json: '{}',
          action_results_json: '[]',
        }
      );

      const orienter = ctx.capabilities.orienters.get('historian:historicalContext');

      // The text search looks for keywords > 3 chars from the observation summary
      // We need to include keywords that match the stored incident
      const assessment = await orienter?.orient(
        [
          {
            source: 'metrics/cpu-monitor',
            timestamp: new Date(),
            type: 'metric',
            severity: 'warning',
            data: { message: 'High CPU usage detected on api-server, possible memory issues' },
          },
        ],
        ctx
      );

      expect(assessment?.source).toBe('historian/similar-incidents');
      expect(assessment?.findings.length).toBeGreaterThan(0);
      expect(assessment?.contributingFactor).toBe('Memory leak in application');
    });
  });
});
