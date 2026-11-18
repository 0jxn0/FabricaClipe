// Processo principal: sobe o backend, serve o frontend por app://fabrica/ (sem servidor HTTP) e abre a janela endurecida.
import { app, BrowserWindow, net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startBackend, type Backend } from './bootstrap/backend.ts';
import { registerIpc } from './ipc/handlers.ts';
import { setupLifecycle } from './lifecycle/lifecycle.ts';
import { CaptureWorker } from '../backend/workers/capture/CaptureWorker.ts';
import { CuttingWorker } from '../backend/workers/cutting/CuttingWorker.ts';
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
    let rel: string; try { rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname); } catch { return new Response('bad request', { status: 400 }); }
    if (/[:*?"<>|]|[. ]$/.test(rel) || rel.includes('\0')) return new Response('bad request', { status: 400 }); // nomes que o Windows normaliza para outro arquivo
    const base = rel.startsWith('/vendor/three/') ? path.join(root, 'node_modules', 'three', 'build') : path.join(root, 'public');
    const file = path.resolve(base, '.' + (rel.startsWith('/vendor/three/') ? rel.slice('/vendor/three'.length) : rel));
    if (!isInside(base, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
    if (path.extname(file).toLowerCase() === '.html') {
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
  win.webContents.on('render-process-gone', () => { be.logger.error('renderer caiu; recarregando'); void win?.loadURL(`${APP_ORIGIN}/index.html`); });
  await win.loadURL(`${APP_ORIGIN}/index.html`);
}

let lifecycle: ReturnType<typeof setupLifecycle>;
app.whenReady().then(async () => {
  hardenSession(); serveApp();
  // Estações reais já implementadas. Legenda, Render e Publicação (Fases 4-5) ficam INDISPONÍVEIS até existirem — nada é simulado.
  be = startBackend(dataDir, [new CaptureWorker({ dataDir }), new CuttingWorker({ dataDir })]);
  lifecycle = setupLifecycle(be, () => win, () => { win?.show(); win?.focus(); });
  registerIpc(be, () => win, () => void lifecycle.shutdown(), () => lifecycle.isQuitting());
  await be.orchestrator.start();
  await createWindow();
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  if (SMOKE) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await win!.webContents.executeJavaScript(`({ api: typeof window.fabrica, node: typeof require + typeof process, csp: !!document.querySelector('canvas'), fab: typeof window.__fabrica, keys: Object.keys(window.fabrica||{}), diag: null })`);
    const diag = await win!.webContents.executeJavaScript('window.fabrica.system.diagnostics()');
    console.log('SMOKE ' + JSON.stringify({ ...r, db: diag.database.integrity, ffmpeg: diag.ffmpeg.ok, workers: diag.workers.map((w: any) => w.state) }));
    // Fluxo real ponta a ponta (só com --smoke e um vídeo informado pelo lançador, nunca pelo renderer)
    const vid = process.env.FABRICA_SMOKE_VIDEO;
    if (vid) {
      const job = be.orchestrator.createJob({ name: 'smoke', sourcePath: vid, config: { cut: { startSec: 1, durationSec: 2 } } });
      const t0 = Date.now(); while (be.orchestrator.job(job.id)!.stationId !== 'subtitles' && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));
      await new Promise((r) => setTimeout(r, 500));
      const j = be.orchestrator.job(job.id)!;
      const ui = await win!.webContents.executeJavaScript(`({ d1: window.__fabrica.events.snapshot('desk-1').status, d2: window.__fabrica.events.snapshot('desk-2').status, jobAt: (window.__fabrica.flow.job(${JSON.stringify(job.id)})||{}).at, size: ${be.orchestrator.history(job.id).length} })`);
      console.log('SMOKEJOB ' + JSON.stringify({ station: j.stationId, state: j.state, file: j.currentPath, bytes: fs.statSync(j.currentPath).size, steps: be.orchestrator.history(job.id).length, ui }));
    }
    await lifecycle.shutdown();
  }
}).catch((e) => { console.error('falha ao iniciar', e); app.exit(1); });
