// WebSocket nativo com reconexão (backoff exponencial + jitter). Só transporta JSON; não conhece a UI nem os eventos.
export class WebSocketClient {
  constructor(url, { minDelay = 1000, maxDelay = 15000 } = {}) {
    this.url = url; this.minDelay = minDelay; this.maxDelay = maxDelay;
    this.attempt = 0; this.ws = null; this.timer = null; this.closedByUser = false;
    this.state = 'connecting'; this.handlers = { message: [], status: [] };
  }

  on(name, fn) { this.handlers[name].push(fn); return this; }
  _emit(name, arg) { for (const fn of this.handlers[name]) { try { fn(arg); } catch (e) { console.error(e); } } }
  _setState(state, extra = {}) { this.state = state; this._emit('status', { state, attempt: this.attempt, ...extra }); }

  connect() {
    this.closedByUser = false;
    clearTimeout(this.timer);
    this._setState(this.attempt ? 'reconnecting' : 'connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch { return this._retry(); }
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this._setState('open'); };
    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      for (const m of Array.isArray(data) ? data : [data]) this._emit('message', m);
    };
    ws.onerror = () => {}; // onclose sempre vem em seguida
    ws.onclose = () => { if (this.ws === ws) this._retry(); };
  }

  _retry() {
    if (this.closedByUser) return;
    this.attempt += 1;
    const base = Math.min(this.maxDelay, this.minDelay * 2 ** (this.attempt - 1));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this._setState('disconnected', { retryIn: delay });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  close() { this.closedByUser = true; clearTimeout(this.timer); this.ws?.close(); this._setState('closed'); }
}
