/**
 * Vercel Deploys Plugin Types
 */

/**
 * Authentication configuration
 * Phase 1: PAT-based auth only
 * Phase 2 (future): OAuth support
 */
export type VercelAuthConfig = {
  /** Personal Access Token from Vercel */
  token: string;
};

/**
 * Project configuration for monitoring
 */
export type VercelProjectConfig = {
  /** Vercel project ID (e.g., 'prj_xyz') or project name */
  id: string;

  /** Optional team ID for team-scoped projects */
  teamId?: string;

  /** Human-readable service name for SRE context */
  serviceName: string;

  /** Environments to monitor (default: ['production']) */
  environments?: Array<'production' | 'preview' | 'development'>;
};

/**
 * Plugin options
 */
export type VercelDeploysPluginOptions = {
  /** Authentication configuration */
  auth: VercelAuthConfig;

  /** Projects to monitor */
  projects: VercelProjectConfig[];

  /** How often to poll for new deployments in ms (default: 60000) */
  pollIntervalMs?: number;

  /** Maximum deployments to fetch per project (default: 20) */
  maxDeploysPerProject?: number;

  /** Vercel API base URL (default: https://api.vercel.com) */
  apiBaseUrl?: string;
};

/**
 * Git metadata from a deployment
 */
export type VercelGitMetadata = {
  commitSha?: string;
  commitMessage?: string;
  branch?: string;
  author?: string;
  repoUrl?: string;
};

/**
 * Deployment state from Vercel API
 */
export type VercelDeploymentState =
  | 'BUILDING'
  | 'ERROR'
  | 'INITIALIZING'
  | 'QUEUED'
  | 'READY'
  | 'CANCELED';

/**
 * Deployment target environment
 */
export type VercelDeploymentTarget = 'production' | 'preview' | 'development';

/**
 * Normalized deployment data
 */
export type VercelDeployment = {
  /** Deployment unique ID */
  uid: string;

  /** Project ID */
  projectId: string;

  /** Project name */
  projectName: string;

  /** Team ID if applicable */
  teamId?: string;

  /** Deployment URL */
  url: string;

  /** Inspector URL for debugging */
  inspectorUrl?: string;

  /** Deployment state */
  state: VercelDeploymentState;

  /** Target environment */
  target?: VercelDeploymentTarget;

  /** Creation timestamp */
  createdAt: Date;

  /** Ready timestamp (when deployment completed) */
  readyAt?: Date;

  /** Building started timestamp */
  buildingAt?: Date;

  /** Git metadata */
  git: VercelGitMetadata;

  /** Creator information */
  creator?: {
    uid: string;
    email?: string;
    username?: string;
  };

  /** Error information if deployment failed */
  error?: {
    code?: string;
    message?: string;
  };
};

/**
 * Internal state for tracking deployments per project
 */
export type ProjectDeploymentState = {
  /** Last seen deployment timestamp (for incremental fetching) */
  lastSeenTimestamp?: number;

  /** Recent deployments cache */
  recentDeployments: VercelDeployment[];

  /** Last fetch timestamp */
  lastFetchTime?: Date;
};

/**
 * Raw deployment response from Vercel API
 */
export type VercelApiDeployment = {
  uid: string;
  name: string;
  projectId?: string;
  url?: string;
  inspectorUrl?: string;
  created: number;
  buildingAt?: number;
  ready?: number;
  state?: string;
  readyState?: string;
  target?: string;
  creator?: {
    uid: string;
    email?: string;
    username?: string;
    githubLogin?: string;
    gitlabLogin?: string;
  };
  meta?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
};

/**
 * Vercel API list deployments response
 */
export type VercelApiDeploymentsResponse = {
  pagination: {
    count: number;
    next?: number;
    prev?: number;
  };
  deployments: VercelApiDeployment[];
};
