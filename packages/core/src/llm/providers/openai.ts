/**
 * OpenAI Provider
 *
 * Implements LLMProvider interface using OpenAI's API.
 * Also works with OpenAI-compatible APIs (Ollama, LM Studio, etc.)
 * Functional style with closures.
 */

import OpenAI from 'openai';
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

function mapFinishReason(
  reason: string | null | undefined
): 'stop' | 'length' | 'content_filter' | 'tool_calls' | undefined {
  if (!reason) return undefined;

  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
      return 'tool_calls';
    default:
      return undefined;
  }
}

function mapChatStopReason(
  reason: string | null | undefined
): ChatResult['stopReason'] {
  if (!reason) return 'end_turn';

  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

function convertMessagesToOpenAI(
  messages: ChatMessage[],
  systemPrompt?: string
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: msg.content || null,
      };

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        assistantMsg.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        }));
      }

      result.push(assistantMsg);
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }

  return result;
}

export function createOpenAIProvider(config: {
  apiKey: string;
  model: string;
  baseURL?: string;
  organization?: string;
}): LLMProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    organization: config.organization,
  });
  const model = config.model;

  const provider: LLMProvider = {
    async generateText(prompt: string, options?: GenerateOptions): Promise<TextResult> {
      const messages: OpenAI.ChatCompletionMessageParam[] = [];

      // Add system message if provided
      if (options?.system) {
        messages.push({
          role: 'system',
          content: options.system,
        });
      }

      messages.push({
        role: 'user',
        content: prompt,
      });

      const response = await client.chat.completions.create({
        model,
        messages,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop: options?.stop,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error('No response from OpenAI');
      }

      // Extract usage
      const usage: TokenUsage | undefined = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      return {
        text: choice.message.content || '',
        usage,
        finishReason: mapFinishReason(choice.finish_reason),
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
      const messages: OpenAI.ChatCompletionMessageParam[] = [];

      // Add system message if provided
      if (options?.system) {
        messages.push({
          role: 'system',
          content: options.system,
        });
      }

      messages.push({
        role: 'user',
        content: prompt,
      });

      const stream = await client.chat.completions.create({
        model,
        messages,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop: options?.stop,
        stream: true,
      });

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const content = choice.delta.content;
        if (content) {
          yield {
            text: content,
            done: false,
          };
        }

        if (choice.finish_reason) {
          yield {
            text: '',
            done: true,
          };
        }
      }
    },

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
      const openaiMessages = convertMessagesToOpenAI(messages, options?.system);

      // Convert tools to OpenAI format
      const tools: OpenAI.ChatCompletionTool[] | undefined = options?.tools?.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));

      const response = await client.chat.completions.create({
        model,
        messages: openaiMessages,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop: options?.stop,
        tools: tools && tools.length > 0 ? tools : undefined,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error('No response from OpenAI');
      }

      // Extract tool calls
      const toolCalls: ToolCall[] = [];
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if (tc.type === 'function') {
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}'),
            });
          }
        }
      }

      // Extract usage
      const usage: TokenUsage | undefined = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      return {
        content: choice.message.content || '',
        toolCalls,
        stopReason: mapChatStopReason(choice.finish_reason),
        usage,
        model: response.model,
      };
    },
  };

  return provider;
}
