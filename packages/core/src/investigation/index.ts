/**
 * Investigation Module
 *
 * Exports for the tool-calling investigation loop.
 */

export type {
  ToolResult,
  InvestigationTool,
  InvestigationConfig,
  InvestigationResult,
  InvestigationMessage,
  InvestigationToolCall,
} from './types';

export { runInvestigation, DEFAULT_INVESTIGATION_SYSTEM_PROMPT } from './loop';
export { createInvestigationTool } from './tool-helper';
export type { CreateToolOptions } from './tool-helper';
