import type { AlertRuleDto, IncidentDto, MuteDto, NotificationDto } from '@cc/shared';
import type { MuteRow, NotificationRow } from './repo';
import { RULE_META, parseOverrides, type IncidentView, type RuleRow } from './rules';

export function toRuleDto(r: RuleRow): AlertRuleDto {
  const meta = RULE_META[r.key];
  return {
    id: r.id,
    key: r.key,
    category: r.category,
    name: r.name,
    description: r.description,
    severity: r.severity,
    enabled: r.enabled === 1,
    threshold: r.threshold,
    durationS: r.duration_s,
    cooldownS: r.cooldown_s,
    overrides: parseOverrides(r.params),
    implemented: meta?.implemented ?? false,
    perService: meta?.perService ?? false,
    unit: meta?.unit ?? null,
    updatedAt: r.updated_at,
  };
}

export function toIncidentDto(i: IncidentView): IncidentDto {
  return {
    id: i.id,
    ruleId: i.rule_id,
    ruleKey: i.rule_key,
    ruleName: i.rule_name,
    category: i.category,
    severity: i.severity,
    serviceId: i.service_id,
    serviceName: i.service_name,
    fingerprint: i.fingerprint,
    state: i.state,
    openedAt: i.opened_at,
    resolvedAt: i.resolved_at,
    lastNotifiedAt: i.last_notified_at,
    notifyCount: i.notify_count,
    peakValue: i.peak_value,
    summary: i.summary,
    suppressedBy: i.suppressed_by,
  };
}

export function toNotificationDto(n: NotificationRow, includeAddress: boolean): NotificationDto {
  return {
    id: n.id,
    incidentId: n.incident_id,
    kind: n.kind,
    toEmail: includeAddress ? n.to_email : null,
    status: n.status,
    attempts: n.attempts,
    error: includeAddress ? n.error : null,
    ts: n.ts,
  };
}

export function toMuteDto(
  m: MuteRow,
  names: { service: (id: number) => string | null; rule: (id: number) => string | null },
  now: number,
): MuteDto {
  return {
    id: m.id,
    startsAt: m.starts_at,
    endsAt: m.ends_at,
    serviceId: m.service_id,
    serviceName: m.service_id === null ? null : names.service(m.service_id),
    category: m.category,
    ruleId: m.rule_id,
    ruleName: m.rule_id === null ? null : names.rule(m.rule_id),
    reason: m.reason,
    createdBy: m.created_by,
    createdAt: m.created_at,
    active: m.starts_at <= now && m.ends_at > now,
  };
}
