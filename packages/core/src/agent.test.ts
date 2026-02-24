/**
 * Tests for Zup Agent
 */

import { describe, test, expect } from 'bun:test';
import { createAgent } from './agent';
import { definePlugin, createObserver, createAction } from './plugin';
import type { Observation } from './types/index';

describe('Zup Agent', () => {
  test('should create agent with default options', async () => {
    const agent = await createAgent();
    const ctx = agent.getContext();

    expect(ctx.agent.name).toBe('Zup');
    expect(ctx.agent.model).toBe('claude-3-5-sonnet');
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

  test('should manage state', async () => {
    const agent = await createAgent();
    const state = agent.getState();

    state.set('key1', 'value1');
    expect(state.get('key1')).toBe('value1');
    expect(state.has('key1')).toBe(true);

    state.delete('key1');
    expect(state.has('key1')).toBe(false);
  });
});
