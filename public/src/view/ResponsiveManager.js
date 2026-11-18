// Mede o palco, escolhe 3x2 (desktop) ou 2x3 (mobile/retrato) e uma escala inteira de pixels de dispositivo.
import { minSize } from './OfficeLayout.js';

export class ResponsiveManager {
  constructor(stage, onChange) {
    this.stage = stage; this.onChange = onChange; this.last = null; this.raf = 0;
    this.dead = false;
    this.schedule = () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.update()); };
    this.ro = new ResizeObserver(this.schedule); this.ro.observe(stage);
    window.addEventListener('resize', this.schedule);
    window.addEventListener('orientationchange', this.schedule);
  }

  destroy() {
    this.dead = true; cancelAnimationFrame(this.raf); this.ro.disconnect();
    window.removeEventListener('resize', this.schedule);
    window.removeEventListener('orientationchange', this.schedule);
  }

  measure() {
    const cssW = Math.max(1, this.stage.clientWidth), cssH = Math.max(1, this.stage.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 4);
    const devW = Math.round(cssW * dpr), devH = Math.round(cssH * dpr);
    const cols = cssW < 640 || cssW / cssH < 0.9 ? 2 : 3;
    const m = minSize(cols);
    const fit = Math.min(devW / m.w, devH / m.h);
    // inteiro quando há folga; abaixo de 3x usa passos de 0,25 para aproveitar a tela (pixels levemente irregulares)
    const s = Math.max(1, Math.min(8, fit >= 3 ? Math.floor(fit) : Math.floor(fit * 4) / 4));
    return { cssW, cssH, dpr, devW, devH, cols, s, viewW: Math.ceil(devW / s), viewH: Math.ceil(devH / s), css: s / dpr };
  }

  update() {
    if (this.dead) return;
    const m = this.measure();
    const l = this.last;
    if (l && l.devW === m.devW && l.devH === m.devH && l.s === m.s && l.cols === m.cols) return;
    this.last = m;
    this.onChange(m);
  }
}
