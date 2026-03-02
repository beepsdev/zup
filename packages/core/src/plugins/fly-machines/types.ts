/**
 * Fly.io Machines Plugin Types
 */

/**
 * Authentication configuration
 * Uses Fly.io API token (from `fly tokens create`)
 */
export type FlyAuthConfig = {
  /** Fly.io API token */
  token: string;
};

/**
 * App configuration for monitoring
 */
export type FlyAppConfig = {
  /** Fly.io app name */
  name: string;

  /** Human-readable service name for SRE context */
  serviceName: string;

  /** Optional: filter by specific regions */
  regions?: string[];

  /** Optional: filter by metadata key-value pairs */
  metadata?: Record<string, string>;
};

/**
 * Plugin options
 */
export type FlyMachinesPluginOptions = {
  /** Authentication configuration */
  auth: FlyAuthConfig;

  /** Apps to monitor */
  apps: FlyAppConfig[];

  /** How often to poll for machine changes in ms (default: 60000) */
  pollIntervalMs?: number;

  /** Maximum machines to track per app (default: 50) */
  maxMachinesPerApp?: number;

  /** Fly Machines API base URL (default: https://api.machines.dev) */
  apiBaseUrl?: string;
};

/**
 * Machine state from Fly.io API
 */
export type FlyMachineState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'replacing'
  | 'destroying'
  | 'destroyed'
  | 'suspended';

/**
 * Image reference from Fly.io API
 */
export type FlyImageRef = {
  /** Container registry (e.g., 'registry-1.docker.io') */
  registry: string;

  /** Repository name (e.g., 'library/ubuntu') */
  repository: string;

  /** Image tag (e.g., 'latest') */
  tag?: string;

  /** Image digest (SHA256) */
  digest: string;

  /** Optional labels from the image */
  labels?: Record<string, string>;
};

/**
 * Machine event from Fly.io API
 */
export type FlyMachineEvent = {
  /** Event type (e.g., 'launch', 'start', 'stop', 'exit', 'update') */
  type: string;

  /** Event status (e.g., 'created', 'started', 'stopped') */
  status: string;

  /** Event source (e.g., 'user', 'flyd') */
  source: string;

  /** Event timestamp (Unix milliseconds) */
  timestamp: number;

  /** Optional request data */
  request?: {
    exit_event?: {
      exit_code?: number;
      requested_stop?: boolean;
      restarting?: boolean;
      signal?: number;
    };
  };
};

/**
 * Health check status
 */
export type FlyHealthCheck = {
  /** Check name */
  name: string;

  /** Check status */
  status: 'passing' | 'warning' | 'critical';

  /** Output from the check */
  output?: string;

  /** Last updated timestamp */
  updated_at?: string;
};

/**
 * Guest configuration (CPU/memory)
 */
export type FlyGuestConfig = {
  /** CPU type (e.g., 'shared', 'performance') */
  cpu_kind?: string;

  /** Number of CPUs */
  cpus?: number;

  /** Memory in MB */
  memory_mb?: number;

  /** GPU type if applicable */
  gpu_kind?: string;

  /** Number of GPUs */
  gpus?: number;
};

/**
 * Normalized machine data
 */
export type FlyMachine = {
  /** Machine unique ID */
  id: string;

  /** Machine name */
  name: string;

  /** App name */
  appName: string;

  /** Machine state */
  state: FlyMachineState;

  /** Region code (e.g., 'ord', 'cdg') */
  region: string;

  /** Instance ID - changes on each update (effectively a version) */
  instanceId: string;

  /** Private IPv6 address */
  privateIp?: string;

  /** Image reference */
  imageRef: FlyImageRef;

  /** Guest configuration */
  guest?: FlyGuestConfig;

  /** Machine events (recent history) */
  events: FlyMachineEvent[];

  /** Health check statuses */
  checks?: Record<string, FlyHealthCheck>;

  /** Machine metadata */
  metadata?: Record<string, string>;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
};

/**
 * Internal state for tracking machines per app
 */
export type AppMachineState = {
  /** Map of machine ID to last known instance ID (for detecting updates) */
  lastKnownInstanceIds: Map<string, string>;

  /** Recent machines cache */
  recentMachines: FlyMachine[];

  /** Last fetch timestamp */
  lastFetchTime?: Date;
};

/**
 * Raw machine response from Fly.io API
 */
export type FlyApiMachine = {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id: string;
  private_ip?: string;
  created_at: string;
  updated_at: string;
  image_ref: {
    registry: string;
    repository: string;
    tag?: string;
    digest: string;
    labels?: Record<string, string>;
  };
  config?: {
    guest?: {
      cpu_kind?: string;
      cpus?: number;
      memory_mb?: number;
      gpu_kind?: string;
      gpus?: number;
    };
    metadata?: Record<string, string>;
    image?: string;
    env?: Record<string, string>;
  };
  events?: Array<{
    type: string;
    status: string;
    source: string;
    timestamp: number;
    request?: {
      exit_event?: {
        exit_code?: number;
        requested_stop?: boolean;
        restarting?: boolean;
        signal?: number;
      };
    };
  }>;
  checks?: Record<
    string,
    {
      name?: string;
      status?: string;
      output?: string;
      updated_at?: string;
    }
  >;
  nonce?: string;
};

/**
 * Fly.io API list apps response
 */
export type FlyApiAppsResponse = {
  apps: Array<{
    id: string;
    name: string;
    organization: {
      slug: string;
      name: string;
    };
    status: string;
    deployed: boolean;
    hostname: string;
    app_url: string;
    version: number;
    release_command?: string;
    process_groups?: string[];
    current_release?: {
      id: string;
      version: number;
      image_ref: string;
      created_at: string;
    };
  }>;
};

/**
 * Detected deployment event (aggregated from machine updates)
 */
export type FlyDeploymentEvent = {
  /** Unique ID for this deployment event */
  id: string;

  /** App name */
  appName: string;

  /** Service name (human-readable) */
  serviceName: string;

  /** New image digest */
  newImageDigest: string;

  /** Previous image digest (if known) */
  previousImageDigest?: string;

  /** Image repository */
  imageRepository: string;

  /** Image tag */
  imageTag?: string;

  /** Machines affected by this deployment */
  machinesAffected: string[];

  /** Regions affected */
  regionsAffected: string[];

  /** Deployment detected timestamp */
  detectedAt: Date;

  /** Deployment status based on machine states */
  status: 'in_progress' | 'completed' | 'failed' | 'partial';

  /** Number of machines successfully updated */
  successCount: number;

  /** Number of machines that failed to update */
  failureCount: number;
};
