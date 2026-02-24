---
title: LLM Providers
description: Configure and use LLM providers -- Anthropic, OpenAI, and OpenAI-compatible APIs -- for text generation, structured output, streaming, and tool calling.
---

Zup provides a provider-agnostic LLM abstraction layer. You can use Anthropic's Claude, OpenAI's GPT models, or any OpenAI-compatible API (Ollama, vLLM, LiteLLM, Together AI, etc.) with the same interface.

LLM configuration is optional. Many plugins (like `http-monitor`) work without an LLM. Plugins that require LLM access (like `investigation-orienter`) will check for `ctx.llm` at runtime.

## Configuration

Set the `llm` field in your agent options:

### Anthropic

```ts
import { createAgent } from '@beepsdev/zup';

const agent = await createAgent({
  name: 'my-agent',
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  plugins: [...],
});
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `'anthropic'` | Yes | Selects the Anthropic provider. |
| `apiKey` | `string` | Yes | Anthropic API key. |
| `model` | `string` | Yes | Model name (e.g., `'claude-sonnet-4-20250514'`, `'claude-haiku-4-20250514'`). |
| `baseURL` | `string` | No | Custom API endpoint. Useful for proxies or API gateways. |

### OpenAI

```ts
const agent = await createAgent({
  name: 'my-agent',
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  },
  plugins: [...],
});
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `'openai'` | Yes | Selects the OpenAI provider. |
| `apiKey` | `string` | Yes | OpenAI API key. |
| `model` | `string` | Yes | Model name (e.g., `'gpt-4o'`, `'gpt-4o-mini'`). |
| `baseURL` | `string` | No | Custom API endpoint. |
| `organization` | `string` | No | OpenAI organization ID. |

### OpenAI-compatible

Use this for any provider that exposes an OpenAI-compatible API: Ollama, vLLM, LiteLLM, Together AI, Groq, etc.

```ts
// Ollama (local)
const agent = await createAgent({
  name: 'my-agent',
  llm: {
    provider: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',  // Ollama doesn't need a real key
    model: 'llama3.1',
  },
  plugins: [...],
});

// Together AI
const agent = await createAgent({
  name: 'my-agent',
  llm: {
    provider: 'openai-compatible',
    baseURL: 'https://api.together.xyz/v1',
    apiKey: process.env.TOGETHER_API_KEY!,
    model: 'meta-llama/Llama-3-70b-chat-hf',
  },
  plugins: [...],
});
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `'openai-compatible'` | Yes | Selects the OpenAI-compatible provider. |
| `baseURL` | `string` | Yes | API endpoint URL. Must include `/v1` if the provider expects it. |
| `apiKey` | `string` | Yes | API key for the provider. |
| `model` | `string` | Yes | Model name as expected by the provider. |

Under the hood, `openai-compatible` uses the same OpenAI SDK client as the `openai` provider, but with a custom `baseURL` and no organization field.

## LLM capability

When an LLM is configured, `ctx.llm` is populated with an `LLMCapability` object that provides four methods:

```ts
type LLMCapability = {
  provider: LLMProvider;
  config: LLMConfig;

  generateText(prompt: string, options?: GenerateOptions): Promise<TextResult>;
  generateStructured<T>(prompt: string, schema: ZodSchema<T>, options?: GenerateOptions): Promise<T>;
  streamText(prompt: string, options?: GenerateOptions): AsyncIterable<TextChunk>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
};
```

## Usage patterns

### Generate text

The simplest usage -- send a prompt, get text back.

```ts
const result = await ctx.llm.generateText(
  'Summarize the current system health based on these metrics: ...',
  {
    temperature: 0.3,
    maxTokens: 500,
    system: 'You are an SRE agent analyzing system health.',
  }
);

console.log(result.text);    // The generated text
console.log(result.usage);   // { promptTokens, completionTokens, totalTokens }
console.log(result.model);   // The actual model that responded
```

**TextResult:**

```ts
type TextResult = {
  text: string;
  usage?: TokenUsage;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  model?: string;
};
```

### Generate structured output

Use a Zod schema to get validated, typed output from the LLM. The framework instructs the LLM to respond with JSON, parses the response, and validates it against your schema.

```ts
import { z } from 'zod';

const HealthSummary = z.object({
  status: z.enum(['healthy', 'degraded', 'down']),
  affectedServices: z.array(z.string()),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  recommendation: z.string(),
});

type HealthSummary = z.infer<typeof HealthSummary>;

const summary: HealthSummary = await ctx.llm.generateStructured(
  'Analyze these observations and determine system health: ...',
  HealthSummary,
  {
    temperature: 0.1,  // Lower temperature for more deterministic structured output
    system: 'You are an SRE agent. Respond with a structured health assessment.',
  }
);

// summary is fully typed as HealthSummary
console.log(summary.status);           // 'degraded'
console.log(summary.affectedServices); // ['api-gateway', 'auth-service']
```

If the LLM returns invalid JSON or the response fails Zod validation, `generateStructured` throws an error.

The method handles JSON wrapped in markdown code blocks -- if the LLM responds with ` ```json ... ``` `, the framework strips the code fences before parsing.

### Stream text

For long-running generation or real-time output, use `streamText` to get an async iterable of text chunks:

```ts
const stream = ctx.llm.streamText(
  'Explain the root cause of this outage in detail: ...',
  {
    maxTokens: 2000,
    system: 'You are an SRE agent performing post-incident analysis.',
  }
);

for await (const chunk of stream) {
  process.stdout.write(chunk.text);

  if (chunk.done) {
    console.log('\n--- Generation complete ---');
  }
}
```

**TextChunk:**

```ts
type TextChunk = {
  text: string;
  done: boolean;  // true on the final chunk
};
```

### Chat with tool calling

The `chat` method supports multi-turn conversations and LLM tool calling. This is the foundation for the investigation system.

```ts
const tools = [
  {
    name: 'query_logs',
    description: 'Search application logs',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Log search query' },
        timeRange: { type: 'string', description: 'Time range (e.g., "1h", "30m")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_metrics',
    description: 'Fetch system metrics',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric name' },
        period: { type: 'string', description: 'Time period' },
      },
      required: ['metric'],
    },
  },
];

const messages: ChatMessage[] = [
  { role: 'user', content: 'Investigate why the API latency spiked at 14:30 UTC.' },
];

const result = await ctx.llm.chat(messages, {
  tools,
  system: 'You are an SRE agent. Use the available tools to investigate.',
  maxTokens: 4096,
});

// Check if the LLM wants to call tools
if (result.stopReason === 'tool_use') {
  for (const toolCall of result.toolCalls) {
    console.log(`Tool call: ${toolCall.name}(${JSON.stringify(toolCall.input)})`);
    // Execute the tool and feed results back...
  }
}
```

**ChatMessage types:**

```ts
type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
```

**ChatResult:**

```ts
type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: TokenUsage;
  model?: string;
};
```

**ToolDefinition:**

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema object
};
```

## GenerateOptions reference

All generation methods accept an optional `GenerateOptions` object:

| Field | Type | Default | Description |
|---|---|---|---|
| `maxTokens` | `number` | `4096` | Maximum tokens to generate. |
| `temperature` | `number` | Provider default | Sampling temperature (0-2). Lower values produce more deterministic output. |
| `topP` | `number` | Provider default | Top-P / nucleus sampling. |
| `stop` | `string[]` | -- | Stop sequences that halt generation. |
| `timeout` | `number` | -- | Request timeout in milliseconds. |
| `system` | `string` | -- | System prompt prepended to the conversation. |

`ChatOptions` extends `GenerateOptions` with an additional `tools` field:

| Field | Type | Description |
|---|---|---|
| `tools` | `ToolDefinition[]` | Tool definitions the LLM can call. |

## Using LLM in plugins

Plugins access the LLM through `ctx.llm`. Always check for its existence first, since LLM configuration is optional:

```ts
import { definePlugin, createOrienter } from '@beepsdev/zup';

export const myPlugin = () => definePlugin({
  id: 'my-plugin',

  orienters: {
    analyze: createOrienter({
      name: 'llm-analysis',
      description: 'Use LLM to analyze observations',
      orient: async (observations, ctx) => {
        if (!ctx.llm) {
          return {
            source: 'my-plugin/analyze',
            findings: ['LLM not configured -- skipping analysis'],
            confidence: 0.3,
          };
        }

        const result = await ctx.llm.generateText(
          `Analyze these observations: ${JSON.stringify(observations)}`,
          { temperature: 0.2 }
        );

        return {
          source: 'my-plugin/analyze',
          findings: [result.text],
          confidence: 0.8,
        };
      },
    }),
  },
});
```

### Investigation orienter

The `investigation-orienter` plugin is a production example of LLM-powered orientation. It uses `ctx.llm.chat` with tool calling to run a multi-turn investigation loop within the Orient phase:

```ts
import { investigationOrienter } from '@beepsdev/zup/plugins/investigation-orienter';

const agent = await createAgent({
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  plugins: [
    investigationOrienter({
      triggerSeverity: 'warning',  // Only investigate warning+ observations
      maxTurns: 15,                // Max tool-calling rounds
      tools: [
        {
          name: 'query_logs',
          description: 'Search logs',
          parameters: z.object({ query: z.string() }),
          execute: async (params) => {
            // Query your logging system
            return JSON.stringify(results);
          },
        },
      ],
    }),
  ],
});
```

The investigation orienter checks whether any observation meets the `triggerSeverity` threshold. If so, it builds a prompt from the observations and runs a tool-calling loop. The LLM's final response is parsed into a `SituationAssessment` with extracted findings, contributing factors, and impact assessment.

## Creating an LLM provider directly

If you need LLM access outside of an agent context, you can create a provider directly:

```ts
import { createLLMProvider, createLLMCapability } from '@beepsdev/zup';

// Create a raw provider
const provider = createLLMProvider({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-20250514',
});

const result = await provider.generateText('Hello, world!');

// Or create a full LLMCapability (same object that appears on ctx.llm)
const llm = createLLMCapability({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
});

const structured = await llm.generateStructured('...', myZodSchema);
```

## Token usage tracking

All methods that return `TextResult` or `ChatResult` include optional `usage` information:

```ts
type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};
```

Token counts are provided by the upstream API and may not be available for all providers (especially some OpenAI-compatible ones).
