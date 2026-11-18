import { createHash } from 'node:crypto';

/** CSP restrito: só recursos do próprio app; o importmap inline é liberado por hash, não por 'unsafe-inline' em scripts. */
export function csp(importmapHash?: string): string {
  return ["default-src 'none'", `script-src 'self'${importmapHash ? ` 'sha256-${importmapHash}'` : ''}`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", 'media-src media:', "font-src 'self'", "connect-src 'self'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
}
export const hashOf = (s: string) => createHash('sha256').update(s).digest('base64');

