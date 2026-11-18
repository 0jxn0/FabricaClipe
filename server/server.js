// Ponte backend -> navegador. Serve /public, aceita POST /event (pipeline Python) e repassa por WebSocket em /ws.
//   node server/server.js            # só ponte
//   node server/server.js --demo     # + simulador de jobs
// PORT (8787) e HOST (0.0.0.0) por env. Qualquer máquina da rede pode ver o painel (GET + /ws).
// POST /event só aceita: origem local (loopback) OU header 'x-event-token' igual a EVENT_TOKEN (se definido).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.EVENT_TOKEN || '';
const isLoopback = (a = '') => a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1';
const TYPES = new Set(['clip.job.queued', 'clip.job.started', 'clip.job.progress', 'clip.job.completed', 'clip.job.failed', 'clip.job.cancelled',
  'clip.job.transferred', 'clip.job.received', 'clip.job.publishing', 'clip.job.published', 'clip.job.publish_failed']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const history = []; // últimos eventos, na ordem de chegada (replay marcado com replay:true para quem conecta)
const wss = new WebSocketServer({ noServer: true });

function broadcast(ev) {
  const msg = JSON.stringify(ev);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

function publish(ev) {
  if (!ev || !TYPES.has(ev.type) || typeof ev.deskId !== 'string' || typeof ev.jobId !== 'string') return false;
  delete ev.replay; // só o servidor marca replay
  history.push(ev); if (history.length > 400) history.shift();
  broadcast(ev);
  return true;
}

const resolveStatic = (url) => {
  const p = decodeURIComponent(new URL(url, 'http://x').pathname);
  if (p.startsWith('/vendor/three/')) return path.join(root, 'node_modules/three/build', p.slice(14));
  const f = path.join(root, 'public', p === '/' ? 'index.html' : p);
  return f.startsWith(path.join(root, 'public')) ? f : null;
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/event') {
    const authed = (TOKEN && req.headers['x-event-token'] === TOKEN) || isLoopback(req.socket.remoteAddress);
    if (!authed) return res.writeHead(403).end('forbidden');
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 64e3) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        const ok = publish(ev);
        res.writeHead(ok ? 202 : 400).end(ok ? 'ok' : 'invalid event');
      } catch { res.writeHead(400).end('bad json'); }
    });
    return;
  }
  const file = req.method === 'GET' ? resolveStatic(req.url) : null;
  if (!file) return res.writeHead(404).end('not found');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    for (const ev of history) ws.send(JSON.stringify({ ...ev, replay: true })); // recuperação de estado
  });
});

server.listen(PORT, HOST, () => console.log(`Fábrica de Clipe: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (escutando em ${HOST}; ws: /ws; POST /event ${TOKEN ? 'com token' : 'só local'})`));

// ---- simulador: cada job percorre desk-1..6; falhas bloqueiam só o job; publicação por plataforma ----
if (process.argv.includes('--demo')) {
  const TITLES = ['Campanha institucional', 'Corte GTA RP #12', 'Teaser trailer', 'Highlights live', 'Meme da semana', 'Reels promo', 'Entrevista curta'];
  const ALL = ['instagram', 'tiktok', 'youtube', 'facebook', 'kwai', 'x'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tails = Array.from({ length: 6 }, () => Promise.resolve()); // fila por estação
  let n = 1000;
  const emit = (e) => publish({ ...e, timestamp: new Date().toISOString() });
  const desk = (i) => `desk-${i + 1}`;

  async function runJob() {
    const jobId = `job-${++n}`, title = TITLES[n % TITLES.length];
    const platforms = ALL.filter(() => Math.random() < 0.55); if (!platforms.length) platforms.push('instagram');
    const explicit = Math.random() < 0.5; // metade usa transferred; a outra deixa o fluxo ser deduzido
    const failAt = Math.random() < 0.2 ? Math.floor(Math.random() * 6) : -1;
    emit({ type: 'clip.job.queued', deskId: desk(0), jobId, title, platforms });
    for (let i = 0; i < 6; i++) {
      const ok = await new Promise((resolve) => {
        tails[i] = tails[i].then(async () => {
          emit({ type: 'clip.job.started', deskId: desk(i), jobId, title, platforms });
          let p = 0; const total = 3500 + Math.random() * 3500, steps = 6;
          for (let k = 1; k <= steps; k++) {
            await sleep(total / steps);
            if (i === failAt && k === 3) { emit({ type: 'clip.job.failed', deskId: desk(i), jobId, error: 'Falha durante ' + ['captura', 'corte', 'legenda', 'renderização', 'aprovação', 'publicação'][i] }); return resolve(false); }
            if (i !== 5) { p = Math.round((k / steps) * 100); if (k < steps) emit({ type: 'clip.job.progress', deskId: desk(i), jobId, progress: p }); }
          }
          if (i === 5) {
            for (const pl of platforms) {
              emit({ type: 'clip.job.publishing', deskId: desk(i), jobId, platform: pl }); await sleep(1200 + Math.random() * 1200);
              if (Math.random() < 0.15) emit({ type: 'clip.job.publish_failed', deskId: desk(i), jobId, platform: pl, error: 'Limite da API' });
              else emit({ type: 'clip.job.published', deskId: desk(i), jobId, platform: pl });
            }
          }
          emit({ type: 'clip.job.completed', deskId: desk(i), jobId, duration: 20 + Math.round(Math.random() * 90) });
          resolve(true);
        });
      });
      if (!ok) return; // arquivo bloqueado: não segue adiante
      if (i < 5) {
        await sleep(600);
        if (explicit) emit({ type: 'clip.job.transferred', deskId: desk(i), jobId, toDeskId: desk(i + 1) });
        await sleep(1700); // tempo do arquivo na esteira
        emit({ type: 'clip.job.received', deskId: desk(i + 1), jobId, title });
      }
    }
  }
  const loop = async () => { for (;;) { runJob(); await sleep(7000 + Math.random() * 5000); } };
  setTimeout(loop, 1500);
}
