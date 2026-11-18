import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, probe, resolveBins, run } from '../src/backend/infrastructure/ffmpeg/ffmpeg.ts';

const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'fabrica-ff-'));
const bins = resolveBins();
const sample = path.join(dir, 'amostra.mp4');

test('gera vídeo de amostra e lê metadados reais com ffprobe', async () => {
  const r = await run(bins.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  assert.equal(r.code, 0, r.stderr);
  const m = await probe(sample, bins);
  assert.equal(m.width, 320); assert.equal(m.height, 240); assert.equal(m.fps, 25); assert.ok(m.hasAudio);
  assert.ok(Math.abs(m.durationSec - 6) < 0.3);
});
test('arquivo corrompido é recusado', async () => {
  const bad = path.join(dir, 'ruim.mp4'); fs.writeFileSync(bad, 'isto não é um vídeo');
  await assert.rejects(probe(bad, bins), /ffprobe recusou/);
});
test('check informa a versão e abort mata o processo', async () => {
  assert.equal((await check(bins)).ok, true);
  const ac = new AbortController(); const p = run(bins.ffmpeg, ['-f', 'lavfi', '-i', 'testsrc=duration=60:size=640x480', '-f', 'null', '-'], { signal: ac.signal });
  setTimeout(() => ac.abort(), 200); await assert.rejects(p, /aborted/);
});
