// Funções puras da interface desktop (botões por estado, input de criação) e resolução segura do preview media://.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/backend/infrastructure/database/db.ts';
import { CreateJobInput } from '../src/shared/contracts/jobs.ts';
import { csp } from '../src/main/security/csp.ts';
import { jobIdFromUrl, mediaUrl, parseRange, resolveJobMedia, resolveRegistered } from '../src/main/media/media.ts';
// @ts-ignore módulo JS do frontend (sem tipos)
import { actionsFor, awaitingApproval, buildCreateInput, cleanIpcError, jobForDesk, nameFromPath } from '../public/src/view/jobLogic.js';

const made: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'ui-media-')); made.push(d); return d; };
after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

test('botões por estado do job', () => {
  assert.deepEqual(actionsFor('processing'), ['pause', 'cancel']);
  assert.deepEqual(actionsFor('queued'), ['pause', 'cancel']);
  assert.deepEqual(actionsFor('paused'), ['resume', 'cancel']);
  assert.deepEqual(actionsFor('failed'), ['retry', 'cancel']);
  assert.deepEqual(actionsFor('awaiting_approval'), ['cancel']);
  for (const s of ['completed', 'cancelled', 'approved', 'rejected', 'xyz']) assert.deepEqual(actionsFor(s), []);
});

test('job da estação em foco e fila de aprovação', () => {
  const jobs = [{ id: 'a', stationId: 'cutting', state: 'completed' }, { id: 'b', stationId: 'cutting', state: 'paused' }, { id: 'c', stationId: 'approval', state: 'awaiting_approval' }];
  assert.equal(jobForDesk(jobs, 'desk-2').id, 'b');
  assert.equal(jobForDesk(jobs, 'desk-1'), null);
  assert.equal(jobForDesk(jobs, 'desk-99'), null);
  assert.deepEqual(awaitingApproval(jobs).map((j: { id: string }) => j.id), ['c']);
});

test('input de criação: nome, corte, legendas e validação (aceito pelo schema zod)', () => {
  assert.equal(nameFromPath('C:\\v\\Meu clipe.final.MP4'), 'Meu clipe.final');
  assert.equal(nameFromPath('/x/y/video.mov'), 'video');
  const ok = buildCreateInput('C:\\v\\a.mp4', { platforms: ['youtube'], start: '1,5', duration: '10', subtitles: false });
  assert.equal(ok.error, undefined);
  const p = CreateJobInput.parse(ok.input);
  assert.deepEqual([p.name, p.platforms, p.config.cut, p.config.subtitles], ['a', ['youtube'], { startSec: 1.5, durationSec: 10 }, 'off']);
  assert.equal(CreateJobInput.parse(buildCreateInput('/a.mp4', { start: '', duration: '', subtitles: true }).input).config.subtitles, 'auto');
  assert.ok(buildCreateInput('/a.mp4', { duration: '0.1' }).error);
  assert.ok(buildCreateInput('/a.mp4', { start: '-3' }).error);
  assert.ok(buildCreateInput('/a.mp4', { start: 'abc' }).error);
});

test('erro do IPC sem prefixo técnico', () => {
  assert.equal(cleanIpcError(new Error("Error invoking remote method 'fabrica:jobs:create': Error: Formato não suportado: .txt")), 'Formato não suportado: .txt');
});

test('CSP libera media-src só para media:', () => {
  const c = csp('x'); assert.match(c, /media-src media:(;|$)/); assert.ok(!/media-src[^;]*(\*|'self'|https?:)/.test(c));
});

test('parseRange', () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-5000', 100), { start: 50, end: 99 });
  for (const h of ['bytes=100-', 'bytes=9-5', 'bytes=-', 'bytes=-0', 'bytes=0-1,5-6', 'items=0-1', 'bytes=a-b']) assert.equal(parseRange(h, 100), 'invalid', h);
});

test('jobId da URL media://', () => {
  assert.equal(jobIdFromUrl(mediaUrl('job-1001')), 'job-1001');
  assert.equal(jobIdFromUrl('media://job/job-7'), 'job-7');
  for (const u of ['media://evil/job-1', 'media://job/..%2f..%2fetc', 'media://job/a/b', 'media://job/', 'app://job/job-1', 'media://job/%E0%A4%A']) assert.throws(() => jobIdFromUrl(u), u);
});

test('resolveRegistered: dentro de projects, sem traversal nem symlink', () => {
  const data = tmp(), proj = path.join(data, 'projects'); fs.mkdirSync(path.join(proj, 'p'), { recursive: true });
  const ok = path.join(proj, 'p', 'final.mp4'); fs.writeFileSync(ok, 'x'.repeat(10));
  assert.equal(resolveRegistered(proj, ok).size, 10);
  assert.equal(resolveRegistered(proj, ok).mime, 'video/mp4');
  const out = path.join(data, 'fora.mp4'); fs.writeFileSync(out, 'x');
  assert.throws(() => resolveRegistered(proj, out), /fora da pasta/);
  assert.throws(() => resolveRegistered(proj, path.join(proj, 'p', '..', '..', 'fora.mp4')), /fora da pasta/);
  assert.throws(() => resolveRegistered(proj, path.join(proj, 'p', 'final.txt')), /formato/);
  assert.throws(() => resolveRegistered(proj, 'p/final.mp4'), /inválido/);
  assert.throws(() => resolveRegistered(proj, path.join(proj, 'p')), /formato|regular/);
  const link = path.join(proj, 'p', 'link.mp4');
  try { fs.symlinkSync(out, link); assert.throws(() => resolveRegistered(proj, link), /regular|fora/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; }
  const dirLink = path.join(proj, 'jx'); // junction não exige privilégio no Windows
  try { fs.symlinkSync(data, dirLink, 'junction'); assert.throws(() => resolveRegistered(proj, path.join(dirLink, 'fora.mp4')), /fora da pasta|regular/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; }
});

test('resolveJobMedia: só job aguardando aprovação com arquivo registrado no banco', () => {
  const data = tmp(), proj = path.join(data, 'projects'); fs.mkdirSync(proj, { recursive: true });
  const db = new Db(path.join(data, 'db.sqlite')); db.migrate();
  const now = new Date().toISOString(); db.run("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES ('default','default',?)", now);
  const add = (id: string, state: string, file: string, register: boolean) => {
    db.run("INSERT INTO jobs (id, name, project_id, source_path, current_path, station_id, state, config_json, created_at, updated_at) VALUES (?, 'n', 'default', ?, ?, 'approval', ?, '{}', ?, ?)", id, file, file, state, now, now);
    if (register) db.run("INSERT INTO media_files (job_id, station_id, kind, path, created_at) VALUES (?, 'rendering', 'output', ?, ?)", id, file, now);
  };
  const good = path.join(proj, 'g.mp4'), outside = path.join(data, 'o.mp4'); fs.writeFileSync(good, 'abc'); fs.writeFileSync(outside, 'abc');
  add('j-ok', 'awaiting_approval', good, true); add('j-unreg', 'awaiting_approval', good, false);
  add('j-state', 'processing', good, true); add('j-out', 'awaiting_approval', outside, true);
  assert.equal(resolveJobMedia(db, data, 'j-ok').size, 3);
  assert.throws(() => resolveJobMedia(db, data, 'j-unreg'), /registrado/);
  assert.throws(() => resolveJobMedia(db, data, 'j-state'), /aguardando/);
  assert.throws(() => resolveJobMedia(db, data, 'j-out'), /fora da pasta/);
  assert.throws(() => resolveJobMedia(db, data, 'nao-existe'), /inexistente/);
  assert.throws(() => resolveJobMedia(db, data, '../x'), /inválido/);
  db.raw.close();
});
