export type KubernetesPluginOptions = {
  kubeconfigPath?: string;
  context?: string;
  namespaces?: string[];
  clusterName?: string;
  pollIntervalMs?: number;
  readOnly?: boolean;
  labelSelector?: string;
  maxPodsPerNamespace?: number;
  maxEventsPerPoll?: number;
  excludeSystemNamespaces?: boolean;
  timeoutMs?: number;
};

export type KubectlResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type KubectlError = {
  type: 'not-installed' | 'auth-failed' | 'unreachable' | 'not-found' | 'timeout' | 'unknown';
  message: string;
  stderr?: string;
};

export type PodPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';

export type ContainerState = {
  name: string;
  ready: boolean;
  restartCount: number;
  state: 'running' | 'waiting' | 'terminated';
  reason?: string;
  message?: string;
};

export type PodStatus = {
  name: string;
  namespace: string;
  phase: PodPhase;
  nodeName?: string;
  containers: ContainerState[];
  totalRestarts: number;
  ageSeconds: number;
  conditions?: { type: string; status: string; reason?: string }[];
};

export type DeploymentStatus = {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas: number;
  unavailableReplicas: number;
  updatedReplicas: number;
  ageSeconds: number;
};

export type NodeStatus = {
  name: string;
  ready: boolean;
  conditions: { type: string; status: string; reason?: string; message?: string }[];
  unschedulable: boolean;
  ageSeconds: number;
};

export type K8sEvent = {
  namespace: string;
  name: string;
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  involvedObject: { kind: string; name: string; namespace?: string };
  count: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
};

export type ClusterHealthSummary = {
  clusterName: string;
  context?: string;
  namespaces: string[];
  pods: { total: number; healthy: number; unhealthy: number; byPhase: Record<string, number> };
  deployments: { total: number; healthy: number; degraded: number };
  nodes: { total: number; ready: number; notReady: number };
  recentWarningEvents: number;
};

export type UnhealthyPod = PodStatus & {
  issue: 'CrashLoopBackOff' | 'ImagePullBackOff' | 'Error' | 'Pending' | 'OOMKilled' | 'Unknown';
};

export type DegradedDeployment = DeploymentStatus & {
  issue: 'unavailable-replicas' | 'not-ready' | 'no-replicas';
};

export type ClusterState = {
  lastPollTime?: Date;
  lastSeenEventTimestamp?: string;
  unhealthyPods: UnhealthyPod[];
  degradedDeployments: DegradedDeployment[];
  notReadyNodes: NodeStatus[];
  recentEvents: K8sEvent[];
  summary: ClusterHealthSummary;
};

export type RestartDeploymentInput = {
  namespace: string;
  deployment: string;
};

export type ScaleDeploymentInput = {
  namespace: string;
  deployment: string;
  replicas: number;
};

export type DeletePodInput = {
  namespace: string;
  pod: string;
  gracePeriodSeconds?: number;
};

export type GetLogsInput = {
  namespace: string;
  pod: string;
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
};
