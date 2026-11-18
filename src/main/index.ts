// Processo principal: sobe o backend, serve o frontend por app://fabrica/ (sem servidor HTTP) e abre a janela endurecida.
import { app, BrowserWindow, net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startBackend, type Backend } from './bootstrap/backend.ts';
import { registerIpc } from './ipc/handlers.ts';
import { setupLifecycle } from './lifecycle/lifecycle.ts';
import { APP_ORIGIN, csp, hardenSession, hardenWindow, hashOf } from './security/security.ts';
import { isInside } from '../backend/infrastructure/filesystem/safePaths.ts';

const SMOKE = process.argv.includes('--smoke');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.exit(0);

let win: BrowserWindow | null = null, be: Backend;
const root = app.getAppPath();
const dataDir = process.env.FABRICA_DATA_DIR || path.join(app.getPath('documents'), 'FabricaDeClipe');
// dados do Chromium (cache, cookies) junto aos dados da fábrica, não no perfil do Windows
if (process.env.FABRICA_DATA_DIR) { app.setPath('userData', path.join(dataDir, 'electron')); app.setPath('sessionData', path.join(dataDir, 'electron', 'session')); }
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveApp() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url); if (u.host !== 'fabrica') return new Response('forbidden', { status: 403 });
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const base = rel.startsWith('/vendor/three/') ? path.join(root, 'node_modules', 'three', 'build') : path.join(root, 'public');
    const file = path.resolve(base, '.' + (rel.startsWith('/vendor/three/') ? rel.slice('/vendor/three'.length) : rel));
    if (!isInside(base, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' };
    if (file.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8'), m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
      headers['content-security-policy'] = csp(m ? hashOf(m[1]!) : undefined);
      return new Response(html, { headers });
    }
    return net.fetch(pathToFileURL(file).toString()).then((r) => new Response(r.body, { status: r.status, headers }));
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 360, minHeight: 560, show: false, backgroundColor: '#0a0d14', title: 'Fábrica de Clipe',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'), devTools: !app.isPackaged },
  });
  hardenWindow(win);
  win.once('ready-to-show', () => { if (!SMOKE) win?.show(); });
  win.on('close', (e) => lifecycle.onClose(e));
  await win.loadURL(`${APP_ORIGIN}/index.html`);
}

let lifecycle: ReturnType<typeof setupLifecycle>;
app.whenReady().then(async () => {
  hardenSession(); serveApp();
  be = startBackend(dataDir); // Fase 3+ registra os workers reais aqui
  lifecycle = setupLifecycle(be, () => win, () => { win?.show(); win?.focus(); });
  registerIpc(be, () => win, () => void lifecycle.shutdown());
  await be.orchestrator.start();
  await createWindow();
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  if (SMOKE) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await win!.webContents.executeJavaScript(`({ api: typeof window.fabrica, node: typeof require + typeof process, csp: !!document.querySelector('canvas'), fab: typeof window.__fabrica, keys: Object.keys(window.fabrica||{}), diag: null })`);
    const diag = await win!.webContents.executeJavaScript('window.fabrica.system.diagnostics()');
    console.log('SMOKE ' + JSON.stringify({ ...r, db: diag.database.integrity, workers: diag.workers.map((w: any) => w.state) }));
    await lifecycle.shutdown();
  }
}).catch((e) => { console.error('falha ao iniciar', e); app.exit(1); });
