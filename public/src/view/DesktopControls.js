// Controles reais do app desktop (só existe com window.fabrica): importar vídeo, pausar/retomar/cancelar/retry e aprovação com preview.
// Estado do job: reage aos eventos do barramento (jobs.list() com debounce a cada evento que muda estado) e ao voltar a visibilidade da
// janela; não há polling. Eventos de progresso são ignorados (não mudam o estado). Texto vindo do backend entra só por textContent.
import { ACTIONS, PLATFORM_LABELS, actionsFor, awaitingApproval, buildCreateInput, cleanIpcError, jobForDesk, nameFromPath } from './jobLogic.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };

export class DesktopControls {
  constructor(api, ui) {
    this.api = api; this.ui = ui; this.jobs = []; this.files = []; this.shown = null; this.ctlKey = ''; this.timer = null;
    this._initImport(); this._initApproval();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
    this.refresh();
  }

  /** Chamar a cada evento recebido do backend. */
  onEvent(m) { if (m?.type === 'clip.job.progress') return; clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 250); }

  async refresh() {
    if (document.hidden) return;
    const ticket = this.rt = (this.rt ?? 0) + 1; // respostas fora de ordem não sobrescrevem a mais nova
    let jobs; try { jobs = await this.api.jobs.list(); } catch (e) { console.error(e); return; }
    if (ticket !== this.rt) return;
    this.jobs = jobs; this.render();
  }

  render() { this._renderControls(); this._renderApproval(); }

  // ------------------------------------------------------------- importar
  _initImport() {
    const btn = $('btn-import'), dlg = $('imp-dlg'), form = $('imp-form'); btn.hidden = false;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { const picked = await this.api.files.pickVideos(); if (picked.length) this._openImport(picked); }
      catch (e) { window.alert(cleanIpcError(e)); } finally { btn.disabled = false; }
    });
    $('imp-cancel').addEventListener('click', () => dlg.close());
    $('imp-an').addEventListener('click', () => void this._analyze());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    $('imp-plats').append(...Object.entries(PLATFORM_LABELS).map(([id, label]) => el('label', { className: 'chk' }, el('input', { type: 'checkbox', name: 'plat', value: id }), label)));
    form.addEventListener('submit', (e) => { e.preventDefault(); void this._submitImport(); });
  }

  _openImport(paths) {
    this.files = paths; this._errors([]); $('imp-rep').hidden = true;
    $('imp-files').replaceChildren(...paths.map((p) => el('li', { textContent: nameFromPath(p), title: p })));
    $('imp-go').disabled = false; $('imp-go').textContent = paths.length > 1 ? `Criar ${paths.length} jobs` : 'Criar job';
    if (!$('imp-dlg').open) $('imp-dlg').showModal();
    $('imp-plats').querySelector('input').focus();
  }

  /** "Analisar": relatório técnico real (ffprobe) de cada arquivo escolhido; nada é criado nem alterado. */
  async _analyze() {
    const rep = $('imp-rep'), btn = $('imp-an'); btn.disabled = true; btn.textContent = 'Analisando…'; this._errors([]);
    const lines = [];
    for (const p of this.files) {
      try {
        const r = await this.api.files.analyze(p), i = r.info;
        lines.push(`${nameFromPath(p)}: ${r.summary}${i ? ` — ${i.width}x${i.height}, ${i.fps} fps, ${Math.round(i.durationSec)} s, ${i.videoCodec}${i.hasAudio ? '/' + i.audioCodec : ', sem áudio'}` : ''}`);
        for (const pr of r.problems) lines.push(`   ${pr.severity === 'error' ? '✕' : pr.severity === 'warning' ? '!' : 'i'} ${pr.message}`);
      } catch (e) { lines.push(`${nameFromPath(p)}: ${cleanIpcError(e)}`); }
    }
    rep.replaceChildren(...lines.map((t) => el('p', { textContent: t }))); rep.hidden = !lines.length;
    btn.disabled = false; btn.textContent = 'Analisar';
  }

  _errors(list) { const box = $('imp-err'); box.replaceChildren(...list.map((t) => el('p', { textContent: t }))); box.hidden = !list.length; }

  async _submitImport() {
    const form = $('imp-form'), data = {
      platforms: [...form.querySelectorAll('input[name=plat]:checked')].map((i) => i.value),
      start: form.elements.start.value, duration: form.elements.duration.value, subtitles: form.elements.subs.checked,
    };
    const built = this.files.map((p) => ({ p, r: buildCreateInput(p, data) }));
    const bad = built.find((b) => b.r.error); if (bad) { this._errors([bad.r.error]); return; }
    $('imp-go').disabled = true; $('imp-go').textContent = 'Criando…';
    const errors = [];
    for (const { p, r } of built) {
      try { await this.api.jobs.create(r.input); } catch (e) { errors.push(`${nameFromPath(p)}: ${cleanIpcError(e)}`); }
    }
    await this.refresh();
    if (!errors.length) { $('imp-dlg').close(); return; }
    // a seleção do diálogo nativo vale uma vez: arquivos com erro precisam ser escolhidos de novo
    this._errors([...errors, 'Use "Importar vídeo" para selecionar novamente os arquivos com erro.']);
    this.files = []; $('imp-files').replaceChildren(); $('imp-go').textContent = 'Criar job';
  }

  // ------------------------------------------------------------- controles do job da estação em foco
  _renderControls() {
    const box = $('job-ctl'), job = jobForDesk(this.jobs, this.ui.currentDesk());
    const acts = job ? actionsFor(job.state) : [];
    const key = job ? `${job.id}|${acts.join()}|${this.busy ?? ''}` : '';
    if (key === this.ctlKey) return; this.ctlKey = key;      // sem recriar: o foco do teclado não se perde nos eventos
    box.hidden = !acts.length; if (!acts.length) { box.replaceChildren(); return; }
    const label = el('span', { className: 'jc-name', textContent: `${job.name} · ${job.id}` });
    const btns = acts.map((a) => {
      const b = el('button', { type: 'button', className: `btn sm${ACTIONS[a].danger ? ' danger' : ''}`, textContent: ACTIONS[a].label, disabled: !!this.busy });
      b.setAttribute('aria-label', `${ACTIONS[a].aria}: ${job.name}`);
      b.addEventListener('click', () => this._act(job.id, a)); return b;
    });
    box.replaceChildren(label, ...btns);
  }

  async _act(jobId, action) {
    if (action === 'cancel' && !window.confirm('Cancelar este job? Essa ação não pode ser desfeita.')) return;
    this.busy = action; this.ctlKey = ''; this._renderControls();
    try { await this.api.jobs.action({ jobId, action }); } catch (e) { window.alert(cleanIpcError(e)); }
    this.busy = null; this.ctlKey = ''; await this.refresh(); this._renderControls();
  }

  // ------------------------------------------------------------- aprovação
  _initApproval() {
    const pan = $('apv'); this.vid = $('apv-video');
    $('apv-open').addEventListener('click', () => this._toggleApproval(pan.hidden));
    $('apv-close').addEventListener('click', () => this._toggleApproval(false, true));
    pan.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._toggleApproval(false, true); });
    $('apv-sel').addEventListener('change', () => { this.shown = $('apv-sel').value; this._loadVideo(); });
    this.vid.addEventListener('error', () => this._apvMsg('Não foi possível carregar o preview deste vídeo.'));
    $('apv-yes').addEventListener('click', () => this._decide('approve'));
    $('apv-no').addEventListener('click', () => this._decide('reject'));
  }

  _toggleApproval(open, focusBack) {
    const pan = $('apv'); pan.hidden = !open; $('apv-open').setAttribute('aria-expanded', String(open));
    if (open) { this._loadVideo(); $('apv-close').focus(); } else { this._unloadVideo(); if (focusBack) $('apv-open').focus(); }
  }

  _renderApproval() {
    const list = awaitingApproval(this.jobs), open = $('apv-open'), pan = $('apv');
    open.hidden = !list.length; open.querySelector('b').textContent = String(list.length);
    if (!list.length) { this.shown = null; if (!pan.hidden) this._toggleApproval(false); return; }
    if (!list.some((j) => j.id === this.shown)) { this.shown = list[0].id; if (!pan.hidden) this._loadVideo(); }
    const sel = $('apv-sel'); sel.hidden = list.length < 2;
    const key = `${this.shown}|${list.map((j) => j.id + j.name).join()}`; if (key === this.apvKey) return; this.apvKey = key;  // não recria o select a cada evento (foco)
    sel.replaceChildren(...list.map((j) => el('option', { value: j.id, textContent: `${j.name} · ${j.id}`, selected: j.id === this.shown })));
    const j = list.find((x) => x.id === this.shown); $('apv-title').textContent = `${j.name} · ${j.id}`;
  }

  _apvMsg(t) { const m = $('apv-msg'); m.textContent = t; m.hidden = !t; }
  _unloadVideo() { this.vid.pause(); this.vid.removeAttribute('src'); this.vid.load(); this.loaded = null; }

  async _loadVideo() {
    const id = this.shown; if (!id || $('apv').hidden || this.loaded === id) return;
    this._apvMsg(''); this.loaded = id;
    try { const url = await this.api.media.url(id); if (this.shown === id) { this.vid.src = url; } }
    catch (e) { this.loaded = null; this._apvMsg(cleanIpcError(e)); }
  }

  async _decide(decision) {
    const id = this.shown; if (!id) return;
    const yes = $('apv-yes'), no = $('apv-no'); yes.disabled = no.disabled = true; this._apvMsg('');
    try {
      await this.api.jobs.decide({ jobId: id, decision, note: $('apv-note').value.trim() });
      $('apv-note').value = ''; this._unloadVideo(); await this.refresh();
    } catch (e) { this._apvMsg(cleanIpcError(e)); } finally { yes.disabled = no.disabled = false; }
  }
}
