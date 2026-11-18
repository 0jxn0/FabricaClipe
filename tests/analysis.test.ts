import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFile } from '../src/backend/services/analysis.ts';
import { resolveBins, run } from '../src/backend/infrastructure/ffmpeg/ffmpeg.ts';

const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'fabrica-an-')), bins = resolveBins();
const mk = (name: string, args: string[]) => run(bins.ffmpeg, ['-v', 'error', ...args, path.join(dir, name)]).then((r) => { assert.equal(r.code, 0, r.stderr); return path.join(dir, name); });

test('vídeo bom com áudio: ok e metadados reais', async () => {
  const f = await mk('ok.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const r = await analyzeFile(f, bins); assert.equal(r.ok, true); assert.equal(r.info!.width, 1280); assert.ok(r.problems.some((p) => p.code === 'landscape'));
});
test('sem áudio e baixa resolução geram avisos', async () => {
  const f = await mk('mudo.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const r = await analyzeFile(f, bins); const codes = r.problems.map((p) => p.code);
  assert.ok(r.ok && codes.includes('no-audio') && codes.includes('low-resolution') && codes.includes('low-fps'));
});
test('corrompido, inexistente e extensão inválida viram erro com relatório', async () => {
  const bad = path.join(dir, 'ruim.mp4'); fs.writeFileSync(bad, 'nada');
  assert.equal((await analyzeFile(bad, bins)).problems[0]!.code, 'unreadable');
  assert.equal((await analyzeFile(path.join(dir, 'x.mp4'), bins)).ok, false);
  assert.equal((await analyzeFile(path.join(dir, 'a.txt'), bins)).problems[0]!.code, 'invalid-file');
});
