/**
 * Google Cloud Run Plugin Types
 */

export type CloudRunAuthConfig = {
  /**
   * Use Application Default Credentials (ADC).
   * Default: true
   */
  useADC?: boolean;

  /**
   * OAuth scopes to request when using ADC.
   * Default: ['https://www.googleapis.com/auth/cloud-platform']
   */
  scopes?: string[];
};

export type CloudRunProjectConfig = {
  /** GCP project ID */
  projectId: string;

  /** Regions to monitor (e.g., ['us-central1']) */
  regions: string[];

  /** Optional allowlist of service names */
  services?: string[];

  /** Optional label filter (service labels must include all provided pairs) */
  labels?: Record<string, string>;

  /** Optional mapping of service name -> display name */
  serviceNameMap?: Record<string, string>;
};

export type CloudRunPluginOptions = {
  /** Authentication configuration (ADC by default) */
  auth?: CloudRunAuthConfig;

  /** Projects to monitor */
  projects: CloudRunProjectConfig[];

  /** Cloud Run API base URL (default: https://run.googleapis.com) */
  apiBaseUrl?: string;

  /** Polling interval in ms (default: 60000) */
  pollIntervalMs?: number;

  /** Max revisions to fetch per service (default: 20) */
  maxRevisionsPerService?: number;

  /** Read-only mode (default: true) */
  readOnly?: boolean;

  /** Enable auto-rollback on failed rollouts (default: false) */
  autoRollback?: boolean;

  /** Min minutes a new revision must be ready before considered failed (default: 5) */
  autoRollbackMinReadyMinutes?: number;

  /** Include Cloud Logging error observations (default: false) */
  includeLogs?: boolean;

  /** Log query window in minutes (default: 10) */
  logQueryWindowMinutes?: number;

  /** Max log entries to fetch per service (default: 50) */
  logPageSize?: number;

  /** Include Cloud Monitoring metrics observations (default: false) */
  includeMetrics?: boolean;

  /** Metrics query window in minutes (default: 5) */
  metricsWindowMinutes?: number;

  /** Error rate warning threshold (default: 0.05) */
  errorRateWarningThreshold?: number;

  /** Error rate error threshold (default: 0.1) */
  errorRateErrorThreshold?: number;
};

export type CloudRunTrafficTarget = {
  revision?: string;
  percent?: number;
  tag?: string;
  latestRevision?: boolean;
};

export type CloudRunServiceCondition = {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

export type CloudRunServiceResource = {
  name?: string;
  uid?: string;
  labels?: Record<string, string>;
  createTime?: string;
  updateTime?: string;
  uri?: string;
  traffic?: CloudRunTrafficTarget[];
  conditions?: CloudRunServiceCondition[];
  latestReadyRevision?: string;
  latestCreatedRevision?: string;
  status?: {
    url?: string;
    traffic?: CloudRunTrafficTarget[];
    conditions?: CloudRunServiceCondition[];
    latestReadyRevision?: string;
    latestCreatedRevision?: string;
  };
};

export type CloudRunRevisionResource = {
  name?: string;
  uid?: string;
  createTime?: string;
  updateTime?: string;
  service?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  conditions?: CloudRunServiceCondition[];
};

export type CloudRunServiceSnapshot = {
  key: string;
  projectId: string;
  region: string;
  service: string;
  serviceName: string;
  url?: string;
  latestReadyRevision?: string;
  latestCreatedRevision?: string;
  lastKnownGoodRevision?: string;
  traffic: CloudRunTrafficTarget[];
  conditions: CloudRunServiceCondition[];
  rolloutStatus?: CloudRunRolloutStatus;
  rolloutReason?: string;
  rolloutAgeMs?: number;
  updatedAt: string;
};

export type CloudRunRolloutStatus = 'in_progress' | 'completed' | 'failed' | 'unknown';
