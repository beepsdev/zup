/**
 * API Types
 */

import type { AgentContext } from '../types/context';

/**
 * Request with route parameters
 */
export type RequestContext = {
  request: Request;
  params: Record<string, string>;
  context: AgentContext;
};

/**
 * Route handler
 */
export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

/**
 * Route definition
 */
export type Route = {
  method: string;
  path: string;
  handler: RouteHandler;
  auth?: boolean; // Default true
};

/**
 * API server instance
 */
export type ApiServer = {
  server: ReturnType<typeof Bun.serve>;
  route: (method: string, path: string, handler: RouteHandler, auth?: boolean) => void;
  stop: () => void;
};

/**
 * API server options
 */
export type ApiServerOptions = {
  port?: number;
  hostname?: string;
  basePath?: string;
  apiKeys?: string[];
  allowUnauthenticated?: boolean;
  /**
   * Maximum seconds a connection may sit idle before Bun closes it.
   * Bun's default is 10s, which is too short for long-running requests
   * like synchronous loop triggers. Maximum allowed value is 255.
   */
  idleTimeout?: number;
};
