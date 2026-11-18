import test from 'node:test';
import assert from 'node:assert/strict';
import { EventManager } from '../public/src/core/EventManager.js';
import { FlowManager } from '../public/src/core/FlowManager.js';

const ids = ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'];
const mk = () => {
  const em = new EventManager(ids, { setTimer: () => 0, clearTimer: () => {} });
  const fm = new FlowManager(ids); const acts = [];
  fm.on('action', (a) => acts.push(a)); em.on('accepted', (e) => fm.handle(e));
  return { em, fm, acts, h: (type, deskId, jobId, x = {}) => em.handle({ type: `clip.job.${type}`, deskId, jobId, ...x }) };
};

test('transferência só após evidência real', () => {
  const { h, acts } = mk();
  h('started', 'desk-1', 'a'); h('completed', 'desk-1', 'a');
  assert.deepEqual(acts.map((a) => a.kind), ['enter', 'outbox']); // nenhuma transferência inventada
  h('started', 'desk-2', 'a');
  assert.deepEqual(acts.at(-1), { kind: 'transfer', jobId: 'a', from: 'desk-1', to: 'desk-2', animate: true });
});

test('transferred explícito + received/started não duplica animação', () => {
  const { h, acts } = mk();
  h('started', 'desk-1', 'a'); h('completed', 'desk-1', 'a');
  h('transferred', 'desk-1', 'a', { toDeskId: 'desk-2' }); h('received', 'desk-2', 'a'); h('started', 'desk-2', 'a');
  assert.equal(acts.filter((a) => a.kind === 'transfer').length, 1);
});

test('falha bloqueia o job e não afeta outro', () => {
  const { h, acts, em, fm } = mk();
  h('started', 'desk-1', 'a'); h('started', 'desk-1', 'b');
  h('failed', 'desk-1', 'a', { error: 'x' }); h('started', 'desk-2', 'a');
  assert.equal(acts.filter((a) => a.kind === 'transfer').length, 0);
  assert.equal(fm.job('a').blocked, 'desk-1');
  assert.equal(fm.job('b').blocked, null);
  assert.equal(em.snapshot('desk-2').status, 'working'); // estação 2 segue seus próprios eventos
});

test('recuperação libera o arquivo', () => {
  const { h, fm } = mk();
  h('started', 'desk-1', 'a', { timestamp: '2026-01-01T00:00:00Z' }); h('failed', 'desk-1', 'a', { timestamp: '2026-01-01T00:00:05Z' });
  h('started', 'desk-1', 'a', { timestamp: '2026-01-01T00:00:10Z' });
  assert.equal(fm.job('a').blocked, null);
});

test('publicação: só published confirma; completed não', () => {
  const { h, fm } = mk();
  h('started', 'desk-6', 'a', { platforms: ['instagram', 'tiktok'] });
  h('publishing', 'desk-6', 'a', { platform: 'instagram' });
  h('completed', 'desk-6', 'a');
  assert.deepEqual(fm.job('a').platforms.map((p) => p.state), ['publishing', 'waiting']);
  h('published', 'desk-6', 'a', { platform: 'instagram' });
  h('publish_failed', 'desk-6', 'a', { platform: 'tiktok', error: 'quota' });
  assert.deepEqual(fm.job('a').platforms.map((p) => p.state), ['published', 'failed']);
});

test('replay não anima', () => {
  const { h, acts } = mk();
  h('started', 'desk-1', 'a', { replay: true }); h('completed', 'desk-1', 'a', { replay: true }); h('started', 'desk-2', 'a', { replay: true });
  assert.equal(acts.find((a) => a.kind === 'transfer').animate, false);
});

test('eventos de fluxo inválidos são rejeitados', () => {
  const { h } = mk();
  assert.equal(h('transferred', 'desk-1', 'a', { toDeskId: 'desk-1' }).reason, 'bad-target');
  assert.equal(h('published', 'desk-6', 'a', { platform: 'bad platform!' }).reason, 'bad-platform');
});
