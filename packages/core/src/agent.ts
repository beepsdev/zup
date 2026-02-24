import { randomUUID } from 'crypto';
import type {
  AgentContext,
  AgentOptions,
  ZupPlugin,
  LoopResult,
} from './types/index';
import { createStateStore } from './utils/state';
import { initializePlugins } from './plugin';
import { runOODALoop, executeActionById } from './loop';
import { createApiServer } from './api/server';
import { registerCoreRoutes } from './api/routes';
import { registerRunRoutes } from './api/run-routes';
import type { ApiServer } from './api/types';
import { createLLMCapability } from './llm';
import { createSQLiteCapability } from './db';

export async function createAgent(options: AgentOptions = {}) {
  const logger = options.logger || console;
  const sqliteCapability = options.sqlite
    ? createSQLiteCapability(options.sqlite, logger)
    : undefined;
  let context: AgentContext = {
    agent: {
      id: options.id || randomUUID(),
      name: options.name || 'Zup',
      model: options.model || 'claude-3-5-sonnet',
      systemPrompt: options.systemPrompt || 'You are Zup, an SRE agent that helps maintain and troubleshoot systems.',
    },

    logger,

    // Initialize LLM if configured
    llm: options.llm ? createLLMCapability(options.llm) : undefined,

    // Initialize SQLite if configured
    sqlite: sqliteCapability,

    loop: {
      iteration: 0,
      phase: 'idle',
      startTime: new Date(),
      observations: [],
      actionResults: [],
    },

    capabilities: {
      observers: new Map(),
      orienters: new Map(),
      decisionStrategies: new Map(),
      actions: new Map(),
    },

    state: createStateStore({
      persistence: options.statePersistence,
      logger,
      sqlite: sqliteCapability,
    }),
    history: [],

    options,
  };

  const plugins: ZupPlugin[] = (options.plugins as ZupPlugin[]) || [];

  const { context: initializedContext, options: mergedOptions } = await initializePlugins(
    context,
    plugins
  );

  context = initializedContext;
  context.options = mergedOptions;
  let loopPromise: Promise<LoopResult> | null = null;

  return {
    getContext(): AgentContext {
      return context;
    },

    async runLoop(): Promise<LoopResult> {
      if (loopPromise) {
        return loopPromise;
      }

      loopPromise = runOODALoop(context, plugins)
        .finally(() => {
          loopPromise = null;
        });

      return loopPromise;
    },

    async executeAction(actionId: string, params: Record<string, unknown> = {}): Promise<LoopResult['actionResults'][number]> {
      return executeActionById(actionId, params, context, plugins);
    },

    async start() {
      const mode = context.options.mode || 'manual';

      if (mode === 'continuous') {
        const interval = context.options.loopInterval || 60000; // Default 60s

        context.logger.info(`Starting Zup in continuous mode (interval: ${interval}ms)`);

        // Run continuously
        const timer = setInterval(async () => {
          try {
            await this.runLoop();
          } catch (error) {
            context.logger.error('Error in OODA loop:', error);
          }
        }, interval);

        return () => clearInterval(timer);
      } else if (mode === 'event-driven') {
        context.logger.info('Starting Zup in event-driven mode');
      } else {
        context.logger.info('Zup ready in manual mode. Call runLoop() to execute.');
      }
    },

    getCapabilities() {
      return {
        observers: Array.from(context.capabilities.observers.keys()),
        orienters: Array.from(context.capabilities.orienters.keys()),
        decisionStrategies: Array.from(context.capabilities.decisionStrategies.keys()),
        actions: Array.from(context.capabilities.actions.keys()),
      };
    },

    getHistory(): LoopResult[] {
      return context.history;
    },

    getState() {
      return context.state;
    },

    startApi(options?: {
      port?: number;
      hostname?: string;
      apiKeys?: string[];
      allowUnauthenticated?: boolean;
    }): ApiServer {
      const apiConfig = {
        port: options?.port || context.options.api?.port || 3000,
        hostname: options?.hostname || context.options.api?.host || 'localhost',
        basePath: '/api/v0',
        apiKeys: options?.apiKeys || context.options.api?.auth?.apiKeys?.map(k => k.key) || [],
        allowUnauthenticated:
          options?.allowUnauthenticated ??
          context.options.api?.auth?.allowUnauthenticated ??
          false,
      };

      const server = createApiServer(context, apiConfig);
      registerCoreRoutes(server.route, this);
      registerRunRoutes(server.route, this);

      for (const plugin of plugins) {
        if (plugin.endpoints) {
          for (const [key, endpoint] of Object.entries(plugin.endpoints)) {
            const method = endpoint.method || 'GET';
            const path = endpoint.path;
            const auth = endpoint.auth ?? true; // Default to requiring auth

            server.route(method, path, endpoint.handler, auth);
          }
        }
      }

      return server;
    },
  };
}

export type ZupAgent = Awaited<ReturnType<typeof createAgent>>;
