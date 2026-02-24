/**
 * Vercel Deploys Plugin
 *
 * Observes recent deployments from Vercel and feeds that context into the OODA loop.
 * This plugin is part of the OBSERVE phase, providing deployment context for the
 * ORIENT phase to correlate with incidents and system state.
 *
 * Features:
 * - Monitor deployments across multiple projects
 * - Track deployment state changes (building, ready, error)
 * - Capture git metadata (commit, branch, author) for correlation
 * - REST API for querying deployment status
 *
 * Phase 1: PAT-based authentication
 * Phase 2 (future): OAuth integration support
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
  VercelDeploysPluginOptions,
  VercelProjectConfig,
  VercelDeployment,
  VercelApiDeploymentsResponse,
  VercelApiDeployment,
  ProjectDeploymentState,
  VercelGitMetadata,
} from './types';

export type { VercelDeploysPluginOptions, VercelProjectConfig, VercelDeployment };

const DEFAULT_API_BASE_URL = 'https://api.vercel.com';
const DEFAULT_POLL_INTERVAL_MS = 60000;
const DEFAULT_MAX_DEPLOYS_PER_PROJECT = 20;

/**
 * Get authorization header for Vercel API requests
 * This abstraction allows for future OAuth support
 */
function getAuthHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Extract git metadata from Vercel deployment meta field
 */
function extractGitMetadata(meta: Record<string, unknown> | undefined): VercelGitMetadata {
  if (!meta) return {};

  return {
    commitSha: typeof meta.githubCommitSha === 'string'
      ? meta.githubCommitSha
      : typeof meta.gitlabCommitSha === 'string'
        ? meta.gitlabCommitSha
        : typeof meta.bitbucketCommitSha === 'string'
          ? meta.bitbucketCommitSha
          : undefined,
    commitMessage: typeof meta.githubCommitMessage === 'string'
      ? meta.githubCommitMessage
      : typeof meta.gitlabCommitMessage === 'string'
        ? meta.gitlabCommitMessage
        : typeof meta.bitbucketCommitMessage === 'string'
          ? meta.bitbucketCommitMessage
          : undefined,
    branch: typeof meta.githubCommitRef === 'string'
      ? meta.githubCommitRef
      : typeof meta.gitlabCommitRef === 'string'
        ? meta.gitlabCommitRef
        : typeof meta.bitbucketCommitRef === 'string'
          ? meta.bitbucketCommitRef
          : undefined,
    author: typeof meta.githubCommitAuthorName === 'string'
      ? meta.githubCommitAuthorName
      : typeof meta.gitlabCommitAuthorName === 'string'
        ? meta.gitlabCommitAuthorName
        : typeof meta.bitbucketCommitAuthorName === 'string'
          ? meta.bitbucketCommitAuthorName
          : undefined,
    repoUrl: typeof meta.githubRepo === 'string'
      ? `https://github.com/${meta.githubRepo}`
      : typeof meta.gitlabProjectPath === 'string'
        ? `https://gitlab.com/${meta.gitlabProjectPath}`
        : undefined,
  };
}

/**
 * Normalize Vercel API deployment to our internal format
 */
function normalizeDeployment(
  apiDeployment: VercelApiDeployment,
  projectConfig: VercelProjectConfig
): VercelDeployment {
  const state = (apiDeployment.readyState || apiDeployment.state || 'QUEUED').toUpperCase();

  return {
    uid: apiDeployment.uid,
    projectId: apiDeployment.projectId || projectConfig.id,
    projectName: apiDeployment.name || projectConfig.serviceName,
    teamId: projectConfig.teamId,
    url: apiDeployment.url || '',
    inspectorUrl: apiDeployment.inspectorUrl,
    state: state as VercelDeployment['state'],
    target: apiDeployment.target as VercelDeployment['target'],
    createdAt: new Date(apiDeployment.created),
    readyAt: apiDeployment.ready ? new Date(apiDeployment.ready) : undefined,
    buildingAt: apiDeployment.buildingAt ? new Date(apiDeployment.buildingAt) : undefined,
    git: extractGitMetadata(apiDeployment.meta),
    creator: apiDeployment.creator
      ? {
          uid: apiDeployment.creator.uid,
          email: apiDeployment.creator.email,
          username: apiDeployment.creator.username || apiDeployment.creator.githubLogin,
        }
      : undefined,
    error:
      apiDeployment.errorCode || apiDeployment.errorMessage
        ? {
            code: apiDeployment.errorCode,
            message: apiDeployment.errorMessage,
          }
        : undefined,
  };
}

/**
 * Fetch deployments from Vercel API for a specific project
 */
async function fetchDeployments(
  projectConfig: VercelProjectConfig,
  options: {
    token: string;
    apiBaseUrl: string;
    limit: number;
    since?: number;
  }
): Promise<VercelDeployment[]> {
  const url = new URL(`${options.apiBaseUrl}/v6/deployments`);

  // Add query parameters
  url.searchParams.set('projectId', projectConfig.id);
  url.searchParams.set('limit', String(options.limit));

  if (projectConfig.teamId) {
    url.searchParams.set('teamId', projectConfig.teamId);
  }

  if (options.since) {
    url.searchParams.set('since', String(options.since));
  }

  // Filter by target environment if specified
  if (projectConfig.environments && projectConfig.environments.length > 0) {
    // Vercel API accepts comma-separated targets
    const firstEnv = projectConfig.environments[0];
    if (firstEnv) {
      url.searchParams.set('target', firstEnv);
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
    throw new Error(`Vercel API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as VercelApiDeploymentsResponse;

  return data.deployments.map((d) => normalizeDeployment(d, projectConfig));
}

/**
 * Create the Vercel Deploys plugin
 */
export const vercelDeploys = (options: VercelDeploysPluginOptions) => {
  // Validation
  if (!options.auth?.token) {
    throw new Error('vercelDeploys: auth.token is required');
  }

  if (!options.projects || options.projects.length === 0) {
    throw new Error('vercelDeploys: at least one project must be configured');
  }

  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const maxDeploysPerProject = options.maxDeploysPerProject || DEFAULT_MAX_DEPLOYS_PER_PROJECT;

  return definePlugin({
    id: 'vercel-deploys',

    init: async (ctx: AgentContext) => {
      ctx.logger.info(
        `[vercel-deploys] Initializing plugin with ${options.projects.length} project(s)`
      );

      // Initialize state for each project
      const projectStates = new Map<string, ProjectDeploymentState>();
      for (const project of options.projects) {
        projectStates.set(project.id, {
          recentDeployments: [],
        });
      }

      return {
        context: {
          vercelDeploys: {
            projects: options.projects,
            projectStates,
            apiBaseUrl,
            token: options.auth.token,
            maxDeploysPerProject,
          },
        },
      };
    },

    observers: {
      recentDeploys: createObserver({
        name: 'vercel-recent-deploys',
        description: 'Monitor recent deployments from Vercel',
        interval: pollIntervalMs,
        observe: async (ctx: AgentContext) => {
          const pluginCtx = ctx.vercelDeploys as {
            projects: VercelProjectConfig[];
            projectStates: Map<string, ProjectDeploymentState>;
            apiBaseUrl: string;
            token: string;
            maxDeploysPerProject: number;
          };

          const observations: Observation[] = [];

          for (const project of pluginCtx.projects) {
            try {
              const state = pluginCtx.projectStates.get(project.id);
              if (!state) continue;

              // Fetch deployments (optionally since last seen)
              const deployments = await fetchDeployments(project, {
                token: pluginCtx.token,
                apiBaseUrl: pluginCtx.apiBaseUrl,
                limit: pluginCtx.maxDeploysPerProject,
                since: state.lastSeenTimestamp,
              });

              // Update state
              if (deployments.length > 0) {
                // Update last seen timestamp to the most recent deployment
                const mostRecent = deployments.reduce((latest, d) =>
                  d.createdAt > latest.createdAt ? d : latest
                );
                state.lastSeenTimestamp = mostRecent.createdAt.getTime();
                state.recentDeployments = deployments;
              }
              state.lastFetchTime = new Date();

              // Create observations for each deployment
              for (const deployment of deployments) {
                const isError = deployment.state === 'ERROR' || deployment.state === 'CANCELED';
                const isBuilding = deployment.state === 'BUILDING' || deployment.state === 'QUEUED';

                // Determine severity based on state and environment
                let severity: Observation['severity'] = 'info';
                if (isError) {
                  severity = deployment.target === 'production' ? 'critical' : 'error';
                } else if (isBuilding) {
                  severity = 'info';
                }

                // Calculate time since previous deployment if we have history
                let timeSincePreviousDeploy: number | undefined;
                const previousDeploys = state.recentDeployments.filter(
                  (d) => d.uid !== deployment.uid && d.createdAt < deployment.createdAt
                );
                if (previousDeploys.length > 0) {
                  const previousDeploy = previousDeploys.reduce((latest, d) =>
                    d.createdAt > latest.createdAt ? d : latest
                  );
                  timeSincePreviousDeploy =
                    deployment.createdAt.getTime() - previousDeploy.createdAt.getTime();
                }

                observations.push({
                  source: 'vercel-deploys/deployment',
                  timestamp: deployment.createdAt,
                  type: 'event',
                  severity,
                  data: {
                    deploymentId: deployment.uid,
                    projectId: deployment.projectId,
                    projectName: deployment.projectName,
                    serviceName: project.serviceName,
                    teamId: deployment.teamId,
                    environment: deployment.target,
                    state: deployment.state,
                    url: deployment.url,
                    inspectorUrl: deployment.inspectorUrl,
                    createdAt: deployment.createdAt.toISOString(),
                    readyAt: deployment.readyAt?.toISOString(),
                    buildingAt: deployment.buildingAt?.toISOString(),
                    git: deployment.git,
                    creator: deployment.creator,
                    error: deployment.error,
                    timeSincePreviousDeploy,
                  },
                  metadata: {
                    plugin: 'vercel-deploys',
                    projectConfig: {
                      id: project.id,
                      serviceName: project.serviceName,
                      environments: project.environments,
                    },
                  },
                });
              }
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : 'Unknown error';
              ctx.logger.error(
                `[vercel-deploys] Failed to fetch deployments for ${project.serviceName}: ${errorMessage}`
              );

              // Emit an error observation so the system knows something is wrong
              observations.push({
                source: 'vercel-deploys/error',
                timestamp: new Date(),
                type: 'alert',
                severity: 'warning',
                data: {
                  projectId: project.id,
                  serviceName: project.serviceName,
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
      analyzeDeployments: createOrienter({
        name: 'analyze-vercel-deployments',
        description: 'Analyze recent Vercel deployments and identify patterns',
        orient: async (observations: Observation[], ctx: AgentContext) => {
          const deployObs = observations.filter(
            (obs) => obs.source === 'vercel-deploys/deployment'
          );

          const findings: string[] = [];
          let contributingFactor: string | undefined;

          if (deployObs.length === 0) {
            findings.push('No recent Vercel deployments observed');
            return {
              source: 'vercel-deploys/analyze-deployments',
              findings,
              confidence: 1.0,
            };
          }

          // Group by service
          const byService = new Map<string, Observation[]>();
          for (const obs of deployObs) {
            const serviceName = obs.data.serviceName as string;
            const existing = byService.get(serviceName) || [];
            existing.push(obs);
            byService.set(serviceName, existing);
          }

          // Analyze each service
          for (const [serviceName, serviceObs] of byService) {
            const prodDeploys = serviceObs.filter((o) => o.data.environment === 'production');
            const failedDeploys = serviceObs.filter(
              (o) => o.data.state === 'ERROR' || o.data.state === 'CANCELED'
            );
            const recentDeploy = serviceObs.reduce((latest, o) => {
              const oDate = new Date(o.data.createdAt as string);
              const latestDate = new Date(latest.data.createdAt as string);
              return oDate > latestDate ? o : latest;
            });

            // Report recent production deployment
            if (prodDeploys.length > 0) {
              const mostRecentProd = prodDeploys.reduce((latest, o) => {
                const oDate = new Date(o.data.createdAt as string);
                const latestDate = new Date(latest.data.createdAt as string);
                return oDate > latestDate ? o : latest;
              });

              const timeSince = Date.now() - new Date(mostRecentProd.data.createdAt as string).getTime();
              const minutesAgo = Math.round(timeSince / 60000);

              const gitInfo = mostRecentProd.data.git as VercelGitMetadata;
              const commitInfo = gitInfo?.commitSha
                ? ` (commit ${gitInfo.commitSha.slice(0, 7)}${gitInfo.author ? ` by ${gitInfo.author}` : ''})`
                : '';

              findings.push(
                `${serviceName}: production deployment ${minutesAgo}m ago - ${mostRecentProd.data.state}${commitInfo}`
              );
            }

            // Report failures
            if (failedDeploys.length > 0) {
              findings.push(
                `${serviceName}: ${failedDeploys.length} failed deployment(s) in recent history`
              );

              // If multiple failures, this might indicate a systemic issue
              if (failedDeploys.length >= 3) {
                contributingFactor = `Multiple deployment failures detected for ${serviceName} - possible build or configuration issue`;
              }
            }

            // Report if there's a deployment in progress
            const buildingDeploys = serviceObs.filter(
              (o) => o.data.state === 'BUILDING' || o.data.state === 'QUEUED'
            );
            if (buildingDeploys.length > 0) {
              findings.push(`${serviceName}: ${buildingDeploys.length} deployment(s) in progress`);
            }
          }

          const assessment: SituationAssessment = {
            source: 'vercel-deploys/analyze-deployments',
            findings,
            contributingFactor,
            confidence: 0.85,
          };

          return assessment;
        },
      }),
    },

    endpoints: {
      listProjects: createEndpoint({
        method: 'GET',
        path: '/vercel/projects',
        description: 'List configured Vercel projects with deployment status',
        handler: async (ctx) => {
          const pluginCtx = ctx.context.vercelDeploys as {
            projects: VercelProjectConfig[];
            projectStates: Map<string, ProjectDeploymentState>;
          };

          const projects = pluginCtx.projects.map((project) => {
            const state = pluginCtx.projectStates.get(project.id);
            const lastDeploy =
              state?.recentDeployments && state.recentDeployments.length > 0
                ? state.recentDeployments.reduce((latest, d) =>
                    d.createdAt > latest.createdAt ? d : latest
                  )
                : null;

            return {
              id: project.id,
              serviceName: project.serviceName,
              teamId: project.teamId,
              environments: project.environments || ['production'],
              lastFetchTime: state?.lastFetchTime?.toISOString(),
              lastDeployment: lastDeploy
                ? {
                    uid: lastDeploy.uid,
                    state: lastDeploy.state,
                    target: lastDeploy.target,
                    url: lastDeploy.url,
                    createdAt: lastDeploy.createdAt.toISOString(),
                    git: lastDeploy.git,
                  }
                : null,
              recentDeploymentCount: state?.recentDeployments?.length || 0,
            };
          });

          return json({ projects });
        },
        auth: true,
      }),

      getProjectDeployments: createEndpoint({
        method: 'GET',
        path: '/vercel/projects/:projectId/deployments',
        description: 'Get recent deployments for a specific project',
        handler: async (ctx) => {
          const projectId = ctx.params.projectId;
          if (!projectId) {
            return error('Project ID is required', 400);
          }

          const pluginCtx = ctx.context.vercelDeploys as {
            projects: VercelProjectConfig[];
            projectStates: Map<string, ProjectDeploymentState>;
          };

          const project = pluginCtx.projects.find((p) => p.id === projectId);
          if (!project) {
            return error(`Project not found: ${projectId}`, 404);
          }

          const state = pluginCtx.projectStates.get(projectId);
          if (!state) {
            return error(`No state found for project: ${projectId}`, 404);
          }

          const deployments = state.recentDeployments.map((d) => ({
            uid: d.uid,
            projectId: d.projectId,
            projectName: d.projectName,
            state: d.state,
            target: d.target,
            url: d.url,
            inspectorUrl: d.inspectorUrl,
            createdAt: d.createdAt.toISOString(),
            readyAt: d.readyAt?.toISOString(),
            git: d.git,
            creator: d.creator,
            error: d.error,
          }));

          return json({
            project: {
              id: project.id,
              serviceName: project.serviceName,
            },
            deployments,
            lastFetchTime: state.lastFetchTime?.toISOString(),
          });
        },
        auth: true,
      }),
    },

    onLoopComplete: async (result, ctx) => {
      const pluginCtx = ctx.vercelDeploys as {
        projectStates: Map<string, ProjectDeploymentState>;
      };

      // Log summary of deployment observations
      const deployObs = result.observations.filter(
        (obs) => obs.source === 'vercel-deploys/deployment'
      );
      const errorObs = result.observations.filter((obs) => obs.source === 'vercel-deploys/error');

      if (deployObs.length > 0 || errorObs.length > 0) {
        const failedDeploys = deployObs.filter(
          (o) => o.data.state === 'ERROR' || o.data.state === 'CANCELED'
        );

        if (failedDeploys.length > 0) {
          ctx.logger.warn(
            `[vercel-deploys] Loop complete: ${deployObs.length} deployment(s) observed, ${failedDeploys.length} failed`
          );
        } else if (errorObs.length > 0) {
          ctx.logger.warn(
            `[vercel-deploys] Loop complete: ${errorObs.length} API error(s) occurred`
          );
        } else {
          ctx.logger.info(
            `[vercel-deploys] Loop complete: ${deployObs.length} deployment(s) observed`
          );
        }
      }
    },
  });
};
