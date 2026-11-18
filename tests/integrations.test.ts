// Integrações de contas: cofre (safeStorage fake), PKCE (vetores da RFC 7636), OAuth contra servidor FALSO local, allowlist do openExternal, zod dos canais.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Db } from '../src/backend/infrastructure/database/db.ts';
import { CredentialVault, type SafeStorageLike } from '../src/backend/services/credentials.ts';
import { OAuthService, assertAllowedUrl, challengeS256, makeVerifier } from '../src/backend/integrations/oauth.ts';
import { IntegrationsService } from '../src/backend/integrations/IntegrationsService.ts';
import { PLATFORM_CONFIG, buildGuide, type PlatformConfig } from '../src/backend/integrations/platforms.ts';
import { IpcSchemas } from '../src/shared/contracts/ipc.ts';

const made: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'integ-')); made.push(d); return d; };
after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

// cifra reversível de teste (XOR + prefixo): suficiente para provar que o disco nunca recebe o texto original
const fakeSafe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.concat([Buffer.from('ENC1'), Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]),
  decryptString: (b) => Buffer.from(b.subarray(4).map((x) => x ^ 0x5a)).toString('utf8'),
});
const mkVault = (available = true) => { const dir = tmp(), db = new Db(path.join(dir, 'f.sqlite')); db.migrate(); return { dir, db, vault: new CredentialVault(db, path.join(dir, 'secrets'), fakeSafe(available)) }; };
const allBytes = (dir: string): Buffer => { const out: Buffer[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p)); } }; walk(dir); return Buffer.concat(out); };

test('vault: grava cifrado, lê de volta, e nada em claro vai ao disco/banco', () => {
  const { dir, db, vault } = mkVault();
  vault.write('youtube', { clientId: 'CID-abc', clientSecret: 'SEGREDO-xyz', accessToken: 'TOKEN-123' });
  vault.setStatus('youtube', 'connected', { label: 'Meu Canal', connectedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(vault.read('youtube'), { clientId: 'CID-abc', clientSecret: 'SEGREDO-xyz', accessToken: 'TOKEN-123' });
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = allBytes(dir);
  for (const s of ['SEGREDO-xyz', 'TOKEN-123', 'CID-abc']) assert.ok(!bytes.includes(Buffer.from(s)), `${s} apareceu em claro no disco`);
  const m = vault.meta('youtube');
  assert.equal(m.status, 'connected'); assert.equal(m.label, 'Meu Canal'); assert.equal(m.secretFile, 'youtube.bin');
  assert.ok(!JSON.stringify(db.all('SELECT * FROM platform_accounts')).includes('SEGREDO'));
  vault.clear('youtube'); assert.equal(vault.meta('youtube').status, 'none'); assert.deepEqual(vault.read('youtube'), {});
});

test('vault: safeStorage indisponível recusa gravar (nada em disco nem no banco)', () => {
  const { dir, db, vault } = mkVault(false);
  assert.equal(vault.available(), false);
  assert.throws(() => vault.write('tiktok', { clientSecret: 'SEGREDO-xyz' }), /indispon/);
  assert.equal(fs.existsSync(path.join(dir, 'secrets')), false);
  assert.equal(db.all('SELECT * FROM platform_accounts').length, 0);
  assert.throws(() => vault.write('../x', {}), /indispon|inválida/);
});

test('PKCE: vetor da RFC 7636 (Apêndice B) e verifier gerado', () => {
  assert.equal(challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const v = makeVerifier(); assert.match(v, /^[A-Za-z0-9_-]{43,128}$/); assert.notEqual(v, makeVerifier());
  assert.equal(challengeS256('abc', 'hex'), createHash('sha256').update('abc').digest('hex'));
});

test('allowlist do openExternal: só https em domínio oficial', () => {
  const h = PLATFORM_CONFIG.youtube.allowedHosts;
  assert.equal(assertAllowedUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1', h).hostname, 'accounts.google.com');
  for (const bad of ['http://accounts.google.com/', 'https://evil.com/', 'javascript:alert(1)', 'file:///c:/windows/win.ini', 'https://accounts.google.com.evil.com/', 'https://user:pw@accounts.google.com/', 'https://accounts.google.com:8443/', 'https://www.facebook.com/', 'nao é url', 'data:text/html,x'])
    assert.throws(() => assertAllowedUrl(bad, h), /recusada|inválida/, bad);
});

// ---------- provedor OAuth falso ----------
function provider() {
  const calls = { token: [] as Record<string, string>[], api: [] as string[] };
  let challenge = '', lastPort = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const json = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/token') {
        const f = Object.fromEntries(new URLSearchParams(b)); calls.token.push(f);
        if (f.grant_type === 'authorization_code') {
          const okPkce = createHash('sha256').update(f.code_verifier ?? '').digest('base64url') === challenge;
          return f.code === 'good-code' && okPkce && f.client_secret === 'SEGREDO-xyz' ? json(200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 }) : json(400, { error: 'invalid_grant', error_description: 'code ruim' });
        }
        return f.grant_type === 'refresh_token' && f.refresh_token === 'RT1' ? json(200, { access_token: 'AT2', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
      }
      if (req.url?.startsWith('/api')) { calls.api.push(String(req.headers.authorization)); return json(200, { items: [{ snippet: { title: 'Meu Canal' } }] }); }
      json(404, {});
    });
  });
  const listening = new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  /** "navegador": segue o redirect como o usuário faria ao autorizar. */
  const browser = (mode: 'ok' | 'badstate' | 'denied' | 'none' = 'ok') => async (u: string) => {
    const q = new URL(u).searchParams; challenge = q.get('code_challenge') ?? ''; lastPort = Number(new URL(q.get('redirect_uri')!).port);
    if (mode === 'none') return;
    const r = new URL(q.get('redirect_uri')!);
    if (mode === 'denied') r.searchParams.set('error', 'access_denied'); else r.searchParams.set('code', 'good-code');
    r.searchParams.set('state', mode === 'badstate' ? 'forjado' : q.get('state')!);
    setImmediate(() => void fetch(r).then((x) => x.arrayBuffer()).catch(() => {}));
  };
  const base = () => `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  const cfg = async (): Promise<PlatformConfig> => { await listening; return { ...PLATFORM_CONFIG.youtube, authUrl: `${base()}/auth`, tokenUrl: `${base()}/token`, fixedPort: 0, test: { ...PLATFORM_CONFIG.youtube.test, url: `${base()}/api` } }; };
  return { calls, browser, cfg, port: () => lastPort, close: () => srv.close() };
}
const portClosed = (port: number) => new Promise<boolean>((ok) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); ok(false); }); s.once('error', () => ok(true)); });
const noGuard = () => {};
const CREDS = { clientId: 'CID-abc', clientSecret: 'SEGREDO-xyz' };

test('OAuth: troca de code com PKCE, state validado e porta fechada depois', async () => {
  const p = provider(); const cfg = await p.cfg();
  const svc = new OAuthService({ openExternal: p.browser('ok'), guardUrl: noGuard, timeoutMs: 5000 });
  const t = await svc.authorize(cfg, CREDS);
  assert.equal(t.accessToken, 'AT1'); assert.equal(t.refreshToken, 'RT1'); assert.ok(t.expiresAt! > Date.now());
  assert.equal(p.calls.token[0].client_id, 'CID-abc'); assert.match(p.calls.token[0].redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok(await portClosed(p.port()), 'porta loopback deveria estar fechada');
  p.close();
});

test('OAuth: state errado é ignorado (404), não derruba o fluxo, não troca o code e a porta fecha ao expirar', async () => {
  const p = provider(); const cfg = await p.cfg();
  const svc = new OAuthService({ openExternal: p.browser('badstate'), guardUrl: noGuard, timeoutMs: 5000 });
  await assert.rejects(svc.authorize(cfg, CREDS), /tempo esgotado/);
  assert.equal(p.calls.token.length, 0); assert.ok(await portClosed(p.port())); p.close();
});

test('OAuth: autorização negada e timeout', async () => {
  const p = provider(); const cfg = await p.cfg();
  await assert.rejects(new OAuthService({ openExternal: p.browser('denied'), guardUrl: noGuard, timeoutMs: 5000 }).authorize(cfg, CREDS), /recusou.*access_denied/);
  await assert.rejects(new OAuthService({ openExternal: p.browser('none'), guardUrl: noGuard, timeoutMs: 150 }).authorize(cfg, CREDS), /tempo esgotado/);
  assert.ok(await portClosed(p.port())); assert.equal(p.calls.token.length, 0); p.close();
});

test('OAuth: guarda padrão recusa authUrl http (o navegador nem é aberto) e refresh funciona', async () => {
  const p = provider(); const cfg = await p.cfg(); let opened = 0;
  await assert.rejects(new OAuthService({ openExternal: async () => { opened++; }, timeoutMs: 500 }).authorize(cfg, CREDS), /recusada/);
  assert.equal(opened, 0);
  const svc = new OAuthService({ openExternal: p.browser(), guardUrl: noGuard });
  const r = await svc.refresh(cfg, { ...CREDS, refreshToken: 'RT1', accessToken: 'AT1' });
  assert.equal(r.accessToken, 'AT2'); assert.equal(r.refreshToken, 'RT1'); // Google não devolve refresh novo: mantém o antigo
  await assert.rejects(svc.refresh(cfg, { ...CREDS }), /reconecte/);
  p.close();
});

test('IntegrationsService: salvar, conectar, listar sem segredos, testar, renovar, desconectar', async () => {
  const p = provider(); const saved = { ...PLATFORM_CONFIG.youtube }; Object.assign(PLATFORM_CONFIG.youtube, await p.cfg());
  try {
    const { dir, vault } = mkVault(); let clock = Date.now(); const logs: string[] = [];
    const svc = new IntegrationsService({ vault, openExternal: p.browser(), guardUrl: noGuard, now: () => clock, timeoutMs: 5000, log: (_l, m) => logs.push(m) });
    assert.equal(svc.list().find((x) => x.platform === 'youtube')!.status, 'none');
    assert.deepEqual(await svc.test('youtube'), { ok: false, message: 'Conta não conectada. Conecte antes de testar.' });
    await assert.rejects(svc.connect('youtube'), /salve as credenciais/);
    svc.saveCredentials('youtube', 'CID-abc', 'SEGREDO-xyz');
    assert.equal(svc.item('youtube').status, 'credentials');
    assert.equal((await svc.connect('youtube')).status, 'connected');
    const r = await svc.test('youtube'); assert.equal(r.ok, true); assert.match(r.message, /Meu Canal/); assert.equal(svc.item('youtube').label, 'Meu Canal');
    assert.equal(p.calls.api.at(-1), 'Bearer AT1');
    clock += 3_600_000; await svc.test('youtube'); assert.equal(p.calls.api.at(-1), 'Bearer AT2'); // expirado: renovou antes de chamar
    const exposed = JSON.stringify(svc.list()) + logs.join('\n');
    for (const s of ['SEGREDO-xyz', 'AT1', 'AT2', 'RT1']) assert.ok(!exposed.includes(s), `${s} vazou para a lista/logs`);
    assert.ok(!allBytes(dir).includes(Buffer.from('RT1')));
    assert.equal(svc.item('youtube').publishAdapter, false);
    assert.equal(svc.disconnect('youtube').status, 'credentials');
    assert.equal(svc.disconnect('youtube').status, 'none');
    await assert.rejects(svc.openConsole('youtube', 'inexistente'), /desconhecido/);
  } finally { Object.assign(PLATFORM_CONFIG.youtube, saved); p.close(); }
});

test('IntegrationsService: cofre indisponível recusa salvar; rate-limit; consoles abrem só URL da allowlist', async () => {
  const { vault } = mkVault(false); const opened: string[] = [];
  const svc = new IntegrationsService({ vault, openExternal: async (u) => { opened.push(u); } });
  assert.throws(() => svc.saveCredentials('tiktok', 'k', 's'), /indispon/);
  assert.equal(svc.list()[0].secureStorage, false);
  for (const id of ['apps']) { await svc.openConsole('tiktok', id); }
  assert.deepEqual(opened, ['https://developers.tiktok.com/apps/']);
  for (let i = 0; i < 9; i++) await svc.openConsole('tiktok', 'apps');
  await assert.rejects(svc.openConsole('tiktok', 'apps'), /muitas tentativas/);
  for (const c of Object.values(PLATFORM_CONFIG)) for (const k of c.consoles) assert.doesNotThrow(() => assertAllowedUrl(k.url, c.allowedHosts), k.url);
});

test('guia: 6 passos por plataforma, redirect exibido e aviso de publicação ausente', () => {
  for (const id of ['youtube', 'instagram', 'tiktok', 'facebook'] as const) {
    const g = buildGuide(id); assert.equal(g.steps.length, 6); assert.equal(g.publishAdapter, false); assert.match(g.publishNote, /NÃO existe/);
    assert.match(g.redirectUri, /^http:\/\/127\.0\.0\.1:/); assert.ok(g.fields.some((f) => f.secret));
  }
  assert.match(buildGuide('instagram').steps[0], /PROFISSIONAL/);
});

test('zod dos canais de integração', () => {
  const S = IpcSchemas;
  assert.equal(S.integSave.parse({ platform: 'youtube', clientId: ' abc ', clientSecret: 'x' }).clientId, 'abc');
  for (const bad of [{ platform: 'orkut', clientId: 'a' }, { platform: 'youtube', clientId: '' }, { platform: 'youtube', clientId: 'a b' }, { platform: 'youtube', clientId: 'a', clientSecret: 'x'.repeat(513) }, { platform: 'youtube' }, 'x', null])
    assert.throws(() => S.integSave.parse(bad), Error, JSON.stringify(bad));
  assert.equal(S.integPlatform.parse({ platform: 'tiktok' }).platform, 'tiktok');
  assert.throws(() => S.integPlatform.parse({ platform: '../etc' }));
  assert.throws(() => S.integConsole.parse({ platform: 'youtube', consoleId: 'http://x' }));
});
