// Cola: eventos (WebSocket -> EventManager -> FlowManager) e visual (cena, esteira, UI). Só conversam por views/snapshots/ações.
import { DESKS, PIPES, resolveWsUrl } from './config.js';
import { EventManager } from './core/EventManager.js';
import { FlowManager } from './core/FlowManager.js';
import { StatsManager } from './core/StatsManager.js';
import { PipeManager } from './view/PipeManager.js';
import { WebSocketClient } from './core/WebSocketClient.js';
import { IpcTransport } from './core/IpcTransport.js';
import { SceneManager } from './view/SceneManager.js';
import { WorkerManager } from './view/WorkerManager.js';
import { BeltRenderer } from './view/BeltRenderer.js';
import { UIController } from './view/UIController.js';
import { ResponsiveManager } from './view/ResponsiveManager.js';
import { computeLayout } from './view/OfficeLayout.js';
import { drawBackground } from './view/art.js';

const ids = DESKS.map((d) => d.id);
const stage = document.getElementById('stage');
const scene = new SceneManager(stage);
const pipes = new PipeManager(scene, PIPES);
const workers = new WorkerManager(scene, DESKS, pipes);
const stats = new StatsManager(ids);
const belt = new BeltRenderer(document.getElementById('belt'), DESKS);
const events = new EventManager(ids);
const flow = new FlowManager(ids);
const ui = new UIController(DESKS, {
  onSelect: (id) => workers.setSelected(id),
  onHover: (id) => workers.setHover(id),
});

const refreshBelt = () => belt.setViews(events.all(), ui.currentDesk());
ui.onCurrent = refreshBelt;
events.on('change', (v) => { workers.apply(v); ui.setView(v); });
events.on('accepted', (e) => { stats.handle(e); flow.handle(e); });
flow.on('change', () => { const snap = flow.snapshot(); belt.sync(snap); workers.setFlow(snap); });
flow.on('action', (a) => { belt.action(a); workers.action(a); });
scene.onTick((dt, t) => { belt.draw(dt, t); pipes.tick(dt, t, stats.snapshot().plat); });
stats.on(() => ui.setStats(stats.snapshot()));
if (new URLSearchParams(location.search).has('debug')) events.on('event', (r) => !r.ok && console.debug('[evento rejeitado]', r.reason, r.raw));

// App desktop: IPC tipado do preload. Navegador (dev/rede): WebSocket. O restante da interface não muda.
const ws = window.fabrica ? new IpcTransport(window.fabrica) : new WebSocketClient(resolveWsUrl());
ws.on('message', (m) => events.handle(m));
ws.on('status', (s) => { workers.setLink(s.state === 'open'); ui.setConnection(s); });

const responsive = new ResponsiveManager(stage, (info) => {
  const layout = computeLayout(info.viewW, info.viewH, info.cols);
  scene.resize(info);
  scene.setBackground(drawBackground(info.viewW, info.viewH, layout));
  workers.layout(layout.cells);
  pipes.layout(layout.pipes);
  ui.placeHits(layout.cells, info.css);
  window.__fabrica.layout = { cols: info.cols, s: info.s, cells: layout.cells };
});

window.__fabrica = { events, flow, stats, pipes, ws, scene, workers, ui, belt };
responsive.update();
scene.start();
ws.connect();
