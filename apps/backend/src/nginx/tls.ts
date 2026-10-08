import tls from 'node:tls';

export interface CertInfo {
  notAfter: number;
  issuer: string | null;
}

/** `host` or `host:port` (port defaults to 443). */
export function splitHostPort(h: string): { host: string; port: number } {
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(h.trim());
  if (!m) throw new Error('invalid host');
  const port = m[2] ? Number(m[2]) : 443;
  if (port < 1 || port > 65535) throw new Error('invalid port');
  return { host: m[1] as string, port };
}

/**
 * Reads the certificate a host presents and returns its expiry. Only the handshake is performed
 * (SNI set to the host name); nothing is sent afterwards. Chain validity is deliberately not
 * judged here: the question is "when does this certificate expire", and an expired or self-signed
 * certificate must still be readable so that it can be reported.
 */
export function checkCert(hostPort: string, timeoutMs = 8_000, connectTo?: { host: string; port: number }): Promise<CertInfo> {
  const { host, port } = splitHostPort(hostPort);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: connectTo?.host ?? host,
      port: connectTo?.port ?? port,
      servername: host,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    const fail = (e: Error): void => {
      sock.destroy();
      reject(e);
    };
    sock.once('timeout', () => fail(new Error('TLS handshake timed out')));
    sock.once('error', (e) => fail(e));
    sock.once('secureConnect', () => {
      try {
        const c = sock.getPeerCertificate();
        sock.end();
        const t = c?.valid_to ? Date.parse(c.valid_to) : NaN;
        if (!c || Number.isNaN(t)) throw new Error('the host presented no readable certificate');
        const issuer = c.issuer?.O ?? c.issuer?.CN ?? null;
        resolve({ notAfter: t, issuer: typeof issuer === 'string' ? issuer.slice(0, 200) : null });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
