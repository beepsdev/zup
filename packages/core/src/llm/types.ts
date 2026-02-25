/**
 * LLM Abstraction Types
 *
 * Minimal, provider-agnostic interfaces for LLM integration.
 * Supports 20+ providers via the Vercel AI SDK.
 */

import type { z } from 'zod';

/**
 * Token usage tracking
 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/**
 * Tool definition for LLM tool calling
 */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
};

/**
 * Tool call from LLM response
 */
export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * Chat message for multi-turn conversations with tool calling
 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * Result from chat with tool calling
 */
export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: TokenUsage;
  model?: string;
};

/**
 * Result from text generation
 */
export type TextResult = {
  text: string;
  usage?: TokenUsage;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  model?: string;
};

/**
 * Options for text generation
 */
export type GenerateOptions = {
  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Temperature (0-2, higher = more random) */
  temperature?: number;

  /** Top P sampling */
  topP?: number;

  /** Stop sequences */
  stop?: string[];

  /** Request timeout in ms */
  timeout?: number;

  /** System prompt */
  system?: string;
};

/**
 * Streaming chunk from text generation
 */
export type TextChunk = {
  text: string;
  done: boolean;
};

/**
 * Options for chat with tool calling
 */
export type ChatOptions = GenerateOptions & {
  tools?: ToolDefinition[];
};

/**
 * LLM Provider Interface
 *
 * All providers must implement this interface for consistency.
 */
export interface LLMProvider {
  /**
   * Generate text from a prompt
   */
  generateText(prompt: string, options?: GenerateOptions): Promise<TextResult>;

  /**
   * Generate structured output that matches a Zod schema
   */
  generateStructured<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options?: GenerateOptions
  ): Promise<T>;

  /**
   * Stream text generation
   */
  streamText(prompt: string, options?: GenerateOptions): AsyncIterable<TextChunk>;

  /**
   * Multi-turn chat with optional tool calling
   */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

/**
 * Base config shared by all simple API-key providers
 */
type BaseProviderConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
};

/**
 * Provider-specific configuration
 *
 * Simple API-key providers: anthropic, openai, google, mistral, groq, xai,
 * cohere, perplexity, togetherai, deepinfra, cerebras, openrouter
 *
 * Providers with extra options: azure, amazon-bedrock, google-vertex
 *
 * Generic: openai-compatible (any endpoint with baseURL)
 */
export type LLMConfig =
  | (BaseProviderConfig & { provider: 'anthropic' })
  | (BaseProviderConfig & { provider: 'openai'; organization?: string })
  | (BaseProviderConfig & { provider: 'google' })
  | (BaseProviderConfig & { provider: 'mistral' })
  | (BaseProviderConfig & { provider: 'groq' })
  | (BaseProviderConfig & { provider: 'xai' })
  | (BaseProviderConfig & { provider: 'cohere' })
  | (BaseProviderConfig & { provider: 'perplexity' })
  | (BaseProviderConfig & { provider: 'togetherai' })
  | (BaseProviderConfig & { provider: 'deepinfra' })
  | (BaseProviderConfig & { provider: 'cerebras' })
  | (BaseProviderConfig & { provider: 'openrouter' })
  | {
      provider: 'azure';
      apiKey: string;
      model: string;
      resourceName: string;
      apiVersion?: string;
    }
  | {
      provider: 'amazon-bedrock';
      model: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    }
  | {
      provider: 'google-vertex';
      model: string;
      project: string;
      location: string;
    }
  | {
      provider: 'openai-compatible';
      baseURL: string;
      apiKey: string;
      model: string;
    };

/**
 * LLM capability added to agent context
 */
export type LLMCapability = {
  provider: LLMProvider;
  config: LLMConfig;

  // Convenience methods
  generateText: LLMProvider['generateText'];
  generateStructured: LLMProvider['generateStructured'];
  streamText: LLMProvider['streamText'];
  chat: LLMProvider['chat'];
};
