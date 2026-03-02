/**
 * HTTP Monitor Plugin
 *
 * Production-ready plugin for monitoring HTTP endpoints and automatically
 * restarting services when they become unhealthy.
 *
 * Features:
 * - Configurable health checks with expected status codes
 * - Failure threshold to avoid false positives
 * - Cooldown period to prevent restart loops
 * - Multiple restart strategies (shell, HTTP, custom)
 * - Pattern analysis for cascading failures
 * - REST API for manual control
 */

import {
  definePlugin,
  createObserver,
  createOrienter,
  createDecisionStrategy,
  createAction,
  createEndpoint,
  json,
  error,
  type AgentContext,
  type Observation,
  type SituationAssessment,
} from '../../index';
import { z } from 'zod';
import type {
  HttpMonitorPluginOptions,
  EndpointConfig,
  EndpointState,
  HealthCheckResult,
  RestartStrategy,
} from './types';

export type { HttpMonitorPluginOptions, EndpointConfig, RestartStrategy };

export const httpMonitor = (options: HttpMonitorPluginOptions) => {
  const endpoints = options.endpoints || [];
  const checkInterval = options.checkInterval || 30000;
  const maxHistorySize = options.maxHistorySize || 50;

  // Validation
  if (endpoints.length === 0) {
    throw new Error('httpMonitor: At least one endpoint must be configured');
  }

  return definePlugin({
    id: 'http-monitor',

    init: async (ctx: AgentContext) => {
      ctx.logger.info(`[http-monitor] Initializing plugin with ${endpoints.length} endpoints`);

      // Initialize state for each endpoint
      const endpointStates = new Map<string, EndpointState>();
      for (const endpoint of endpoints) {
        endpointStates.set(endpoint.id, {
          consecutiveFailures: 0,
          history: [],
        });
      }

      return {
        context: {
          httpMonitor: {
            endpoints,
            endpointStates,
            maxHistorySize,
          },
        },
      };
    },

    observers: {
      healthCheck: createObserver({
        name: 'http-health-check',
        description: 'Monitor HTTP endpoints for availability',
        interval: checkInterval,
        observe: async (ctx: AgentContext) => {
          const pluginCtx = ctx.httpMonitor as {
            endpoints: EndpointConfig[];
            endpointStates: Map<string, EndpointState>;
            maxHistorySize: number;
          };

          const observations: Observation[] = [];

          // Check each endpoint
          for (const endpoint of pluginCtx.endpoints) {
            const result = await checkEndpoint(endpoint);
            const state = pluginCtx.endpointStates.get(endpoint.id)!;

            // Update state
            updateEndpointState(state, result, pluginCtx.maxHistorySize);

            // Create observation
            const severity = result.success
              ? 'info'
              : state.consecutiveFailures >= (endpoint.failureThreshold || 3)
              ? endpoint.critical ? 'critical' : 'error'
              : 'warning';

            observations.push({
              source: 'http-monitor/health-check',
              timestamp: result.timestamp,
              type: 'metric',
              severity,
              data: {
                endpointId: endpoint.id,
                endpointName: endpoint.name,
                url: endpoint.url,
                success: result.success,
                statusCode: result.statusCode,
                responseTime: result.responseTime,
                error: result.error,
                consecutiveFailures: state.consecutiveFailures,
                lastRestartTime: state.lastRestartTime,
              },
            });
          }

          return observations;
        },
      }),
    },

    orienters: {
      analyzeFailures: createOrienter({
        name: 'analyze-endpoint-failures',
        description: 'Analyze endpoint failures and identify patterns',
        orient: async (observations: Observation[], ctx: AgentContext) => {
          const httpObs = observations.filter(
            obs => obs.source === 'http-monitor/health-check'
          );

          const failedEndpoints = httpObs.filter(obs => !obs.data.success);
          const criticalFailures = failedEndpoints.filter(
            obs => obs.severity === 'critical' || obs.severity === 'error'
          );

          const findings: string[] = [];
          let contributingFactor: string | undefined;

          if (criticalFailures.length === 0) {
            findings.push('All monitored endpoints are healthy');
          } else {
            // Analyze failure patterns
            findings.push(`${criticalFailures.length} endpoint(s) are unhealthy`);

            for (const obs of criticalFailures) {
              const { endpointName, consecutiveFailures, error } = obs.data;
              findings.push(
                `${endpointName}: ${consecutiveFailures} consecutive failures - ${error || 'unknown error'}`
              );
            }

            // Determine if it's cascading or isolated
            if (criticalFailures.length >= httpObs.length * 0.5) {
              contributingFactor = 'Cascading failure detected - multiple endpoints affected simultaneously';
            } else {
              contributingFactor = 'Isolated failure - specific endpoint(s) are unhealthy';
            }
          }

          const assessment: SituationAssessment = {
            source: 'http-monitor/analyze-failures',
            findings,
            contributingFactor,
            confidence: criticalFailures.length > 0 ? 0.9 : 1.0,
          };

          return assessment;
        },
      }),
    },

    decisionStrategies: {
      restartUnhealthyEndpoint: createDecisionStrategy({
        name: 'restart-unhealthy-endpoint',
        description: 'Decide to restart services for persistently failing endpoints',
        applicableWhen: (situation) => {
          // Only applicable if there are unhealthy endpoints
          return situation.assessments.some(
            a => a.findings.some(f => f.includes('unhealthy') || f.includes('failure'))
          );
        },
        decide: async (situation, ctx: AgentContext) => {
          const pluginCtx = ctx.httpMonitor as {
            endpoints: EndpointConfig[];
            endpointStates: Map<string, EndpointState>;
          };

          // Find the first endpoint that needs restart
          for (const endpoint of pluginCtx.endpoints) {
            const state = pluginCtx.endpointStates.get(endpoint.id)!;
            const failureThreshold = endpoint.failureThreshold || 3;
            const cooldownPeriod = endpoint.cooldownPeriod || 300000; // 5 minutes

            // Check if this endpoint qualifies for restart
            if (state.consecutiveFailures >= failureThreshold) {
              // Check cooldown period
              const now = Date.now();
              if (state.lastRestartTime) {
                const timeSinceRestart = now - state.lastRestartTime.getTime();
                if (timeSinceRestart < cooldownPeriod) {
                  ctx.logger.warn(
                    `[http-monitor] Endpoint ${endpoint.name} in cooldown (${Math.round((cooldownPeriod - timeSinceRestart) / 1000)}s remaining)`
                  );
                  continue;
                }
              }

              // Check if restart strategy is configured
              if (!endpoint.restartStrategy) {
                ctx.logger.warn(
                  `[http-monitor] Endpoint ${endpoint.name} has no restart strategy configured`
                );
                continue;
              }

              return {
                action: 'http-monitor:restartService',
                params: {
                  endpointId: endpoint.id,
                },
                rationale: `Endpoint ${endpoint.name} has failed ${state.consecutiveFailures} consecutive times and is past cooldown period`,
                confidence: 0.85,
                risk: endpoint.critical ? 'medium' : 'low',
                requiresApproval: endpoint.critical || false,
              };
            }
          }

          // No action needed
          return {
            action: 'no-op',
            params: {},
            rationale: 'All endpoints are either healthy or in cooldown period',
            confidence: 1.0,
            risk: 'low',
            requiresApproval: false,
          };
        },
      }),
    },

    actions: {
      restartService: createAction({
        name: 'restart-service',
        description: 'Restart a service associated with a failed endpoint',
        risk: 'medium',
        autonomy: {
          mode: 'auto',
          minConfidence: 0.7,
        },
        schema: z.object({
          endpointId: z.string(),
        }),
        execute: async (params, ctx: AgentContext) => {
          const startTime = Date.now();
          const pluginCtx = ctx.httpMonitor as {
            endpoints: EndpointConfig[];
            endpointStates: Map<string, EndpointState>;
          };

          const endpoint = pluginCtx.endpoints.find(e => e.id === params.endpointId);
          if (!endpoint) {
            throw new Error(`Endpoint not found: ${params.endpointId}`);
          }

          if (!endpoint.restartStrategy) {
            throw new Error(`No restart strategy configured for endpoint: ${endpoint.name}`);
          }

          ctx.logger.info(`[http-monitor] Restarting service for endpoint: ${endpoint.name}`);

          try {
            await executeRestartStrategy(endpoint.restartStrategy, ctx);

            // Update state
            const state = pluginCtx.endpointStates.get(endpoint.id)!;
            state.lastRestartTime = new Date();
            state.consecutiveFailures = 0; // Reset after restart

            return {
              action: 'restart-service',
              success: true,
              output: `Successfully restarted service for ${endpoint.name}`,
              duration: Date.now() - startTime,
              sideEffects: [`Service restart triggered for ${endpoint.url}`],
            };
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            ctx.logger.error(`[http-monitor] Failed to restart service: ${errorMessage}`);

            return {
              action: 'restart-service',
              success: false,
              error: errorMessage,
              duration: Date.now() - startTime,
            };
          }
        },
      }),
    },

    endpoints: {
      listEndpoints: createEndpoint({
        method: 'GET',
        path: '/http-monitor/endpoints',
        handler: async (ctx) => {
          const pluginCtx = ctx.context.httpMonitor as {
            endpoints: EndpointConfig[];
            endpointStates: Map<string, EndpointState>;
          };

          const endpointsWithState = pluginCtx.endpoints.map(endpoint => {
            const state = pluginCtx.endpointStates.get(endpoint.id)!;
            return {
              id: endpoint.id,
              name: endpoint.name,
              url: endpoint.url,
              consecutiveFailures: state.consecutiveFailures,
              lastRestartTime: state.lastRestartTime,
              recentChecks: state.history.slice(-5),
            };
          });

          return json({ endpoints: endpointsWithState });
        },
        auth: true,
      }),

      checkEndpoint: createEndpoint({
        method: 'POST',
        path: '/http-monitor/endpoints/:endpointId/check',
        handler: async (ctx) => {
          const { endpointId } = ctx.params;
          const pluginCtx = ctx.context.httpMonitor as {
            endpoints: EndpointConfig[];
          };

          const endpoint = pluginCtx.endpoints.find(e => e.id === endpointId);
          if (!endpoint) {
            return error(`Endpoint not found: ${endpointId}`, 404);
          }

          const result = await checkEndpoint(endpoint);
          return json(result);
        },
        auth: true,
      }),

      restartEndpoint: createEndpoint({
        method: 'POST',
        path: '/http-monitor/endpoints/:endpointId/restart',
        handler: async (ctx) => {
          const { endpointId } = ctx.params;

          // Trigger the restart action
          const action = ctx.context.capabilities.actions.get('http-monitor:restartService');
          if (!action) {
            return error('Restart action not found', 500);
          }

          try {
            const result = await action.execute({ endpointId }, ctx.context);
            return json(result);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            return error(errorMessage, 500);
          }
        },
        auth: true,
      }),
    },

    onLoopComplete: async (result, ctx) => {
      const pluginCtx = ctx.httpMonitor as {
        endpointStates: Map<string, EndpointState>;
      };

      // Log summary
      const states = Array.from(pluginCtx.endpointStates.values());
      const unhealthyCount = states.filter(s => s.consecutiveFailures > 0).length;

      if (unhealthyCount > 0) {
        ctx.logger.warn(
          `[http-monitor] Loop complete: ${unhealthyCount} unhealthy endpoint(s)`
        );
      }
    },
  });
};

/**
 * Check a single endpoint
 */
async function checkEndpoint(endpoint: EndpointConfig): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const timeout = endpoint.timeout || 5000;
  const method = endpoint.method || 'GET';
  const expectedStatus = endpoint.expectedStatus || 200;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(endpoint.url, {
      method,
      headers: endpoint.headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseTime = Date.now() - startTime;
    const success = response.status === expectedStatus;

    return {
      endpointId: endpoint.id,
      url: endpoint.url,
      success,
      statusCode: response.status,
      responseTime,
      error: success ? undefined : `Expected status ${expectedStatus}, got ${response.status}`,
      timestamp: new Date(),
    };
  } catch (err) {
    const responseTime = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    return {
      endpointId: endpoint.id,
      url: endpoint.url,
      success: false,
      responseTime,
      error: errorMessage,
      timestamp: new Date(),
    };
  }
}

/**
 * Update endpoint state with new health check result
 */
function updateEndpointState(
  state: EndpointState,
  result: HealthCheckResult,
  maxHistorySize: number
): void {
  // Update failure count
  if (result.success) {
    state.consecutiveFailures = 0;
  } else {
    state.consecutiveFailures++;
    state.lastFailureTime = result.timestamp;
  }

  // Add to history
  state.history.push(result);

  // Trim history if needed
  if (state.history.length > maxHistorySize) {
    state.history = state.history.slice(-maxHistorySize);
  }
}

/**
 * Execute restart strategy
 */
async function executeRestartStrategy(
  strategy: RestartStrategy,
  ctx: AgentContext
): Promise<void> {
  if (strategy.type === 'command') {
    const cmd = Array.isArray(strategy.command)
      ? strategy.command
      : strategy.command.split(' ');

    if (cmd.length === 0) {
      throw new Error('Empty command provided');
    }

    const proc = Bun.spawn(cmd, {
      cwd: strategy.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Command failed with exit code ${exitCode}: ${stderr}`);
    }
  } else if (strategy.type === 'http') {
    const timeout = strategy.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(strategy.url, {
        method: strategy.method || 'POST',
        headers: strategy.headers,
        body: strategy.body ? JSON.stringify(strategy.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP restart failed: ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } else if (strategy.type === 'function') {
    await strategy.handler();
  }
}
