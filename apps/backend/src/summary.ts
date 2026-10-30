import type { OverviewSummary, Severity } from '@cc/shared';
import type { AppContext } from './context';
import { toIncidentDto } from './alerts/dto';
import { toCertDto } from './routes/nginx';

const DAY_MS = 86_400_000;
const NEWEST_ALERTS = 5;

/**
 * The slower-changing parts of the Overview (alerts by severity, last backup, nearest certificate,
 * GitHub, email) in one answer, so the page needs a single request every 30 s.
 */
export function buildOverviewSummary(ctx: AppContext): OverviewSummary {
  const now = ctx.now();

  // --- alerts: firing incidents by severity, newest first -------------------------------------
  const firing = ctx.alertRepo.firing().sort((a, b) => b.opened_at - a.opened_at || b.id - a.id);
  const count: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const i of firing) count[i.severity] += 1;

  // --- backup: the job's last result (H7) -----------------------------------------------------
  const run = ctx.db
    .prepare("SELECT last_run_at, last_status, last_detail FROM maintenance_runs WHERE job = 'backup'")
    .get() as { last_run_at: number; last_status: string; last_detail: string | null } | undefined;
  let detail: { file?: unknown; bytes?: unknown; error?: unknown } = {};
  try {
    detail = run?.last_detail ? (JSON.parse(run.last_detail) as typeof detail) : {};
  } catch {
    detail = {};
  }

  // --- TLS: the certificate that expires first ------------------------------------------------
  const certs = ctx.state.getTlsCerts().map((r) => toCertDto(r, now));
  const dated = certs.filter((c): c is typeof c & { notAfter: number; daysLeft: number } => c.notAfter !== null && c.daysLeft !== null);
  dated.sort((a, b) => a.notAfter - b.notAfter);
  const soonest = dated[0];

  // --- GitHub: mapped services, in sync, behind, failing ---------------------------------------
  const mapped = ctx.services.list().filter((r) => r.git_repo);
  let inSync = 0;
  let problems = 0;
  const behind: OverviewSummary['github']['behind'] = [];
  for (const r of mapped) {
    const b = ctx.git.badge(r.id);
    if (!b || b.state !== 'ok') problems += 1;
    else if (b.sync === 'in_sync') inSync += 1;
    if (b && b.behindBy > 0) behind.push({ serviceId: r.id, name: r.name, behindBy: b.behindBy });
  }
  behind.sort((a, b) => b.behindBy - a.behindBy || a.name.localeCompare(b.name));

  // --- email: Resend events in the last 24 hours, all sender domains ---------------------------
  const since = now - DAY_MS;
  const email = { sent: 0, delivered: 0, delayed: 0, bounced: 0, complained: 0, failed: 0 };
  for (const row of ctx.email.summary(since)) {
    email.sent += row.sent;
    email.delivered += row.delivered;
    email.delayed += row.delayed;
    email.bounced += row.bounced;
    email.complained += row.complained;
    email.failed += row.failed;
  }

  return {
    generatedAt: now,
    alerts: { ...count, newest: firing.slice(0, NEWEST_ALERTS).map(toIncidentDto) },
    backup: {
      enabled: ctx.config.backupDir !== null,
      lastRunAt: run?.last_run_at ?? null,
      status: run?.last_status === 'ok' || run?.last_status === 'error' ? run.last_status : null,
      file: typeof detail.file === 'string' ? detail.file : null,
      bytes: typeof detail.bytes === 'number' ? detail.bytes : null,
      error: typeof detail.error === 'string' ? detail.error : null,
    },
    tls: {
      hosts: certs.length,
      errors: certs.filter((c) => c.lastError !== null).length,
      soonest: soonest ? { host: soonest.host, notAfter: soonest.notAfter, daysLeft: soonest.daysLeft } : null,
    },
    github: { tokenSet: ctx.git.tokenSet, mapped: mapped.length, inSync, behind, problems },
    email: {
      since,
      webhookConfigured: Boolean(ctx.config.resendWebhookSecret),
      ...email,
      lastEventAt: ctx.email.lastReceivedAt(),
    },
  };
}
