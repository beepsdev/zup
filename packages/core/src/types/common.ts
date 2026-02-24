/**
 * Common types used across Zup
 */

export type Awaitable<T> = T | Promise<T>;

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type LoopPhase = 'observe' | 'orient' | 'decide' | 'act' | 'idle';

export type ObservationType = 'metric' | 'log' | 'alert' | 'event' | 'state';

export type ObservationSeverity = 'info' | 'warning' | 'error' | 'critical';

export type Priority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Logger interface compatible with console and most logging libraries
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
