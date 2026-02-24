/**
 * Reference Investigation Tools
 *
 * Example tools that can be used with the investigation orienter.
 * These are reference implementations that demonstrate the tool pattern.
 * In production, you would implement these to integrate with your actual
 * observability stack (Datadog, Prometheus, Loki, etc.).
 */

import { z } from 'zod';
import { createInvestigationTool } from '../../core/src/investigation';

/**
 * Query logs for a service
 *
 * In production, this would integrate with your log provider
 * (Datadog, Loki, CloudWatch, Elasticsearch, etc.)
 */
export const queryLogs = createInvestigationTool({
  name: 'query_logs',
  description: 'Search logs for a service. Returns matching log entries.',
  parameters: z.object({
    service: z.string().describe('Service name to query logs for'),
    query: z.string().describe('Search query (supports regex)'),
    timeRange: z.string().optional().describe('Time range like "15m", "1h", "24h"'),
    limit: z.number().optional().describe('Max entries to return'),
  }),
  execute: async (params, ctx) => {
    ctx.logger.debug('[query_logs] Querying logs', params);

    // Reference implementation - replace with actual log provider integration
    return {
      output: `[Reference Implementation] Logs for ${params.service} matching "${params.query}" (last ${params.timeRange || '15m'}, limit ${params.limit || 50}):

This is a reference implementation. In production, integrate with your log provider:
- Datadog: Use the Logs API
- Loki: Use LogQL queries
- CloudWatch: Use CloudWatch Logs Insights
- Elasticsearch: Use the Search API

Example log entries would appear here.`,
      metadata: {
        service: params.service,
        query: params.query,
        timeRange: params.timeRange || '15m',
        limit: params.limit || 50,
      },
    };
  },
});

/**
 * Query metrics for a service
 *
 * In production, this would integrate with your metrics provider
 * (Prometheus, Datadog, CloudWatch, etc.)
 */
export const queryMetrics = createInvestigationTool({
  name: 'query_metrics',
  description: 'Query metrics for a service. Returns metric values over time.',
  parameters: z.object({
    service: z.string().describe('Service name to query metrics for'),
    metric: z.string().describe('Metric name (e.g., "error_rate", "latency_p99", "cpu_usage")'),
    timeRange: z.string().optional().describe('Time range like "15m", "1h", "24h"'),
  }),
  execute: async (params, ctx) => {
    ctx.logger.debug('[query_metrics] Querying metrics', params);

    // Reference implementation - replace with actual metrics provider integration
    return {
      output: `[Reference Implementation] Metrics for ${params.service}/${params.metric} (last ${params.timeRange || '15m'}):

This is a reference implementation. In production, integrate with your metrics provider:
- Prometheus: Use PromQL queries
- Datadog: Use the Metrics API
- CloudWatch: Use GetMetricData API

Example metric data would appear here with timestamps and values.`,
      metadata: {
        service: params.service,
        metric: params.metric,
        timeRange: params.timeRange || '15m',
      },
    };
  },
});

/**
 * Check health status of a service
 *
 * In production, this would check health endpoints, k8s status, etc.
 */
export const checkHealth = createInvestigationTool({
  name: 'check_health',
  description: 'Check current health status of a service.',
  parameters: z.object({
    service: z.string().describe('Service name to check health for'),
  }),
  execute: async (params, ctx) => {
    ctx.logger.debug('[check_health] Checking health', params);

    // Reference implementation - replace with actual health check integration
    return {
      output: `[Reference Implementation] Health status for ${params.service}:

This is a reference implementation. In production, integrate with:
- Kubernetes: Check pod status, readiness probes
- Health endpoints: Call /health or /ready endpoints
- Load balancer: Check target health status

Example health data would appear here.`,
      metadata: {
        service: params.service,
      },
    };
  },
});

/**
 * Correlate events across services
 *
 * In production, this would query your event store and find related events
 */
export const correlateEvents = createInvestigationTool({
  name: 'correlate_events',
  description: 'Find related events across services within a time window.',
  parameters: z.object({
    timestamp: z.string().describe('Center timestamp for correlation (ISO format)'),
    services: z.array(z.string()).optional().describe('Services to include (all if not specified)'),
    windowMinutes: z.number().optional().describe('Time window in minutes (default: 5)'),
  }),
  execute: async (params, ctx) => {
    ctx.logger.debug('[correlate_events] Correlating events', params);

    const window = params.windowMinutes || 5;
    const servicesStr = params.services?.join(', ') || 'all services';

    // Reference implementation - replace with actual event correlation
    return {
      output: `[Reference Implementation] Events correlated around ${params.timestamp} (+/- ${window} minutes) for ${servicesStr}:

This is a reference implementation. In production, integrate with:
- Event store: Query events within the time window
- Deployment tracker: Check for recent deployments
- Change management: Check for recent changes
- Alert system: Check for related alerts

Example correlated events would appear here.`,
      metadata: {
        timestamp: params.timestamp,
        services: params.services,
        windowMinutes: window,
      },
    };
  },
});

/**
 * Get recent deployments
 *
 * In production, this would query your deployment system
 */
export const getRecentDeployments = createInvestigationTool({
  name: 'get_recent_deployments',
  description: 'Get recent deployments for a service or all services.',
  parameters: z.object({
    service: z.string().optional().describe('Service name (all if not specified)'),
    limit: z.number().optional().describe('Max deployments to return (default: 10)'),
  }),
  execute: async (params, ctx) => {
    ctx.logger.debug('[get_recent_deployments] Getting deployments', params);

    const serviceStr = params.service || 'all services';
    const limit = params.limit || 10;

    // Reference implementation - replace with actual deployment system integration
    return {
      output: `[Reference Implementation] Recent deployments for ${serviceStr} (limit ${limit}):

This is a reference implementation. In production, integrate with:
- Kubernetes: Query deployment history
- ArgoCD: Query application sync history
- GitHub Actions: Query workflow runs
- Your CI/CD system: Query deployment records

Example deployment data would appear here.`,
      metadata: {
        service: params.service,
        limit,
      },
    };
  },
});

/**
 * Check database status
 *
 * In production, this would query your database monitoring system
 */
export const checkDatabaseStatus = createInvestigationTool({
  name: 'check_database_status',
  description: 'Check database health, connections, and query performance.',
  parameters: z.object({
    database: z.string().describe('Database name or identifier'),
  }),
  execute: async (params, ctx) => {
    ctx.logger.debug('[check_database_status] Checking database', params);

    // Reference implementation - replace with actual database monitoring
    return {
      output: `[Reference Implementation] Database status for ${params.database}:

This is a reference implementation. In production, integrate with:
- PostgreSQL: Query pg_stat_activity, pg_stat_statements
- MySQL: Query performance_schema
- MongoDB: Query serverStatus, currentOp
- Cloud databases: Use provider APIs (RDS, Cloud SQL, etc.)

Example database status would appear here including:
- Connection count
- Active queries
- Slow queries
- Replication lag
- Disk usage`,
      metadata: {
        database: params.database,
      },
    };
  },
});

/**
 * All reference tools bundled together
 */
export const referenceTools = [
  queryLogs,
  queryMetrics,
  checkHealth,
  correlateEvents,
  getRecentDeployments,
  checkDatabaseStatus,
];
