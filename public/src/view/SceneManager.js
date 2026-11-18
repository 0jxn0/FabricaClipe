// three.js: renderer, câmera ortográfica top-down, loop com delta time e helpers de sprite. Sem regras de negócio.
import * as THREE from 'three';

export class SceneManager {
  constructor(stage) {
    this.stage = stage;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, depth: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x0a0d14, 1);
    stage.prepend(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 100);
    this.camera.position.z = 50;
    this.bgMesh = null;
    this.ticks = []; this.running = false; this.last = 0; this.time = 0; this.raf = 0; this.dead = false;
    this.onVisibility = () => (document.hidden ? this.stop() : this.start());
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Teardown: para o loop, solta listeners e libera GPU (inclui o contexto WebGL, limitado a ~16 por página). */
  destroy() {
    if (this.dead) return;
    this.dead = true; this.stop(); this.ticks = [];
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material ?? [])) { m.map?.dispose(); m.dispose(); }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  /** Cria textura nearest-neighbor a partir de um canvas. */
  texture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Sprite plano (w x h em art px) com ordem de camada explícita. */
  sprite(canvas, order, { additive = false, color = 0xffffff, opacity = 1 } = {}) {
    const tex = this.texture(canvas);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, color, opacity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(canvas.width, canvas.height), mat);
    mesh.renderOrder = order;
    this.scene.add(mesh);
    return { mesh, tex, mat };
  }

  /** Posiciona pelo canto superior esquerdo em art px (origem no topo-esquerdo da vista). */
  place(mesh, x, y) { mesh.position.set(x + mesh.geometry.parameters.width / 2, -(y + mesh.geometry.parameters.height / 2), 0); }

  setBackground(canvas) {
    if (this.bgMesh) { this.scene.remove(this.bgMesh); this.bgMesh.material.map.dispose(); this.bgMesh.geometry.dispose(); this.bgMesh.material.dispose(); }
    const { mesh } = this.sprite(canvas, 0);
    mesh.material.transparent = false;
    this.place(mesh, 0, 0);
    this.bgMesh = mesh;
  }

  /** info vem do ResponsiveManager. Alinha 1 art px a `s` pixels de dispositivo exatos. */
  resize(info) {
    this.renderer.setPixelRatio(info.dpr);
    this.renderer.setSize(info.cssW, info.cssH, true);
    const c = this.camera;
    c.left = 0; c.right = info.devW / info.s; c.top = 0; c.bottom = -info.devH / info.s;
    c.updateProjectionMatrix();
  }

  onTick(fn) { this.ticks.push(fn); }

  /** Pausa "dura": stop() + impede o visibilitychange de religar o loop. */
  hold() { this.held = true; this.stop(); }
  release() { this.held = false; if (!document.hidden) this.start(); }

  /** Desenha 1 quadro estático (dt=0) sem loop; usado com o loop pausado. */
  renderOnce() {
    if (this.dead) return;
    for (const fn of this.ticks) fn(0, this.time);
    this.renderer.render(this.scene, this.camera);
  }

  start() {
    if (this.running || this.dead || this.held) return;
    this.running = true; this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now; this.time += dt;
      for (const fn of this.ticks) fn(dt, this.time);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }
}
