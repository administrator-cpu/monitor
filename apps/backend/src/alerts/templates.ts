import type { IncidentView } from './rules';

export type EmailKind = 'opened' | 'reminder' | 'resolved' | 'test';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Header values must never contain line breaks. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

const TAG: Record<EmailKind, string> = {
  opened: '',
  reminder: 'STILL FIRING',
  resolved: 'RESOLVED',
  test: 'TEST',
};

/**
 * Operational facts only: what, where, since when, how bad. Never log lines, addresses or tokens.
 * Everything that came from outside (service names) is escaped in the HTML part.
 */
export function renderIncidentEmail(
  kind: Exclude<EmailKind, 'test'>,
  inc: IncidentView,
  o: { dashboardUrl: string | null; now: number },
): RenderedEmail {
  const sev = inc.severity.toUpperCase();
  const tag = TAG[kind] || sev;
  const where = inc.service_name ? ` (${inc.service_name})` : '';
  const subject = oneLine(`[${tag}] ${inc.rule_name}${where}`).slice(0, 200);
  const link = o.dashboardUrl ? `${o.dashboardUrl}/alerts?incident=${inc.id}` : null;

  const rows: [string, string][] = [
    ['Alert', inc.rule_name],
    ['Severity', inc.severity],
    ...(inc.service_name ? ([['Service', inc.service_name]] as [string, string][]) : []),
    ['Details', inc.summary],
    ['Started', iso(inc.opened_at)],
    kind === 'resolved' && inc.resolved_at !== null
      ? ['Resolved', `${iso(inc.resolved_at)} (after ${duration(inc.resolved_at - inc.opened_at)})`]
      : ['Firing for', duration(o.now - inc.opened_at)],
  ];
  if (inc.peak_value !== null && kind !== 'reminder') rows.push(['Peak value', String(Math.round(inc.peak_value * 100) / 100)]);

  const headline =
    kind === 'resolved' ? 'This alert has resolved.' : kind === 'reminder' ? 'This alert is still firing.' : 'A new alert is firing.';

  const text = [headline, '', ...rows.map(([k, v]) => `${k}: ${v}`), ...(link ? ['', `Open in the dashboard: ${link}`] : [])].join('\n');
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a">
<h2 style="margin:0 0 12px">${esc(headline)}</h2>
<table cellpadding="4" style="border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="color:#666;padding-right:16px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('\n')}
</table>
${link ? `<p><a href="${esc(link)}">Open in the dashboard</a></p>` : ''}
</body></html>`;
  return { subject, html, text };
}

export function renderTestEmail(o: { dashboardUrl: string | null; now: number }): RenderedEmail {
  const text = `This is a test email from the Command Center.\nSent: ${iso(o.now)}\n${o.dashboardUrl ? `Dashboard: ${o.dashboardUrl}\n` : ''}If you can read this, alert emails can reach you.`;
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif"><p>This is a test email from the Command Center.</p><p>Sent: ${esc(iso(o.now))}</p><p>If you can read this, alert emails can reach you.</p></body></html>`;
  return { subject: '[TEST] Command Center email check', html, text };
}
