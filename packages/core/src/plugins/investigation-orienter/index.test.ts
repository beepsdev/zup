/**
 * Investigation Orienter Plugin Tests
 */

import { describe, test, expect, mock } from 'bun:test';
import { createAgent, type AgentContext } from '../../index';
import { investigationOrienter } from './index';
import { createInvestigationTool } from '../../investigation';
import { z } from 'zod';

describe('Investigation Orienter Plugin', () => {
  describe('Plugin Initialization', () => {
    test('should throw error if no tools configured', () => {
      expect(() => {
        investigationOrienter({
          tools: [],
        });
      }).toThrow('At least one tool must be configured');
    });

    test('should initialize with valid configuration', async () => {
      const mockTool = createInvestigationTool({
        name: 'mock_tool',
        description: 'A mock tool for testing',
        parameters: z.object({
          query: z.string(),
        }),
        execute: async () => ({ output: 'mock result' }),
      });

      const agent = await createAgent({
        plugins: [
          investigationOrienter({
            tools: [mockTool],
          }),
        ],
      });

      const ctx = agent.getContext();
      expect(ctx.capabilities.orienters.has('investigation-orienter:investigate')).toBe(true);
    });
  });

  describe('Severity Threshold', () => {
    test('should not investigate if observations below threshold', async () => {
      const mockTool = createInvestigationTool({
        name: 'mock_tool',
        description: 'A mock tool',
        parameters: z.object({}),
        execute: async () => ({ output: 'result' }),
      });

      const agent = await createAgent({
        plugins: [
          investigationOrienter({
            tools: [mockTool],
            triggerSeverity: 'error',
          }),
        ],
      });

      // Create a mock observer that returns low-severity observations
      const ctx = agent.getContext();
      ctx.capabilities.observers.set('test:mock', {
        name: 'Mock Observer',
        description: 'Returns info-level observations',
        observe: async () => [
          {
            source: 'test',
            timestamp: new Date(),
            type: 'metric',
            severity: 'info',
            data: { value: 1 },
          },
        ],
      });

      const result = await agent.runLoop();

      // Should have assessment but no deep investigation
      const assessment = result.situation?.assessments.find(
        a => a.source === 'investigation-orienter'
      );
      expect(assessment).toBeDefined();
      expect(assessment?.findings).toContain('No significant observations requiring deep investigation');
    });
  });

  describe('Tool Helper', () => {
    test('createInvestigationTool should create valid tool', () => {
      const tool = createInvestigationTool({
        name: 'test_tool',
        description: 'Test description',
        parameters: z.object({
          param1: z.string(),
          param2: z.number().optional(),
        }),
        execute: async (params) => ({
          output: `Received: ${params.param1}`,
        }),
      });

      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('Test description');
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeInstanceOf(Function);
    });

    test('tool should validate parameters', async () => {
      const tool = createInvestigationTool({
        name: 'validated_tool',
        description: 'Tool with validation',
        parameters: z.object({
          required: z.string(),
        }),
        execute: async (params) => ({
          output: params.required,
        }),
      });

      // Valid params should work
      const validResult = tool.parameters.safeParse({ required: 'test' });
      expect(validResult.success).toBe(true);

      // Invalid params should fail
      const invalidResult = tool.parameters.safeParse({});
      expect(invalidResult.success).toBe(false);
    });
  });

  describe('Investigation Loop Integration', () => {
    test('should call tools when investigating', async () => {
      let toolCalled = false;
      let toolParams: unknown = null;

      const mockTool = createInvestigationTool({
        name: 'tracking_tool',
        description: 'Tracks if it was called',
        parameters: z.object({
          query: z.string().optional(),
        }),
        execute: async (params) => {
          toolCalled = true;
          toolParams = params;
          return { output: 'Tool was called successfully' };
        },
      });

      const agent = await createAgent({
        plugins: [
          investigationOrienter({
            tools: [mockTool],
            triggerSeverity: 'warning',
          }),
        ],
      });

      // Inject mock LLM using type assertion to bypass strict typing
      const ctx = agent.getContext();
      const mockChat = async () => {
        // First call: return a tool call
        if (!toolCalled) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'tracking_tool',
                input: { query: 'test query' },
              },
            ],
            stopReason: 'tool_use' as const,
          };
        }
        // Second call: return findings
        return {
          content: 'Investigation complete. Root cause: test issue. Impact: minimal.',
          toolCalls: [],
          stopReason: 'end_turn' as const,
        };
      };

      ctx.llm = {
        provider: {
          generateText: async () => ({ text: 'test' }),
          generateStructured: async <T>() => ({} as T),
          streamText: async function* () {
            yield { text: '', done: true };
          },
          chat: mockChat,
        },
        config: { provider: 'anthropic', apiKey: 'test', model: 'test' },
        generateText: async () => ({ text: 'test' }),
        generateStructured: async <T>() => ({} as T),
        streamText: async function* () {
          yield { text: '', done: true };
        },
        chat: mockChat,
      };

      // Add a mock observer that returns warning-level observations
      ctx.capabilities.observers.set('test:warning', {
        name: 'Warning Observer',
        description: 'Returns warning-level observations',
        observe: async () => [
          {
            source: 'test',
            timestamp: new Date(),
            type: 'alert',
            severity: 'warning',
            data: { message: 'Something is wrong' },
          },
        ],
      });

      const result = await agent.runLoop();

      expect(toolCalled).toBe(true);
      expect(toolParams).toEqual({ query: 'test query' });

      // Check that assessment was created
      const assessment = result.situation?.assessments.find(
        a => a.source === 'investigation-orienter'
      );
      expect(assessment).toBeDefined();
      expect(assessment?.findings[0]).toContain('Investigation complete');
    });
  });
});

describe('Zod to JSON Schema Converter', () => {
  const { zodToJsonSchema } = require('../../utils/zod-to-json-schema');

  test('should convert string schema', () => {
    const schema = z.string();
    const jsonSchema = zodToJsonSchema(schema);
    expect(jsonSchema.type).toBe('string');
  });

  test('should convert number schema', () => {
    const schema = z.number();
    const jsonSchema = zodToJsonSchema(schema);
    expect(jsonSchema.type).toBe('number');
  });

  test('should convert boolean schema', () => {
    const schema = z.boolean();
    const jsonSchema = zodToJsonSchema(schema);
    expect(jsonSchema.type).toBe('boolean');
  });

  test('should convert object schema', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean().optional(),
    });
    const jsonSchema = zodToJsonSchema(schema);

    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();
    expect((jsonSchema.properties as Record<string, unknown>).name).toEqual({ type: 'string' });
    expect((jsonSchema.properties as Record<string, unknown>).age).toEqual({ type: 'number' });
    expect(jsonSchema.required).toContain('name');
    expect(jsonSchema.required).toContain('age');
    expect(jsonSchema.required).not.toContain('active');
  });

  test('should convert array schema', () => {
    const schema = z.array(z.string());
    const jsonSchema = zodToJsonSchema(schema);

    expect(jsonSchema.type).toBe('array');
    expect(jsonSchema.items).toEqual({ type: 'string' });
  });

  test('should convert enum schema', () => {
    const schema = z.enum(['low', 'medium', 'high']);
    const jsonSchema = zodToJsonSchema(schema);

    expect(jsonSchema.type).toBe('string');
    expect(jsonSchema.enum).toEqual(['low', 'medium', 'high']);
  });
});
