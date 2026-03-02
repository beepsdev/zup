/**
 * Example Plugin - System Monitor
 *
 * A simple plugin that demonstrates:
 * - Observers (check system health)
 * - Orienters (analyze observations)
 * - Decision strategies (decide what to do)
 * - Actions (restart service)
 */

import {
  definePlugin,
  createObserver,
  createOrienter,
  createDecisionStrategy,
  createAction,
  type AgentContext,
  type Observation,
  type SituationAssessment,
} from '../index';
import { z } from 'zod';

export type ExamplePluginOptions = {
  serviceName?: string;
  checkInterval?: number;
};

export const examplePlugin = (options: ExamplePluginOptions = {}) => {
  const serviceName = options.serviceName || 'example-service';
  const checkInterval = options.checkInterval ?? 30000;

  return definePlugin({
    id: 'example',

    // Initialize plugin - add custom data to context
    init: async (ctx: AgentContext) => {
      console.log(`[example] Initializing plugin for service: ${serviceName}`);

      return {
        context: {
          example: {
            serviceName,
            restartCount: 0,
          },
        },
      };
    },

    // OBSERVE: Check if service is healthy
    observers: {
      serviceHealth: createObserver({
        name: 'service-health',
        description: 'Check if the service is running',
        interval: checkInterval,
        observe: async (ctx: AgentContext) => {
          // Simulate checking service health
          // In real world, this would check actual service status
          const isHealthy = Math.random() > 0.3; // 70% chance healthy

          const observations: Observation[] = [];

          if (!isHealthy) {
            observations.push({
              source: 'example/service-health',
              timestamp: new Date(),
              type: 'state',
              severity: 'critical',
              data: {
                service: serviceName,
                status: 'down',
                message: 'Service is not responding',
              },
            });
          } else {
            observations.push({
              source: 'example/service-health',
              timestamp: new Date(),
              type: 'state',
              severity: 'info',
              data: {
                service: serviceName,
                status: 'healthy',
              },
            });
          }

          return observations;
        },
      }),
    },

    // ORIENT: Analyze the observations
    orienters: {
      analyzeHealth: createOrienter({
        name: 'analyze-health',
        description: 'Analyze service health observations',
        orient: async (observations: Observation[], ctx: AgentContext) => {
          const unhealthyObs = observations.filter(
            obs => obs.source.includes('service-health') && obs.severity === 'critical'
          );

          const assessment: SituationAssessment = {
            source: 'example/analyze-health',
            findings: unhealthyObs.length > 0
              ? [`Service ${serviceName} is down or unhealthy`]
              : [`Service ${serviceName} is healthy`],
            contributingFactor: unhealthyObs.length > 0
              ? 'Service process has crashed or is unresponsive'
              : undefined,
            confidence: 0.9,
          };

          return assessment;
        },
      }),
    },

    // DECIDE: Decide what to do based on situation
    decisionStrategies: {
      restartUnhealthyService: createDecisionStrategy({
        name: 'restart-unhealthy-service',
        description: 'Decide to restart service if unhealthy',
        applicableWhen: (situation) => {
          // Only applicable if there are critical findings
          return situation.assessments.some(
            a => a.findings.some(f => f.includes('down') || f.includes('unhealthy'))
          );
        },
        decide: async (situation, ctx: AgentContext) => {
          return {
            action: 'example:restartService',
            params: {
              serviceName,
            },
            rationale: `Service ${serviceName} is unhealthy and needs to be restarted`,
            confidence: 0.85,
            risk: 'low',
            requiresApproval: false,
          };
        },
      }),
    },

    // ACT: Restart the service
    actions: {
      restartService: createAction({
        name: 'restart-service',
        description: 'Restart a service',
        risk: 'low',
        autonomy: {
          mode: 'auto',
          minConfidence: 0.7,
        },
        schema: z.object({
          serviceName: z.string(),
        }),
        execute: async (params, ctx: AgentContext) => {
          const startTime = Date.now();

          console.log(`[example] Restarting service: ${params.serviceName}`);

          // Simulate restart (in real world, this would actually restart the service)
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Track restart count
          const exampleData = ctx.example as { serviceName: string; restartCount: number } | undefined;
          if (exampleData) {
            exampleData.restartCount++;
          }

          return {
            action: 'restart-service',
            success: true,
            output: `Service ${params.serviceName} restarted successfully`,
            duration: Date.now() - startTime,
            sideEffects: [`Service ${params.serviceName} was restarted`],
            metrics: {
              restartCount: exampleData?.restartCount || 1,
            },
          };
        },
        dryRun: async (params) => {
          return `Would restart service: ${params.serviceName}`;
        },
      }),
    },

    // Hooks
    onLoopStart: async (ctx) => {
      console.log(`[example] OODA loop #${ctx.loop.iteration + 1} starting`);
    },

    onLoopComplete: async (result, ctx) => {
      console.log(`[example] OODA loop #${ctx.loop.iteration} completed in ${result.duration}ms`);
    },
  });
};
