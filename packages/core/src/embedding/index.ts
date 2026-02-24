/**
 * Embedding Provider
 *
 * Provides text embedding capabilities for vector search.
 * Currently supports OpenAI embeddings.
 */

import OpenAI from 'openai';
import type { Logger } from '../types/common';

export type EmbeddingConfig = {
  provider: 'openai';
  apiKey: string;
  model?: string;
  dimensions?: number;
};

export type EmbeddingCapability = {
  embed: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  dimensions: number;
};

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

export function createEmbeddingCapability(
  config: EmbeddingConfig,
  logger: Logger = console
): EmbeddingCapability {
  const model = config.model || DEFAULT_MODEL;
  const dimensions = config.dimensions || DEFAULT_DIMENSIONS;

  const client = new OpenAI({
    apiKey: config.apiKey,
  });

  const embed = async (text: string): Promise<number[]> => {
    try {
      const response = await client.embeddings.create({
        model,
        input: text,
        dimensions,
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new Error('No embedding returned from API');
      }
      return embedding;
    } catch (err) {
      logger.error('[embedding] Failed to generate embedding:', err);
      throw err;
    }
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }

    try {
      const response = await client.embeddings.create({
        model,
        input: texts,
        dimensions,
      });

      return response.data.map(d => d.embedding);
    } catch (err) {
      logger.error('[embedding] Failed to generate batch embeddings:', err);
      throw err;
    }
  };

  return {
    embed,
    embedBatch,
    dimensions,
  };
}
