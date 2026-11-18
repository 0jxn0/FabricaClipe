// Integrações de contas (só existe com window.fabrica): <dialog> modal acessível (foco preso e Esc nativos), um cartão por plataforma com
// passo a passo, credenciais e Conectar/Testar/Desconectar. O renderer nunca recebe segredo/token; texto do backend entra só por textContent.
import { PLATFORM_LABELS, cleanIpcError } from './jobLogic.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
const STATUS = { none: 'Não configurada', credentials: 'Credenciais salvas', connected: 'Conectada', error: 'Erro' };

export class IntegrationsPanel {
  constructor(api) {
    this.api = api.integrations; this.cards = new Map(); this.guides = null; this.dlg = $('integ-dlg'); this.opener = $('integ-open');
    this.opener.hidden = false;
    this.opener.addEventListener('click', () => this.open());
    $('integ-close').addEventListener('click', () => this.dlg.close());
    this.dlg.addEventListener('click', (e) => { if (e.target === this.dlg) this.dlg.close(); }); // clique no fundo
    this.dlg.addEventListener('close', () => { for (const i of this.dlg.querySelectorAll('input[type=password]')) i.value = ''; this.opener.focus(); }); // segredo digitado não fica no DOM
  }

  async open() {
    this._err(''); if (!this.dlg.open) this.dlg.showModal();
    const list = $('integ-list'); if (!this.cards.size) list.replaceChildren(el('p', { className: 'hint', textContent: 'Carregando…' }));
    try {
      this.guides ??= await Promise.all(Object.keys(PLATFORM_LABELS).map((p) => this.api.guide(p)));
      const items = await this.api.list();
      if (!this.cards.size) { for (const g of this.guides) this.cards.set(g.platform, this._card(g)); list.replaceChildren(...[...this.cards.values()].map((c) => c.root)); }
      for (const it of items) this.cards.get(it.platform)?.update(it);
      $('integ-vault').hidden = items.every((i) => i.secureStorage);
    } catch (e) {
      list.replaceChildren(); this._err(`Não foi possível carregar as integrações: ${cleanIpcError(e)}`);
      list.append(el('button', { className: 'btn', type: 'button', textContent: 'Tentar de novo', onclick: () => this.open() }));
    }
  }

  _err(t) { const m = $('integ-err'); m.textContent = t; m.hidden = !t; }

  _card(g) {
    const p = g.platform, id = `integ-${p}`;
    const badge = el('span', { className: 'badge' }), summary = el('summary', {}, el('span', { className: 'pname', id: `${id}-n`, textContent: g.name }), badge);
    const info = el('p', { className: 'cinfo' });
    const pub = el('p', { className: 'msg warn', textContent: g.publishNote });
    const steps = el('ol', { className: 'steps' }, ...g.steps.map((t) => el('li', { textContent: t })));
    const links = el('div', { className: 'links' }, ...g.consoles.map((c) => el('button', { type: 'button', className: 'btn sm', textContent: `Abrir: ${c.label}`, onclick: () => this._run(c.id, () => this.api.openConsole(p, c.id)) })));
    const ruInput = el('input', { id: `${id}-ru`, type: 'text', readOnly: true, value: g.redirectUri, autocomplete: 'off', spellcheck: false });
    const copy = el('button', { type: 'button', className: 'btn sm', textContent: 'Copiar', onclick: () => this._copy(ruInput, copy) });
    copy.setAttribute('aria-label', `Copiar redirect URI do ${g.name}`);
    const redirect = el('div', { className: 'redirect' }, el('label', { htmlFor: ruInput.id, textContent: 'Redirect URI (passo 2)' }), el('div', { className: 'rurow' }, ruInput, copy), el('small', { className: 'hint', textContent: g.redirectNote }));
    const inputs = {}, fields = g.fields.map((f) => {
      const inp = el('input', { id: `${id}-${f.name}`, name: f.name, type: f.secret ? 'password' : 'text', autocomplete: f.secret ? 'new-password' : 'off', spellcheck: false, maxLength: 512 });
      inp.setAttribute('autocapitalize', 'off'); inputs[f.name] = inp;
      return el('div', { className: 'fld' }, el('label', { htmlFor: inp.id, textContent: f.label }), inp);
    });
    const msg = el('p', { className: 'cmsg', role: 'status' }); msg.setAttribute('aria-live', 'polite');
    const btn = (text, cls, props = {}) => el('button', { type: 'button', className: `btn${cls ? ' ' + cls : ''}`, textContent: text, ...props });
    const save = btn('Salvar', 'primary', { type: 'submit' }), conn = btn('Conectar', ''), test = btn('Testar conexão', ''), off = btn('Desconectar', 'danger');
    const form = el('form', { className: 'cform', autocomplete: 'off', noValidate: false }, ...fields, el('div', { className: 'row' }, save, conn, test, off));
    form.setAttribute('aria-label', `Credenciais do ${g.name}`);
    const lim = el('details', { className: 'lim' }, el('summary', { textContent: 'Limitações e pontos não verificados' }),
      el('ul', {}, ...g.limitations.map((t) => el('li', { textContent: t })), ...g.unverified.map((t) => el('li', { textContent: `Não verificado online: ${t}` }))));
    const root = el('details', { className: 'card' }, summary, el('div', { className: 'cbody' }, info, pub, steps, links, redirect, form, msg, lim));
    root.dataset.platform = p;
    if (this.cards.size === 0) root.open = true; // o primeiro cartão já abre com o passo a passo visível
    const ctl = { cur: null, busy: false };
    const setMsg = (t, bad) => { msg.textContent = t || ''; msg.className = `cmsg${bad ? ' bad' : ''}`; };
    const apply = () => {
      const it = ctl.cur; if (!it) return; const has = it.hasClientId && it.hasSecret;
      badge.textContent = STATUS[it.status] ?? it.status; badge.dataset.s = it.status;
      info.textContent = it.status === 'connected' ? `Conta conectada${it.label ? `: ${it.label}` : ''}${it.connectedAt ? ` (desde ${new Date(it.connectedAt).toLocaleString('pt-BR')})` : ''}.` : it.hasClientId ? 'Credenciais guardadas com segurança (não são exibidas de novo).' : 'Nenhuma credencial salva.';
      for (const f of g.fields) inputs[f.name].placeholder = (f.name === 'clientId' ? it.hasClientId : it.hasSecret) ? 'salvo (preencha só para trocar)' : '';
      save.disabled = ctl.busy || !it.secureStorage; conn.disabled = ctl.busy || !has || !it.secureStorage; test.disabled = ctl.busy || !(it.status === 'connected' || it.status === 'error');
      off.disabled = ctl.busy || it.status === 'none'; off.textContent = it.status === 'connected' || it.status === 'error' ? 'Desconectar' : 'Apagar credenciais';
    };
    const busy = (on, label) => { ctl.busy = on; apply(); if (on) setMsg(label); };
    const act = async (label, fn, okMsg) => {
      busy(true, label);
      try { const r = await fn(); if (r?.platform) ctl.cur = r; setMsg(typeof okMsg === 'function' ? okMsg(r) : okMsg, false); return r; }
      catch (e) { setMsg(cleanIpcError(e), true); } finally { busy(false); try { ctl.cur = (await this.api.list()).find((x) => x.platform === p) ?? ctl.cur; } catch { /* mantém */ } apply(); }
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); const cid = inputs.clientId.value.trim();
      if (!cid) { setMsg(`Informe o ${g.fields[0].label}.`, true); inputs.clientId.focus(); return; }
      const r = await act('Salvando…', () => this.api.saveCredentials({ platform: p, clientId: cid, ...(inputs.clientSecret?.value.trim() ? { clientSecret: inputs.clientSecret.value.trim() } : {}) }), 'Credenciais salvas no cofre do sistema.');
      if (r) for (const i of Object.values(inputs)) i.value = ''; // não deixa o segredo no DOM
    });
    conn.addEventListener('click', () => act('Aguardando a autorização no navegador (até 3 minutos)…', () => this.api.connect(p), 'Conta conectada. Use Testar conexão para confirmar.'));
    test.addEventListener('click', () => act('Testando…', async () => { const r = await this.api.test(p); if (!r.ok) throw new Error(r.message); return r; }, (r) => r.message));
    off.addEventListener('click', () => { if (window.confirm(`${off.textContent} ${g.name}? Será preciso conectar/salvar de novo.`)) act('Removendo…', () => this.api.disconnect(p), 'Feito.'); });
    return { root, update: (it) => { ctl.cur = it; apply(); if (it.status === 'error' && it.message) setMsg(it.message, true); } };
  }

  async _run(key, fn) { try { await fn(); } catch (e) { this._err(cleanIpcError(e)); } }

  async _copy(input, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(input.value); ok = true; } catch { input.select(); try { ok = document.execCommand('copy'); } catch { /* ignora */ } }
    btn.textContent = ok ? 'Copiado' : 'Selecione e copie (Ctrl+C)'; setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
  }
}
