/**
 * API Server
 *
 * HTTP server using Bun's native Web APIs
 */

import type { AgentContext } from '../types/context';
import type { Route, ApiServer, ApiServerOptions, RouteHandler, RequestContext } from './types';

/**
 * Simple path matcher
 */
function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];

    if (patternPart?.startsWith(':')) {
      // Dynamic segment
      params[patternPart.slice(1)] = pathPart || '';
    } else if (patternPart !== pathPart) {
      // Static segment doesn't match
      return null;
    }
  }

  return params;
}

/**
 * Create API server
 */
export function createApiServer(
  context: AgentContext,
  options: ApiServerOptions = {}
): ApiServer {
  const {
    port = 3000,
    hostname = 'localhost',
    basePath = '/api/v0',
    apiKeys = [],
    allowUnauthenticated = false,
  } = options;

  const apiKeySet = new Set(apiKeys);
  const routes: Route[] = [];

  /**
   * Register a route
   */
  function route(method: string, path: string, handler: RouteHandler, auth = true) {
    routes.push({
      method: method.toUpperCase(),
      path: `${basePath}${path}`,
      handler,
      auth,
    });
  }

  /**
   * Helper: JSON response
   */
  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Helper: Error response
   */
  function errorResponse(message: string, status = 400): Response {
    return json({ error: message }, status);
  }

  /**
   * Auth middleware - check Bearer token
   */
  function requireAuth(req: Request): Response | null {
    if (apiKeySet.size === 0) {
      if (allowUnauthenticated) {
        return null;
      }
      return errorResponse('API authentication required but no API keys are configured', 401);
    }

    const auth = req.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) {
      return errorResponse('Missing or invalid Authorization header', 401);
    }

    const token = auth.slice(7);
    if (!apiKeySet.has(token)) {
      return errorResponse('Invalid API key', 401);
    }

    return null;
  }

  /**
   * Request handler
   */
  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // Find matching route
    for (const route of routes) {
      if (route.method !== method) continue;

      const params = matchPath(route.path, url.pathname);
      if (params === null) continue;

      // Check auth if required (default true)
      if (route.auth !== false) {
        const authError = requireAuth(req);
        if (authError) return authError;
      }

      try {
        // Create request context
        const requestContext: RequestContext = {
          request: req,
          params,
          context,
        };

        return await route.handler(requestContext);
      } catch (error) {
        context.logger.error('Route handler error:', error);
        return errorResponse(
          error instanceof Error ? error.message : 'Internal server error',
          500
        );
      }
    }

    return errorResponse('Not found', 404);
  }

  // Start server
  const server = Bun.serve({
    port,
    hostname,
    fetch: handleRequest,
  });

  if (apiKeySet.size === 0 && !allowUnauthenticated) {
    context.logger.warn('API auth is required but no API keys are configured; auth-required routes will return 401');
  }

  context.logger.info(`API server listening on http://${hostname}:${port}${basePath}`);

  return {
    server,
    route,
    stop: () => server.stop(),
  };
}
