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
import { SubtitlesWorker } from '../backend/workers/subtitles/SubtitlesWorker.ts';
import { RenderWorker } from '../backend/workers/rendering/RenderWorker.ts';
import { APP_ORIGIN, csp, hardenSession, hardenWindow, hashOf } from './security/security.ts';
import { isInside } from '../backend/infrastructure/filesystem/safePaths.ts';
import { Readable } from 'node:stream';
import { jobIdFromUrl, parseRange, resolveJobMedia } from './media/media.ts';

const SMOKE = !app.isPackaged && process.argv.includes('--smoke'); // teste automático nunca roda no app instalado
const smokeOut = (s: string) => { console.log(s); if (process.env.FABRICA_SMOKE_LOG) fs.appendFileSync(process.env.FABRICA_SMOKE_LOG, s + String.fromCharCode(10)); }; // stdout redirecionado só descarrega ao sair
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }, // preview do vídeo a aprovar
]);


let win: BrowserWindow | null = null, be: Backend;
const root = app.getAppPath();
const dataDir = process.env.FABRICA_DATA_DIR || path.join(app.getPath('documents'), 'FabricaDeClipe');
// dados do Chromium (cache, cookies) junto aos dados da fábrica, não no perfil do Windows
if (process.env.FABRICA_DATA_DIR) { app.setPath('userData', path.join(dataDir, 'electron')); app.setPath('sessionData', path.join(dataDir, 'electron', 'session')); }
// a trava de instância única vale por perfil de dados (instâncias com FABRICA_DATA_DIR diferentes não se bloqueiam)
if (!app.requestSingleInstanceLock()) app.exit(0);
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

/** media://job/<jobId>: só o vídeo (registrado no banco) de um job aguardando aprovação; suporta Range para o <video> buscar trechos. */
function mediaResponse(req: Request): Response {
  try {
    const { file, size, mime } = resolveJobMedia(be.db, dataDir, jobIdFromUrl(req.url));
    const base = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const range = parseRange(req.headers.get('range'), size);
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (size === 0) return new Response(null, { status: 200, headers: { ...base, 'content-length': '0' } });
    const rs = fs.createReadStream(file, { start, end });
    req.signal.addEventListener('abort', () => rs.destroy(), { once: true }); // seek/fechar do <video> não deixa descritor aberto
    const body = Readable.toWeb(rs) as unknown as ReadableStream;
    return new Response(body, { status: range ? 206 : 200, headers: { ...base, 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) } });
  } catch (e) { be.logger.warn(`media recusado: ${(e as Error).message}`); return new Response('forbidden', { status: 403 }); }
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
  let reloads = 0;
  win.webContents.on('render-process-gone', () => { be.logger.error('renderer caiu'); if (++reloads <= 3) void win?.loadURL(`${APP_ORIGIN}/index.html`); });
  await win.loadURL(`${APP_ORIGIN}/index.html`);
}

let lifecycle: ReturnType<typeof setupLifecycle>;
app.whenReady().then(async () => {
  hardenSession(); serveApp(); protocol.handle('media', (req) => mediaResponse(req));
  // Estações reais já implementadas. Legenda, Render e Publicação (Fases 4-5) ficam INDISPONÍVEIS até existirem — nada é simulado.
  be = startBackend(dataDir, [new CaptureWorker({ dataDir }), new CuttingWorker({ dataDir }), new SubtitlesWorker({ dataDir }), new RenderWorker({ dataDir })]);
  lifecycle = setupLifecycle(be, () => win, () => { win?.show(); win?.focus(); });
  registerIpc(be, () => win, () => void lifecycle.shutdown(), () => lifecycle.isQuitting());
  await be.orchestrator.start();
  await createWindow();
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  if (SMOKE) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await win!.webContents.executeJavaScript(`({ api: typeof window.fabrica, node: typeof require + typeof process, csp: !!document.querySelector('canvas'), fab: typeof window.__fabrica, keys: Object.keys(window.fabrica||{}), diag: null })`);
    const diag = await win!.webContents.executeJavaScript('window.fabrica.system.diagnostics()');
    smokeOut('SMOKE ' + JSON.stringify({ ...r, db: diag.database.integrity, ffmpeg: diag.ffmpeg.ok, workers: diag.workers.map((w: any) => w.state) }));
    // Handler media://: serve só o vídeo registrado de job em aprovação; recusa traversal, arquivo fora do banco e job fora do estado
    {
      const now = new Date().toISOString(), good = path.join(dataDir, 'projects', 'smoke-media.mp4'), outside = path.join(dataDir, 'smoke-fora.mp4');
      fs.writeFileSync(good, Buffer.alloc(100, 1)); fs.writeFileSync(outside, Buffer.alloc(10, 2));
      const add = (id: string, state: string, file: string, reg: boolean) => {
        be.db.run("INSERT INTO jobs (id, name, project_id, source_path, current_path, station_id, state, config_json, created_at, updated_at) VALUES (?, 'smoke', 'default', ?, ?, 'approval', ?, '{}', ?, ?)", id, file, file, state, now, now);
        if (reg) be.db.run("INSERT INTO media_files (job_id, station_id, kind, path, created_at) VALUES (?, 'rendering', 'output', ?, ?)", id, file, now);
      };
      add('smoke-m1', 'awaiting_approval', good, true); add('smoke-m2', 'awaiting_approval', outside, true); add('smoke-m3', 'awaiting_approval', good, false); add('smoke-m4', 'processing', good, true);
      const get = (u: string, range?: string) => mediaResponse(new Request(u, range ? { headers: { range } } : undefined));
      const [full, part, bad416, trav, out, unreg, state] = [get('media://job/smoke-m1'), get('media://job/smoke-m1', 'bytes=10-19'), get('media://job/smoke-m1', 'bytes=500-'),
        get('media://job/..%2f..%2fsmoke-fora'), get('media://job/smoke-m2'), get('media://job/smoke-m3'), get('media://job/smoke-m4')];
      const apiUrl = await win!.webContents.executeJavaScript("window.fabrica.media.url('smoke-m1')");
      const apiBad = await win!.webContents.executeJavaScript("window.fabrica.media.url('smoke-m2').then(() => 'ABRIU', (e) => 'recusou')");
      const ui = await win!.webContents.executeJavaScript("({ imp: !document.getElementById('btn-import').hidden, apv: !document.getElementById('apv-open').hidden })");
      for (const r of [full, part]) void r.body?.cancel();
      smokeOut('SMOKEMEDIA ' + JSON.stringify({ full: full.status, part: [part.status, part.headers.get('content-range')], r416: bad416.status, trav: trav.status, outside: out.status, unregistered: unreg.status, wrongState: state.status, apiUrl: String(apiUrl).split('?')[0], apiBad, ui }));
      be.db.run("DELETE FROM media_files WHERE job_id LIKE 'smoke-m%'"); be.db.run("DELETE FROM jobs WHERE id LIKE 'smoke-m%'");
      fs.rmSync(good, { force: true }); fs.rmSync(outside, { force: true });
    }
    // Fluxo real ponta a ponta (só com --smoke e um vídeo informado pelo lançador, nunca pelo renderer)
    // Captura de tela da janela (só com --smoke e FABRICA_SMOKE_SHOT): útil para ver o painel de Integrações renderizado
    if (process.env.FABRICA_SMOKE_SHOT) {
      win!.setSize(1280, 820); win!.showInactive(); await new Promise((r) => setTimeout(r, 2500));
      await win!.webContents.executeJavaScript("document.getElementById('integ-open').click()"); await new Promise((r) => setTimeout(r, 1500));
      fs.writeFileSync(process.env.FABRICA_SMOKE_SHOT, (await win!.webContents.capturePage()).toPNG());
      await win!.webContents.executeJavaScript("document.getElementById('integ-dlg').scrollTop = 600"); await new Promise((r) => setTimeout(r, 500));
      fs.writeFileSync(process.env.FABRICA_SMOKE_SHOT.replace('.png', '-2.png'), (await win!.webContents.capturePage()).toPNG());
    }
    const vid = process.env.FABRICA_SMOKE_VIDEO;
    if (vid) {
      const wait = async (f: () => boolean, ms: number) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 200)); };
      const job = be.orchestrator.createJob({ name: 'smoke', sourcePath: vid, platforms: ['youtube'], config: { cut: { startSec: 1, durationSec: 2 }, subtitleLang: 'pt', subtitles: 'off', render: { width: 540, height: 960, fps: 30, codec: 'h264', bitrateKbps: 2000, format: 'mp4', audioBitrateKbps: 128 } } });
      await wait(() => be.orchestrator.job(job.id)!.state === 'awaiting_approval', 120000);
      const atApproval = be.orchestrator.job(job.id)!;
      const approvalFile = atApproval.currentPath;
      be.orchestrator.decide({ jobId: job.id, decision: 'approve', user: 'smoke', note: 'ok' });
      await wait(() => be.orchestrator.job(job.id)!.stationId === 'publishing', 20000);
      await new Promise((r) => setTimeout(r, 800));
      const j = be.orchestrator.job(job.id)!;
      const ui = await win!.webContents.executeJavaScript(`({ d5: window.__fabrica.events.snapshot('desk-5').status, d6: window.__fabrica.events.snapshot('desk-6').status, jobAt: (window.__fabrica.flow.job(${JSON.stringify(job.id)})||{}).at })`);
      smokeOut('SMOKEJOB ' + JSON.stringify({ atApproval: atApproval.state, approvalFile: path.basename(approvalFile), bytes: fs.statSync(approvalFile).size, station: j.stationId, state: j.state, steps: be.orchestrator.history(job.id).length, transfers: be.db.all('SELECT from_station, to_station, state FROM transfers WHERE job_id = ?', job.id).length, ui }));
    }
    await lifecycle.shutdown();
  }
}).catch((e) => { console.error('falha ao iniciar', e); smokeOut('SMOKEERR ' + String((e as Error)?.stack ?? e).slice(0, 600)); app.exit(1); });
