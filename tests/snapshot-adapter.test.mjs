import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotAdapter } from '../src/embed/snapshotAdapter.js';
import { EventManager } from '../public/src/core/EventManager.js';
import { FlowManager } from '../public/src/core/FlowManager.js';

const NOW = 1_700_000_000;
const stations = (over = {}) => ['capture', 'cutting', 'subtitles', 'rendering', 'approval', 'publishing'].map((key, i) => ({ id: `desk-${i + 1}`, key, available: true, reason: null, ...over[`desk-${i + 1}`] }));
const item = (o = {}) => ({ id: 'p1', title: 'Video 1', station: 'desk-1', state: 'queued', progress: null, stage: null, error: null, updated_at: NOW, clips: null, ...o });
const snap = (items, over = {}, now = NOW) => ({ now, stations: stations(over), items });
const mk = () => {
  const ev = []; const a = new SnapshotAdapter((e) => ev.push(e), { clock: () => NOW * 1000 });
  return { a, ev, take: () => ev.splice(0).map((e) => `${e.type.slice(9)}@${e.deskId}${e.toDeskId ? '>' + e.toDeskId : ''}${e.progress != null ? ':' + e.progress : ''}${e.replay ? '*' : ''}`) };
};

test('primeiro snapshot: eventos replay que reconstroem o estado', () => {
  const { a, take } = mk();
  a.feed(snap([item({ id: 'a', station: 'desk-2', state: 'working', progress: 40 }), item({ id: 'b', station: 'desk-5', state: 'waiting' }),
    item({ id: 'c', station: 'desk-5', state: 'done' }), item({ id: 'd', station: 'desk-3', state: 'failed', error: 'x' })]));
  assert.deepEqual(take(), ['started@desk-2*', 'progress@desk-2:40*', 'queued@desk-5*', 'completed@desk-5*', 'failed@desk-3*']);
});

test('estado novo no mesmo desk: queued -> started -> progress -> completed', () => {
  const { a, take } = mk();
  a.feed(snap([item()])); take();
  a.feed(snap([item({ state: 'working', progress: null })])); assert.deepEqual(take(), ['started@desk-1']); // sem % inventado
  a.feed(snap([item({ state: 'working', progress: 10 })])); assert.deepEqual(take(), ['progress@desk-1:10']);
  a.feed(snap([item({ state: 'done' })])); assert.deepEqual(take(), ['completed@desk-1']);
});

test('transição A->B: completed, transferred, received (+started) com animação', () => {
  const { a, take, ev } = mk();
  a.feed(snap([item({ state: 'working' })])); take();
  a.feed(snap([item({ station: 'desk-2', state: 'queued' })]));
  assert.deepEqual(take(), ['completed@desk-1', 'transferred@desk-1>desk-2', 'received@desk-2']);
  a.feed(snap([item({ station: 'desk-3', state: 'working', progress: 5 })]));
  assert.deepEqual(take(), ['completed@desk-2', 'transferred@desk-2>desk-3', 'received@desk-3', 'started@desk-3', 'progress@desk-3:5']);
  assert.ok(ev.every((e) => !e.replay));
});

test('estações puladas entre dois snapshots: um único transfer', () => {
  const { a, take } = mk();
  a.feed(snap([item({ state: 'working' })])); take();
  a.feed(snap([item({ station: 'desk-5', state: 'waiting' })]));
  assert.deepEqual(take(), ['completed@desk-1', 'transferred@desk-1>desk-5', 'received@desk-5']);
});

test('progresso só quando muda e nunca regride', () => {
  const { a, take } = mk();
  a.feed(snap([item({ state: 'working', progress: 30 })])); take();
  a.feed(snap([item({ state: 'working', progress: 30 })])); assert.deepEqual(take(), []);
  a.feed(snap([item({ state: 'working', progress: 20 })])); assert.deepEqual(take(), []);
  a.feed(snap([item({ state: 'working', progress: 25 })])); assert.deepEqual(take(), []); // ainda abaixo do máximo visto
  a.feed(snap([item({ state: 'working', progress: 31 })])); assert.deepEqual(take(), ['progress@desk-1:31']);
  a.feed(snap([item({ state: 'working', progress: null })])); assert.deepEqual(take(), []);
});

test('falha emite failed na estação com o erro; retry volta com started', () => {
  const { a, take, ev } = mk();
  a.feed(snap([item({ state: 'working', progress: 50 })])); take();
  a.feed(snap([item({ state: 'failed', error: 'ffmpeg caiu' })]));
  assert.equal(ev.at(-1).error, 'ffmpeg caiu'); assert.deepEqual(take(), ['failed@desk-1']);
  a.feed(snap([item({ state: 'working', progress: 5 })])); assert.deepEqual(take(), ['started@desk-1', 'progress@desk-1:5']); // nova execução: progresso recomeça
});

test('item que some: cancelled se não concluído; concluído some em silêncio', () => {
  const { a, take } = mk();
  a.feed(snap([item({ id: 'a', state: 'working' }), item({ id: 'b', station: 'desk-5', state: 'done' })])); take();
  a.feed(snap([])); assert.deepEqual(take(), ['cancelled@desk-1']);
});

test('estações available:false: expostas em unavailable/reasons', () => {
  const { a } = mk();
  a.feed(snap([], { 'desk-6': { available: false, reason: 'sem contas conectadas' } }));
  assert.deepEqual(a.unavailable, ['desk-6']); assert.equal(a.reasons['desk-6'], 'sem contas conectadas');
  a.feed(snap([])); assert.deepEqual(a.unavailable, []);
});

test('idempotência: o mesmo snapshot repetido não emite nada', () => {
  const { a, take } = mk();
  const s = snap([item({ state: 'working', progress: 12 }), item({ id: 'b', station: 'desk-5', state: 'waiting' })]);
  a.feed(s); take(); a.feed(s); a.feed(JSON.parse(JSON.stringify(s))); assert.deepEqual(take(), []);
});

test('integração com EventManager/FlowManager: transferência animada, ids sem colisão no dedupe', () => {
  const ids = stations().map((s) => s.id);
  const em = new EventManager(ids, { setTimer: () => 0, clearTimer: () => {} }), fm = new FlowManager(ids, { now: () => NOW * 1000 });
  const acts = []; fm.on('action', (x) => acts.push(x)); em.on('accepted', (e) => fm.handle(e));
  const res = []; const a = new SnapshotAdapter((e) => res.push(em.handle(e)), { clock: () => NOW * 1000 });
  a.feed(snap([item({ state: 'working', progress: 10 })]));
  a.feed(snap([item({ state: 'working', progress: 60 })]));
  a.feed(snap([item({ station: 'desk-2', state: 'working', progress: 5 })], {}, NOW + 5));
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  assert.deepEqual(acts.at(-1) && acts.filter((x) => x.kind === 'transfer'), [{ kind: 'transfer', jobId: 'p1', from: 'desk-1', to: 'desk-2', animate: true }]);
  assert.equal(em.snapshot('desk-2').status, 'working');
  assert.equal(em.snapshot('desk-2').progress, 5);
});
