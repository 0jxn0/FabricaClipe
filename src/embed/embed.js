// Entrada do bundle embutível: monta o escritório 2.5D dentro de um container de OUTRO app (sem página inteira,
// sem WebSocket, sem window.fabrica, sem inline script/style). Usa os mesmos módulos de public/src/main.js.
import { DESKS, PIPES } from '../../public/src/config.js';
import { EventManager } from '../../public/src/core/EventManager.js';
import { FlowManager } from '../../public/src/core/FlowManager.js';
import { StatsManager } from '../../public/src/core/StatsManager.js';
import { PipeManager } from '../../public/src/view/PipeManager.js';
import { SceneManager } from '../../public/src/view/SceneManager.js';
import { WorkerManager } from '../../public/src/view/WorkerManager.js';
import { BeltRenderer } from '../../public/src/view/BeltRenderer.js';
import { UIController } from '../../public/src/view/UIController.js';
import { ResponsiveManager } from '../../public/src/view/ResponsiveManager.js';
import { computeLayout } from '../../public/src/view/OfficeLayout.js';
import { drawBackground } from '../../public/src/view/art.js';
import { SnapshotAdapter } from './snapshotAdapter.js';
import { MOTION_QUERY, initialMotion, isPaused, motionReduce } from './motion.js';

// Mesmo esqueleto da página, sem cabeçalho (título/conexão) nem diálogos do desktop. Os ids são resolvidos dentro do container.
const SKELETON = `<div class="fe-root" role="region" aria-label="Visualização da fábrica">
<main id="stage"><div id="hits"></div>
  <aside id="kpi" aria-label="Métricas da fábrica">
    <header><b>Métricas</b><button id="kpi-toggle" type="button" aria-expanded="true" aria-controls="kpi-body" title="Minimizar">&minus;</button></header>
    <div id="kpi-body">
      <div class="kgrid">
        <div><b id="k-done">0</b><span>Vídeos feitos</span></div>
        <div><b id="k-prod">0</b><span>Em produção</span></div>
        <div><b id="k-fail">0</b><span>Com falha</span></div>
        <div><b id="k-rate">—</b><span>Sucesso</span></div>
        <div><b id="k-avg">—</b><span>Tempo médio</span></div>
        <div><b id="k-hour">0</b><span>Vídeos/hora</span></div>
      </div>
      <h3>Publicações</h3><ul id="k-plat"></ul>
      <h3>Concluídos por estação</h3><div id="k-desk"></div>
    </div>
  </aside>
</main>
<section id="bar" aria-label="Painel de operação">
  <div id="area-ind" class="area">
    <div class="metrics">
      <div><b id="m-working">0</b><span>Trabalhando</span></div>
      <div><b id="m-free">6</b><span>Disponíveis</span></div>
      <div><b id="m-jobs">0</b><span>Jobs ativos</span></div>
    </div>
    <div id="m-state" data-s="idle"><i></i><b>Fábrica ociosa</b></div>
  </div>
  <div id="area-belt" class="area" aria-label="Esteira de produção"><canvas id="belt"></canvas></div>
  <div id="area-act" class="area"><div id="act-info" aria-live="off"></div><div id="act-live" class="fe-sr" role="status" aria-live="polite"></div></div>
</section></div>`;

/**
 * @param {HTMLElement} container  define a altura do componente (min-height 520px)
 * @param {{ onStatus?: (text: string) => void, labels?: { metrics?: string, stations?: Record<string, string> } }} [opts]
 * @returns {{ destroy(): void, feed(snapshot: object): void, select(deskId: string | null): void, readonly unavailable: string[],
 *   pause(): void, resume(): void, readonly paused: boolean }}
 */
export function mount(container, opts = {}) {
  const labels = opts.labels ?? {};
  const desks = DESKS.map((d) => ({ ...d, name: labels.stations?.[d.id] ?? d.name }));
  const ids = desks.map((d) => d.id);
  container.classList.add('fabrica-embed');
  container.innerHTML = SKELETON;
  if (labels.metrics) container.querySelector('#kpi header b').textContent = labels.metrics;

  const scene = new SceneManager(container.querySelector('#stage'));
  const pipes = new PipeManager(scene, PIPES);
  const workers = new WorkerManager(scene, desks, pipes);
  const stats = new StatsManager(ids);
  const belt = new BeltRenderer(container.querySelector('#belt'), desks);
  const events = new EventManager(ids);
  const flow = new FlowManager(ids);
  const ui = new UIController(desks, { onSelect: (id) => workers.setSelected(id), onHover: (id) => workers.setHover(id) }, container);

  ui.onCurrent = () => belt.setViews(events.all(), ui.currentDesk());
  events.on('change', (v) => { workers.apply(v); ui.setView(v); });
  events.on('accepted', (e) => { stats.handle(e); flow.handle(e); });
  flow.on('change', () => { const snap = flow.snapshot(); belt.sync(snap); workers.setFlow(snap); });
  flow.on('action', (a) => { belt.action(a); workers.action(a); });
  scene.onTick((dt, t) => { belt.draw(dt, t); pipes.tick(dt, t, stats.snapshot().plat); });
  stats.on(() => ui.setStats(stats.snapshot()));

  const mq = typeof matchMedia === 'function' ? matchMedia(MOTION_QUERY) : null;
  let motion = initialMotion(mq?.matches), shown = null, dead = false;
  const still = () => { if (!dead && isPaused(motion)) scene.renderOnce(); };

  const responsive = new ResponsiveManager(container.querySelector('#stage'), (info) => {
    const layout = computeLayout(info.viewW, info.viewH, info.cols);
    scene.resize(info);
    scene.setBackground(drawBackground(info.viewW, info.viewH, layout));
    workers.layout(layout.cells);
    pipes.layout(layout.pipes);
    ui.placeHits(layout.cells, info.css);
    still();
  });

  // Sem transporte próprio: a conexão é do app hospedeiro; aqui o painel nunca fica em "sem conexão".
  workers.setLink(true); ui.setConnection({ state: 'open' });
  const adapter = new SnapshotAdapter((e) => events.handle(e), { order: ids });
  let last = '';

  // Movimento: prefers-reduced-motion => loop rAF parado e 1 quadro estático redesenhado a cada feed/mudança (ver motion.js).
  const sync = () => {
    const p = isPaused(motion);
    if (p === shown) return;
    shown = p;
    if (p) { scene.hold(); scene.renderOnce(); } else scene.release();
  };
  const act = (a, v) => { if (!dead) { motion = motionReduce(motion, a, v); sync(); } };
  const onMq = (e) => act('media', e.matches);
  mq?.addEventListener?.('change', onMq);
  events.on('change', still); flow.on('change', still);

  // Anúncio a leitores de tela só quando o ESTADO da fábrica muda (não por % de progresso); #act-info fica aria-live=off.
  const live = container.querySelector('#act-live'), stateEl = container.querySelector('#m-state b');
  let liveTxt = '';
  const announce = () => { const t = stateEl.textContent; if (t !== liveTxt) { liveTxt = t; live.textContent = t; } };
  events.on('change', announce);

  responsive.update();
  sync(); if (!isPaused(motion)) scene.start();
  announce();

  return {
    get paused() { return isPaused(motion); },
    pause() { act('pause'); },
    resume() { act('resume'); },
    get unavailable() { return [...adapter.unavailable]; },
    feed(snapshot) {
      if (dead) return;
      adapter.feed(snapshot);
      workers.setUnavailable(adapter.reasons); ui.setUnavailable(adapter.reasons);
      announce(); still();
      if (opts.onStatus) {
        const st = stats.snapshot(), un = adapter.unavailable.map((id) => `indisponível: ${desks[ids.indexOf(id)].name} (${adapter.reasons[id]})`);
        const text = [`${st.done} feitos`, ...un].join(' · ');
        if (text !== last) { last = text; opts.onStatus(text); }
      }
    },
    select(deskId) { if (!dead && (deskId == null || ids.includes(deskId))) ui.select(deskId ?? null); },
    destroy() {
      if (dead) return;
      dead = true;
      mq?.removeEventListener?.('change', onMq);
      responsive.destroy(); scene.destroy(); belt.destroy(); ui.destroy(); events.dispose();
      container.classList.remove('fabrica-embed'); container.replaceChildren();
    },
  };
}
