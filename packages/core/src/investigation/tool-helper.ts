/**
 * Tool Helper
 *
 * Type-safe helper for creating investigation tools.
 */

import type { z } from 'zod';
import type { AgentContext } from '../types/context';
import type { InvestigationTool, ToolResult } from './types';

/**
 * Options for creating an investigation tool
 */
export type CreateToolOptions<T extends z.ZodSchema<unknown>> = {
  name: string;
  description: string;
  parameters: T;
  execute: (params: z.infer<T>, ctx: AgentContext) => Promise<ToolResult>;
};

/**
 * Create a type-safe investigation tool.
 *
 * @example
 * ```typescript
 * const queryLogs = createInvestigationTool({
 *   name: 'query_logs',
 *   description: 'Search logs for a service',
 *   parameters: z.object({
 *     service: z.string().describe('Service name'),
 *     query: z.string().describe('Search query'),
 *     limit: z.number().optional().describe('Max entries'),
 *   }),
 *   execute: async (params, ctx) => {
 *     const logs = await fetchLogs(params.service, params.query, params.limit);
 *     return { output: logs };
 *   },
 * });
 * ```
 */
export function createInvestigationTool<T extends z.ZodSchema<unknown>>(
  options: CreateToolOptions<T>
): InvestigationTool {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    execute: options.execute as InvestigationTool['execute'],
  };
}
