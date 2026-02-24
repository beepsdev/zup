/**
 * Core API Routes
 *
 * Standard REST endpoints for the agent
 */

import type { ZupAgent } from '../agent';
import type { RouteHandler } from './types';
import { json, error, parseBody } from './helpers';
import { getApprovalQueue, resolveApproval, purgeExpiredApprovals, enqueueApproval, DEFAULT_APPROVAL_TTL_MS } from '../utils/approvals';

/**
 * Register core API routes
 */
export function registerCoreRoutes(
  route: (method: string, path: string, handler: RouteHandler, auth?: boolean) => void,
  agent: ZupAgent
) {
  /**
   * POST /loop/trigger - Trigger OODA loop
   */
  route('POST', '/loop/trigger', async (ctx) => {
    const body = await parseBody(ctx.request);
    const triggerContext = body && typeof body === 'object' && 'context' in body && typeof body.context === 'string'
      ? body.context
      : undefined;

    try {
      const result = await agent.runLoop();
      return json({
        success: true,
        result: {
          observations: result.observations.length,
          situation: result.situation?.summary,
          decision: result.decision?.action,
          actionResults: result.actionResults.length,
          duration: result.duration,
        },
        context: triggerContext,
      });
    } catch (err) {
      return error(
        err instanceof Error ? err.message : 'Failed to run loop',
        500
      );
    }
  });

  /**
   * GET /loop/status - Get loop status
   */
  route('GET', '/loop/status', async (ctx) => {
    return json({
      phase: ctx.context.loop.phase,
      iteration: ctx.context.loop.iteration,
      startTime: ctx.context.loop.startTime,
      currentSituation: ctx.context.loop.situation?.summary,
      currentDecision: ctx.context.loop.decision?.action,
    });
  });

  /**
   * GET /observations - Get observations
   */
  route('GET', '/observations', async (ctx) => {
    const url = new URL(ctx.request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const source = url.searchParams.get('source');

    let observations = ctx.context.loop.observations;

    // Filter by source if provided
    if (source) {
      observations = observations.filter(obs => obs.source.includes(source));
    }

    // Limit results
    observations = observations.slice(0, limit);

    return json({
      observations,
      total: ctx.context.loop.observations.length,
      filtered: observations.length,
    });
  });

  /**
   * GET /situation - Get current situation
   */
  route('GET', '/situation', async (ctx) => {
    if (!ctx.context.loop.situation) {
      return error('No situation available', 404);
    }

    return json({
      situation: ctx.context.loop.situation,
    });
  });

  /**
   * GET /actions - List available actions
   */
  route('GET', '/actions', async (ctx) => {
    const actions = Array.from(ctx.context.capabilities.actions.entries()).map(
      ([id, action]) => ({
        id,
        name: action.name,
        description: action.description,
        risk: action.risk,
        autonomy: action.autonomy,
      })
    );

    return json({ actions });
  });

  /**
   * GET /approvals - List pending approvals
   */
  route('GET', '/approvals', async (ctx) => {
    const url = new URL(ctx.request.url);
    const includeHistory = url.searchParams.get('includeHistory') !== 'false';
    const approvalConfig = ctx.context.options.approvals;
    const autoExpire = approvalConfig?.autoExpire ?? true;
    const ttlMs = approvalConfig?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (autoExpire) {
      purgeExpiredApprovals(ctx.context.state, ttlMs);
    }
    const queue = getApprovalQueue(ctx.context.state);

    return json({
      pending: queue.pending,
      history: includeHistory ? queue.history : [],
    });
  });

  /**
   * POST /approvals/:approvalId/approve - Approve and execute action
   */
  route('POST', '/approvals/:approvalId/approve', async (ctx) => {
    const approvalId = ctx.params.approvalId;
    if (!approvalId) {
      return error('Approval ID required', 400);
    }

    const approvalConfig = ctx.context.options.approvals;
    const autoExpire = approvalConfig?.autoExpire ?? true;
    const ttlMs = approvalConfig?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (autoExpire) {
      purgeExpiredApprovals(ctx.context.state, ttlMs);
    }

    const queue = getApprovalQueue(ctx.context.state);
    const pending = queue.pending.find(item => item.id === approvalId);
    if (!pending) {
      return error('Approval not found', 404);
    }

    const body = await parseBody(ctx.request);
    const note = body && typeof body === 'object' && 'note' in body && typeof body.note === 'string'
      ? body.note
      : undefined;
    const actedBy = body && typeof body === 'object' && 'actedBy' in body && typeof body.actedBy === 'string'
      ? body.actedBy
      : undefined;

    const result = await agent.executeAction(pending.actionId, pending.params);
    const resolved = resolveApproval(ctx.context.state, approvalId, 'approved', {
      result,
      note,
      actedBy,
    });

    if (!resolved) {
      return error('Approval could not be resolved', 500);
    }

    return json({ success: result.success, approval: resolved, result });
  });

  /**
   * POST /approvals/:approvalId/deny - Deny an approval request
   */
  route('POST', '/approvals/:approvalId/deny', async (ctx) => {
    const approvalId = ctx.params.approvalId;
    if (!approvalId) {
      return error('Approval ID required', 400);
    }

    const approvalConfig = ctx.context.options.approvals;
    const autoExpire = approvalConfig?.autoExpire ?? true;
    const ttlMs = approvalConfig?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (autoExpire) {
      purgeExpiredApprovals(ctx.context.state, ttlMs);
    }

    const queue = getApprovalQueue(ctx.context.state);
    const pending = queue.pending.find(item => item.id === approvalId);
    if (!pending) {
      return error('Approval not found', 404);
    }

    const body = await parseBody(ctx.request);
    const note = body && typeof body === 'object' && 'note' in body && typeof body.note === 'string'
      ? body.note
      : undefined;
    const actedBy = body && typeof body === 'object' && 'actedBy' in body && typeof body.actedBy === 'string'
      ? body.actedBy
      : undefined;

    const resolved = resolveApproval(ctx.context.state, approvalId, 'denied', {
      note,
      actedBy,
    });

    if (!resolved) {
      return error('Approval could not be resolved', 500);
    }

    return json({ success: true, approval: resolved });
  });

  /**
   * POST /actions/:actionId - Execute an action
   */
  route('POST', '/actions/:actionId', async (ctx) => {
    const actionId = ctx.params.actionId;

    if (!actionId) {
      return error('Action ID required', 400);
    }

    const action = ctx.context.capabilities.actions.get(actionId);
    if (!action) {
      return error(`Action not found: ${actionId}`, 404);
    }

    const body = await parseBody(ctx.request);
    const actionParams = body && typeof body === 'object' && 'params' in body && typeof body.params === 'object' && body.params !== null
      ? body.params as Record<string, unknown>
      : {};
    const requiresApproval = body && typeof body === 'object' && 'requiresApproval' in body && body.requiresApproval === true;
    const rationale = body && typeof body === 'object' && 'rationale' in body && typeof body.rationale === 'string'
      ? body.rationale
      : 'Manual action request via API';

    const autonomy = action.autonomy;
    const approvalConfig = ctx.context.options.approvals;
    const autoExpire = approvalConfig?.autoExpire ?? true;
    const ttlMs = approvalConfig?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;

    if (autoExpire) {
      purgeExpiredApprovals(ctx.context.state, ttlMs);
    }

    const requiresQueue =
      requiresApproval ||
      autonomy?.mode === 'approval-required' ||
      autonomy?.mode === 'human-only';

    if (requiresQueue) {
      const approval = enqueueApproval(
        ctx.context.state,
        {
          decision: {
            action: actionId,
            params: actionParams,
            rationale,
            confidence: 1,
            risk: action.risk ?? 'low',
            requiresApproval: true,
          },
          actionId,
          actionName: action.name,
          params: actionParams,
          risk: action.risk,
          confidence: 1,
          autonomy: action.autonomy,
          loopIteration: ctx.context.loop.iteration,
          situationSummary: ctx.context.loop.situation?.summary,
        },
        autoExpire ? ttlMs : undefined
      );

      return json({
        success: false,
        queued: true,
        approvalId: approval.id,
      }, 202);
    }

    try {
      const result = await agent.executeAction(actionId, actionParams);
      return json({
        success: result.success,
        result,
      });
    } catch (err) {
      return error(
        err instanceof Error ? err.message : 'Action execution failed',
        500
      );
    }
  });

  /**
   * GET /state - Get agent state
   */
  route('GET', '/state', async (ctx) => {
    return json({
      agent: {
        id: ctx.context.agent.id,
        name: ctx.context.agent.name,
        model: ctx.context.agent.model,
      },
      capabilities: {
        observers: Array.from(ctx.context.capabilities.observers.keys()),
        orienters: Array.from(ctx.context.capabilities.orienters.keys()),
        decisionStrategies: Array.from(ctx.context.capabilities.decisionStrategies.keys()),
        actions: Array.from(ctx.context.capabilities.actions.keys()),
      },
      history: {
        totalLoops: ctx.context.history.length,
        lastLoop: ctx.context.history[ctx.context.history.length - 1],
      },
    });
  });

  /**
   * GET /health - Health check (no auth required)
   */
  route('GET', '/health', async () => {
    return json({ status: 'ok', timestamp: new Date().toISOString() });
  }, false);
}
