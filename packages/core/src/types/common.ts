/**
 * Common types used across Zup
 */

export type Awaitable<T> = T | Promise<T>;

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type LoopPhase = 'observe' | 'orient' | 'decide' | 'act' | 'idle';

export type ObservationType = 'metric' | 'log' | 'alert' | 'event' | 'state';

export const SEVERITY_LEVELS = ['info', 'warning', 'error', 'critical'] as const;

export type ObservationSeverity = (typeof SEVERITY_LEVELS)[number];

/**
 * Returns true if `severity` meets or exceeds `threshold`.
 */
export function meetsThreshold(
  severity: string | undefined,
  threshold: ObservationSeverity
): boolean {
  if (!severity) return false;
  const sevIdx = SEVERITY_LEVELS.indexOf(severity as ObservationSeverity);
  const threshIdx = SEVERITY_LEVELS.indexOf(threshold);
  return sevIdx >= threshIdx;
}

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
