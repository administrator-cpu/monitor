import type { RangeLimitsResponse } from '@cc/shared';
import type { Settings } from './settings';

/**
 * The longest ranges the routes accept. Read from the settings on every request, so a changed
 * retention setting applies at once, and a range never asks for data the retention job has deleted.
 */
export function rangeLimits(settings: Settings): RangeLimitsResponse {
  return {
    historyMaxMs: settings.get('retention.metrics_days') * 86_400_000,
    logSearchMaxMs: Math.round(settings.get('logs.retention_hours') * 3_600_000),
  };
}
