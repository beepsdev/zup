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
};
