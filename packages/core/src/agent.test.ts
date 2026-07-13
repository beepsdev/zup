/**
 * Tests for Zup Agent
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAgent } from './agent';
import { definePlugin, createObserver, createAction } from './plugin';
import type { Observation } from './types/index';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Zup Agent', () => {
  test('should create agent with default options', async () => {
    const agent = await createAgent();
    const ctx = agent.getContext();

    expect(ctx.agent.name).toBe('Zup');
    expect(ctx.agent.model).toBe('claude-sonnet-4-6');
    expect(ctx.loop.iteration).toBe(0);
    expect(ctx.loop.phase).toBe('idle');
  });

  test('should create agent with custom options', async () => {
    const agent = await createAgent({
      name: 'Test Agent',
      model: 'gpt-4',
    });
    const ctx = agent.getContext();

    expect(ctx.agent.name).toBe('Test Agent');
    expect(ctx.agent.model).toBe('gpt-4');
  });

  test('should register plugin capabilities', async () => {
    const testPlugin = definePlugin({
      id: 'test',
      observers: {
        testObserver: createObserver({
          name: 'test-observer',
          description: 'Test observer',
          observe: async () => [],
        }),
      },
      actions: {
        testAction: createAction({
          name: 'test-action',
          description: 'Test action',
          execute: async () => ({
            action: 'test-action',
            success: true,
            duration: 0,
          }),
        }),
      },
    });

    const agent = await createAgent({
      plugins: [testPlugin],
    });

    const capabilities = agent.getCapabilities();

    expect(capabilities.observers).toContain('test:testObserver');
    expect(capabilities.actions).toContain('test:testAction');
  });

  test('should run OODA loop', async () => {
    const observations: Observation[] = [];

    const testPlugin = definePlugin({
      id: 'test',
      observers: {
        testObserver: createObserver({
          name: 'test',
          description: 'Test',
          observe: async () => {
            const obs: Observation = {
              source: 'test',
              timestamp: new Date(),
              type: 'state',
              severity: 'info',
              data: { test: true },
            };
            observations.push(obs);
            return [obs];
          },
        }),
      },
    });

    const agent = await createAgent({
      plugins: [testPlugin],
    });

    const result = await agent.runLoop();

    expect(result.success).toBe(true);
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations[0]?.data.test).toBe(true);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('should not enforce observer intervals in manual mode', async () => {
    let callCount = 0;

    const testPlugin = definePlugin({
      id: 'test',
      observers: {
        intervalObserver: createObserver({
          name: 'interval-observer',
          description: 'Interval observer',
          interval: 60000,
          observe: async () => {
            callCount += 1;
            const obs: Observation = {
              source: 'test/interval',
              timestamp: new Date(),
              type: 'state',
              severity: 'info',
              data: { count: callCount },
            };
            return [obs];
          },
        }),
      },
    });

    const agent = await createAgent({
      plugins: [testPlugin],
    });

    await agent.runLoop();
    await agent.runLoop();

    expect(callCount).toBe(2);
  });

  test('should enforce observer intervals in continuous mode', async () => {
    let callCount = 0;

    const testPlugin = definePlugin({
      id: 'test',
      observers: {
        intervalObserver: createObserver({
          name: 'interval-observer',
          description: 'Interval observer',
          interval: 60000,
          observe: async () => {
            callCount += 1;
            const obs: Observation = {
              source: 'test/interval',
              timestamp: new Date(),
              type: 'state',
              severity: 'info',
              data: { count: callCount },
            };
            return [obs];
          },
        }),
      },
    });

    const agent = await createAgent({
      mode: 'continuous',
      plugins: [testPlugin],
    });

    await agent.runLoop();
    await agent.runLoop();

    expect(callCount).toBe(1);
  });

  test('should execute plugin init hook', async () => {
    let initCalled = false;

    const testPlugin = definePlugin({
      id: 'test',
      init: async (ctx) => {
        initCalled = true;
        return {
          context: {
            testData: 'hello',
          },
        };
      },
    });

    const agent = await createAgent({
      plugins: [testPlugin],
    });

    expect(initCalled).toBe(true);

    const ctx = agent.getContext();
    expect(ctx.testData).toBe('hello');
  });

  test('should track loop history', async () => {
    const agent = await createAgent();

    expect(agent.getHistory().length).toBe(0);

    await agent.runLoop();
    expect(agent.getHistory().length).toBe(1);

    await agent.runLoop();
    expect(agent.getHistory().length).toBe(2);
  });

  test('should cap loop history at maxHistory', async () => {
    let iteration = 0;

    const testPlugin = definePlugin({
      id: 'test',
      observers: {
        iterationObserver: createObserver({
          name: 'iteration-observer',
          description: 'Tags each loop with its iteration number',
          observe: async () => {
            iteration += 1;
            const obs: Observation = {
              source: 'test/iteration',
              timestamp: new Date(),
              type: 'state',
              severity: 'info',
              data: { iteration },
            };
            return [obs];
          },
        }),
      },
    });

    const agent = await createAgent({
      plugins: [testPlugin],
      maxHistory: 3,
    });

    const history = agent.getHistory();

    for (let i = 0; i < 7; i++) {
      await agent.runLoop();
    }

    expect(history.length).toBe(3);

    // History should contain the most recent results (iterations 5, 6, 7)
    const iterations = history.map(r => r.observations[0]?.data.iteration);
    expect(iterations).toEqual([5, 6, 7]);

    // getHistory() still returns the same (in-place trimmed) array
    expect(agent.getHistory()).toBe(history);
  });

  test('should manage state', async () => {
    const agent = await createAgent();
    const state = agent.getState();

    state.set('key1', 'value1');
    expect(state.get('key1')).toBe('value1');
    expect(state.has('key1')).toBe(true);

    state.delete('key1');
    expect(state.has('key1')).toBe(false);
  });

  test('stop() clears the continuous-mode timer', async () => {
    const agent = await createAgent({
      mode: 'continuous',
      loopInterval: 10,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    await agent.start();
    await sleep(60);
    await agent.stop();

    const iterationsAtStop = agent.getContext().loop.iteration;
    expect(iterationsAtStop).toBeGreaterThan(0);

    await sleep(60);
    expect(agent.getContext().loop.iteration).toBe(iterationsAtStop);
  });

  test('stop() is idempotent', async () => {
    const agent = await createAgent({
      mode: 'continuous',
      loopInterval: 10,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    await agent.start();
    await agent.stop();
    await agent.stop();

    // Also safe on an agent that was never started
    const manualAgent = await createAgent();
    await manualAgent.stop();
    await manualAgent.stop();
  });

  test('stop() flushes persisted state without waiting for the debounce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zup-state-'));
    const statePath = join(dir, 'zup.state.json');

    try {
      const agent = await createAgent({
        statePersistence: {
          enabled: true,
          type: 'file',
          config: { path: statePath }, // default 1s debounce
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      });

      agent.getState().set('approval', 'pending');
      await agent.stop();

      const persisted = JSON.parse(await Bun.file(statePath).text()) as {
        entries: Array<[string, unknown]>;
      };
      expect(new Map(persisted.entries).get('approval')).toBe('pending');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
