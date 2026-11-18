import { createHash } from 'node:crypto';
import { session, type BrowserWindow } from 'electron';

export const APP_ORIGIN = 'app://fabrica';

/** CSP restrito: só recursos do próprio app; o importmap inline é liberado por hash, não por 'unsafe-inline' em scripts. */
export function csp(importmapHash?: string): string {
  return ["default-src 'none'", `script-src 'self'${importmapHash ? ` 'sha256-${importmapHash}'` : ''}`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
}
export const hashOf = (s: string) => createHash('sha256').update(s).digest('base64');

export function hardenSession() {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // nenhuma permissão (câmera, geolocalização...)
  s.setPermissionCheckHandler(() => false);
}

export function hardenWindow(win: BrowserWindow) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(APP_ORIGIN + '/')) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

export const fromApp = (url: string | undefined) => !!url && url.startsWith(APP_ORIGIN + '/');
