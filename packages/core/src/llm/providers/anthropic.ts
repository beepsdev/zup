/**
 * Anthropic Provider
 *
 * Implements LLMProvider interface using Anthropic's Claude API.
 * Functional style with closures.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type {
  LLMProvider,
  TextResult,
  GenerateOptions,
  TextChunk,
  TokenUsage,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ToolCall,
} from '../types';

function mapStopReason(
  reason: string | null
): 'stop' | 'length' | 'content_filter' | 'tool_calls' | undefined {
  if (!reason) return undefined;

  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    default:
      return undefined;
  }
}

function mapChatStopReason(
  reason: string | null
): ChatResult['stopReason'] {
  if (!reason) return 'end_turn';

  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

function convertMessagesToAnthropic(
  messages: ChatMessage[]
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];

      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }

      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
      }

      result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // Tool results need to be part of a user message in Anthropic's format
      const lastMsg = result.at(-1);
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
        (lastMsg.content as Anthropic.ToolResultBlockParam[]).push({
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
        });
      } else {
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId,
              content: msg.content,
            },
          ],
        });
      }
    }
  }

  return result;
}

export function createAnthropicProvider(config: {
  apiKey: string;
  model: string;
  baseURL?: string;
}): LLMProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
  const model = config.model;

  const provider: LLMProvider = {
    async generateText(prompt: string, options?: GenerateOptions): Promise<TextResult> {
      const messages: Anthropic.MessageParam[] = [
        {
          role: 'user',
          content: prompt,
        },
      ];

      const response = await client.messages.create({
        model,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop_sequences: options?.stop,
        system: options?.system,
        messages,
      });

      // Extract text from response
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      // Convert usage
      const usage: TokenUsage | undefined = response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined;

      return {
        text,
        usage,
        finishReason: mapStopReason(response.stop_reason),
        model: response.model,
      };
    },

    async generateStructured<T>(
      prompt: string,
      schema: z.ZodSchema<T>,
      options?: GenerateOptions
    ): Promise<T> {
      // Add JSON formatting instruction to prompt
      const structuredPrompt = `${prompt}

Please respond with valid JSON that matches this schema. Do not include any text outside the JSON object.`;

      const result = await provider.generateText(structuredPrompt, {
        ...options,
        system: options?.system
          ? `${options.system}\n\nYou must respond with valid JSON only.`
          : 'You must respond with valid JSON only.',
      });

      // Parse and validate JSON
      let parsed: unknown;
      try {
        // Extract JSON from markdown code blocks if present
        let jsonText = result.text.trim();
        const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonMatch) {
          jsonText = jsonMatch[1]!.trim();
        }

        parsed = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(`Failed to parse JSON response: ${result.text}`);
      }

      // Validate with Zod schema
      return schema.parse(parsed);
    },

    async *streamText(
      prompt: string,
      options?: GenerateOptions
    ): AsyncIterable<TextChunk> {
      const messages: Anthropic.MessageParam[] = [
        {
          role: 'user',
          content: prompt,
        },
      ];

      const stream = await client.messages.create({
        model,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop_sequences: options?.stop,
        system: options?.system,
        messages,
        stream: true,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield {
              text: event.delta.text,
              done: false,
            };
          }
        } else if (event.type === 'message_stop') {
          yield {
            text: '',
            done: true,
          };
        }
      }
    },

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
      const anthropicMessages = convertMessagesToAnthropic(messages);

      // Convert tools to Anthropic format
      const tools: Anthropic.Tool[] | undefined = options?.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }));

      const response = await client.messages.create({
        model,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop_sequences: options?.stop,
        system: options?.system,
        messages: anthropicMessages,
        tools,
      });

      // Extract text content
      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      // Convert usage
      const usage: TokenUsage | undefined = response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined;

      return {
        content,
        toolCalls,
        stopReason: mapChatStopReason(response.stop_reason),
        usage,
        model: response.model,
      };
    },
  };

  return provider;
}
