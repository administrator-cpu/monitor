'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { AlertRuleDto } from '@cc/shared';
import { api, errorMessage, fetcher } from '@/lib/api';

const GIB = 1024 ** 3;
const CATEGORIES = ['host', 'pm2', 'nginx', 'mongo', 'app', 'monitor'] as const;
const CATEGORY_LABEL: Record<string, string> = {
  host: 'Host', pm2: 'Services (PM2)', nginx: 'Nginx', mongo: 'MongoDB', app: 'Applications', monitor: 'The monitor itself',
};

const toUi = (r: AlertRuleDto, v: number | null): string =>
  v === null ? '' : String(r.unit === 'bytes' ? Math.round((v / GIB) * 100) / 100 : v);
const fromUi = (r: AlertRuleDto, s: string): number => (r.unit === 'bytes' ? Number(s) * GIB : Number(s));
const unitLabel = (r: AlertRuleDto): string => (r.unit === 'bytes' ? 'GiB' : (r.unit ?? ''));

function overridesText(r: AlertRuleDto): string {
  return Object.entries(r.overrides).map(([k, v]) => `${k} = ${toUi(r, v)}`).join('\n');
}
function parseOverrides(r: AlertRuleDto, text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(.+?)\s*=\s*([0-9.]+)$/.exec(t);
    if (!m) throw new Error(`Cannot read "${t}". Use: service-name = value`);
    const n = fromUi(r, m[2] as string);
    if (!(n > 0)) throw new Error(`"${t}" must be above zero.`);
    out[(m[1] as string).trim()] = n;
  }
  return out;
}

function RuleEditor({ r, onSaved }: { r: AlertRuleDto; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(r.enabled);
  const [threshold, setThreshold] = useState(toUi(r, r.threshold));
  const [duration, setDuration] = useState(String(r.durationS));
  const [cooldown, setCooldown] = useState(String(r.cooldownS));
  const [ov, setOv] = useState(overridesText(r));
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      const body: Record<string, unknown> = { enabled, durationS: Number(duration), cooldownS: Number(cooldown) };
      if (r.threshold !== null) body.threshold = fromUi(r, threshold);
      if (r.perService) body.overrides = parseOverrides(r, ov);
      await api(`/alerts/rules/${r.id}`, { method: 'PATCH', body });
      setOk(true);
      onSaved();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} style={{ padding: '8px 0' }}>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <label style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 'auto' }} /> Enabled
        </label>
        {r.threshold !== null && (
          <div>
            <label htmlFor={`t-${r.id}`}>Threshold {unitLabel(r) && `(${unitLabel(r)})`}</label>
            <input id={`t-${r.id}`} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ width: 130 }} />
          </div>
        )}
        <div>
          <label htmlFor={`d-${r.id}`}>Must last (seconds)</label>
          <input id={`d-${r.id}`} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} style={{ width: 120 }} />
        </div>
        <div>
          <label htmlFor={`c-${r.id}`}>Repeat every (seconds, 0 = global)</label>
          <input id={`c-${r.id}`} inputMode="numeric" value={cooldown} onChange={(e) => setCooldown(e.target.value)} style={{ width: 150 }} />
        </div>
      </div>
      {r.perService && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor={`o-${r.id}`}>Per-service limits, one per line: <code>pm2-name = value</code> {unitLabel(r) && `(${unitLabel(r)})`}</label>
          <textarea id={`o-${r.id}`} rows={3} value={ov} onChange={(e) => setOv(e.target.value)} />
        </div>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row">
        <button className="btn primary small" disabled={busy}>Save</button>
        {ok && <span className="notice" role="status" style={{ margin: 0 }}>Saved.</span>}
      </div>
    </form>
  );
}

export function RulesTab({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, mutate } = useSWR<{ rules: AlertRuleDto[] }>('/alerts/rules', fetcher);
  if (error) return <div className="banner crit" role="alert">Could not load rules: {error.message}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  return (
    <>
      {CATEGORIES.map((cat) => {
        const rules = data.rules.filter((r) => r.category === cat);
        if (rules.length === 0) return null;
        return (
          <section className="card" key={cat} style={{ marginBottom: 14 }} aria-label={CATEGORY_LABEL[cat]}>
            <h2>{CATEGORY_LABEL[cat]}</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Rule</th><th>Severity</th><th>Threshold</th><th>Must last</th><th>State</th></tr></thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} data-testid={`rule-${r.key}`} style={r.implemented ? undefined : { opacity: 0.6 }}>
                      <td>
                        {r.name}
                        <div className="muted" style={{ fontSize: '0.8rem' }}>{r.description}</div>
                        {isAdmin && r.implemented && (
                          <details>
                            <summary>edit</summary>
                            <RuleEditor r={r} onSaved={() => void mutate()} />
                          </details>
                        )}
                      </td>
                      <td><span className={`tag ${r.severity === 'critical' ? 'crit' : r.severity === 'warning' ? 'warn' : ''}`}>{r.severity}</span></td>
                      <td className="num">{r.threshold === null ? '—' : `${toUi(r, r.threshold)} ${unitLabel(r)}`}
                        {Object.keys(r.overrides).length > 0 && <div className="muted">{Object.keys(r.overrides).length} override(s)</div>}
                      </td>
                      <td className="num">{r.durationS}s</td>
                      <td>
                        {!r.implemented ? <span className="tag">later phase</span> : r.enabled ? <span className="tag ok">on</span> : <span className="tag warn">off</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
