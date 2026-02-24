/**
 * Run API Routes
 *
 * REST endpoints for managing externally-submitted runs.
 */

import type { ZupAgent } from '../agent';
import type { RouteHandler } from './types';
import type { CreateRunInput } from '../types/run';
import { json, error, parseBody } from './helpers';
import { createRun, getRun, listRuns, updateRunStatus } from '../runs';

/**
 * Register run API routes
 */
export function registerRunRoutes(
  route: (method: string, path: string, handler: RouteHandler, auth?: boolean) => void,
  agent: ZupAgent
) {
  /**
   * POST /runs - Create a new run
   */
  route('POST', '/runs', async (ctx) => {
    const body = await parseBody<CreateRunInput>(ctx.request);
    if (!body) {
      return error('Request body is required', 400);
    }

    if (!body.title || typeof body.title !== 'string') {
      return error('title is required and must be a string', 400);
    }

    if (!body.description || typeof body.description !== 'string') {
      return error('description is required and must be a string', 400);
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (body.priority && !validPriorities.includes(body.priority)) {
      return error(`priority must be one of: ${validPriorities.join(', ')}`, 400);
    }

    const run = createRun(ctx.context, {
      title: body.title,
      description: body.description,
      priority: body.priority,
      context: body.context,
      source: body.source,
      callbackUrl: body.callbackUrl,
    });

    // Auto-trigger loop for manual/event-driven modes
    const mode = ctx.context.options.mode || 'manual';
    if (mode === 'manual' || mode === 'event-driven') {
      agent.runLoop().catch(err => {
        ctx.context.logger.error('Auto-triggered loop failed:', err);
      });
    }

    return json({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
    }, 201);
  });

  /**
   * GET /runs - List runs
   */
  route('GET', '/runs', async (ctx) => {
    const url = new URL(ctx.request.url);
    const status = url.searchParams.get('status') as CreateRunInput['priority'] | null;
    const limitStr = url.searchParams.get('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const validStatuses = ['pending', 'investigating', 'completed', 'failed', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      return error(`status must be one of: ${validStatuses.join(', ')}`, 400);
    }

    const runs = listRuns(ctx.context, {
      status: status as 'pending' | 'investigating' | 'completed' | 'failed' | 'cancelled' | undefined,
      limit: limit && limit > 0 ? limit : undefined,
    });

    return json({
      runs,
      total: runs.length,
    });
  });

  /**
   * GET /runs/:runId - Get a specific run
   */
  route('GET', '/runs/:runId', async (ctx) => {
    const runId = ctx.params.runId;
    if (!runId) {
      return error('Run ID is required', 400);
    }

    const run = getRun(ctx.context, runId);
    if (!run) {
      return error('Run not found', 404);
    }

    return json(run);
  });

  /**
   * POST /runs/:runId/cancel - Cancel a run
   */
  route('POST', '/runs/:runId/cancel', async (ctx) => {
    const runId = ctx.params.runId;
    if (!runId) {
      return error('Run ID is required', 400);
    }

    const run = getRun(ctx.context, runId);
    if (!run) {
      return error('Run not found', 404);
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return error(`Cannot cancel run with status: ${run.status}`, 400);
    }

    const updated = updateRunStatus(ctx.context, runId, 'cancelled');
    if (!updated) {
      return error('Failed to cancel run', 500);
    }

    return json({
      id: updated.id,
      status: updated.status,
      updatedAt: updated.updatedAt,
    });
  });
}
