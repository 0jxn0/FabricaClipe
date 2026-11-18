// Animação procedural por funcionário, baseada em delta time. Não conhece rede nem three.js.
// update(dt) devolve uma pose com valores inteiros (pixel art limpa).
import { TIMING } from '../config.js';

const rnd = (a, b) => a + Math.random() * (b - a);

export class WorkerAnimation {
  constructor() {
    this.state = 'idle';        // idle | working | completed | error (estado "efetivo" da animação)
    this.t = 0; this.stateT = 0;
    this.blinkIn = rnd(1.5, 4); this.blinkT = 0;
    this.glanceIn = rnd(3, 7); this.glanceT = 0; this.glanceDir = 0;
    this.shiftIn = rnd(8, 16); this.shiftT = 0;
    this.keyT = 0; this.lh = 0; this.rh = 0; this.pauseT = 0; this.pauseIn = rnd(2, 5);
    this.pose = { br: 0, turn: 0, dx: 0, dy: 0, blink: false, mode: 'rest', lh: 0, rh: 0, wave: false };
  }

  /** Estado vindo do modelo. 'completed' toca a celebração e volta sozinho a idle; 'cancelled' vira idle. */
  setState(s) {
    const next = s === 'cancelled' ? 'idle' : s;
    if (next === this.state) return;
    this.state = next; this.stateT = 0;
  }

  update(dt) {
    this.t += dt; this.stateT += dt;
    const p = this.pose;
    let state = this.state;
    if (state === 'completed' && this.stateT > TIMING.celebrateMs / 1000) state = 'idle';

    p.br = Math.sin(this.t * (state === 'working' ? 3.2 : 1.8)) > 0.55 ? 1 : 0; // respiração
    this._blink(dt, state);

    if (state === 'idle') this._idle(dt);
    else if (state === 'working') this._work(dt);
    else if (state === 'completed') this._done();
    else if (state === 'error') this._error();
    return p;
  }

  _blink(dt, state) {
    const p = this.pose;
    if (this.blinkT > 0) { this.blinkT -= dt; p.blink = this.blinkT > 0; return; }
    this.blinkIn -= dt;
    if (this.blinkIn <= 0 && state !== 'error') { this.blinkT = 0.14; this.blinkIn = rnd(2, 5.5); p.blink = true; }
  }

  _idle(dt) {
    const p = this.pose;
    p.mode = 'rest'; p.lh = 0; p.rh = 0; p.dy = 0;
    if (this.glanceT > 0) { this.glanceT -= dt; p.turn = this.glanceT > 0 ? this.glanceDir : 0; p.dx = p.turn; }
    else {
      p.turn = 0; p.dx = 0;
      this.glanceIn -= dt;
      if (this.glanceIn <= 0) { this.glanceT = rnd(0.9, 1.8); this.glanceDir = Math.random() < 0.5 ? -1 : 1; this.glanceIn = rnd(4, 9); }
    }
    if (this.shiftT > 0) { this.shiftT -= dt; p.rh = 1; } // ajeita a mão
    else { this.shiftIn -= dt; if (this.shiftIn <= 0) { this.shiftT = 0.7; this.shiftIn = rnd(10, 20); } }
  }

  _work(dt) {
    const p = this.pose;
    p.mode = 'type'; p.turn = 0;
    p.dy = Math.sin(this.t * 2.4) > 0.6 ? 1 : 0;
    p.dx = Math.round(Math.sin(this.t * 1.1)); // inclina a cabeça de leve
    this.pauseIn -= dt;
    if (this.pauseT > 0) { this.pauseT -= dt; p.lh = 0; p.rh = 0; return; }
    if (this.pauseIn <= 0) { this.pauseT = rnd(0.4, 0.9); this.pauseIn = rnd(2.5, 6); return; }
    this.keyT -= dt;
    if (this.keyT <= 0) { this.keyT = rnd(0.07, 0.14); this.lh = Math.random() < 0.55 ? 1 + ((Math.random() * 2) | 0) : 0; this.rh = Math.random() < 0.55 ? 1 + ((Math.random() * 2) | 0) : 0; }
    p.lh = this.lh; p.rh = this.rh;
  }

  _done() {
    const p = this.pose;
    p.turn = 0; p.dx = 0; p.lh = 0; p.rh = 0;
    if (this.stateT < 0.25) { p.mode = 'rest'; p.dy = 0; return; } // para de digitar
    p.mode = 'raise'; p.wave = Math.floor(this.stateT * 5) % 2 === 0; p.dy = -1;
  }

  _error() {
    const p = this.pose;
    p.turn = 0; p.lh = 0; p.rh = 0; p.blink = false;
    p.dy = 2; p.dx = this.stateT < 0.5 ? (Math.floor(this.stateT * 24) % 2 ? 1 : -1) : 0; // tremor curto
    p.mode = this.stateT > 0.6 ? 'face' : 'rest';
  }
}
