import test from 'node:test';
import assert from 'node:assert/strict';
import { EventManager } from '../public/src/core/EventManager.js';

const ids = ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'];
const mk = () => new EventManager(ids, { setTimer: () => 0, clearTimer: () => {} });
const ev = (type, deskId, jobId, extra = {}) => ({ type, deskId, jobId, ...extra });

test('seis estações começam em idle', () => {
  assert.deepEqual(mk().all().map((v) => v.status), Array(6).fill('idle'));
});

test('evento afeta só a própria estação', () => {
  const m = mk();
  m.handle(ev('clip.job.started', 'desk-2', 'j1', { title: 'T' }));
  assert.deepEqual(m.all().map((v) => v.status), ['idle', 'working', 'idle', 'idle', 'idle', 'idle']);
});

test('progresso, conclusão e erro', () => {
  const m = mk();
  m.handle(ev('clip.job.started', 'desk-1', 'j1'));
  assert.equal(m.snapshot('desk-1').progress, null); // sem progresso inventado
  m.handle(ev('clip.job.progress', 'desk-1', 'j1', { progress: 65 }));
  assert.equal(m.snapshot('desk-1').progress, 65);
  m.handle(ev('clip.job.completed', 'desk-1', 'j1', { duration: 42 }));
  assert.equal(m.snapshot('desk-1').status, 'completed');
  assert.equal(m.snapshot('desk-1').duration, 42);
  m.handle(ev('clip.job.started', 'desk-3', 'j9'));
  m.handle(ev('clip.job.failed', 'desk-3', 'j9', { error: 'boom' }));
  assert.equal(m.snapshot('desk-3').status, 'error');
  assert.equal(m.snapshot('desk-3').error, 'boom');
});

test('completed volta a idle após o intervalo', () => {
  let fire; const m = new EventManager(ids, { setTimer: (f) => { fire = f; return 1; }, clearTimer: () => {} });
  m.handle(ev('clip.job.started', 'desk-1', 'j1')); m.handle(ev('clip.job.completed', 'desk-1', 'j1'));
  fire();
  assert.equal(m.snapshot('desk-1').status, 'idle');
});

test('duplicados, fora de ordem e inválidos', () => {
  const m = mk();
  assert.equal(m.handle(ev('clip.job.started', 'desk-1', 'j1')).ok, true);
  assert.equal(m.handle(ev('clip.job.started', 'desk-1', 'j1')).reason, 'duplicate');
  m.handle(ev('clip.job.progress', 'desk-1', 'j1', { progress: 70 }));
  assert.equal(m.handle(ev('clip.job.progress', 'desk-1', 'j1', { progress: 30 })).reason, 'stale-progress');
  assert.equal(m.snapshot('desk-1').progress, 70);
  m.handle(ev('clip.job.completed', 'desk-1', 'j1'));
  assert.equal(m.handle(ev('clip.job.progress', 'desk-1', 'j1', { progress: 90 })).reason, 'stale-after-finish');
  assert.equal(m.snapshot('desk-1').status, 'completed');
  assert.equal(m.handle(ev('clip.job.started', 'desk-9', 'j1')).reason, 'bad-desk');
  assert.equal(m.handle({ type: 'x' }).ok, false);
  assert.equal(m.handle(null).ok, false);
  assert.equal(m.handle(ev('clip.job.progress', 'desk-1', 'j2', { progress: 'a' })).reason, 'bad-progress');
});

test('conclusão chegando antes do início não reabre o job', () => {
  const m = mk();
  m.handle(ev('clip.job.completed', 'desk-4', 'j1'));
  assert.equal(m.handle(ev('clip.job.started', 'desk-4', 'j1')).ok, false);
  assert.equal(m.snapshot('desk-4').status, 'completed');
});

test('fila: queued conta e started consome', () => {
  const m = mk();
  m.handle(ev('clip.job.queued', 'desk-5', 'a')); m.handle(ev('clip.job.queued', 'desk-5', 'b'));
  assert.equal(m.snapshot('desk-5').queued, 2);
  m.handle(ev('clip.job.started', 'desk-5', 'a'));
  assert.equal(m.snapshot('desk-5').queued, 1);
});
