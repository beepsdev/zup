/**
 * LLM Abstraction Layer
 *
 * Provider-agnostic LLM integration for Zup.
 * Supports Anthropic, OpenAI, and OpenAI-compatible APIs.
 */

export type {
  LLMProvider,
  LLMConfig,
  LLMCapability,
  TextResult,
  TextChunk,
  GenerateOptions,
  TokenUsage,
  ToolDefinition,
  ToolCall,
  ChatMessage,
  ChatResult,
  ChatOptions,
} from './types';

export { createAnthropicProvider } from './providers/anthropic';
export { createOpenAIProvider } from './providers/openai';

import type { LLMProvider, LLMConfig, LLMCapability } from './types';
import { createAnthropicProvider } from './providers/anthropic';
import { createOpenAIProvider } from './providers/openai';

/**
 * Create an LLM provider from configuration
 */
export function createLLMProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
      });

    case 'openai':
      return createOpenAIProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
        organization: config.organization,
      });

    case 'openai-compatible':
      return createOpenAIProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
      });

    default: {
      const _exhaustiveCheck: never = config;
      throw new Error(`Unknown LLM provider: ${(_exhaustiveCheck as { provider: string }).provider}`);
    }
  }
}

/**
 * Create LLM capability for agent context
 */
export function createLLMCapability(config: LLMConfig): LLMCapability {
  const provider = createLLMProvider(config);

  return {
    provider,
    config,
    generateText: provider.generateText.bind(provider),
    generateStructured: provider.generateStructured.bind(provider),
    streamText: provider.streamText.bind(provider),
    chat: provider.chat.bind(provider),
  };
}
