'use client';

import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { AuthProvider } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ revalidateOnFocus: false, shouldRetryOnError: false }}>
      <AuthProvider>
        <LiveProvider>{children}</LiveProvider>
      </AuthProvider>
    </SWRConfig>
  );
}
