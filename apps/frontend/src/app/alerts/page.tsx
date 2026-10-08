'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { EmailStatus } from '@/components/alerts/EmailStatus';
import { IncidentsTab } from '@/components/alerts/IncidentsTab';
import { MutesTab } from '@/components/alerts/MutesTab';
import { RulesTab } from '@/components/alerts/RulesTab';
import { SubscriptionsTab } from '@/components/alerts/SubscriptionsTab';
import { PageHead, Shell } from '@/components/Shell';
import { useAuth } from '@/lib/auth';

const TABS = [
  ['incidents', 'Incidents'],
  ['rules', 'Rules'],
  ['mutes', 'Mutes'],
  ['mine', 'My emails'],
] as const;

function Alerts() {
  const auth = useAuth();
  const params = useSearchParams();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('incidents');
  const isAdmin = auth.state.status === 'authed' && auth.state.me.user.role === 'admin';
  const serviceParam = params.get('service');
  const incidentParam = params.get('incident');
  const serviceId = serviceParam && /^\d+$/.test(serviceParam) ? Number(serviceParam) : undefined;
  const focus = incidentParam && /^\d+$/.test(incidentParam) ? Number(incidentParam) : undefined;

  return (
    <>
      <PageHead title="Alerts" />
      <EmailStatus isAdmin={isAdmin} />
      <div className="tabs" role="tablist" aria-label="Alerts sections">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'incidents' && <IncidentsTab isAdmin={isAdmin} serviceId={serviceId} focus={focus} />}
      {tab === 'rules' && <RulesTab isAdmin={isAdmin} />}
      {tab === 'mutes' && <MutesTab isAdmin={isAdmin} />}
      {tab === 'mine' && <SubscriptionsTab />}
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Suspense fallback={<div className="muted">Loading…</div>}>
        <Alerts />
      </Suspense>
    </Shell>
  );
}
