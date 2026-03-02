/**
 * Cloud Run Plugin Tests
 */

import { describe, test, expect } from 'bun:test';
import { createAgent } from '../../index';
import { cloudRun } from './index';

describe('Cloud Run Plugin', () => {
  test('should initialize with valid configuration', async () => {
    const agent = await createAgent({
      plugins: [
        cloudRun({
          projects: [
            {
              projectId: 'test-project',
              regions: ['us-central1'],
            },
          ],
        }),
      ],
    });

    const ctx = agent.getContext();
    expect(ctx.cloudRun).toBeDefined();
  });

  test('should throw if no projects configured', async () => {
    expect(async () => {
      await createAgent({
        plugins: [
          cloudRun({
            projects: [],
          }),
        ],
      });
    }).toThrow('At least one project must be configured');
  });

  test('should throw if project has no regions', async () => {
    expect(async () => {
      await createAgent({
        plugins: [
          cloudRun({
            projects: [
              {
                projectId: 'test-project',
                regions: [] as string[],
              },
            ],
          }),
        ],
      });
    }).toThrow('must specify at least one region');
  });
});
