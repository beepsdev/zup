import { describe, test, expect } from 'bun:test';
import { matchPlaybooks } from './matcher';
import type { Playbook } from './types';
import type { Observation } from '../types/observation';

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'test',
    name: 'Test Playbook',
    description: 'Test',
    phases: ['orient', 'decide'],
    priority: 0,
    content: 'Test content',
    source: 'inline',
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    source: 'test:observer',
    timestamp: new Date(),
    type: 'state',
    data: {},
    ...overrides,
  };
}

describe('matchPlaybooks', () => {
  test('matches playbook with no trigger (catch-all)', () => {
    const pb = makePlaybook({ trigger: undefined });
    const result = matchPlaybooks([pb], [makeObservation()], 'orient');
    expect(result).toHaveLength(1);
  });

  test('matches playbook with empty trigger object', () => {
    const pb = makePlaybook({ trigger: {} });
    const result = matchPlaybooks([pb], [makeObservation()], 'orient');
    expect(result).toHaveLength(1);
  });

  test('filters by phase', () => {
    const orientOnly = makePlaybook({ id: 'orient', phases: ['orient'] });
    const decideOnly = makePlaybook({ id: 'decide', phases: ['decide'] });
    const both = makePlaybook({ id: 'both', phases: ['orient', 'decide'] });

    const orientResult = matchPlaybooks([orientOnly, decideOnly, both], [makeObservation()], 'orient');
    expect(orientResult.map(p => p.id)).toEqual(['orient', 'both']);

    const decideResult = matchPlaybooks([orientOnly, decideOnly, both], [makeObservation()], 'decide');
    expect(decideResult.map(p => p.id)).toEqual(['decide', 'both']);
  });

  describe('severity trigger', () => {
    test('matches when observation meets threshold', () => {
      const pb = makePlaybook({ trigger: { severity: 'warning' } });
      const obs = makeObservation({ severity: 'error' });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(1);
    });

    test('matches at exact threshold', () => {
      const pb = makePlaybook({ trigger: { severity: 'warning' } });
      const obs = makeObservation({ severity: 'warning' });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(1);
    });

    test('does not match below threshold', () => {
      const pb = makePlaybook({ trigger: { severity: 'error' } });
      const obs = makeObservation({ severity: 'warning' });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(0);
    });

    test('does not match observations without severity', () => {
      const pb = makePlaybook({ trigger: { severity: 'info' } });
      const obs = makeObservation({ severity: undefined });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(0);
    });
  });

  describe('keyword trigger', () => {
    test('matches keyword in observation data', () => {
      const pb = makePlaybook({ trigger: { keywords: ['error rate'] } });
      const obs = makeObservation({ data: { message: 'High error rate detected' } });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(1);
    });

    test('matches keyword case-insensitively', () => {
      const pb = makePlaybook({ trigger: { keywords: ['CPU'] } });
      const obs = makeObservation({ data: { metric: 'cpu_usage' } });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(1);
    });

    test('matches keyword in observation source', () => {
      const pb = makePlaybook({ trigger: { keywords: ['kubernetes'] } });
      const obs = makeObservation({ source: 'kubernetes:pods' });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(1);
    });

    test('does not match when no keywords found', () => {
      const pb = makePlaybook({ trigger: { keywords: ['database'] } });
      const obs = makeObservation({ data: { message: 'CPU spike' } });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(0);
    });
  });

  describe('source trigger', () => {
    test('matches source prefix', () => {
      const pb = makePlaybook({ trigger: { sources: ['http-monitor'] } });
      const obs = makeObservation({ source: 'http-monitor:healthCheck' });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(1);
    });

    test('does not match different source', () => {
      const pb = makePlaybook({ trigger: { sources: ['kubernetes'] } });
      const obs = makeObservation({ source: 'http-monitor:healthCheck' });
      const result = matchPlaybooks([pb], [obs], 'orient');
      expect(result).toHaveLength(0);
    });
  });

  describe('custom trigger', () => {
    test('matches when custom function returns true', () => {
      const pb = makePlaybook({
        trigger: { custom: (obs) => obs.length > 2 },
      });
      const obs = [makeObservation(), makeObservation(), makeObservation()];
      const result = matchPlaybooks([pb], obs, 'orient');
      expect(result).toHaveLength(1);
    });

    test('does not match when custom function returns false', () => {
      const pb = makePlaybook({
        trigger: { custom: () => false },
      });
      const result = matchPlaybooks([pb], [makeObservation()], 'orient');
      expect(result).toHaveLength(0);
    });

    test('passes situation to custom function', () => {
      let receivedSituation: unknown;
      const pb = makePlaybook({
        trigger: {
          custom: (_obs, situation) => {
            receivedSituation = situation;
            return true;
          },
        },
      });
      const situation = { summary: 'test', assessments: [], anomalies: [], correlations: [], priority: 'high' as const, confidence: 0.8 };
      matchPlaybooks([pb], [makeObservation()], 'orient', situation);
      expect(receivedSituation).toBe(situation);
    });

    test('treats throwing custom function as non-match', () => {
      const pb = makePlaybook({
        trigger: {
          custom: () => { throw new Error('boom'); },
        },
      });
      const result = matchPlaybooks([pb], [makeObservation()], 'orient');
      expect(result).toHaveLength(0);
    });
  });

  describe('AND logic', () => {
    test('requires all specified conditions to match', () => {
      const pb = makePlaybook({
        trigger: {
          severity: 'warning',
          keywords: ['database'],
        },
      });

      // Severity matches but keyword doesn't
      const obs1 = makeObservation({ severity: 'error', data: { msg: 'CPU high' } });
      expect(matchPlaybooks([pb], [obs1], 'orient')).toHaveLength(0);

      // Keyword matches but severity doesn't
      const obs2 = makeObservation({ severity: 'info', data: { msg: 'database slow' } });
      expect(matchPlaybooks([pb], [obs2], 'orient')).toHaveLength(0);

      // Both match
      const obs3 = makeObservation({ severity: 'error', data: { msg: 'database down' } });
      expect(matchPlaybooks([pb], [obs3], 'orient')).toHaveLength(1);
    });
  });

  describe('priority sorting', () => {
    test('sorts by priority descending', () => {
      const low = makePlaybook({ id: 'low', priority: 1 });
      const high = makePlaybook({ id: 'high', priority: 10 });
      const mid = makePlaybook({ id: 'mid', priority: 5 });

      const result = matchPlaybooks([low, high, mid], [makeObservation()], 'orient');
      expect(result.map(p => p.id)).toEqual(['high', 'mid', 'low']);
    });
  });

  test('returns empty for empty playbooks', () => {
    const result = matchPlaybooks([], [makeObservation()], 'orient');
    expect(result).toEqual([]);
  });

  test('returns empty for empty observations with severity trigger', () => {
    const pb = makePlaybook({ trigger: { severity: 'warning' } });
    const result = matchPlaybooks([pb], [], 'orient');
    expect(result).toHaveLength(0);
  });
});
