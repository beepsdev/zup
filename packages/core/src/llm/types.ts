/**
 * LLM Abstraction Types
 *
 * Minimal, provider-agnostic interfaces for LLM integration.
 * Supports Anthropic, OpenAI, and any OpenAI-compatible API.
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
 * Provider-specific configuration
 */
export type LLMConfig =
  | {
      provider: 'anthropic';
      apiKey: string;
      model: string;
      baseURL?: string;
    }
  | {
      provider: 'openai';
      apiKey: string;
      model: string;
      baseURL?: string;
      organization?: string;
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
