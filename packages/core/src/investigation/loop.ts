/**
 * Investigation Loop
 *
 * Konchu-style tool-calling loop for deep incident investigation.
 * The LLM iteratively calls tools until it has enough information
 * to provide findings, or until maxTurns is reached.
 */

import type { AgentContext } from '../types/context';
import type { ChatMessage, ToolDefinition, ToolCall } from '../llm/types';
import type {
  InvestigationTool,
  InvestigationConfig,
  InvestigationResult,
  InvestigationMessage,
  InvestigationToolCall,
} from './types';
import { zodToJsonSchema } from '../utils/zod-to-json-schema';

const DEFAULT_SYSTEM_PROMPT = `You are an SRE investigation agent. Your job is to deeply analyze 
system observations and determine root cause.

Use the available tools to:
- Query logs for error patterns
- Check metrics for anomalies  
- Correlate events across services
- Verify service health

Be thorough but efficient. When you have enough information to explain what's happening, 
provide your findings without calling more tools.`;

const DEFAULT_MAX_TURNS = 20;

/**
 * Convert investigation tools to LLM tool definitions
 */
function toolsToDefinitions(tools: InvestigationTool[]): ToolDefinition[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.parameters),
  }));
}

/**
 * Convert investigation messages to LLM chat messages
 */
function toChatlMessages(messages: InvestigationMessage[]): ChatMessage[] {
  return messages.map(msg => {
    if (msg.role === 'user') {
      return { role: 'user' as const, content: msg.content };
    } else if (msg.role === 'assistant') {
      const toolCalls: ToolCall[] | undefined = msg.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));
      return {
        role: 'assistant' as const,
        content: msg.content,
        toolCalls,
      };
    } else {
      return {
        role: 'tool' as const,
        toolCallId: msg.toolCallId,
        content: msg.content,
      };
    }
  });
}

/**
 * Run an investigation loop with the given prompt and tools.
 *
 * The loop continues until:
 * 1. The LLM returns a response with no tool calls (investigation complete)
 * 2. maxTurns is reached (investigation incomplete)
 */
export async function runInvestigation(
  ctx: AgentContext,
  prompt: string,
  config: InvestigationConfig
): Promise<InvestigationResult> {
  if (!ctx.llm) {
    throw new Error('LLM capability required for investigation');
  }

  const { tools, maxTurns = DEFAULT_MAX_TURNS, systemPrompt = DEFAULT_SYSTEM_PROMPT } = config;
  const messages: InvestigationMessage[] = [{ role: 'user', content: prompt }];
  const toolsUsed: Set<string> = new Set();
  const toolDefinitions = toolsToDefinitions(tools);

  let turn = 0;

  while (turn < maxTurns) {
    turn++;
    ctx.logger.debug(`Investigation turn ${turn}/${maxTurns}`);

    // Call LLM with tools
    const response = await ctx.llm.chat(toChatlMessages(messages), {
      system: systemPrompt,
      tools: toolDefinitions,
    });

    // Convert tool calls to investigation format
    const investigationToolCalls: InvestigationToolCall[] = response.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));

    // Add assistant response to history
    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: investigationToolCalls.length > 0 ? investigationToolCalls : undefined,
    });

    // If no tool calls, investigation is complete
    if (response.toolCalls.length === 0) {
      return {
        findings: response.content,
        turnsUsed: turn,
        toolsUsed: Array.from(toolsUsed),
        transcript: messages,
      };
    }

    // Execute tool calls
    for (const toolCall of response.toolCalls) {
      toolsUsed.add(toolCall.name);

      const tool = tools.find(t => t.name === toolCall.name);
      if (!tool) {
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: `Error: Unknown tool "${toolCall.name}"`,
        });
        continue;
      }

      try {
        // Validate and execute tool
        const validatedParams = tool.parameters.parse(toolCall.input);
        const result = await tool.execute(validatedParams, ctx);
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: result.error ? `Error: ${result.error}` : result.output,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: `Error: ${errorMessage}`,
        });
      }
    }
  }

  // Max turns reached - extract best findings from last assistant message
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();

  return {
    findings: lastAssistant?.content || 'Investigation incomplete - max turns reached',
    turnsUsed: turn,
    toolsUsed: Array.from(toolsUsed),
    incomplete: true,
    transcript: messages,
  };
}
