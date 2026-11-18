import test from 'node:test';
import assert from 'node:assert/strict';
import { StatsManager } from '../public/src/core/StatsManager.js';

test('KPIs: concluídos, falhas, plataformas e média', () => {
  const ids = ['desk-1', 'desk-2'], s = new StatsManager(ids);
  s.handle({ type: 'clip.job.completed', deskId: 'desk-1', jobId: 'a', duration: 10 });
  s.handle({ type: 'clip.job.completed', deskId: 'desk-2', jobId: 'a', duration: 30 });
  s.handle({ type: 'clip.job.failed', deskId: 'desk-1', jobId: 'b' });
  s.handle({ type: 'clip.job.published', deskId: 'desk-2', jobId: 'a', platform: 'tiktok' });
  s.handle({ type: 'clip.job.published', deskId: 'desk-2', jobId: 'a', platform: 'tiktok' });
  const k = s.snapshot();
  assert.equal(k.done, 1); assert.equal(k.failed, 1); assert.equal(k.successRate, 50);
  assert.equal(k.avgSec, 20); assert.equal(k.plat.tiktok.published, 1); assert.equal(k.perHour, 1);
});
