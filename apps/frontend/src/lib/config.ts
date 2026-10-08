/** Public API origin (not secret). Set `NEXT_PUBLIC_API_BASE` at build time. */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
export const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/api/v1/ws`;
