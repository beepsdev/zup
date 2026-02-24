/**
 * API Helpers
 *
 * Utility functions for building API responses
 */

/**
 * Create a JSON response
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create an error response
 */
export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Parse JSON body safely
 */
export async function parseBody<T = unknown>(req: Request): Promise<T | null> {
  try {
    return await req.json() as T;
  } catch {
    return null;
  }
}

/**
 * Common HTTP status helpers
 */
export const responses = {
  ok: <T>(data: T) => json(data, 200),
  created: <T>(data: T) => json(data, 201),
  noContent: () => new Response(null, { status: 204 }),

  badRequest: (message: string) => error(message, 400),
  unauthorized: (message = 'Unauthorized') => error(message, 401),
  forbidden: (message = 'Forbidden') => error(message, 403),
  notFound: (message = 'Not found') => error(message, 404),

  internalError: (message = 'Internal server error') => error(message, 500),
};
