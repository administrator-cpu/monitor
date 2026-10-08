'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import type { LoginInput, MeResponse } from '@cc/shared';
import { api, ApiError, NetworkError, setUnauthorizedHandler } from './api';

export type AuthState =
  | { status: 'loading' }
  | { status: 'anon' }
  | { status: 'error'; message: string }
  | { status: 'authed'; me: MeResponse };

interface AuthApi {
  state: AuthState;
  refresh(): Promise<void>;
  login(input: LoginInput): Promise<MeResponse>;
  logout(): Promise<void>;
  setMe(me: MeResponse): void;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const me = await api<MeResponse>('/auth/me', { skipUnauthorizedHandler: true });
      setState({ status: 'authed', me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState({ status: 'anon' });
      else if (e instanceof NetworkError) setState({ status: 'error', message: e.message });
      else
        setState({ status: 'error', message: e instanceof Error ? e.message : 'Unexpected error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any 401 from a data call means the session ended: go back to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anon' }));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const me = await api<MeResponse>('/auth/login', {
      method: 'POST',
      body: input,
      skipUnauthorizedHandler: true,
    });
    setState({ status: 'authed', me });
    return me;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', skipUnauthorizedHandler: true });
    } catch {
      // the cookie is cleared server-side when it can be reached; either way we leave
    }
    setState({ status: 'anon' });
    router.replace('/login');
  }, [router]);

  const setMe = useCallback((me: MeResponse) => setState({ status: 'authed', me }), []);

  const value = useMemo(
    () => ({ state, refresh, login, logout, setMe }),
    [state, refresh, login, logout, setMe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
