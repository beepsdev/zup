/**
 * LLM Abstraction Layer
 *
 * Provider-agnostic LLM integration for Zup.
 * Supports 20+ providers via the Vercel AI SDK.
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

export { createAISDKProvider } from './providers/ai-sdk';

import type { LLMProvider, LLMConfig, LLMCapability } from './types';
import { createAISDKProvider } from './providers/ai-sdk';

/**
 * Create an LLM provider from configuration
 */
export function createLLMProvider(config: LLMConfig): LLMProvider {
  return createAISDKProvider(config);
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
