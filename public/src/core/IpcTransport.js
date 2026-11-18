// Transporte do app desktop: mesma interface do WebSocketClient, mas por IPC tipado (window.fabrica, exposto pelo preload).
export class IpcTransport {
  constructor(api) { this.api = api; this.state = 'connecting'; this.handlers = { message: [], status: [] }; this.off = null; }

  on(name, fn) { this.handlers[name].push(fn); return this; }
  _emit(name, arg) { for (const fn of this.handlers[name]) { try { fn(arg); } catch (e) { console.error(e); } } }
  _set(state, extra = {}) { this.state = state; this._emit('status', { state, attempt: 0, ...extra }); }

  async connect() {
    this._set('connecting');
    this.off?.(); this.off = null; clearTimeout(this.timer);
    try {
      this.off = this.api.events.onEvent((e) => this._emit('message', e)); // assina antes do snapshot: nada se perde (duplicados são ignorados)
      const snap = await this.api.events.snapshot();                         // recuperação de estado: histórico marcado replay:true
      for (const e of snap.events) this._emit('message', e);
      this.tries = 0; this._set('open');
    } catch (err) {
      console.error(err); this.tries = (this.tries ?? 0) + 1;
      const retryIn = Math.min(15000, 1000 * 2 ** (this.tries - 1)); this._set('disconnected', { retryIn });
      this.timer = setTimeout(() => this.connect(), retryIn);
    }
  }

  close() { clearTimeout(this.timer); this.off?.(); this._set('closed'); }
}
