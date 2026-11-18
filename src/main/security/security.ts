import { session, type BrowserWindow } from 'electron';

export const APP_ORIGIN = 'app://fabrica';

export { csp, hashOf } from './csp.ts';

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
  const block = (e: Electron.Event, url: string) => { if (!url.startsWith(APP_ORIGIN + '/')) e.preventDefault(); };
  wc.on('will-redirect', block);
  // iframes e navegações de subframe (detalhes no 1º argumento nas versões novas do Electron)
  (wc as unknown as { on(n: string, f: (d: { url?: string; preventDefault(): void }) => void): void }).on('will-frame-navigate', (d) => { if (!String(d.url ?? '').startsWith(APP_ORIGIN + '/')) d.preventDefault(); });
}

export const fromApp = (url: string | undefined) => !!url && url.startsWith(APP_ORIGIN + '/');
