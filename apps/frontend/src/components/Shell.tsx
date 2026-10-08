'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useLive } from '@/lib/live';
import { ConnectionBadge } from './ConnectionBadge';

interface NavItem {
  href: string;
  label: string;
  admin?: boolean;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/host', label: 'Host' },
  { href: '/services', label: 'Services' },
  { href: '/nginx', label: 'Nginx' },
  { href: '/mongo', label: 'MongoDB' },
  { href: '/logs', label: 'Log search' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/admin/users', label: 'Users', admin: true },
  { href: '/admin/settings', label: 'Settings', admin: true },
  { href: '/admin/audit', label: 'Audit log', admin: true },
];

interface Props {
  children: ReactNode;
  adminOnly?: boolean;
  /** Screens such as the forced password change hide the navigation. */
  bare?: boolean;
}

/** Session gate + navigation. Contains no data: the shell is static until `/auth/me` answers. */
export function Shell({ children, adminOnly = false, bare = false }: Props) {
  const auth = useAuth();
  const router = useRouter();
  const path = usePathname();
  const st = auth.state;
  const { live } = useLive();
  const firing = live?.openIncidents ?? 0;

  useEffect(() => {
    if (st.status === 'anon') router.replace('/login');
    else if (st.status === 'authed') {
      if (st.me.mustChangePassword && path !== '/change-password')
        router.replace('/change-password');
      else if (adminOnly && st.me.user.role !== 'admin') router.replace('/');
    }
  }, [st, path, adminOnly, router]);

  if (st.status === 'loading') {
    return (
      <div className="center-screen" role="status" aria-live="polite">
        <span className="muted">Loading…</span>
      </div>
    );
  }
  if (st.status === 'error') {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          <h1>Cannot reach the monitor</h1>
          <p className="muted">{st.message} Check your connection or whether the VPS is up.</p>
          <button className="btn primary" onClick={() => void auth.refresh()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (st.status === 'anon') return null;
  if (adminOnly && st.me.user.role !== 'admin') return null;

  const me = st.me;
  const items = NAV.filter((n) => !n.admin || me.user.role === 'admin');
  const current = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  if (bare) return <main className="main">{children}</main>;

  return (
    <div className="shell">
      <aside className="rail" aria-label="Primary">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Command Center
        </div>
        <nav className="nav">
          {items
            .filter((n) => !n.admin)
            .map((n) => (
              <Link key={n.href} href={n.href} aria-current={current(n.href) ? 'page' : undefined}>
                {n.label}
                {n.href === '/alerts' && firing > 0 && (
                  <span className="nav-badge" data-testid="alerts-badge">{firing}</span>
                )}
              </Link>
            ))}
          {items.some((n) => n.admin) && <div className="group">Admin</div>}
          {items
            .filter((n) => n.admin)
            .map((n) => (
              <Link key={n.href} href={n.href} aria-current={current(n.href) ? 'page' : undefined}>
                {n.label}
              </Link>
            ))}
        </nav>
        <div className="rail-foot">
          <div>
            <strong>{me.user.displayName}</strong>
            <div className="muted">{me.user.role}</div>
          </div>
          <Link href="/change-password" className="muted">
            Change password
          </Link>
          <button className="btn small" onClick={() => void auth.logout()}>
            Sign out
          </button>
        </div>
      </aside>

      <div>
        <div className="mobile-top">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Command Center
          </div>
          <div className="row">
            <Link href="/change-password" className="btn small">
              Account
            </Link>
            <button className="btn small" onClick={() => void auth.logout()}>
              Sign out
            </button>
          </div>
        </div>
        <main className="main">{children}</main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {items.map((n) => (
          <Link key={n.href} href={n.href} aria-current={current(n.href) ? 'page' : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      <div className="row">
        {children}
        <ConnectionBadge />
      </div>
    </div>
  );
}
