/**
 * Historian Plugin Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../agent';
import { definePlugin, createObserver, createDecisionStrategy, createAction } from '../../plugin';
import { parsePlaybook, matchPlaybooks } from '../../playbook';
import { historianPlugin } from './index';
import type { Observation } from '../../types/index';

const OBSERVATION: Observation = {
  source: 'http-monitor/health',
  timestamp: new Date(),
  type: 'state',
  severity: 'critical',
  data: { status: 'down', endpoint: 'api', error: 'connection timeout' },
};

/** A plugin that observes a failing service, decides to restart it, and succeeds. */
function incidentPlugin(opts: { confidence?: number; risk?: 'low' | 'high'; succeed?: boolean; action?: string } = {}) {
  const { confidence = 0.9, risk = 'low', succeed = true, action = 'test:restart' } = opts;
  return definePlugin({
    id: 'test',
    observers: {
      health: createObserver({
        name: 'health',
        description: 'Emits a failing health observation',
        observe: async () => [OBSERVATION],
      }),
    },
    decisionStrategies: {
      restart: createDecisionStrategy({
        name: 'restart',
        description: 'Always restarts',
        decide: async () => ({
          action,
          params: {},
          rationale: 'Service is down after deploy, restarting',
          confidence,
          risk,
          requiresApproval: false,
        }),
      }),
    },
    actions: {
      restart: createAction({
        name: 'restart',
        description: 'Restart the service',
        execute: async () => ({
          action: 'restart',
          success: succeed,
          error: succeed ? undefined : 'restart failed',
          duration: 5,
        }),
      }),
    },
  });
}

describe('Historian Plugin', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'historian-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function incidentFiles(): Promise<string[]> {
    return (await readdir(dir)).filter(f => f.endsWith('.md'));
  }

  test('records a successful resolution as a parseable playbook file', async () => {
    const agent = await createAgent({
      plugins: [incidentPlugin(), historianPlugin({ dir })],
    });

    await agent.runLoop();

    const files = await incidentFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith('incident-');

    const raw = await Bun.file(join(dir, files[0]!)).text();
    const playbook = parsePlaybook(raw, { source: 'filesystem', sourcePath: files[0] });

    expect(playbook.description.length).toBeGreaterThan(0);
    expect(playbook.trigger?.keywords?.length).toBeGreaterThan(0);
    expect(playbook.trigger?.sources).toContain('http-monitor/health');
    expect(playbook.priority).toBeLessThan(0);
    expect(playbook.content).toContain('test:restart');
    expect(playbook.content).toContain('## Lesson');
  });

  test('recorded incident matches similar future observations', async () => {
    const agent = await createAgent({
      plugins: [incidentPlugin(), historianPlugin({ dir })],
    });

    await agent.runLoop();

    // Incident is live in ctx.playbooks immediately, without a restart
    const ctx = agent.getContext();
    const incidents = ctx.playbooks.filter(p => p.id.startsWith('incident-'));
    expect(incidents).toHaveLength(1);

    const matched = matchPlaybooks(ctx.playbooks, [OBSERVATION], 'orient');
    expect(matched.map(p => p.id)).toContain(incidents[0]!.id);

    // An unrelated observation does not match
    const unrelated: Observation = {
      source: 'unrelated/source',
      timestamp: new Date(),
      type: 'state',
      severity: 'critical',
      data: { note: 'nothing in common whatsoever' },
    };
    const unmatched = matchPlaybooks(ctx.playbooks, [unrelated], 'orient');
    expect(unmatched.map(p => p.id)).not.toContain(incidents[0]!.id);
  });

  test('historicalContext orienter surfaces similar incidents as findings', async () => {
    const agent = await createAgent({
      plugins: [incidentPlugin(), historianPlugin({ dir })],
    });

    // First loop records the incident; second loop should surface it
    await agent.runLoop();
    const second = await agent.runLoop();

    const historianAssessment = second.situation?.assessments.find(
      a => a.source === 'historian/similar-incidents'
    );
    expect(historianAssessment).toBeDefined();
    expect(historianAssessment!.findings[0]).toContain('Similar past incident:');
    expect(historianAssessment!.findings[0]).toContain('Lesson:');
  });

  test('loads previously recorded incidents on startup', async () => {
    const first = await createAgent({ plugins: [incidentPlugin(), historianPlugin({ dir })] });
    await first.runLoop();
    expect(await incidentFiles()).toHaveLength(1);

    // A fresh agent — as after a restart — sees the recorded incident
    const second = await createAgent({ plugins: [incidentPlugin(), historianPlugin({ dir })] });
    const incidents = second.getContext().playbooks.filter(p => p.id.startsWith('incident-'));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.pluginId).toBe('historian');
  });

  test('skips no-op decisions', async () => {
    const noopPlugin = definePlugin({
      id: 'test',
      observers: {
        health: createObserver({
          name: 'health',
          description: 'Emits an observation',
          observe: async () => [OBSERVATION],
        }),
      },
    });
    const agent = await createAgent({ plugins: [noopPlugin, historianPlugin({ dir })] });
    await agent.runLoop();
    expect(await incidentFiles()).toHaveLength(0);
  });

  test('skips low-confidence resolutions', async () => {
    const agent = await createAgent({
      plugins: [incidentPlugin({ confidence: 0.4 }), historianPlugin({ dir })],
    });
    await agent.runLoop();
    expect(await incidentFiles()).toHaveLength(0);
  });

  test('skips failed actions', async () => {
    const agent = await createAgent({
      plugins: [incidentPlugin({ succeed: false }), historianPlugin({ dir })],
    });
    await agent.runLoop();
    expect(await incidentFiles()).toHaveLength(0);
  });

  test('skips high-risk actions by default, records them when includeHighRisk', async () => {
    const excluded = await createAgent({
      plugins: [incidentPlugin({ risk: 'high' }), historianPlugin({ dir })],
    });
    await excluded.runLoop();
    expect(await incidentFiles()).toHaveLength(0);

    const included = await createAgent({
      plugins: [incidentPlugin({ risk: 'high' }), historianPlugin({ dir, includeHighRisk: true })],
    });
    await included.runLoop();
    expect(await incidentFiles()).toHaveLength(1);
  });

  test('uses the LLM narrative when an LLM is available', async () => {
    const agent = await createAgent({
      plugins: [incidentPlugin(), historianPlugin({ dir })],
    });

    // Stub the LLM capability with a canned structured response
    agent.getContext().llm = {
      generateStructured: async () => ({
        description: 'API went down after deploy; restart fixed it',
        keywords: ['api down', '5xx', 'deploy', 'connection timeout'],
        lesson: 'Check recent deploys before restarting.',
      }),
    } as unknown as NonNullable<ReturnType<typeof agent.getContext>['llm']>;

    await agent.runLoop();

    const files = await incidentFiles();
    expect(files).toHaveLength(1);
    const raw = await Bun.file(join(dir, files[0]!)).text();
    const playbook = parsePlaybook(raw);

    expect(playbook.description).toBe('API went down after deploy; restart fixed it');
    expect(playbook.trigger?.keywords).toContain('api down');
    expect(playbook.content).toContain('Check recent deploys before restarting.');
  });

  test('falls back to deterministic narrative when the LLM call fails', async () => {
    const agent = await createAgent({
      plugins: [incidentPlugin(), historianPlugin({ dir })],
    });

    agent.getContext().llm = {
      generateStructured: async () => {
        throw new Error('LLM unavailable');
      },
    } as unknown as NonNullable<ReturnType<typeof agent.getContext>['llm']>;

    await agent.runLoop();

    const files = await incidentFiles();
    expect(files).toHaveLength(1);
    const raw = await Bun.file(join(dir, files[0]!)).text();
    const playbook = parsePlaybook(raw);
    expect(playbook.trigger?.keywords).toContain('restart');
  });

  test('caps loaded incidents at maxIncidents, keeping the newest', async () => {
    for (let i = 0; i < 3; i++) {
      const stamp = `2026010100000${i}`;
      await Bun.write(
        join(dir, `incident-${stamp}-old.md`),
        `---\nname: Incident ${i}\ndescription: Incident number ${i}\ntrigger:\n  keywords: [test]\n---\nBody ${i}\n`
      );
    }

    const agent = await createAgent({
      plugins: [historianPlugin({ dir, maxIncidents: 2 })],
    });

    const incidents = agent.getContext().playbooks.filter(p => p.id.startsWith('incident-'));
    expect(incidents).toHaveLength(2);
    const ids = incidents.map(p => p.id);
    expect(ids).toContain('incident-20260101000002-old');
    expect(ids).toContain('incident-20260101000001-old');
  });
});
