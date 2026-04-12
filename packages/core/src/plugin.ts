import { defu } from 'defu';
import type {
  ZupPlugin,
  AgentContext,
  AgentOptions,
  Observer,
  Orienter,
  DecisionStrategy,
  Action,
} from './types/index';
import type { Playbook } from './playbook/types';

export async function initializePlugins(
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<{ context: AgentContext; options: AgentOptions }> {
  let context = ctx;
  let options = ctx.options;

  for (const plugin of plugins) {
    if (plugin.init) {
      const result = await plugin.init(context);

      if (result) {
        if (result.options) {
          options = defu(options, result.options);
        }

        if (result.context) {
          context = {
            ...context,
            ...result.context,
          };
        }
      }
    }

    registerPluginCapabilities(context, plugin);
  }

  context.options = options;

  // Collect playbooks bundled with plugins
  const pluginPlaybooks = collectPluginPlaybooks(plugins);
  if (pluginPlaybooks.length > 0) {
    const existing = (context.playbooks as Playbook[] | undefined) || [];
    context.playbooks = [...existing, ...pluginPlaybooks];
  }

  return { context, options };
}

function registerPluginCapabilities(ctx: AgentContext, plugin: ZupPlugin): void {
  if (plugin.observers) {
    for (const [key, observer] of Object.entries(plugin.observers)) {
      const observerId = `${plugin.id}:${key}`;
      ctx.capabilities.observers.set(observerId, observer);
    }
  }

  if (plugin.orienters) {
    for (const [key, orienter] of Object.entries(plugin.orienters)) {
      const orienterId = `${plugin.id}:${key}`;
      ctx.capabilities.orienters.set(orienterId, orienter);
    }
  }

  if (plugin.decisionStrategies) {
    for (const [key, strategy] of Object.entries(plugin.decisionStrategies)) {
      const strategyId = `${plugin.id}:${key}`;
      ctx.capabilities.decisionStrategies.set(strategyId, strategy);
    }
  }

  if (plugin.actions) {
    for (const [key, action] of Object.entries(plugin.actions)) {
      const actionId = `${plugin.id}:${key}`;
      ctx.capabilities.actions.set(actionId, action);
    }
  }
}

export async function executePluginHooks<T extends keyof ZupPlugin>(
  plugins: ZupPlugin[],
  hookName: T,
  ...args: unknown[]
): Promise<unknown[]> {
  const results: unknown[] = [];
  const ctx = args.find(arg => arg && typeof arg === 'object' && 'logger' in arg) as { logger: import('./types/common').Logger } | undefined;
  const logger = ctx?.logger || console;

  for (const plugin of plugins) {
    const hook = plugin[hookName];
    if (typeof hook === 'function') {
      try {
        const result = await (hook as (...args: unknown[]) => Promise<unknown>)(...args);
        if (result !== undefined) {
          results.push(result);
        }
      } catch (error) {
        logger.error(`Error in plugin ${plugin.id} hook ${String(hookName)}:`, error);
      }
    }
  }

  return results;
}

function collectPluginPlaybooks(plugins: ZupPlugin[]): Playbook[] {
  const playbooks: Playbook[] = [];
  for (const plugin of plugins) {
    if (plugin.playbooks) {
      for (const playbook of plugin.playbooks) {
        playbooks.push({
          ...playbook,
          source: 'plugin',
          pluginId: plugin.id,
        });
      }
    }
  }
  return playbooks;
}

export function definePlugin(plugin: ZupPlugin): ZupPlugin {
  return plugin;
}

export function createObserver(observer: Observer): Observer {
  return observer;
}

export function createOrienter(orienter: Orienter): Orienter {
  return orienter;
}

export function createDecisionStrategy(strategy: DecisionStrategy): DecisionStrategy {
  return strategy;
}

export function createAction(action: Action): Action {
  return action;
}

export function createEndpoint(endpoint: import('./types/plugin').Endpoint): import('./types/plugin').Endpoint {
  return endpoint;
}
