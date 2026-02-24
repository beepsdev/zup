/**
 * Fly.io Machines Plugin
 *
 * Observes Fly.io machines and their state changes to track deployments and feed
 * that context into the OODA loop. This plugin is part of the OBSERVE phase,
 * providing deployment and machine health context for the ORIENT phase to
 * correlate with incidents and system state.
 *
 * Features:
 * - Monitor machines across multiple Fly.io apps
 * - Track machine state changes and detect deployments via instance_id changes
 * - Capture image metadata (registry, repository, tag, digest) for correlation
 * - Track machine events (launch, start, stop, update)
 * - REST API for querying machine status
 *
 * Key Difference from Vercel:
 * Fly.io doesn't have a dedicated "deployments" endpoint. Instead, we detect
 * deployments by monitoring machine instance_id changes and image digest updates.
 */

import {
  definePlugin,
  createObserver,
  createOrienter,
  createEndpoint,
  json,
  error,
  type AgentContext,
  type Observation,
  type SituationAssessment,
} from '../../core/src/index';
import type {
  FlyMachinesPluginOptions,
  FlyAppConfig,
  FlyMachine,
  FlyApiMachine,
  AppMachineState,
  FlyMachineState,
  FlyDeploymentEvent,
} from './types';

export type { FlyMachinesPluginOptions, FlyAppConfig, FlyMachine, FlyDeploymentEvent };

const DEFAULT_API_BASE_URL = 'https://api.machines.dev';
const DEFAULT_POLL_INTERVAL_MS = 60000;
const DEFAULT_MAX_MACHINES_PER_APP = 50;

/**
 * Get authorization header for Fly.io API requests
 */
function getAuthHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Normalize Fly.io API machine to our internal format
 */
function normalizeMachine(apiMachine: FlyApiMachine, appName: string): FlyMachine {
  return {
    id: apiMachine.id,
    name: apiMachine.name,
    appName,
    state: apiMachine.state as FlyMachineState,
    region: apiMachine.region,
    instanceId: apiMachine.instance_id,
    privateIp: apiMachine.private_ip,
    imageRef: {
      registry: apiMachine.image_ref.registry,
      repository: apiMachine.image_ref.repository,
      tag: apiMachine.image_ref.tag,
      digest: apiMachine.image_ref.digest,
      labels: apiMachine.image_ref.labels,
    },
    guest: apiMachine.config?.guest
      ? {
          cpu_kind: apiMachine.config.guest.cpu_kind,
          cpus: apiMachine.config.guest.cpus,
          memory_mb: apiMachine.config.guest.memory_mb,
          gpu_kind: apiMachine.config.guest.gpu_kind,
          gpus: apiMachine.config.guest.gpus,
        }
      : undefined,
    events: (apiMachine.events || []).map((e) => ({
      type: e.type,
      status: e.status,
      source: e.source,
      timestamp: e.timestamp,
      request: e.request,
    })),
    checks: apiMachine.checks
      ? Object.fromEntries(
          Object.entries(apiMachine.checks).map(([key, check]) => [
            key,
            {
              name: check.name || key,
              status: (check.status || 'unknown') as 'passing' | 'warning' | 'critical',
              output: check.output,
              updated_at: check.updated_at,
            },
          ])
        )
      : undefined,
    metadata: apiMachine.config?.metadata,
    createdAt: new Date(apiMachine.created_at),
    updatedAt: new Date(apiMachine.updated_at),
  };
}

/**
 * Fetch machines from Fly.io API for a specific app
 */
async function fetchMachines(
  appConfig: FlyAppConfig,
  options: {
    token: string;
    apiBaseUrl: string;
  }
): Promise<FlyMachine[]> {
  const url = new URL(`${options.apiBaseUrl}/v1/apps/${appConfig.name}/machines`);

  // Add region filter if specified
  if (appConfig.regions && appConfig.regions.length > 0) {
    const firstRegion = appConfig.regions[0];
    if (firstRegion) {
      url.searchParams.set('region', firstRegion);
    }
  }

  // Add metadata filters if specified
  if (appConfig.metadata) {
    for (const [key, value] of Object.entries(appConfig.metadata)) {
      url.searchParams.set(`metadata.${key}`, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      ...getAuthHeader(options.token),
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fly.io API error (${response.status}): ${errorText}`);
  }

  const machines = (await response.json()) as FlyApiMachine[];

  return machines.map((m) => normalizeMachine(m, appConfig.name));
}

/**
 * Detect deployment events by comparing current machines to previous state
 */
function detectDeploymentEvents(
  appConfig: FlyAppConfig,
  currentMachines: FlyMachine[],
  previousInstanceIds: Map<string, string>
): FlyDeploymentEvent[] {
  const deploymentEvents: FlyDeploymentEvent[] = [];

  // Group machines by image digest to detect coordinated deployments
  const machinesByDigest = new Map<string, FlyMachine[]>();
  const updatedMachines: FlyMachine[] = [];

  for (const machine of currentMachines) {
    const previousInstanceId = previousInstanceIds.get(machine.id);

    // Detect if this machine was updated (instance_id changed)
    if (previousInstanceId && previousInstanceId !== machine.instanceId) {
      updatedMachines.push(machine);
    }

    // Group by digest
    const digest = machine.imageRef.digest;
    const existing = machinesByDigest.get(digest) || [];
    existing.push(machine);
    machinesByDigest.set(digest, existing);
  }

  // If we have updated machines, create a deployment event
  if (updatedMachines.length > 0) {
    // Group updated machines by their new image digest
    const updatedByDigest = new Map<string, FlyMachine[]>();
    for (const machine of updatedMachines) {
      const digest = machine.imageRef.digest;
      const existing = updatedByDigest.get(digest) || [];
      existing.push(machine);
      updatedByDigest.set(digest, existing);
    }

    // Create deployment event for each unique new digest
    for (const [digest, machines] of updatedByDigest) {
      const firstMachine = machines[0];
      if (!firstMachine) continue;

      const regions = [...new Set(machines.map((m) => m.region))];
      const machineIds = machines.map((m) => m.id);

      // Determine deployment status based on machine states
      const startedCount = machines.filter((m) => m.state === 'started').length;
      const failedCount = machines.filter(
        (m) => m.state === 'destroyed' || m.state === 'replacing'
      ).length;

      let status: FlyDeploymentEvent['status'] = 'in_progress';
      if (startedCount === machines.length) {
        status = 'completed';
      } else if (failedCount > 0 && startedCount > 0) {
        status = 'partial';
      } else if (failedCount === machines.length) {
        status = 'failed';
      }

      deploymentEvents.push({
        id: `deploy-${appConfig.name}-${Date.now()}`,
        appName: appConfig.name,
        serviceName: appConfig.serviceName,
        newImageDigest: digest,
        imageRepository: firstMachine.imageRef.repository,
        imageTag: firstMachine.imageRef.tag,
        machinesAffected: machineIds,
        regionsAffected: regions,
        detectedAt: new Date(),
        status,
        successCount: startedCount,
        failureCount: failedCount,
      });
    }
  }

  return deploymentEvents;
}

/**
 * Create the Fly.io Machines plugin
 */
export const flyMachines = (options: FlyMachinesPluginOptions) => {
  // Validation
  if (!options.auth?.token) {
    throw new Error('flyMachines: auth.token is required');
  }

  if (!options.apps || options.apps.length === 0) {
    throw new Error('flyMachines: at least one app must be configured');
  }

  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const maxMachinesPerApp = options.maxMachinesPerApp || DEFAULT_MAX_MACHINES_PER_APP;

  return definePlugin({
    id: 'fly-machines',

    init: async (ctx: AgentContext) => {
      ctx.logger.info(`[fly-machines] Initializing plugin with ${options.apps.length} app(s)`);

      // Initialize state for each app
      const appStates = new Map<string, AppMachineState>();
      for (const app of options.apps) {
        appStates.set(app.name, {
          lastKnownInstanceIds: new Map(),
          recentMachines: [],
        });
      }

      return {
        context: {
          flyMachines: {
            apps: options.apps,
            appStates,
            apiBaseUrl,
            token: options.auth.token,
            maxMachinesPerApp,
          },
        },
      };
    },

    observers: {
      machineStatus: createObserver({
        name: 'fly-machine-status',
        description: 'Monitor Fly.io machine status and detect deployments',
        interval: pollIntervalMs,
        observe: async (ctx: AgentContext) => {
          const pluginCtx = ctx.flyMachines as {
            apps: FlyAppConfig[];
            appStates: Map<string, AppMachineState>;
            apiBaseUrl: string;
            token: string;
            maxMachinesPerApp: number;
          };

          const observations: Observation[] = [];

          for (const app of pluginCtx.apps) {
            try {
              const state = pluginCtx.appStates.get(app.name);
              if (!state) continue;

              // Fetch current machines
              const machines = await fetchMachines(app, {
                token: pluginCtx.token,
                apiBaseUrl: pluginCtx.apiBaseUrl,
              });

              // Limit to max machines
              const limitedMachines = machines.slice(0, pluginCtx.maxMachinesPerApp);

              // Detect deployment events (instance_id changes)
              const deploymentEvents = detectDeploymentEvents(
                app,
                limitedMachines,
                state.lastKnownInstanceIds
              );

              // Update state with current instance IDs
              for (const machine of limitedMachines) {
                state.lastKnownInstanceIds.set(machine.id, machine.instanceId);
              }
              state.recentMachines = limitedMachines;
              state.lastFetchTime = new Date();

              // Create observations for deployment events
              for (const deployEvent of deploymentEvents) {
                const severity: Observation['severity'] =
                  deployEvent.status === 'failed'
                    ? 'critical'
                    : deployEvent.status === 'partial'
                      ? 'error'
                      : 'info';

                observations.push({
                  source: 'fly-machines/deployment',
                  timestamp: deployEvent.detectedAt,
                  type: 'event',
                  severity,
                  data: {
                    deploymentId: deployEvent.id,
                    appName: deployEvent.appName,
                    serviceName: deployEvent.serviceName,
                    imageDigest: deployEvent.newImageDigest,
                    imageRepository: deployEvent.imageRepository,
                    imageTag: deployEvent.imageTag,
                    machinesAffected: deployEvent.machinesAffected,
                    regionsAffected: deployEvent.regionsAffected,
                    status: deployEvent.status,
                    successCount: deployEvent.successCount,
                    failureCount: deployEvent.failureCount,
                  },
                  metadata: {
                    plugin: 'fly-machines',
                    appConfig: {
                      name: app.name,
                      serviceName: app.serviceName,
                      regions: app.regions,
                    },
                  },
                });
              }

              // Create observations for each machine's current state
              for (const machine of limitedMachines) {
                const isUnhealthy =
                  machine.state === 'destroyed' ||
                  machine.state === 'stopping' ||
                  machine.state === 'stopped';

                const hasFailingChecks =
                  machine.checks &&
                  Object.values(machine.checks).some((c) => c.status === 'critical');

                let severity: Observation['severity'] = 'info';
                if (isUnhealthy || hasFailingChecks) {
                  severity = 'warning';
                }

                // Get most recent event
                const recentEvent = machine.events[0];

                observations.push({
                  source: 'fly-machines/machine',
                  timestamp: machine.updatedAt,
                  type: 'metric',
                  severity,
                  data: {
                    machineId: machine.id,
                    machineName: machine.name,
                    appName: machine.appName,
                    serviceName: app.serviceName,
                    state: machine.state,
                    region: machine.region,
                    instanceId: machine.instanceId,
                    imageDigest: machine.imageRef.digest,
                    imageRepository: machine.imageRef.repository,
                    imageTag: machine.imageRef.tag,
                    guest: machine.guest,
                    checks: machine.checks,
                    recentEvent: recentEvent
                      ? {
                          type: recentEvent.type,
                          status: recentEvent.status,
                          timestamp: new Date(recentEvent.timestamp).toISOString(),
                        }
                      : undefined,
                    createdAt: machine.createdAt.toISOString(),
                    updatedAt: machine.updatedAt.toISOString(),
                  },
                  metadata: {
                    plugin: 'fly-machines',
                    appConfig: {
                      name: app.name,
                      serviceName: app.serviceName,
                    },
                  },
                });
              }
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : 'Unknown error';
              ctx.logger.error(
                `[fly-machines] Failed to fetch machines for ${app.serviceName}: ${errorMessage}`
              );

              // Emit an error observation
              observations.push({
                source: 'fly-machines/error',
                timestamp: new Date(),
                type: 'alert',
                severity: 'warning',
                data: {
                  appName: app.name,
                  serviceName: app.serviceName,
                  error: errorMessage,
                },
              });
            }
          }

          return observations;
        },
      }),
    },

    orienters: {
      analyzeMachines: createOrienter({
        name: 'analyze-fly-machines',
        description: 'Analyze Fly.io machines and identify deployment patterns',
        orient: async (observations: Observation[], ctx: AgentContext) => {
          const machineObs = observations.filter(
            (obs) => obs.source === 'fly-machines/machine'
          );
          const deployObs = observations.filter(
            (obs) => obs.source === 'fly-machines/deployment'
          );

          const findings: string[] = [];
          let contributingFactor: string | undefined;

          if (machineObs.length === 0 && deployObs.length === 0) {
            findings.push('No Fly.io machines or deployments observed');
            return {
              source: 'fly-machines/analyze-machines',
              findings,
              confidence: 1.0,
            };
          }

          // Analyze deployments
          if (deployObs.length > 0) {
            for (const obs of deployObs) {
              const status = obs.data.status as string;
              const serviceName = obs.data.serviceName as string;
              const machineCount = (obs.data.machinesAffected as string[]).length;
              const regions = (obs.data.regionsAffected as string[]).join(', ');
              const imageTag = obs.data.imageTag as string | undefined;

              const tagInfo = imageTag ? ` (${imageTag})` : '';

              if (status === 'completed') {
                findings.push(
                  `${serviceName}: deployment completed - ${machineCount} machine(s) updated in ${regions}${tagInfo}`
                );
              } else if (status === 'in_progress') {
                findings.push(
                  `${serviceName}: deployment in progress - ${machineCount} machine(s) updating in ${regions}${tagInfo}`
                );
              } else if (status === 'partial') {
                findings.push(
                  `${serviceName}: deployment partially failed - some machines failed to update in ${regions}${tagInfo}`
                );
                contributingFactor = `Partial deployment failure for ${serviceName} - some machines did not update successfully`;
              } else if (status === 'failed') {
                findings.push(
                  `${serviceName}: deployment FAILED - ${machineCount} machine(s) failed in ${regions}${tagInfo}`
                );
                contributingFactor = `Deployment failure for ${serviceName} - all machines failed to update`;
              }
            }
          }

          // Group machines by service
          const byService = new Map<string, Observation[]>();
          for (const obs of machineObs) {
            const serviceName = obs.data.serviceName as string;
            const existing = byService.get(serviceName) || [];
            existing.push(obs);
            byService.set(serviceName, existing);
          }

          // Analyze each service's machines
          for (const [serviceName, serviceObs] of byService) {
            const totalMachines = serviceObs.length;
            const startedMachines = serviceObs.filter(
              (o) => o.data.state === 'started'
            ).length;
            const stoppedMachines = serviceObs.filter(
              (o) => o.data.state === 'stopped' || o.data.state === 'suspended'
            ).length;
            const unhealthyMachines = serviceObs.filter((o) => {
              const checks = o.data.checks as Record<string, { status: string }> | undefined;
              return (
                checks && Object.values(checks).some((c) => c.status === 'critical')
              );
            }).length;

            // Get unique regions
            const regions = [...new Set(serviceObs.map((o) => o.data.region as string))];

            findings.push(
              `${serviceName}: ${startedMachines}/${totalMachines} machines running across ${regions.join(', ')}`
            );

            if (stoppedMachines > 0) {
              findings.push(`${serviceName}: ${stoppedMachines} machine(s) stopped/suspended`);
            }

            if (unhealthyMachines > 0) {
              findings.push(
                `${serviceName}: ${unhealthyMachines} machine(s) with failing health checks`
              );
              if (!contributingFactor) {
                contributingFactor = `Health check failures detected for ${serviceName}`;
              }
            }
          }

          const assessment: SituationAssessment = {
            source: 'fly-machines/analyze-machines',
            findings,
            contributingFactor,
            confidence: 0.85,
          };

          return assessment;
        },
      }),
    },

    endpoints: {
      listApps: createEndpoint({
        method: 'GET',
        path: '/fly/apps',
        description: 'List configured Fly.io apps with machine status',
        handler: async (ctx) => {
          const pluginCtx = ctx.context.flyMachines as {
            apps: FlyAppConfig[];
            appStates: Map<string, AppMachineState>;
          };

          const apps = pluginCtx.apps.map((app) => {
            const state = pluginCtx.appStates.get(app.name);
            const machines = state?.recentMachines || [];

            const startedCount = machines.filter((m) => m.state === 'started').length;
            const totalCount = machines.length;

            // Get unique image digests (to detect if all machines are on same version)
            const uniqueDigests = [...new Set(machines.map((m) => m.imageRef.digest))];
            const isConsistent = uniqueDigests.length <= 1;

            // Get unique regions
            const regions = [...new Set(machines.map((m) => m.region))];

            return {
              name: app.name,
              serviceName: app.serviceName,
              configuredRegions: app.regions,
              activeRegions: regions,
              lastFetchTime: state?.lastFetchTime?.toISOString(),
              machineCount: totalCount,
              runningCount: startedCount,
              isConsistent,
              currentImageDigest: uniqueDigests[0],
              imageDigestCount: uniqueDigests.length,
            };
          });

          return json({ apps });
        },
        auth: true,
      }),

      getAppMachines: createEndpoint({
        method: 'GET',
        path: '/fly/apps/:appName/machines',
        description: 'Get machines for a specific Fly.io app',
        handler: async (ctx) => {
          const appName = ctx.params.appName;
          if (!appName) {
            return error('App name is required', 400);
          }

          const pluginCtx = ctx.context.flyMachines as {
            apps: FlyAppConfig[];
            appStates: Map<string, AppMachineState>;
          };

          const app = pluginCtx.apps.find((a) => a.name === appName);
          if (!app) {
            return error(`App not found: ${appName}`, 404);
          }

          const state = pluginCtx.appStates.get(appName);
          if (!state) {
            return error(`No state found for app: ${appName}`, 404);
          }

          const machines = state.recentMachines.map((m) => ({
            id: m.id,
            name: m.name,
            state: m.state,
            region: m.region,
            instanceId: m.instanceId,
            imageRef: {
              repository: m.imageRef.repository,
              tag: m.imageRef.tag,
              digest: m.imageRef.digest.slice(0, 16) + '...',
            },
            guest: m.guest,
            checks: m.checks,
            recentEvents: m.events.slice(0, 5).map((e) => ({
              type: e.type,
              status: e.status,
              timestamp: new Date(e.timestamp).toISOString(),
            })),
            createdAt: m.createdAt.toISOString(),
            updatedAt: m.updatedAt.toISOString(),
          }));

          return json({
            app: {
              name: app.name,
              serviceName: app.serviceName,
            },
            machines,
            lastFetchTime: state.lastFetchTime?.toISOString(),
          });
        },
        auth: true,
      }),
    },

    onLoopComplete: async (result, ctx) => {
      const pluginCtx = ctx.flyMachines as {
        appStates: Map<string, AppMachineState>;
      };

      // Log summary of observations
      const machineObs = result.observations.filter(
        (obs) => obs.source === 'fly-machines/machine'
      );
      const deployObs = result.observations.filter(
        (obs) => obs.source === 'fly-machines/deployment'
      );
      const errorObs = result.observations.filter(
        (obs) => obs.source === 'fly-machines/error'
      );

      if (machineObs.length > 0 || deployObs.length > 0 || errorObs.length > 0) {
        const unhealthyMachines = machineObs.filter(
          (o) => o.data.state !== 'started'
        );
        const failedDeploys = deployObs.filter(
          (o) => o.data.status === 'failed' || o.data.status === 'partial'
        );

        if (failedDeploys.length > 0) {
          ctx.logger.warn(
            `[fly-machines] Loop complete: ${deployObs.length} deployment(s), ${failedDeploys.length} failed/partial`
          );
        } else if (unhealthyMachines.length > 0) {
          ctx.logger.warn(
            `[fly-machines] Loop complete: ${machineObs.length} machine(s), ${unhealthyMachines.length} not running`
          );
        } else if (errorObs.length > 0) {
          ctx.logger.warn(
            `[fly-machines] Loop complete: ${errorObs.length} API error(s) occurred`
          );
        } else if (deployObs.length > 0) {
          ctx.logger.info(
            `[fly-machines] Loop complete: ${deployObs.length} deployment(s) detected, ${machineObs.length} machine(s) observed`
          );
        } else {
          ctx.logger.info(
            `[fly-machines] Loop complete: ${machineObs.length} machine(s) observed`
          );
        }
      }
    },
  });
};
