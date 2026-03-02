/**
 * HTTP Monitor Plugin Types
 */

export type RestartStrategy =
  | { type: 'command'; command: string | string[]; cwd?: string }
  | { type: 'http'; url: string; method?: string; body?: unknown; headers?: Record<string, string>; timeout?: number }
  | { type: 'function'; handler: () => Promise<void> };

export type EndpointConfig = {
  /** Unique identifier for this endpoint */
  id: string;

  /** Human-readable name */
  name: string;

  /** URL to monitor */
  url: string;

  /** HTTP method (default: GET) */
  method?: string;

  /** Expected status code (default: 200) */
  expectedStatus?: number;

  /** Request timeout in ms (default: 5000) */
  timeout?: number;

  /** Headers to send with the request */
  headers?: Record<string, string>;

  /** How to restart this service */
  restartStrategy?: RestartStrategy;

  /** Number of consecutive failures before taking action (default: 3) */
  failureThreshold?: number;

  /** Minimum time between restarts in ms (default: 300000 = 5min) */
  cooldownPeriod?: number;

  /** Whether this endpoint is critical (affects severity) */
  critical?: boolean;
};

export type HealthCheckResult = {
  endpointId: string;
  url: string;
  success: boolean;
  statusCode?: number;
  responseTime: number;
  error?: string;
  timestamp: Date;
};

export type EndpointState = {
  consecutiveFailures: number;
  lastFailureTime?: Date;
  lastRestartTime?: Date;
  history: HealthCheckResult[];
};

export type HttpMonitorPluginOptions = {
  /** Endpoints to monitor */
  endpoints: EndpointConfig[];

  /** How often to check endpoints in ms (default: 30000 = 30s) */
  checkInterval?: number;

  /** Maximum number of health check results to keep in history (default: 50) */
  maxHistorySize?: number;
};
