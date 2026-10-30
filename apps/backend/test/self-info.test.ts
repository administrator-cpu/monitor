import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MonitorHealthReporter } from '../src/monitor-health';
import { DeployShaReader, runsAs } from '../src/self-info';

const SHA = '9b4a79b0c1d2e3f405162738495a6b7c8d9e0f12';

describe('how the monitor was started (H9)', () => {
  it('reads PM2, the Windows service and a hand start from the environment', () => {
    expect(runsAs({ pm_id: '3', name: 'monitor-api' })).toEqual({ kind: 'pm2', name: 'monitor-api' });
    expect(runsAs({ CC_SERVICE_NAME: 'monitor-api' })).toEqual({ kind: 'service', name: 'monitor-api' });
    expect(runsAs({})).toEqual({ kind: 'direct', name: null });
    expect(runsAs({ pm_id: 'x', CC_SERVICE_NAME: ' ' })).toEqual({ kind: 'direct', name: null });
  });
});

describe('deployed commit from .deploy-sha', () => {
  let root: string;
  let backend: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deploysha-'));
    backend = path.join(root, 'apps', 'backend');
    fs.mkdirSync(backend, { recursive: true });
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds the file in the repository root above apps/backend', () => {
    fs.writeFileSync(path.join(root, '.deploy-sha'), `${SHA.toUpperCase()}\r\n`);
    expect(new DeployShaReader(backend).get()).toBe(SHA);
  });

  it('is null without the file, with a bad value, or without a repository root', () => {
    expect(new DeployShaReader(backend).get()).toBeNull();
    fs.writeFileSync(path.join(root, '.deploy-sha'), 'manual\n');
    expect(new DeployShaReader(backend).get()).toBeNull();
    const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lone-'));
    try {
      expect(new DeployShaReader(lone).get()).toBeNull();
    } finally {
      fs.rmSync(lone, { recursive: true, force: true });
    }
  });

  it('picks up a commit written after startup, at most 30 s later', () => {
    let t = 0;
    const r = new DeployShaReader(backend, () => t);
    expect(r.get()).toBeNull();
    fs.writeFileSync(path.join(root, '.deploy-sha'), SHA);
    t += 10_000;
    expect(r.get()).toBeNull();
    t += 25_000;
    expect(r.get()).toBe(SHA);
  });

  it('is part of the monitor health snapshot', () => {
    fs.writeFileSync(path.join(root, '.deploy-sha'), SHA);
    const h = new MonitorHealthReporter(':memory:', () => 0, new DeployShaReader(backend)).snapshot();
    expect(h.deployedSha).toBe(SHA);
    expect(h.runsAs.kind).toMatch(/^(pm2|service|direct)$/);
  });
});
