/**
 * Google Cloud Run Plugin
 *
 * Observes Cloud Run services and rollouts, providing deployment context
 * and optional auto-rollback via traffic shifting.
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
} from '../../core/src/index';
import { z } from 'zod';
import { GoogleAuth } from 'google-auth-library';
import type {
  CloudRunPluginOptions,
  CloudRunProjectConfig,
  CloudRunRevisionResource,
  CloudRunServiceResource,
  CloudRunServiceSnapshot,
  CloudRunServiceCondition,
  CloudRunTrafficTarget,
  CloudRunRolloutStatus,
} from './types';

export type {
  CloudRunPluginOptions,
  CloudRunProjectConfig,
  CloudRunServiceSnapshot,
  CloudRunRevisionResource,
};

const DEFAULT_RUN_API_BASE_URL = 'https://run.googleapis.com';
const DEFAULT_LOGGING_API_BASE_URL = 'https://logging.googleapis.com';
const DEFAULT_MONITORING_API_BASE_URL = 'https://monitoring.googleapis.com';
const DEFAULT_POLL_INTERVAL_MS = 60000;
const DEFAULT_MAX_REVISIONS_PER_SERVICE = 20;
const DEFAULT_AUTO_ROLLBACK_MIN_READY_MINUTES = 5;
const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const DEFAULT_LOG_QUERY_WINDOW_MINUTES = 10;
const DEFAULT_LOG_PAGE_SIZE = 50;
const DEFAULT_METRICS_WINDOW_MINUTES = 5;
const DEFAULT_ERROR_RATE_WARNING_THRESHOLD = 0.05;
const DEFAULT_ERROR_RATE_ERROR_THRESHOLD = 0.1;

type AccessTokenState = {
  token?: string;
  expiresAt?: number;
};

type CloudRunServiceState = {
  lastCreatedRevision?: string;
  lastReadyRevision?: string;
  lastKnownGoodRevision?: string;
  rolloutStartMs?: number;
  lastSnapshot?: CloudRunServiceSnapshot;
};

type CloudRunPluginContext = {
  options: Required<CloudRunPluginOptions> & { auth: { useADC: boolean; scopes: string[] } };
  serviceStates: Map<string, CloudRunServiceState>;
  snapshots: Map<string, CloudRunServiceSnapshot>;
  tokenState: AccessTokenState;
  authClient?: GoogleAuth;
};

type CloudRunListServicesResponse = {
  services?: CloudRunServiceResource[];
  nextPageToken?: string;
};

type CloudRunListRevisionsResponse = {
  revisions?: CloudRunRevisionResource[];
  nextPageToken?: string;
};

type CloudRunLogEntry = {
  timestamp?: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  protoPayload?: Record<string, unknown>;
};

type CloudRunLogEntriesResponse = {
  entries?: CloudRunLogEntry[];
  nextPageToken?: string;
};

type CloudRunTimeSeriesPoint = {
  value?: {
    doubleValue?: number;
    int64Value?: string;
  };
};

type CloudRunTimeSeries = {
  points?: CloudRunTimeSeriesPoint[];
};

type CloudRunTimeSeriesResponse = {
  timeSeries?: CloudRunTimeSeries[];
};

function buildServiceKey(projectId: string, region: string, service: string): string {
  return `${projectId}/${region}/${service}`;
}

function extractServiceName(resourceName?: string): string | undefined {
  if (!resourceName) return undefined;
  const parts = resourceName.split('/');
  return parts[parts.length - 1];
}

function getCondition(
  conditions: CloudRunServiceCondition[],
  type: string
): CloudRunServiceCondition | undefined {
  return conditions.find(condition => condition.type === type);
}

function matchesLabelFilter(
  labels: Record<string, string> | undefined,
  filter: Record<string, string> | undefined
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (!labels) return false;
  return Object.entries(filter).every(([key, value]) => labels[key] === value);
}

function shouldIncludeService(
  serviceName: string,
  labels: Record<string, string> | undefined,
  project: CloudRunProjectConfig
): boolean {
  if (project.services && !project.services.includes(serviceName)) {
    return false;
  }
  if (!matchesLabelFilter(labels, project.labels)) {
    return false;
  }
  return true;
}

function resolveServiceDisplayName(
  serviceName: string,
  project: CloudRunProjectConfig
): string {
  return project.serviceNameMap?.[serviceName] ?? serviceName;
}

function buildTrafficSummary(traffic: CloudRunTrafficTarget[]): string {
  if (traffic.length === 0) return 'no traffic';
  return traffic
    .map(target => {
      const percent = target.percent ?? 0;
      if (target.latestRevision) {
        return `latest(${percent}%)`;
      }
      return `${target.revision ?? 'unknown'}(${percent}%)`;
    })
    .join(', ');
}

function isAllTrafficToRevision(
  traffic: CloudRunTrafficTarget[],
  revision: string
): boolean {
  if (traffic.length === 0) return false;
  const revisionPercent = traffic.reduce((sum, target) => {
    return sum + (target.revision === revision ? (target.percent ?? 0) : 0);
  }, 0);
  const hasLatest = traffic.some(target => target.latestRevision);
  return !hasLatest && revisionPercent >= 99;
}

async function getAccessToken(
  ctx: AgentContext,
  pluginCtx: CloudRunPluginContext
): Promise<string> {
  const now = Date.now();
  if (pluginCtx.tokenState.token && pluginCtx.tokenState.expiresAt) {
    if (now < pluginCtx.tokenState.expiresAt - 60_000) {
      return pluginCtx.tokenState.token;
    }
  }

  const envToken = process.env.GCP_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (envToken) {
    pluginCtx.tokenState = {
      token: envToken,
      expiresAt: now + 30 * 60_000,
    };
    return envToken;
  }

  if (!pluginCtx.options.auth.useADC) {
    throw new Error('cloud-run auth: ADC disabled and no access token provided');
  }

  if (pluginCtx.authClient) {
    try {
      const client = await pluginCtx.authClient.getClient();
      const tokenResponse = await client.getAccessToken();
      const token =
        typeof tokenResponse === 'string'
          ? tokenResponse
          : tokenResponse?.token;

      if (token) {
        pluginCtx.tokenState = {
          token,
          expiresAt: now + 5 * 60_000,
        };
        return token;
      }
    } catch (err) {
      ctx.logger.warn('[cloud-run] GoogleAuth token fetch failed, falling back to metadata server', err);
    }
  }

  const metadataUrl =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  const response = await fetch(metadataUrl, {
    headers: {
      'Metadata-Flavor': 'Google',
    },
  });

  if (!response.ok) {
    throw new Error(
      `cloud-run auth: failed to fetch metadata token (${response.status})`
    );
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('cloud-run auth: metadata token response missing access_token');
  }

  pluginCtx.tokenState = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 300) * 1000,
  };

  return data.access_token;
}

async function listServices(
  projectId: string,
  region: string,
  token: string,
  apiBaseUrl: string
): Promise<CloudRunServiceResource[]> {
  const services: CloudRunServiceResource[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${apiBaseUrl}/v2/projects/${projectId}/locations/${region}/services`);
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud Run API error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as CloudRunListServicesResponse;
    if (data.services) {
      services.push(...data.services);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return services;
}

async function listRevisions(
  projectId: string,
  region: string,
  service: string,
  token: string,
  apiBaseUrl: string,
  pageSize?: number
): Promise<CloudRunRevisionResource[]> {
  const revisions: CloudRunRevisionResource[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(
      `${apiBaseUrl}/v2/projects/${projectId}/locations/${region}/services/${service}/revisions`
    );
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    if (pageSize) {
      url.searchParams.set('pageSize', String(pageSize));
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud Run API error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as CloudRunListRevisionsResponse;
    if (data.revisions) {
      revisions.push(...data.revisions);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return revisions;
}

async function listLogEntries(
  projectId: string,
  filter: string,
  pageSize: number,
  token: string
): Promise<CloudRunLogEntry[]> {
  const url = `${DEFAULT_LOGGING_API_BASE_URL}/v2/entries:list`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resourceNames: [`projects/${projectId}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud Logging API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as CloudRunLogEntriesResponse;
  return data.entries ?? [];
}

function extractLogMessage(entry: CloudRunLogEntry): string {
  if (entry.textPayload) {
    return entry.textPayload;
  }
  if (entry.jsonPayload) {
    return JSON.stringify(entry.jsonPayload);
  }
  if (entry.protoPayload) {
    return JSON.stringify(entry.protoPayload);
  }
  return 'log entry';
}

function sumTimeSeries(data: CloudRunTimeSeriesResponse): number {
  let total = 0;
  for (const series of data.timeSeries ?? []) {
    for (const point of series.points ?? []) {
      const value = point.value;
      if (!value) continue;
      if (typeof value.doubleValue === 'number') {
        total += value.doubleValue;
      } else if (value.int64Value) {
        const parsed = Number(value.int64Value);
        if (!Number.isNaN(parsed)) {
          total += parsed;
        }
      }
    }
  }
  return total;
}

async function fetchMetricSum(
  projectId: string,
  filter: string,
  startTime: string,
  endTime: string,
  token: string,
  alignmentSeconds: number
): Promise<number> {
  const url = new URL(
    `${DEFAULT_MONITORING_API_BASE_URL}/v3/projects/${projectId}/timeSeries`
  );
  url.searchParams.set('filter', filter);
  url.searchParams.set('interval.startTime', startTime);
  url.searchParams.set('interval.endTime', endTime);
  url.searchParams.set('aggregation.alignmentPeriod', `${alignmentSeconds}s`);
  url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_SUM');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud Monitoring API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as CloudRunTimeSeriesResponse;
  return sumTimeSeries(data);
}

async function updateServiceTraffic(
  projectId: string,
  region: string,
  service: string,
  traffic: CloudRunTrafficTarget[],
  token: string,
  apiBaseUrl: string
): Promise<unknown> {
  const url = new URL(
    `${apiBaseUrl}/v2/projects/${projectId}/locations/${region}/services/${service}`
  );
  url.searchParams.set('updateMask', 'traffic');

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ traffic }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud Run API error (${response.status}): ${body}`);
  }

  return response.json();
}

export const cloudRun = (options: CloudRunPluginOptions) => {
  const normalizedOptions: CloudRunPluginContext['options'] = {
    auth: {
      useADC: options.auth?.useADC ?? true,
      scopes: options.auth?.scopes ?? DEFAULT_SCOPES,
    },
    projects: options.projects,
    apiBaseUrl: options.apiBaseUrl ?? DEFAULT_RUN_API_BASE_URL,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxRevisionsPerService: options.maxRevisionsPerService ?? DEFAULT_MAX_REVISIONS_PER_SERVICE,
    readOnly: options.readOnly ?? true,
    autoRollback: options.autoRollback ?? false,
    autoRollbackMinReadyMinutes:
      options.autoRollbackMinReadyMinutes ?? DEFAULT_AUTO_ROLLBACK_MIN_READY_MINUTES,
    includeLogs: options.includeLogs ?? false,
    logQueryWindowMinutes: options.logQueryWindowMinutes ?? DEFAULT_LOG_QUERY_WINDOW_MINUTES,
    logPageSize: options.logPageSize ?? DEFAULT_LOG_PAGE_SIZE,
    includeMetrics: options.includeMetrics ?? false,
    metricsWindowMinutes: options.metricsWindowMinutes ?? DEFAULT_METRICS_WINDOW_MINUTES,
    errorRateWarningThreshold:
      options.errorRateWarningThreshold ?? DEFAULT_ERROR_RATE_WARNING_THRESHOLD,
    errorRateErrorThreshold:
      options.errorRateErrorThreshold ?? DEFAULT_ERROR_RATE_ERROR_THRESHOLD,
  };

  if (!normalizedOptions.projects || normalizedOptions.projects.length === 0) {
    throw new Error('cloudRun: At least one project must be configured');
  }

  for (const project of normalizedOptions.projects) {
    if (!project.regions || project.regions.length === 0) {
      throw new Error(`cloudRun: Project ${project.projectId} must specify at least one region`);
    }
  }

  const observers: Record<string, ReturnType<typeof createObserver>> = {
    serviceStatus: createObserver({
      name: 'cloud-run-service-status',
      description: 'Monitor Cloud Run services and rollout state',
      interval: normalizedOptions.pollIntervalMs,
      observe: async (ctx: AgentContext) => {
        const pluginCtx = ctx.cloudRun as CloudRunPluginContext;
        const observations: Observation[] = [];

        let token: string;
        try {
          token = await getAccessToken(ctx, pluginCtx);
        } catch (err) {
          observations.push({
            source: 'cloud-run/connection-error',
            timestamp: new Date(),
            type: 'error',
            severity: 'error',
            data: {
              error: err instanceof Error ? err.message : String(err),
            },
          });
          return observations;
        }

        const now = Date.now();
        const minReadyMs = pluginCtx.options.autoRollbackMinReadyMinutes * 60_000;

        for (const project of pluginCtx.options.projects) {
          for (const region of project.regions) {
            let services: CloudRunServiceResource[] = [];
            try {
              services = await listServices(
                project.projectId,
                region,
                token,
                pluginCtx.options.apiBaseUrl
              );
            } catch (err) {
              observations.push({
                source: 'cloud-run/connection-error',
                timestamp: new Date(),
                type: 'error',
                severity: 'error',
                data: {
                  projectId: project.projectId,
                  region,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
              continue;
            }

            for (const service of services) {
              const serviceName = extractServiceName(service.name) ?? 'unknown-service';
              const labels = service.labels ?? {};
              if (!shouldIncludeService(serviceName, labels, project)) {
                continue;
              }

              const key = buildServiceKey(project.projectId, region, serviceName);
              const state = pluginCtx.serviceStates.get(key) ?? {};
              const traffic = service.traffic ?? service.status?.traffic ?? [];
              const conditions = service.conditions ?? service.status?.conditions ?? [];
              const latestReadyRevision =
                service.latestReadyRevision ?? service.status?.latestReadyRevision;
              const latestCreatedRevision =
                service.latestCreatedRevision ?? service.status?.latestCreatedRevision;
              const url = service.uri ?? service.status?.url;

              const readyCondition = getCondition(conditions, 'Ready');
              const reconcilingCondition = getCondition(conditions, 'Reconciling');

              if (latestCreatedRevision && latestCreatedRevision !== state.lastCreatedRevision) {
                state.rolloutStartMs = now;
                observations.push({
                  source: 'cloud-run/revision',
                  timestamp: new Date(),
                  type: 'event',
                  severity: 'info',
                  data: {
                    projectId: project.projectId,
                    region,
                    service: serviceName,
                    serviceName: resolveServiceDisplayName(serviceName, project),
                    revision: latestCreatedRevision,
                    detectedAt: new Date(now).toISOString(),
                  },
                });
              }

              if (latestReadyRevision && readyCondition?.status === 'True') {
                state.lastKnownGoodRevision = latestReadyRevision;
              }

              if (latestCreatedRevision && latestReadyRevision && latestCreatedRevision === latestReadyRevision) {
                state.rolloutStartMs = undefined;
              }

              state.lastCreatedRevision = latestCreatedRevision ?? state.lastCreatedRevision;
              state.lastReadyRevision = latestReadyRevision ?? state.lastReadyRevision;

              const rolloutAgeMs =
                state.rolloutStartMs !== undefined ? now - state.rolloutStartMs : undefined;

              let rolloutStatus: CloudRunRolloutStatus = 'unknown';
              let rolloutReason: string | undefined;

              if (readyCondition?.status === 'False') {
                rolloutStatus = 'failed';
                rolloutReason = readyCondition.reason ?? 'Ready condition reported False';
              } else if (latestCreatedRevision && latestReadyRevision) {
                if (latestCreatedRevision !== latestReadyRevision) {
                  if (rolloutAgeMs !== undefined && rolloutAgeMs > minReadyMs) {
                    rolloutStatus = 'failed';
                    rolloutReason = 'New revision not ready within threshold';
                  } else {
                    rolloutStatus = 'in_progress';
                    rolloutReason = 'New revision not yet ready';
                  }
                } else {
                  rolloutStatus = 'completed';
                }
              } else if (reconcilingCondition?.status === 'True') {
                rolloutStatus = 'in_progress';
                rolloutReason = 'Service reconciling';
              }

              const snapshot: CloudRunServiceSnapshot = {
                key,
                projectId: project.projectId,
                region,
                service: serviceName,
                serviceName: resolveServiceDisplayName(serviceName, project),
                url,
                latestReadyRevision,
                latestCreatedRevision,
                lastKnownGoodRevision: state.lastKnownGoodRevision,
                traffic,
                conditions,
                rolloutStatus,
                rolloutReason,
                rolloutAgeMs,
                updatedAt: new Date(now).toISOString(),
              };

              pluginCtx.serviceStates.set(key, state);
              pluginCtx.snapshots.set(key, snapshot);

              const readySeverity: Observation['severity'] =
                readyCondition?.status === 'False'
                  ? 'error'
                  : readyCondition?.status === 'Unknown'
                  ? 'warning'
                  : 'info';

              observations.push({
                source: 'cloud-run/service-status',
                timestamp: new Date(),
                type: 'state',
                severity: readySeverity,
                data: {
                  projectId: project.projectId,
                  region,
                  service: serviceName,
                  serviceName: snapshot.serviceName,
                  url,
                  latestReadyRevision,
                  latestCreatedRevision,
                  traffic,
                  conditions,
                },
              });

              if (rolloutStatus !== 'unknown') {
                const rolloutSeverity: Observation['severity'] =
                  rolloutStatus === 'failed'
                    ? 'error'
                    : rolloutStatus === 'in_progress'
                    ? 'warning'
                    : 'info';

                observations.push({
                  source: 'cloud-run/rollout',
                  timestamp: new Date(),
                  type: 'event',
                  severity: rolloutSeverity,
                  data: {
                    projectId: project.projectId,
                    region,
                    service: serviceName,
                    serviceName: snapshot.serviceName,
                    latestCreatedRevision,
                    latestReadyRevision,
                    trafficSummary: buildTrafficSummary(traffic),
                    status: rolloutStatus,
                    reason: rolloutReason,
                    rolloutAgeMs,
                  },
                });
              }
            }
          }
        }

        return observations;
      },
    }),
  };

  if (normalizedOptions.includeLogs) {
    observers.logErrors = createObserver({
      name: 'cloud-run-log-errors',
      description: 'Query Cloud Run error logs for recent failures',
      interval: normalizedOptions.pollIntervalMs,
      observe: async (ctx: AgentContext) => {
        const pluginCtx = ctx.cloudRun as CloudRunPluginContext;
        const observations: Observation[] = [];

        let token: string;
        try {
          token = await getAccessToken(ctx, pluginCtx);
        } catch (err) {
          observations.push({
            source: 'cloud-run/connection-error',
            timestamp: new Date(),
            type: 'error',
            severity: 'error',
            data: {
              error: err instanceof Error ? err.message : String(err),
            },
          });
          return observations;
        }

        const windowMinutes = pluginCtx.options.logQueryWindowMinutes;
        const startTime = new Date(Date.now() - windowMinutes * 60_000).toISOString();

        for (const project of pluginCtx.options.projects) {
          for (const region of project.regions) {
            let services: CloudRunServiceResource[] = [];
            try {
              services = await listServices(
                project.projectId,
                region,
                token,
                pluginCtx.options.apiBaseUrl
              );
            } catch (err) {
              observations.push({
                source: 'cloud-run/connection-error',
                timestamp: new Date(),
                type: 'error',
                severity: 'error',
                data: {
                  projectId: project.projectId,
                  region,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
              continue;
            }

            for (const service of services) {
              const serviceName = extractServiceName(service.name) ?? 'unknown-service';
              const labels = service.labels ?? {};
              if (!shouldIncludeService(serviceName, labels, project)) {
                continue;
              }

              const filter = [
                'resource.type="cloud_run_revision"',
                `resource.labels.service_name="${serviceName}"`,
                `resource.labels.location="${region}"`,
                'severity>=ERROR',
                `timestamp>="${startTime}"`,
              ].join(' AND ');

              try {
                const entries = await listLogEntries(
                  project.projectId,
                  filter,
                  pluginCtx.options.logPageSize,
                  token
                );

                const sampleMessages = entries
                  .slice(0, 3)
                  .map(entry => extractLogMessage(entry))
                  .map(message => message.slice(0, 200));

                let severity: Observation['severity'] = 'info';
                if (entries.length > 0) {
                  severity =
                    entries.length >= pluginCtx.options.logPageSize ? 'error' : 'warning';
                }

                observations.push({
                  source: 'cloud-run/log-errors',
                  timestamp: new Date(),
                  type: 'metric',
                  severity,
                  data: {
                    projectId: project.projectId,
                    region,
                    service: serviceName,
                    serviceName: resolveServiceDisplayName(serviceName, project),
                    errorCount: entries.length,
                    windowMinutes,
                    sampleMessages,
                  },
                });
              } catch (err) {
                observations.push({
                  source: 'cloud-run/connection-error',
                  timestamp: new Date(),
                  type: 'error',
                  severity: 'error',
                  data: {
                    projectId: project.projectId,
                    region,
                    service: serviceName,
                    error: err instanceof Error ? err.message : String(err),
                  },
                });
              }
            }
          }
        }

        return observations;
      },
    });
  }

  if (normalizedOptions.includeMetrics) {
    observers.metrics = createObserver({
      name: 'cloud-run-metrics',
      description: 'Query Cloud Run request metrics',
      interval: normalizedOptions.pollIntervalMs,
      observe: async (ctx: AgentContext) => {
        const pluginCtx = ctx.cloudRun as CloudRunPluginContext;
        const observations: Observation[] = [];

        let token: string;
        try {
          token = await getAccessToken(ctx, pluginCtx);
        } catch (err) {
          observations.push({
            source: 'cloud-run/connection-error',
            timestamp: new Date(),
            type: 'error',
            severity: 'error',
            data: {
              error: err instanceof Error ? err.message : String(err),
            },
          });
          return observations;
        }

        const windowMinutes = pluginCtx.options.metricsWindowMinutes;
        const endTime = new Date().toISOString();
        const startTime = new Date(Date.now() - windowMinutes * 60_000).toISOString();

        for (const project of pluginCtx.options.projects) {
          for (const region of project.regions) {
            let services: CloudRunServiceResource[] = [];
            try {
              services = await listServices(
                project.projectId,
                region,
                token,
                pluginCtx.options.apiBaseUrl
              );
            } catch (err) {
              observations.push({
                source: 'cloud-run/connection-error',
                timestamp: new Date(),
                type: 'error',
                severity: 'error',
                data: {
                  projectId: project.projectId,
                  region,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
              continue;
            }

            for (const service of services) {
              const serviceName = extractServiceName(service.name) ?? 'unknown-service';
              const labels = service.labels ?? {};
              if (!shouldIncludeService(serviceName, labels, project)) {
                continue;
              }

              const baseFilter = [
                'metric.type="run.googleapis.com/request_count"',
                'resource.type="cloud_run_revision"',
                `resource.labels.service_name="${serviceName}"`,
                `resource.labels.location="${region}"`,
              ].join(' AND ');

              try {
                const totalRequests = await fetchMetricSum(
                  project.projectId,
                  baseFilter,
                  startTime,
                  endTime,
                  token,
                  60
                );

                const errorFilter = `${baseFilter} AND metric.label.response_code_class="5xx"`;
                const errorRequests = await fetchMetricSum(
                  project.projectId,
                  errorFilter,
                  startTime,
                  endTime,
                  token,
                  60
                );

                const errorRate = totalRequests > 0 ? errorRequests / totalRequests : 0;
                let severity: Observation['severity'] = 'info';
                if (errorRate >= pluginCtx.options.errorRateErrorThreshold) {
                  severity = 'error';
                } else if (errorRate >= pluginCtx.options.errorRateWarningThreshold) {
                  severity = 'warning';
                }

                observations.push({
                  source: 'cloud-run/metrics',
                  timestamp: new Date(),
                  type: 'metric',
                  severity,
                  data: {
                    projectId: project.projectId,
                    region,
                    service: serviceName,
                    serviceName: resolveServiceDisplayName(serviceName, project),
                    totalRequests,
                    errorRequests,
                    errorRate,
                    windowMinutes,
                  },
                });
              } catch (err) {
                observations.push({
                  source: 'cloud-run/connection-error',
                  timestamp: new Date(),
                  type: 'error',
                  severity: 'error',
                  data: {
                    projectId: project.projectId,
                    region,
                    service: serviceName,
                    error: err instanceof Error ? err.message : String(err),
                  },
                });
              }
            }
          }
        }

        return observations;
      },
    });
  }

  return definePlugin({
    id: 'cloud-run',

    init: async (ctx: AgentContext) => {
      const serviceStates = new Map<string, CloudRunServiceState>();
      const snapshots = new Map<string, CloudRunServiceSnapshot>();
      const authClient = normalizedOptions.auth.useADC
        ? new GoogleAuth({ scopes: normalizedOptions.auth.scopes })
        : undefined;

      return {
        context: {
          cloudRun: {
            options: normalizedOptions,
            serviceStates,
            snapshots,
            tokenState: {},
            authClient,
          },
        },
      };
    },

    observers,

    orienters: {
      analyzeRollouts: createOrienter({
        name: 'analyze-cloud-run-rollouts',
        description: 'Analyze Cloud Run rollout observations',
        orient: async (observations: Observation[]): Promise<SituationAssessment> => {
          const rolloutObs = observations.filter(obs => obs.source === 'cloud-run/rollout');

          if (rolloutObs.length === 0) {
            return {
              source: 'cloud-run/analyze-rollouts',
              findings: ['No Cloud Run rollout activity observed'],
              confidence: 0.6,
            };
          }

          const findings: string[] = [];
          let contributingFactor: string | undefined;

          for (const obs of rolloutObs) {
            const data = obs.data as {
              service: string;
              serviceName?: string;
              status?: string;
              reason?: string;
              trafficSummary?: string;
            };

            const label = data.serviceName ?? data.service;
            const status = data.status ?? 'unknown';
            const reason = data.reason ? ` (${data.reason})` : '';
            const traffic = data.trafficSummary ? ` [${data.trafficSummary}]` : '';
            findings.push(`${label}: rollout ${status}${reason}${traffic}`);

            if (status === 'failed') {
              contributingFactor = 'Cloud Run rollout failure detected';
            }
          }

          return {
            source: 'cloud-run/analyze-rollouts',
            findings,
            contributingFactor,
            confidence: 0.85,
          };
        },
      }),
    },

    decisionStrategies: {
      autoRollbackFailedRollout: createDecisionStrategy({
        name: 'cloud-run-auto-rollback',
        description: 'Rollback Cloud Run traffic when a rollout fails',
        applicableWhen: (situation) => {
          return situation.assessments.some(assessment =>
            assessment.findings.some(finding => finding.includes('rollout failed'))
          );
        },
        decide: async (situation, ctx: AgentContext) => {
          const pluginCtx = ctx.cloudRun as CloudRunPluginContext;

          if (!pluginCtx.options.autoRollback) {
            return {
              action: 'no-op',
              params: {},
              rationale: 'Auto-rollback disabled',
              confidence: 0,
              risk: 'low',
              requiresApproval: false,
            };
          }

          if (pluginCtx.options.readOnly) {
            return {
              action: 'no-op',
              params: {},
              rationale: 'Read-only mode enabled; rollback skipped',
              confidence: 0,
              risk: 'low',
              requiresApproval: false,
            };
          }

          const candidates = Array.from(pluginCtx.snapshots.values()).filter(snapshot => {
            if (snapshot.rolloutStatus !== 'failed') return false;
            if (!snapshot.lastKnownGoodRevision) return false;
            return !isAllTrafficToRevision(snapshot.traffic, snapshot.lastKnownGoodRevision);
          });

          const target = candidates[0];
          if (!target) {
            return {
              action: 'no-op',
              params: {},
              rationale: 'No eligible Cloud Run rollback targets found',
              confidence: 0,
              risk: 'low',
              requiresApproval: false,
            };
          }

          return {
            action: 'cloud-run:rollback',
            params: {
              projectId: target.projectId,
              region: target.region,
              service: target.service,
              revision: target.lastKnownGoodRevision,
            },
            rationale: `Cloud Run rollout failed for ${target.serviceName}; rolling back traffic`,
            confidence: 0.8,
            risk: 'medium',
            requiresApproval: false,
          };
        },
      }),
    },

    actions: {
      setTraffic: createAction({
        name: 'set-traffic',
        description: 'Set Cloud Run service traffic targets',
        risk: 'medium',
        autonomy: {
          mode: 'auto',
          minConfidence: 0.8,
        },
        schema: z.object({
          projectId: z.string(),
          region: z.string(),
          service: z.string(),
          traffic: z.array(
            z.object({
              revision: z.string().optional(),
              percent: z.number().optional(),
              tag: z.string().optional(),
              latestRevision: z.boolean().optional(),
            })
          ),
        }),
        execute: async (params, ctx) => {
          const pluginCtx = ctx.cloudRun as CloudRunPluginContext;
          if (pluginCtx.options.readOnly) {
            return {
              action: 'set-traffic',
              success: false,
              error: 'Read-only mode enabled',
              duration: 0,
            };
          }

          const start = Date.now();
          const token = await getAccessToken(ctx, pluginCtx);
          await updateServiceTraffic(
            params.projectId,
            params.region,
            params.service,
            params.traffic,
            token,
            pluginCtx.options.apiBaseUrl
          );

          return {
            action: 'set-traffic',
            success: true,
            duration: Date.now() - start,
            output: `Updated traffic for ${params.service}`,
          };
        },
        dryRun: async (params) => {
          return `Would set traffic for ${params.service}: ${JSON.stringify(params.traffic)}`;
        },
      }),

      rollback: createAction({
        name: 'rollback',
        description: 'Rollback Cloud Run service to last known good revision',
        risk: 'medium',
        autonomy: {
          mode: 'auto',
          minConfidence: 0.8,
        },
        schema: z.object({
          projectId: z.string(),
          region: z.string(),
          service: z.string(),
          revision: z.string().optional(),
        }),
        execute: async (params, ctx) => {
          const pluginCtx = ctx.cloudRun as CloudRunPluginContext;
          if (pluginCtx.options.readOnly) {
            return {
              action: 'rollback',
              success: false,
              error: 'Read-only mode enabled',
              duration: 0,
            };
          }

          const key = buildServiceKey(params.projectId, params.region, params.service);
          const snapshot = pluginCtx.snapshots.get(key);
          const targetRevision = params.revision ?? snapshot?.lastKnownGoodRevision;

          if (!targetRevision) {
            return {
              action: 'rollback',
              success: false,
              error: 'No known good revision available for rollback',
              duration: 0,
            };
          }

          const start = Date.now();
          const token = await getAccessToken(ctx, pluginCtx);
          await updateServiceTraffic(
            params.projectId,
            params.region,
            params.service,
            [{ revision: targetRevision, percent: 100 }],
            token,
            pluginCtx.options.apiBaseUrl
          );

          return {
            action: 'rollback',
            success: true,
            duration: Date.now() - start,
            output: `Rolled back ${params.service} to ${targetRevision}`,
          };
        },
        dryRun: async (params, ctx) => {
          const pluginCtx = ctx.cloudRun as CloudRunPluginContext;
          const key = buildServiceKey(params.projectId, params.region, params.service);
          const snapshot = pluginCtx.snapshots.get(key);
          const targetRevision = params.revision ?? snapshot?.lastKnownGoodRevision ?? 'unknown';
          return `Would roll back ${params.service} to ${targetRevision}`;
        },
      }),
    },

    endpoints: {
      listServices: createEndpoint({
        method: 'GET',
        path: '/cloud-run/services',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.cloudRun as CloudRunPluginContext;
          const services = Array.from(pluginCtx.snapshots.values());
          return json({ services });
        },
      }),

      listServicesByRegion: createEndpoint({
        method: 'GET',
        path: '/cloud-run/projects/:projectId/regions/:region/services',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.cloudRun as CloudRunPluginContext;
          const { projectId, region } = ctx.params;
          const services = Array.from(pluginCtx.snapshots.values()).filter(
            snapshot => snapshot.projectId === projectId && snapshot.region === region
          );
          return json({ services });
        },
      }),

      getService: createEndpoint({
        method: 'GET',
        path: '/cloud-run/projects/:projectId/regions/:region/services/:service',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.cloudRun as CloudRunPluginContext;
          const { projectId, region, service } = ctx.params;
          const key = buildServiceKey(projectId, region, service);
          const snapshot = pluginCtx.snapshots.get(key);
          if (!snapshot) {
            return error('Service not found', 404);
          }
          return json({ service: snapshot });
        },
      }),

      listRevisions: createEndpoint({
        method: 'GET',
        path: '/cloud-run/projects/:projectId/regions/:region/services/:service/revisions',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.cloudRun as CloudRunPluginContext;
          const { projectId, region, service } = ctx.params;

          let token: string;
          try {
            token = await getAccessToken(ctx.context, pluginCtx);
          } catch (err) {
            return error(err instanceof Error ? err.message : String(err), 500);
          }

          try {
            const revisions = await listRevisions(
              projectId,
              region,
              service,
              token,
              pluginCtx.options.apiBaseUrl,
              pluginCtx.options.maxRevisionsPerService
            );
            return json({ revisions });
          } catch (err) {
            return error(err instanceof Error ? err.message : String(err), 500);
          }
        },
      }),

      setTraffic: createEndpoint({
        method: 'POST',
        path: '/cloud-run/projects/:projectId/regions/:region/services/:service/traffic',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.cloudRun as CloudRunPluginContext;
          if (pluginCtx.options.readOnly) {
            return error('Read-only mode enabled', 403);
          }

          const { projectId, region, service } = ctx.params;
          let body: { traffic?: CloudRunTrafficTarget[] };
          try {
            body = await ctx.request.json();
          } catch (err) {
            return error('Invalid JSON body', 400);
          }

          if (!body.traffic || body.traffic.length === 0) {
            return error('traffic is required', 400);
          }

          try {
            const token = await getAccessToken(ctx.context, pluginCtx);
            await updateServiceTraffic(
              projectId,
              region,
              service,
              body.traffic,
              token,
              pluginCtx.options.apiBaseUrl
            );
          } catch (err) {
            return error(err instanceof Error ? err.message : String(err), 500);
          }

          return json({ success: true });
        },
      }),

      rollbackService: createEndpoint({
        method: 'POST',
        path: '/cloud-run/projects/:projectId/regions/:region/services/:service/rollback',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.cloudRun as CloudRunPluginContext;
          if (pluginCtx.options.readOnly) {
            return error('Read-only mode enabled', 403);
          }

          const { projectId, region, service } = ctx.params;
          const key = buildServiceKey(projectId, region, service);
          const snapshot = pluginCtx.snapshots.get(key);
          const targetRevision = snapshot?.lastKnownGoodRevision;

          if (!targetRevision) {
            return error('No known good revision available for rollback', 400);
          }

          try {
            const token = await getAccessToken(ctx.context, pluginCtx);
            await updateServiceTraffic(
              projectId,
              region,
              service,
              [{ revision: targetRevision, percent: 100 }],
              token,
              pluginCtx.options.apiBaseUrl
            );
          } catch (err) {
            return error(err instanceof Error ? err.message : String(err), 500);
          }

          return json({ success: true, revision: targetRevision });
        },
      }),
    },
  });
};
