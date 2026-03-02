import {
  definePlugin,
  createObserver,
  createOrienter,
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
  KubernetesPluginOptions,
  KubectlResult,
  KubectlError,
  PodStatus,
  DeploymentStatus,
  NodeStatus,
  K8sEvent,
  ClusterState,
  UnhealthyPod,
  DegradedDeployment,
  ClusterHealthSummary,
  ContainerState,
  RestartDeploymentInput,
  ScaleDeploymentInput,
  DeletePodInput,
  GetLogsInput,
} from './types';

export type { KubernetesPluginOptions };

const SYSTEM_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'istio-system', 'cert-manager'];
const PENDING_TOO_LONG_SECONDS = 300;

async function runKubectl(
  args: string[],
  options: KubernetesPluginOptions
): Promise<KubectlResult> {
  const kubectlCmd = 'kubectl';
  const fullArgs = [...args];

  if (options.context) {
    fullArgs.push('--context', options.context);
  }

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (options.kubeconfigPath) {
    env.KUBECONFIG = options.kubeconfigPath;
  }

  const timeout = options.timeoutMs ?? 30000;

  const proc = Bun.spawn([kubectlCmd, ...fullArgs], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error('kubectl command timed out'));
    }, timeout);
  });

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode };
  } catch (err) {
    if (err instanceof Error && err.message.includes('timed out')) {
      throw { type: 'timeout', message: 'kubectl command timed out' } as KubectlError;
    }
    throw err;
  }
}

function parseKubectlError(result: KubectlResult): KubectlError {
  const { stderr, exitCode } = result;
  const lowerStderr = stderr.toLowerCase();

  if (lowerStderr.includes('command not found') || lowerStderr.includes('enoent')) {
    return { type: 'not-installed', message: 'kubectl is not installed or not in PATH', stderr };
  }
  if (lowerStderr.includes('unauthorized') || lowerStderr.includes('forbidden') || lowerStderr.includes('authentication')) {
    return { type: 'auth-failed', message: 'Authentication failed - check kubeconfig', stderr };
  }
  if (lowerStderr.includes('connection refused') || lowerStderr.includes('no such host') || lowerStderr.includes('timeout')) {
    return { type: 'unreachable', message: 'Kubernetes API server is unreachable', stderr };
  }
  if (lowerStderr.includes('not found') || lowerStderr.includes('notfound')) {
    return { type: 'not-found', message: 'Resource not found', stderr };
  }
  return { type: 'unknown', message: `kubectl failed with exit code ${exitCode}`, stderr };
}

function assertWritable(options: KubernetesPluginOptions, action: string): void {
  if (options.readOnly !== false) {
    throw new Error(`Action '${action}' is disabled because plugin is in read-only mode. Set readOnly: false to enable.`);
  }
}

function getNamespaceArgs(options: KubernetesPluginOptions): string[] {
  const namespaces = options.namespaces ?? ['default'];
  if (namespaces.includes('*')) {
    return ['--all-namespaces'];
  }
  return [];
}

function shouldIncludeNamespace(ns: string, options: KubernetesPluginOptions): boolean {
  const namespaces = options.namespaces ?? ['default'];
  if (namespaces.includes('*')) {
    if (options.excludeSystemNamespaces !== false && SYSTEM_NAMESPACES.includes(ns)) {
      return false;
    }
    return true;
  }
  return namespaces.includes(ns);
}

function parseAge(creationTimestamp: string): number {
  const created = new Date(creationTimestamp);
  return Math.floor((Date.now() - created.getTime()) / 1000);
}

function parsePodStatus(pod: Record<string, unknown>): PodStatus {
  const metadata = pod.metadata as Record<string, unknown>;
  const status = pod.status as Record<string, unknown>;
  const spec = pod.spec as Record<string, unknown>;

  const containerStatuses = (status.containerStatuses as Array<Record<string, unknown>>) ?? [];
  const containers: ContainerState[] = containerStatuses.map((cs) => {
    const stateObj = cs.state as Record<string, unknown>;
    let state: 'running' | 'waiting' | 'terminated' = 'waiting';
    let reason: string | undefined;
    let message: string | undefined;

    if (stateObj.running) {
      state = 'running';
    } else if (stateObj.waiting) {
      state = 'waiting';
      const w = stateObj.waiting as Record<string, unknown>;
      reason = w.reason as string | undefined;
      message = w.message as string | undefined;
    } else if (stateObj.terminated) {
      state = 'terminated';
      const t = stateObj.terminated as Record<string, unknown>;
      reason = t.reason as string | undefined;
      message = t.message as string | undefined;
    }

    return {
      name: cs.name as string,
      ready: cs.ready as boolean,
      restartCount: cs.restartCount as number,
      state,
      reason,
      message,
    };
  });

  const totalRestarts = containers.reduce((sum, c) => sum + c.restartCount, 0);

  return {
    name: metadata.name as string,
    namespace: metadata.namespace as string,
    phase: status.phase as PodStatus['phase'],
    nodeName: (spec.nodeName as string) ?? undefined,
    containers,
    totalRestarts,
    ageSeconds: parseAge(metadata.creationTimestamp as string),
    conditions: status.conditions as PodStatus['conditions'],
  };
}

function parseDeploymentStatus(dep: Record<string, unknown>): DeploymentStatus {
  const metadata = dep.metadata as Record<string, unknown>;
  const status = dep.status as Record<string, unknown>;
  const spec = dep.spec as Record<string, unknown>;

  return {
    name: metadata.name as string,
    namespace: metadata.namespace as string,
    replicas: (spec.replicas as number) ?? 0,
    readyReplicas: (status.readyReplicas as number) ?? 0,
    unavailableReplicas: (status.unavailableReplicas as number) ?? 0,
    updatedReplicas: (status.updatedReplicas as number) ?? 0,
    ageSeconds: parseAge(metadata.creationTimestamp as string),
  };
}

function parseNodeStatus(node: Record<string, unknown>): NodeStatus {
  const metadata = node.metadata as Record<string, unknown>;
  const status = node.status as Record<string, unknown>;
  const spec = node.spec as Record<string, unknown>;

  const conditions = (status.conditions as Array<Record<string, unknown>>) ?? [];
  const readyCondition = conditions.find((c) => c.type === 'Ready');
  const ready = readyCondition?.status === 'True';

  return {
    name: metadata.name as string,
    ready,
    conditions: conditions.map((c) => ({
      type: c.type as string,
      status: c.status as string,
      reason: c.reason as string | undefined,
      message: c.message as string | undefined,
    })),
    unschedulable: (spec.unschedulable as boolean) ?? false,
    ageSeconds: parseAge(metadata.creationTimestamp as string),
  };
}

function parseEvent(event: Record<string, unknown>): K8sEvent {
  const metadata = event.metadata as Record<string, unknown>;
  const involvedObject = event.involvedObject as Record<string, unknown>;

  return {
    namespace: metadata.namespace as string,
    name: metadata.name as string,
    type: event.type as 'Normal' | 'Warning',
    reason: event.reason as string,
    message: event.message as string,
    involvedObject: {
      kind: involvedObject.kind as string,
      name: involvedObject.name as string,
      namespace: involvedObject.namespace as string | undefined,
    },
    count: (event.count as number) ?? 1,
    firstTimestamp: event.firstTimestamp as string | undefined,
    lastTimestamp: event.lastTimestamp as string | undefined,
  };
}

function identifyPodIssue(pod: PodStatus): UnhealthyPod['issue'] | null {
  for (const container of pod.containers) {
    if (container.reason === 'CrashLoopBackOff') return 'CrashLoopBackOff';
    if (container.reason === 'ImagePullBackOff' || container.reason === 'ErrImagePull') return 'ImagePullBackOff';
    if (container.reason === 'OOMKilled') return 'OOMKilled';
    if (container.reason === 'Error') return 'Error';
  }

  if (pod.phase === 'Failed') return 'Error';
  if (pod.phase === 'Pending' && pod.ageSeconds > PENDING_TOO_LONG_SECONDS) return 'Pending';

  const allContainersReady = pod.containers.every((c) => c.ready);
  if (pod.phase === 'Running' && !allContainersReady) {
    for (const container of pod.containers) {
      if (container.reason) return container.reason as UnhealthyPod['issue'];
    }
    return 'Unknown';
  }

  return null;
}

function identifyDeploymentIssue(dep: DeploymentStatus): DegradedDeployment['issue'] | null {
  if (dep.replicas === 0) return null;
  if (dep.unavailableReplicas > 0) return 'unavailable-replicas';
  if (dep.readyReplicas < dep.replicas) return 'not-ready';
  return null;
}

async function fetchPods(options: KubernetesPluginOptions): Promise<PodStatus[]> {
  const namespaces = options.namespaces ?? ['default'];
  const pods: PodStatus[] = [];

  if (namespaces.includes('*')) {
    const result = await runKubectl(['get', 'pods', '--all-namespaces', '-o', 'json'], options);
    if (result.exitCode !== 0) throw parseKubectlError(result);
    const data = JSON.parse(result.stdout);
    for (const item of data.items ?? []) {
      const pod = parsePodStatus(item);
      if (shouldIncludeNamespace(pod.namespace, options)) {
        pods.push(pod);
      }
    }
  } else {
    for (const ns of namespaces) {
      const args = ['get', 'pods', '-n', ns, '-o', 'json'];
      if (options.labelSelector) args.push('-l', options.labelSelector);
      const result = await runKubectl(args, options);
      if (result.exitCode !== 0) {
        if (result.stderr.includes('not found')) continue;
        throw parseKubectlError(result);
      }
      const data = JSON.parse(result.stdout);
      for (const item of data.items ?? []) {
        pods.push(parsePodStatus(item));
      }
    }
  }

  const maxPods = options.maxPodsPerNamespace;
  if (maxPods) {
    const byNamespace = new Map<string, PodStatus[]>();
    for (const pod of pods) {
      const list = byNamespace.get(pod.namespace) ?? [];
      if (list.length < maxPods) list.push(pod);
      byNamespace.set(pod.namespace, list);
    }
    return Array.from(byNamespace.values()).flat();
  }

  return pods;
}

async function fetchDeployments(options: KubernetesPluginOptions): Promise<DeploymentStatus[]> {
  const namespaces = options.namespaces ?? ['default'];
  const deployments: DeploymentStatus[] = [];

  if (namespaces.includes('*')) {
    const result = await runKubectl(['get', 'deployments', '--all-namespaces', '-o', 'json'], options);
    if (result.exitCode !== 0) throw parseKubectlError(result);
    const data = JSON.parse(result.stdout);
    for (const item of data.items ?? []) {
      const dep = parseDeploymentStatus(item);
      if (shouldIncludeNamespace(dep.namespace, options)) {
        deployments.push(dep);
      }
    }
  } else {
    for (const ns of namespaces) {
      const result = await runKubectl(['get', 'deployments', '-n', ns, '-o', 'json'], options);
      if (result.exitCode !== 0) {
        if (result.stderr.includes('not found')) continue;
        throw parseKubectlError(result);
      }
      const data = JSON.parse(result.stdout);
      for (const item of data.items ?? []) {
        deployments.push(parseDeploymentStatus(item));
      }
    }
  }

  return deployments;
}

async function fetchNodes(options: KubernetesPluginOptions): Promise<NodeStatus[]> {
  const result = await runKubectl(['get', 'nodes', '-o', 'json'], options);
  if (result.exitCode !== 0) throw parseKubectlError(result);
  const data = JSON.parse(result.stdout);
  return (data.items ?? []).map(parseNodeStatus);
}

async function fetchEvents(options: KubernetesPluginOptions, sinceTimestamp?: string): Promise<K8sEvent[]> {
  const result = await runKubectl(['get', 'events', '--all-namespaces', '-o', 'json', '--sort-by=.lastTimestamp'], options);
  if (result.exitCode !== 0) throw parseKubectlError(result);
  const data = JSON.parse(result.stdout);

  const events: K8sEvent[] = [];
  const maxEvents = options.maxEventsPerPoll ?? 50;

  for (const item of data.items ?? []) {
    const event = parseEvent(item);
    if (event.type !== 'Warning') continue;
    if (!shouldIncludeNamespace(event.namespace, options)) continue;
    if (sinceTimestamp && event.lastTimestamp && event.lastTimestamp <= sinceTimestamp) continue;
    events.push(event);
    if (events.length >= maxEvents) break;
  }

  return events;
}

export const kubernetes = (options: KubernetesPluginOptions) => {
  const clusterName = options.clusterName ?? 'default';
  const pollInterval = options.pollIntervalMs ?? 60000;

  return definePlugin({
    id: 'kubernetes',

    init: async (ctx: AgentContext) => {
      ctx.logger.info(`[kubernetes] Initializing plugin for cluster '${clusterName}'`);

      const result = await runKubectl(['version', '--client', '-o', 'json'], options);
      if (result.exitCode !== 0) {
        ctx.logger.error('[kubernetes] kubectl not available or misconfigured');
      }

      const initialState: ClusterState = {
        unhealthyPods: [],
        degradedDeployments: [],
        notReadyNodes: [],
        recentEvents: [],
        summary: {
          clusterName,
          context: options.context,
          namespaces: options.namespaces ?? ['default'],
          pods: { total: 0, healthy: 0, unhealthy: 0, byPhase: {} },
          deployments: { total: 0, healthy: 0, degraded: 0 },
          nodes: { total: 0, ready: 0, notReady: 0 },
          recentWarningEvents: 0,
        },
      };

      return { context: { kubernetes: { options, state: initialState } } };
    },

    observers: {
      clusterHealth: createObserver({
        name: 'k8s-cluster-health',
        description: 'Monitor Kubernetes cluster health',
        interval: pollInterval,
        observe: async (ctx: AgentContext) => {
          const pluginCtx = ctx.kubernetes as { options: KubernetesPluginOptions; state: ClusterState };
          const observations: Observation[] = [];

          try {
            const [pods, deployments, nodes, events] = await Promise.all([
              fetchPods(pluginCtx.options),
              fetchDeployments(pluginCtx.options),
              fetchNodes(pluginCtx.options),
              fetchEvents(pluginCtx.options, pluginCtx.state.lastSeenEventTimestamp),
            ]);

            const unhealthyPods: UnhealthyPod[] = [];
            const podsByPhase: Record<string, number> = {};

            for (const pod of pods) {
              podsByPhase[pod.phase] = (podsByPhase[pod.phase] ?? 0) + 1;
              const issue = identifyPodIssue(pod);
              if (issue) {
                unhealthyPods.push({ ...pod, issue });
              }
            }

            const degradedDeployments: DegradedDeployment[] = [];
            for (const dep of deployments) {
              const issue = identifyDeploymentIssue(dep);
              if (issue) {
                degradedDeployments.push({ ...dep, issue });
              }
            }

            const notReadyNodes = nodes.filter((n) => !n.ready);

            const summary: ClusterHealthSummary = {
              clusterName,
              context: pluginCtx.options.context,
              namespaces: pluginCtx.options.namespaces ?? ['default'],
              pods: {
                total: pods.length,
                healthy: pods.length - unhealthyPods.length,
                unhealthy: unhealthyPods.length,
                byPhase: podsByPhase,
              },
              deployments: {
                total: deployments.length,
                healthy: deployments.length - degradedDeployments.length,
                degraded: degradedDeployments.length,
              },
              nodes: {
                total: nodes.length,
                ready: nodes.length - notReadyNodes.length,
                notReady: notReadyNodes.length,
              },
              recentWarningEvents: events.length,
            };

            pluginCtx.state = {
              lastPollTime: new Date(),
              lastSeenEventTimestamp: events[0]?.lastTimestamp ?? pluginCtx.state.lastSeenEventTimestamp,
              unhealthyPods,
              degradedDeployments,
              notReadyNodes,
              recentEvents: events,
              summary,
            };

            observations.push({
              source: 'kubernetes/cluster-health',
              timestamp: new Date(),
              type: 'metric',
              severity: unhealthyPods.length > 0 || degradedDeployments.length > 0 || notReadyNodes.length > 0 ? 'warning' : 'info',
              data: { summary },
            });

            for (const pod of unhealthyPods) {
              observations.push({
                source: 'kubernetes/unhealthy-pod',
                timestamp: new Date(),
                type: 'event',
                severity: pod.issue === 'CrashLoopBackOff' || pod.issue === 'OOMKilled' ? 'error' : 'warning',
                data: {
                  clusterName,
                  namespace: pod.namespace,
                  pod: pod.name,
                  issue: pod.issue,
                  phase: pod.phase,
                  restarts: pod.totalRestarts,
                  containers: pod.containers,
                },
              });
            }

            for (const dep of degradedDeployments) {
              observations.push({
                source: 'kubernetes/degraded-deployment',
                timestamp: new Date(),
                type: 'event',
                severity: dep.readyReplicas === 0 ? 'error' : 'warning',
                data: {
                  clusterName,
                  namespace: dep.namespace,
                  deployment: dep.name,
                  issue: dep.issue,
                  replicas: dep.replicas,
                  readyReplicas: dep.readyReplicas,
                  unavailableReplicas: dep.unavailableReplicas,
                },
              });
            }

            for (const node of notReadyNodes) {
              observations.push({
                source: 'kubernetes/node-not-ready',
                timestamp: new Date(),
                type: 'event',
                severity: 'error',
                data: {
                  clusterName,
                  node: node.name,
                  conditions: node.conditions,
                  unschedulable: node.unschedulable,
                },
              });
            }

          } catch (err) {
            const kubectlErr = err as KubectlError;
            observations.push({
              source: 'kubernetes/connection-error',
              timestamp: new Date(),
              type: 'event',
              severity: 'error',
              data: {
                clusterName,
                errorType: kubectlErr.type ?? 'unknown',
                message: kubectlErr.message ?? String(err),
              },
            });
          }

          return observations;
        },
      }),
    },

    orienters: {
      analyzeClusterHealth: createOrienter({
        name: 'analyze-cluster-health',
        description: 'Analyze Kubernetes cluster health and identify issues',
        orient: async (observations: Observation[], ctx: AgentContext) => {
          const k8sObs = observations.filter((o) => o.source.startsWith('kubernetes/'));
          const findings: string[] = [];
          let contributingFactor: string | undefined;

          const summaryObs = k8sObs.find((o) => o.source === 'kubernetes/cluster-health');
          if (summaryObs) {
            const summary = summaryObs.data.summary as ClusterHealthSummary;
            findings.push(`Cluster '${summary.clusterName}': ${summary.pods.total} pods, ${summary.deployments.total} deployments, ${summary.nodes.total} nodes`);

            if (summary.pods.unhealthy > 0) {
              findings.push(`${summary.pods.unhealthy} unhealthy pod(s) detected`);
            }
            if (summary.deployments.degraded > 0) {
              findings.push(`${summary.deployments.degraded} degraded deployment(s)`);
            }
            if (summary.nodes.notReady > 0) {
              findings.push(`${summary.nodes.notReady} node(s) not ready`);
            }
          }

          const unhealthyPods = k8sObs.filter((o) => o.source === 'kubernetes/unhealthy-pod');
          for (const obs of unhealthyPods) {
            const data = obs.data as { namespace: string; pod: string; issue: string; restarts: number };
            findings.push(`Pod ${data.namespace}/${data.pod}: ${data.issue}${data.restarts > 0 ? ` (${data.restarts} restarts)` : ''}`);
          }

          const degradedDeps = k8sObs.filter((o) => o.source === 'kubernetes/degraded-deployment');
          for (const obs of degradedDeps) {
            const data = obs.data as { namespace: string; deployment: string; readyReplicas: number; replicas: number };
            findings.push(`Deployment ${data.namespace}/${data.deployment}: ${data.readyReplicas}/${data.replicas} replicas ready`);
          }

          const notReadyNodes = k8sObs.filter((o) => o.source === 'kubernetes/node-not-ready');
          for (const obs of notReadyNodes) {
            const data = obs.data as { node: string };
            findings.push(`Node ${data.node} is not ready`);
          }

          const connectionErrors = k8sObs.filter((o) => o.source === 'kubernetes/connection-error');
          const firstConnectionError = connectionErrors[0];
          if (firstConnectionError) {
            const errData = firstConnectionError.data as { message: string };
            contributingFactor = `Cluster connectivity issue: ${errData.message}`;
          } else if (notReadyNodes.length > 0) {
            contributingFactor = 'Node health issues detected - may affect workload scheduling';
          } else if (unhealthyPods.length > 0) {
            const crashLoops = unhealthyPods.filter((o) => (o.data as { issue: string }).issue === 'CrashLoopBackOff');
            if (crashLoops.length > 0) {
              contributingFactor = 'Application crashes detected - check container logs';
            }
          }

          if (findings.length === 0) {
            findings.push('Cluster health check completed - no issues detected');
          }

          const assessment: SituationAssessment = {
            source: 'kubernetes/analyze-cluster-health',
            findings,
            contributingFactor,
            confidence: connectionErrors.length > 0 ? 0.5 : 0.9,
          };

          return assessment;
        },
      }),
    },

    actions: {
      restartDeployment: createAction({
        name: 'restart-deployment',
        description: 'Restart a Kubernetes deployment using rollout restart',
        risk: 'medium',
        autonomy: { mode: 'approval-required', minConfidence: 0.8 },
        schema: z.object({
          namespace: z.string(),
          deployment: z.string(),
        }),
        execute: async (params, ctx: AgentContext) => {
          const pluginCtx = ctx.kubernetes as { options: KubernetesPluginOptions };
          const input = params as RestartDeploymentInput;
          assertWritable(pluginCtx.options, 'restartDeployment');

          const startTime = Date.now();
          ctx.logger.info(`[kubernetes] Restarting deployment ${input.namespace}/${input.deployment}`);

          const result = await runKubectl(
            ['rollout', 'restart', 'deployment', input.deployment, '-n', input.namespace],
            pluginCtx.options
          );

          if (result.exitCode !== 0) {
            const err = parseKubectlError(result);
            return {
              action: 'restart-deployment',
              success: false,
              error: err.message,
              duration: Date.now() - startTime,
            };
          }

          return {
            action: 'restart-deployment',
            success: true,
            output: `Deployment ${input.namespace}/${input.deployment} restart initiated`,
            duration: Date.now() - startTime,
            sideEffects: [`Deployment ${input.deployment} pods will be recreated`],
          };
        },
      }),

      scaleDeployment: createAction({
        name: 'scale-deployment',
        description: 'Scale a Kubernetes deployment to a specified number of replicas',
        risk: 'medium',
        autonomy: { mode: 'approval-required', minConfidence: 0.8 },
        schema: z.object({
          namespace: z.string(),
          deployment: z.string(),
          replicas: z.number().int().min(0),
        }),
        execute: async (params, ctx: AgentContext) => {
          const pluginCtx = ctx.kubernetes as { options: KubernetesPluginOptions };
          const input = params as ScaleDeploymentInput;
          assertWritable(pluginCtx.options, 'scaleDeployment');

          const startTime = Date.now();
          ctx.logger.info(`[kubernetes] Scaling deployment ${input.namespace}/${input.deployment} to ${input.replicas} replicas`);

          const result = await runKubectl(
            ['scale', 'deployment', input.deployment, '-n', input.namespace, `--replicas=${input.replicas}`],
            pluginCtx.options
          );

          if (result.exitCode !== 0) {
            const err = parseKubectlError(result);
            return {
              action: 'scale-deployment',
              success: false,
              error: err.message,
              duration: Date.now() - startTime,
            };
          }

          return {
            action: 'scale-deployment',
            success: true,
            output: `Deployment ${input.namespace}/${input.deployment} scaled to ${input.replicas} replicas`,
            duration: Date.now() - startTime,
            sideEffects: [`Deployment ${input.deployment} replica count changed to ${input.replicas}`],
          };
        },
      }),

      deletePod: createAction({
        name: 'delete-pod',
        description: 'Delete a pod to force a restart',
        risk: 'medium',
        autonomy: { mode: 'approval-required', minConfidence: 0.8 },
        schema: z.object({
          namespace: z.string(),
          pod: z.string(),
          gracePeriodSeconds: z.number().int().min(0).optional(),
        }),
        execute: async (params, ctx: AgentContext) => {
          const pluginCtx = ctx.kubernetes as { options: KubernetesPluginOptions };
          const input = params as DeletePodInput;
          assertWritable(pluginCtx.options, 'deletePod');

          const startTime = Date.now();
          ctx.logger.info(`[kubernetes] Deleting pod ${input.namespace}/${input.pod}`);

          const args = ['delete', 'pod', input.pod, '-n', input.namespace];
          if (input.gracePeriodSeconds !== undefined) {
            args.push(`--grace-period=${input.gracePeriodSeconds}`);
          }

          const result = await runKubectl(args, pluginCtx.options);

          if (result.exitCode !== 0) {
            const err = parseKubectlError(result);
            if (err.type === 'not-found') {
              return {
                action: 'delete-pod',
                success: true,
                output: `Pod ${input.namespace}/${input.pod} already deleted or does not exist`,
                duration: Date.now() - startTime,
              };
            }
            return {
              action: 'delete-pod',
              success: false,
              error: err.message,
              duration: Date.now() - startTime,
            };
          }

          return {
            action: 'delete-pod',
            success: true,
            output: `Pod ${input.namespace}/${input.pod} deleted`,
            duration: Date.now() - startTime,
            sideEffects: [`Pod ${input.pod} deleted - controller may recreate it`],
          };
        },
      }),

      getLogs: createAction({
        name: 'get-logs',
        description: 'Get logs from a pod',
        risk: 'low',
        autonomy: { mode: 'auto', minConfidence: 0.5 },
        schema: z.object({
          namespace: z.string(),
          pod: z.string(),
          container: z.string().optional(),
          tailLines: z.number().int().min(1).max(1000).optional(),
          sinceSeconds: z.number().int().min(1).optional(),
        }),
        execute: async (params, ctx: AgentContext) => {
          const pluginCtx = ctx.kubernetes as { options: KubernetesPluginOptions };
          const input = params as GetLogsInput;

          const startTime = Date.now();
          const args = ['logs', input.pod, '-n', input.namespace];

          if (input.container) args.push('-c', input.container);
          args.push('--tail', String(input.tailLines ?? 100));
          if (input.sinceSeconds) args.push(`--since=${input.sinceSeconds}s`);

          const result = await runKubectl(args, pluginCtx.options);

          if (result.exitCode !== 0) {
            const err = parseKubectlError(result);
            return {
              action: 'get-logs',
              success: false,
              error: err.message,
              duration: Date.now() - startTime,
            };
          }

          const maxLogBytes = 50000;
          let logs = result.stdout;
          let truncated = false;
          if (logs.length > maxLogBytes) {
            logs = logs.slice(-maxLogBytes);
            truncated = true;
          }

          return {
            action: 'get-logs',
            success: true,
            output: { logs, truncated, lines: logs.split('\n').length },
            duration: Date.now() - startTime,
          };
        },
      }),
    },

    endpoints: {
      listNamespaces: createEndpoint({
        method: 'GET',
        path: '/k8s/namespaces',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions };
          const result = await runKubectl(['get', 'namespaces', '-o', 'json'], pluginCtx.options);

          if (result.exitCode !== 0) {
            return error(parseKubectlError(result).message, 500);
          }

          const data = JSON.parse(result.stdout);
          const namespaces = (data.items ?? []).map((ns: Record<string, unknown>) => {
            const metadata = ns.metadata as Record<string, unknown>;
            return { name: metadata.name, status: (ns.status as Record<string, unknown>)?.phase };
          });

          return json({ namespaces });
        },
      }),

      listPods: createEndpoint({
        method: 'GET',
        path: '/k8s/namespaces/:namespace/pods',
        auth: true,
        handler: async (ctx) => {
          const namespace = ctx.params.namespace as string;
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions };

          const result = await runKubectl(['get', 'pods', '-n', namespace, '-o', 'json'], pluginCtx.options);

          if (result.exitCode !== 0) {
            return error(parseKubectlError(result).message, 500);
          }

          const data = JSON.parse(result.stdout);
          const pods = (data.items ?? []).map(parsePodStatus);

          return json({ pods });
        },
      }),

      listDeployments: createEndpoint({
        method: 'GET',
        path: '/k8s/namespaces/:namespace/deployments',
        auth: true,
        handler: async (ctx) => {
          const namespace = ctx.params.namespace as string;
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions };

          const result = await runKubectl(['get', 'deployments', '-n', namespace, '-o', 'json'], pluginCtx.options);

          if (result.exitCode !== 0) {
            return error(parseKubectlError(result).message, 500);
          }

          const data = JSON.parse(result.stdout);
          const deployments = (data.items ?? []).map(parseDeploymentStatus);

          return json({ deployments });
        },
      }),

      getPodLogs: createEndpoint({
        method: 'GET',
        path: '/k8s/namespaces/:namespace/pods/:pod/logs',
        auth: true,
        handler: async (ctx) => {
          const namespace = ctx.params.namespace as string;
          const pod = ctx.params.pod as string;
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions };

          const url = new URL(ctx.request.url);
          const container = url.searchParams.get('container') ?? undefined;
          const tailLines = parseInt(url.searchParams.get('tail') ?? '100', 10);

          const args: string[] = ['logs', pod, '-n', namespace, '--tail', String(tailLines)];
          if (container) args.push('-c', container);

          const result = await runKubectl(args, pluginCtx.options);

          if (result.exitCode !== 0) {
            return error(parseKubectlError(result).message, 500);
          }

          return json({ logs: result.stdout });
        },
      }),

      restartDeployment: createEndpoint({
        method: 'POST',
        path: '/k8s/namespaces/:namespace/deployments/:deployment/restart',
        auth: true,
        handler: async (ctx) => {
          const namespace = ctx.params.namespace as string;
          const deployment = ctx.params.deployment as string;
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions };

          try {
            assertWritable(pluginCtx.options, 'restartDeployment');
          } catch (err) {
            return error((err as Error).message, 403);
          }

          const result = await runKubectl(
            ['rollout', 'restart', 'deployment', deployment, '-n', namespace],
            pluginCtx.options
          );

          if (result.exitCode !== 0) {
            return error(parseKubectlError(result).message, 500);
          }

          return json({ success: true, message: `Deployment ${namespace}/${deployment} restart initiated` });
        },
      }),

      scaleDeployment: createEndpoint({
        method: 'POST',
        path: '/k8s/namespaces/:namespace/deployments/:deployment/scale',
        auth: true,
        handler: async (ctx) => {
          const namespace = ctx.params.namespace as string;
          const deployment = ctx.params.deployment as string;
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions };

          try {
            assertWritable(pluginCtx.options, 'scaleDeployment');
          } catch (err) {
            return error((err as Error).message, 403);
          }

          const body = await ctx.request.json() as { replicas?: number };
          if (typeof body.replicas !== 'number') {
            return error('replicas must be a number', 400);
          }

          const result = await runKubectl(
            ['scale', 'deployment', deployment, '-n', namespace, `--replicas=${body.replicas}`],
            pluginCtx.options
          );

          if (result.exitCode !== 0) {
            return error(parseKubectlError(result).message, 500);
          }

          return json({ success: true, message: `Deployment ${namespace}/${deployment} scaled to ${body.replicas} replicas` });
        },
      }),

      deletePod: createEndpoint({
        method: 'DELETE',
        path: '/k8s/namespaces/:namespace/pods/:pod',
        auth: true,
        handler: async (ctx) => {
          const namespace = ctx.params.namespace as string;
          const pod = ctx.params.pod as string;
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions };

          try {
            assertWritable(pluginCtx.options, 'deletePod');
          } catch (err) {
            return error((err as Error).message, 403);
          }

          const result = await runKubectl(['delete', 'pod', pod, '-n', namespace], pluginCtx.options);

          if (result.exitCode !== 0) {
            const err = parseKubectlError(result);
            if (err.type === 'not-found') {
              return json({ success: true, message: `Pod ${namespace}/${pod} already deleted` });
            }
            return error(err.message, 500);
          }

          return json({ success: true, message: `Pod ${namespace}/${pod} deleted` });
        },
      }),

      getClusterStatus: createEndpoint({
        method: 'GET',
        path: '/k8s/status',
        auth: true,
        handler: async (ctx) => {
          const pluginCtx = ctx.context.kubernetes as { options: KubernetesPluginOptions; state: ClusterState };
          return json({
            clusterName,
            lastPollTime: pluginCtx.state.lastPollTime,
            summary: pluginCtx.state.summary,
            unhealthyPods: pluginCtx.state.unhealthyPods.length,
            degradedDeployments: pluginCtx.state.degradedDeployments.length,
            notReadyNodes: pluginCtx.state.notReadyNodes.length,
          });
        },
      }),
    },

    onLoopComplete: async (result, ctx) => {
      const pluginCtx = ctx.kubernetes as { state: ClusterState };
      const { unhealthyPods, degradedDeployments, notReadyNodes } = pluginCtx.state;

      if (unhealthyPods.length > 0 || degradedDeployments.length > 0 || notReadyNodes.length > 0) {
        ctx.logger.warn(
          `[kubernetes] Loop complete: ${unhealthyPods.length} unhealthy pod(s), ${degradedDeployments.length} degraded deployment(s), ${notReadyNodes.length} not-ready node(s)`
        );
      }
    },
  });
};
