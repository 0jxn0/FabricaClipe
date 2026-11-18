import { platformTile } from './chips.js';
import { PIPES } from '../config.js';
// DOM: cabeçalho, barra operacional (indicadores + atividade atual), áreas clicáveis e balões de erro.
const STATUS_TXT = { idle: 'Disponível', queued: 'Na fila', working: 'Trabalhando', completed: 'Concluído', cancelled: 'Cancelado', error: 'Erro' };
const EVT_TXT = {
  'clip.job.queued': 'job enfileirado', 'clip.job.started': 'job iniciado', 'clip.job.progress': 'progresso',
  'clip.job.completed': 'job concluído', 'clip.job.failed': 'job falhou', 'clip.job.cancelled': 'job cancelado',
  'clip.job.transferred': 'arquivo transferido', 'clip.job.received': 'arquivo recebido', 'clip.job.publishing': 'publicando',
  'clip.job.published': 'publicado', 'clip.job.publish_failed': 'falha ao publicar',
};
const $ = (id) => document.getElementById(id);
const hhmmss = (ms) => new Date(ms).toLocaleTimeString('pt-BR');

export class UIController {
  constructor(desks, { onSelect, onHover }) {
    this.desks = desks; this.views = new Map(); this.selected = null; this.conn = { state: 'connecting' };
    this.onSelect = onSelect; this.onHover = onHover; this.hits = new Map(); this.lastAct = null; this.onCurrent = () => {};
    $('count').textContent = `${desks.length} estações`;
    desks.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = 'hit'; b.type = 'button'; b.dataset.desk = d.id;
      b.setAttribute('aria-label', `Estação ${i + 1}: ${d.name}, ${d.agent}`);
      b.innerHTML = '<span class="bubble" hidden></span>';
      b.addEventListener('click', () => this.select(this.selected === d.id ? null : d.id));
      b.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && onHover(d.id));
      b.addEventListener('pointerleave', () => onHover(null));
      b.addEventListener('focus', () => onHover(d.id)); b.addEventListener('blur', () => onHover(null));
      $('hits').append(b); this.hits.set(d.id, b);
      this.views.set(d.id, { deskId: d.id, status: 'idle', queued: 0, lastEvent: null, updatedAt: 0 });
    });
    this._initKpi();
    this.renderActivity(); this.renderStats();
    setInterval(() => { this.renderConn(); this.renderStats(); }, 1000);
  }

  _initKpi() {
    const box = $('kpi'), btn = $('kpi-toggle'); this.kpi = {};
    const set = (min) => { box.classList.toggle('min', min); btn.setAttribute('aria-expanded', String(!min)); btn.innerHTML = min ? '+' : '&minus;'; btn.title = min ? 'Expandir' : 'Minimizar';};
    btn.addEventListener('click', () => {
      const min = !box.classList.contains('min'); this._kpiUser = true; set(min);
      try { localStorage.setItem('fabrica.kpi.min', min ? '1' : '0'); } catch { /* sem storage */ }
    });
    let saved = null; try { saved = localStorage.getItem('fabrica.kpi.min'); } catch { /* sem storage */ }
    this._kpiSet = set; this._kpiUser = saved != null;
    set(saved != null ? saved === '1' : true);
    $('k-plat').innerHTML = PIPES.map((id) => `<li data-p="${id}"><canvas width="12" height="12"></canvas><span>${id}</span><b class="ok">0</b><b class="bad"></b></li>`).join('');
    $('k-plat').querySelectorAll('li').forEach((li) => { const c = li.querySelector('canvas').getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(platformTile(li.dataset.p), 0, 0); });
    $('k-desk').innerHTML = this.desks.map((d) => `<div class="krow"><span>${d.name}</span><i><u style="width:0"></u></i><em>0</em></div>`).join('');
  }

  setStats(k) {
    this.k = k;
    const fmt = (s) => (s == null ? '—' : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);
    const vs = [...this.views.values()];
    $('k-done').textContent = k.done; $('k-fail').textContent = k.failed; $('k-hour').textContent = k.perHour;
    $('k-prod').textContent = vs.filter((v) => v.status === 'working').length + vs.reduce((n, v) => n + (v.queued || 0), 0);
    $('k-rate').textContent = k.successRate == null ? '—' : `${k.successRate}%`; $('k-avg').textContent = fmt(k.avgSec);
    $('k-plat').querySelectorAll('li').forEach((li) => {
      const c = k.plat[li.dataset.p]; li.querySelector('.ok').textContent = c?.published ?? 0; li.querySelector('.bad').textContent = c?.failed ? `✕${c.failed}` : '';
    });
    const max = Math.max(1, ...Object.values(k.byDesk));
    $('k-desk').querySelectorAll('.krow').forEach((r, i) => { const n = k.byDesk[this.desks[i].id]; r.querySelector('u').style.width = `${(n / max) * 100}%`; r.querySelector('em').textContent = n; });
  }

  /** Estação em destaque: a selecionada; senão a que trabalha mais recentemente; senão a do último evento. */
  currentDesk() {
    if (this.selected) return this.selected;
    const vs = [...this.views.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return (vs.find((v) => v.status === 'working') ?? vs.find((v) => v.updatedAt))?.deskId ?? null;
  }

  placeHits(cells, css) {
    // sem escolha do usuário: expande só se houver folga à esquerda do escritório (não cobre as mesas)
    if (!this._kpiUser) { const free = Math.min(...cells.map((c) => c.x)) * css; this._kpiSet(free < 236); }
    cells.forEach((c, i) => {
      const s = this.hits.get(this.desks[i].id).style;
      s.left = `${c.x * css}px`; s.top = `${c.y * css}px`; s.width = `${c.w * css}px`; s.height = `${c.h * css}px`;
    });
  }

  select(id) { this.selected = id; this.onSelect(id); for (const [k, b] of this.hits) b.classList.toggle('sel', k === id); this.renderActivity(); this.onCurrent(); }

  setConnection(c) { this.conn = { ...c, at: Date.now() }; this.renderConn(); this.renderStats(); }

  setView(v) {
    this.views.set(v.deskId, v);
    if (v.lastEvent) this.lastAct = { deskId: v.deskId, ...v.lastEvent, progress: v.progress };
    const b = this.hits.get(v.deskId), bub = b.firstElementChild;
    b.dataset.status = v.status;
    bub.hidden = v.status !== 'error'; bub.textContent = v.status === 'error' ? `${v.jobId}: ${v.error}` : '';
    this.renderStats(); this.renderActivity(); this.onCurrent(); if (this.k) this.setStats(this.k);
  }

  renderConn() {
    const { state, retryIn, at } = this.conn, el = $('conn');
    el.dataset.state = state === 'open' ? 'open' : state === 'disconnected' ? 'down' : 'wait';
    el.querySelector('b').textContent = state === 'open' ? 'Conectado'
      : state === 'disconnected' ? `Desconectado · nova tentativa em ${Math.max(0, Math.ceil((retryIn - (Date.now() - at)) / 1000))}s`
      : state === 'closed' ? 'Encerrado' : 'Conectando…';
  }

  renderStats() {
    const vs = [...this.views.values()];
    const working = vs.filter((v) => v.status === 'working').length, errors = vs.filter((v) => v.status === 'error').length;
    const queued = vs.reduce((n, v) => n + (v.queued || 0), 0);
    $('m-working').textContent = working;
    $('m-free').textContent = vs.filter((v) => v.status === 'idle').length;
    $('m-jobs').textContent = working + queued;
    const up = this.conn.state === 'open';
    const [s, txt] = !up ? ['wait', 'Sem conexão · último estado'] : errors ? ['fail', working ? `Produzindo · ${errors} falha${errors > 1 ? 's' : ''}` : `Com ${errors} falha${errors > 1 ? 's' : ''}`]
      : working ? ['work', 'Fábrica produzindo'] : queued ? ['wait', 'Jobs na fila'] : ['idle', 'Fábrica ociosa'];
    const el = $('m-state'); el.dataset.s = s; el.querySelector('b').textContent = txt;
  }

  renderActivity() {
    const el = $('area-act'), id = this.currentDesk();
    if (!id) { el.innerHTML = '<p class="hint">Aguardando eventos. Toque numa estação para ver agente, job e progresso.</p>'; return; }
    const d = this.desks.find((x) => x.id === id), i = this.desks.indexOf(d), v = this.views.get(id);
    const pct = v.progress != null && v.status === 'working' ? Math.round(v.progress) : null, le = v.lastEvent, a = this.lastAct;
    el.innerHTML = `
      <div class="d-head"><strong></strong><span></span><em class="st st-${v.status}">${STATUS_TXT[v.status]}</em></div>
      <dl>
        <div><dt>Job</dt><dd></dd></div>
        <div><dt>Progresso</dt><dd>${v.status === 'working' ? (pct != null ? `<span class="bar"><i style="width:${pct}%"></i></span> ${pct}%` : 'não informado') : '—'}</dd></div>
        <div><dt>Último evento</dt><dd></dd></div>
        <div><dt>Última atividade</dt><dd></dd></div>
      </dl>`;
    // texto vindo do backend entra como textContent, nunca como HTML
    el.querySelector('strong').textContent = d.agent;
    el.querySelector('.d-head span').textContent = `${String(i + 1).padStart(2, '0')} ${d.name}${this.selected ? ' · selecionada' : ''}`;
    const dd = el.querySelectorAll('dd');
    dd[0].textContent = v.jobId ? `${v.title ? v.title + ' · ' : ''}${v.jobId}${v.error ? ' — ' + v.error : ''}` : 'sem job';
    dd[2].textContent = le ? `${EVT_TXT[le.type]} · ${hhmmss(le.receivedAt)}` : 'nenhum';
    dd[3].textContent = a ? `${a.deskId} · ${EVT_TXT[a.type]}${a.type === 'clip.job.progress' && a.progress != null ? ` ${Math.round(a.progress)}%` : ''}` : '—';
  }
}
