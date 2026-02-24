/**
 * Investigation Types
 *
 * Types for the tool-calling investigation loop that enables
 * deep incident analysis within Zup's Orient phase.
 */

import type { z } from 'zod';
import type { AgentContext } from '../types/context';

/**
 * Result from executing an investigation tool
 */
export type ToolResult = {
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Definition of an investigation tool that the LLM can call
 */
export type InvestigationTool = {
  name: string;
  description: string;
  parameters: z.ZodSchema<unknown>;
  execute: (params: unknown, ctx: AgentContext) => Promise<ToolResult>;
};

/**
 * Configuration for running an investigation
 */
export type InvestigationConfig = {
  tools: InvestigationTool[];
  maxTurns?: number;
  systemPrompt?: string;
};

/**
 * Result from running an investigation loop
 */
export type InvestigationResult = {
  findings: string;
  turnsUsed: number;
  toolsUsed: string[];
  incomplete?: boolean;
  transcript?: InvestigationMessage[];
};

/**
 * Message in the investigation conversation history
 */
export type InvestigationMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: InvestigationToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * Tool call made by the LLM during investigation
 */
export type InvestigationToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};
