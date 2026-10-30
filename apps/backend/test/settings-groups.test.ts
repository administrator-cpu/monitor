import { describe, expect, it } from 'vitest';
import {
  HIDDEN_SETTING_PREFIXES,
  OTHER_SETTINGS_TITLE,
  SETTING_GROUPS,
  groupSettings,
  type SettingEntry,
} from '@cc/shared';
import { SETTING_DEFS } from '../src/settings';

const entry = (key: string, type: SettingEntry['type'] = 'number') => ({ key, type });

describe('Settings page groups', () => {
  it('puts every server setting in a named section or in the hidden list', () => {
    const keys = Object.keys(SETTING_DEFS);
    const groups = groupSettings(keys.map((k) => entry(k)));
    const shown = groups.flatMap((g) => g.rows.map((r) => r.key));
    const hidden = keys.filter((k) => HIDDEN_SETTING_PREFIXES.some((p) => k.startsWith(p)));

    // A new setting needs a prefix in SETTING_GROUPS (or, if nothing reads it yet, in the hidden list).
    expect(groups.map((g) => g.title)).not.toContain(OTHER_SETTINGS_TITLE);
    expect([...shown, ...hidden].sort()).toEqual([...keys].sort());
  });

  it('shows the GitHub poll interval and the stop mute length', () => {
    const groups = groupSettings(Object.keys(SETTING_DEFS).map((k) => entry(k)));
    const titleOf = (key: string) => groups.find((g) => g.rows.some((r) => r.key === key))?.title;
    expect(titleOf('github.poll_minutes')).toBe('GitHub');
    expect(titleOf('actions.stop_mute_minutes')).toBe('Dashboard actions');
    expect(titleOf('agent.max_tenants_per_report')).toBeUndefined();
    expect(titleOf('mongo.slow_ms')).toBeUndefined();
  });

  it('shows an unknown key under Other instead of dropping it, and leaves out list settings', () => {
    const groups = groupSettings([
      entry('login.max_failures'),
      entry('future.thing'),
      entry('logs.exclude', 'list'),
    ]);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.key)])).toEqual([
      ['Sign-in protection', ['login.max_failures']],
      [OTHER_SETTINGS_TITLE, ['future.thing']],
    ]);
  });

  it('keeps the section prefixes distinct', () => {
    const prefixes = [...SETTING_GROUPS.map(([p]) => p), ...HIDDEN_SETTING_PREFIXES];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(p.endsWith('.')).toBe(true);
  });
});
