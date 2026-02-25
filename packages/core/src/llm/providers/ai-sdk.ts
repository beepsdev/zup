/**
 * AI SDK Provider Wrapper
 *
 * Implements LLMProvider interface using the Vercel AI SDK,
 * supporting 20+ providers through a single abstraction.
 */

import {
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  streamText as aiStreamText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type LanguageModelUsage,
  type Tool as AITool,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createMistral } from '@ai-sdk/mistral';
import { createGroq } from '@ai-sdk/groq';
import { createXai } from '@ai-sdk/xai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createCerebras } from '@ai-sdk/cerebras';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { z } from 'zod';
import type {
  LLMConfig,
  LLMProvider,
  TextResult,
  GenerateOptions,
  TextChunk,
  TokenUsage,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ToolCall,
  ToolDefinition,
} from '../types';

function getLanguageModel(config: LLMConfig): LanguageModel {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'openai':
      return createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        organization: config.organization,
      })(config.model);

    case 'google':
      return createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'google-vertex':
      return createVertex({ project: config.project, location: config.location })(config.model);

    case 'mistral':
      return createMistral({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'groq':
      return createGroq({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'xai':
      return createXai({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'amazon-bedrock':
      return createAmazonBedrock({
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        sessionToken: config.sessionToken,
      })(config.model);

    case 'azure':
      return createAzure({
        apiKey: config.apiKey,
        resourceName: config.resourceName,
        apiVersion: config.apiVersion,
      })(config.model);

    case 'cohere':
      return createCohere({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'perplexity':
      return createPerplexity({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'togetherai':
      return createTogetherAI({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'deepinfra':
      return createDeepInfra({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'cerebras':
      return createCerebras({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'openrouter':
      return createOpenRouter({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);

    case 'openai-compatible':
      return createOpenAICompatible({
        name: 'custom',
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })(config.model);

    default: {
      const _exhaustiveCheck: never = config;
      throw new Error(`Unknown LLM provider: ${(_exhaustiveCheck as { provider: string }).provider}`);
    }
  }
}

function mapFinishReason(
  reason: string | undefined
): TextResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    case 'tool-calls':
      return 'tool_calls';
    default:
      return undefined;
  }
}

function mapChatStopReason(
  reason: string | undefined
): ChatResult['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool-calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

function convertMessages(messages: ChatMessage[], system?: string): ModelMessage[] {
  const result: ModelMessage[] = [];

  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const parts: Array<
          | { type: 'text'; text: string }
          | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
        > = [];
        if (msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.input,
          });
        }
        result.push({ role: 'assistant', content: parts });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.toolCallId,
            toolName: '',
            output: { type: 'text', value: msg.content },
          },
        ],
      });
    }
  }

  return result;
}

function convertTools(tools: ToolDefinition[]): Record<string, AITool> {
  const result: Record<string, AITool> = {};
  for (const t of tools) {
    result[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
    } as AITool;
  }
  return result;
}

function extractUsage(usage: LanguageModelUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

export function createAISDKProvider(config: LLMConfig): LLMProvider {
  const model = getLanguageModel(config);

  const provider: LLMProvider = {
    async generateText(prompt: string, options?: GenerateOptions): Promise<TextResult> {
      const result = await aiGenerateText({
        model,
        prompt,
        system: options?.system,
        maxOutputTokens: options?.maxTokens,
        temperature: options?.temperature,
        topP: options?.topP,
        stopSequences: options?.stop,
        abortSignal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
      });

      return {
        text: result.text,
        usage: extractUsage(result.usage),
        finishReason: mapFinishReason(result.finishReason),
        model: result.response?.modelId,
      };
    },

    async generateStructured<T>(
      prompt: string,
      schema: z.ZodSchema<T>,
      options?: GenerateOptions
    ): Promise<T> {
      const result = await aiGenerateObject({
        model,
        prompt,
        schema,
        system: options?.system,
        maxOutputTokens: options?.maxTokens,
        temperature: options?.temperature,
        topP: options?.topP,
        abortSignal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
      });

      return result.object;
    },

    async *streamText(
      prompt: string,
      options?: GenerateOptions
    ): AsyncIterable<TextChunk> {
      const result = aiStreamText({
        model,
        prompt,
        system: options?.system,
        maxOutputTokens: options?.maxTokens,
        temperature: options?.temperature,
        topP: options?.topP,
        stopSequences: options?.stop,
        abortSignal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
      });

      for await (const chunk of result.textStream) {
        yield { text: chunk, done: false };
      }
      yield { text: '', done: true };
    },

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
      const modelMessages = convertMessages(messages, options?.system);

      const tools = options?.tools && options.tools.length > 0
        ? convertTools(options.tools)
        : undefined;

      const result = await aiGenerateText({
        model,
        messages: modelMessages,
        tools,
        maxOutputTokens: options?.maxTokens,
        temperature: options?.temperature,
        topP: options?.topP,
        stopSequences: options?.stop,
        abortSignal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
      });

      const toolCalls: ToolCall[] = result.toolCalls?.map(tc => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc as unknown as { input: Record<string, unknown> }).input,
      })) ?? [];

      return {
        content: result.text,
        toolCalls,
        stopReason: mapChatStopReason(result.finishReason),
        usage: extractUsage(result.usage),
        model: result.response?.modelId,
      };
    },
  };

  return provider;
}
