// OAuth 2.0 Authorization Code + PKCE (RFC 7636) com redirect em loopback. Sem automação de navegador: o usuário autoriza no navegador padrão.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlatformConfig } from './platforms.ts';
import type { Secrets } from '../services/credentials.ts';

export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt?: number }

export const b64url = (b: Buffer) => b.toString('base64url');
export const makeVerifier = () => b64url(randomBytes(32)); // 43 caracteres, dentro de 43..128 da RFC
export const challengeS256 = (verifier: string, enc: 'base64url' | 'hex' = 'base64url') => { const h = createHash('sha256').update(verifier, 'ascii').digest(); return enc === 'hex' ? h.toString('hex') : b64url(h); };

/** Só https, sem credenciais embutidas, sem porta, host na allowlist da plataforma. Usado antes de QUALQUER shell.openExternal. */
export function assertAllowedUrl(raw: string, hosts: string[]): URL {
  let u: URL; try { u = new URL(raw); } catch { throw new Error('URL inválida'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.includes(u.hostname.toLowerCase())) throw new Error('URL recusada: só https em domínios oficiais da plataforma');
  return u;
}

export interface OAuthDeps {
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** Padrão: allowlist da plataforma. Testes com servidor falso http injetam outra. */
  guardUrl?: (url: string, cfg: PlatformConfig) => void;
  timeoutMs?: number; now?: () => number;
}

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const PAGE = (t: string) => `<!doctype html><meta charset="utf-8"><title>Fábrica de Clipe</title><body style="font:16px system-ui;padding:2em"><p>${t}</p></body>`;

export class OAuthService {
  private d: OAuthDeps;
  constructor(deps: OAuthDeps) { this.d = deps; }
  private f() { return this.d.fetch ?? fetch; }
  private now() { return (this.d.now ?? Date.now)(); }

  async authorize(cfg: PlatformConfig, creds: Secrets): Promise<TokenSet> {
    if (!creds.clientId) throw new Error('credenciais não salvas');
    const state = randomBytes(16).toString('hex'), verifier = makeVerifier();
    let port = 0, settle!: { ok(c: string): void; fail(e: Error): void };
    const result = new Promise<string>((ok, fail) => { settle = { ok, fail }; });
    result.catch(() => {}); // a rejeição é consumida abaixo; evita "unhandled" se o navegador não abrir
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reply = (code: number, t: string) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', connection: 'close', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }); res.end(PAGE(t)); };
      // Host fixo (anti DNS-rebinding), só GET /callback; qualquer outra coisa é ignorada e o fluxo segue esperando.
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || u.pathname !== '/callback') return reply(404, 'Não encontrado.');
      const st = u.searchParams.get('state');
      if (!st || !safeEq(st, state)) return reply(404, 'Não encontrado.'); // requisição de terceiros não derruba o fluxo do usuário
      const err = u.searchParams.get('error'), code = u.searchParams.get('code');
      if (err) { reply(200, 'Autorização negada. Você pode fechar esta aba.'); return settle.fail(new Error(`a plataforma recusou a autorização (${err.slice(0, 60).replace(/[^\w .-]/g, '')})`)); }
      if (!code) { reply(400, 'Resposta sem código.'); return settle.fail(new Error('retorno sem código de autorização')); }
      reply(200, 'Conta conectada. Você pode fechar esta aba e voltar ao app.'); settle.ok(code);
    });
    const close = () => { server.close(); server.closeAllConnections(); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((ok, fail) => {
        server.once('error', (e: NodeJS.ErrnoException) => fail(new Error(e.code === 'EADDRINUSE' ? `a porta ${cfg.fixedPort} está em uso; feche o programa que a usa e tente de novo` : `não foi possível abrir o retorno local: ${e.code ?? e.message}`)));
        server.listen(cfg.fixedPort, '127.0.0.1', () => ok());
      });
      port = (server.address() as { port: number }).port;
      const redirect = `http://127.0.0.1:${port}/callback`;
      const q = new URLSearchParams({ response_type: 'code', [cfg.clientIdParam]: creds.clientId, redirect_uri: redirect, scope: cfg.scopes.join(cfg.scopeSep), state, ...cfg.extraAuthParams });
      if (cfg.pkce) { q.set('code_challenge', challengeS256(verifier, cfg.challenge)); q.set('code_challenge_method', 'S256'); }
      const url = `${cfg.authUrl}${cfg.authUrl.includes('?') ? '&' : '?'}${q}`;
      (this.d.guardUrl ?? ((x, c) => void assertAllowedUrl(x, c.allowedHosts)))(url, cfg);
      const safeUrl = new URL(url).href; // abre a forma normalizada, a mesma que foi validada
      timer = setTimeout(() => settle.fail(new Error('tempo esgotado: nenhuma autorização recebida em 3 minutos')), this.d.timeoutMs ?? 180_000);
      await this.d.openExternal(safeUrl);
      const code = await result;
      return await this.token(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirect, ...(cfg.pkce ? { code_verifier: verifier } : {}), ...this.client(cfg, creds) });
    } finally { clearTimeout(timer); close(); }
  }

  /** Renova o access token. Google/TikTok: refresh_token. Meta: troca por token de longa duração. */
  async refresh(cfg: PlatformConfig, creds: Secrets): Promise<TokenSet> {
    if (cfg.refresh === 'fb_exchange') {
      if (!creds.accessToken) throw new Error('sem token para renovar; reconecte a conta');
      return this.token(cfg, { grant_type: 'fb_exchange_token', fb_exchange_token: creds.accessToken, ...this.client(cfg, creds) });
    }
    if (!creds.refreshToken) throw new Error('sem token de atualização; reconecte a conta');
    const t = await this.token(cfg, { grant_type: 'refresh_token', refresh_token: creds.refreshToken, ...this.client(cfg, creds) });
    return { ...t, refreshToken: t.refreshToken ?? creds.refreshToken };
  }

  private client(cfg: PlatformConfig, c: Secrets): Record<string, string> {
    return { [cfg.clientIdParam]: c.clientId ?? '', ...(c.clientSecret ? { client_secret: c.clientSecret } : {}) };
  }

  private async token(cfg: PlatformConfig, body: Record<string, string>): Promise<TokenSet> {
    let res: Response;
    try { res = await this.f()(cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body), redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch (e) { throw new Error(`sem resposta do servidor de autorização (${(e as Error).name})`); }
    const j = await res.json().catch(() => ({})) as Record<string, any>;
    const eo = j.error, detail = String((typeof eo === 'object' && eo ? eo.message : j.error_description ?? eo) ?? '').slice(0, 160); // nunca ecoa o corpo inteiro
    if (!res.ok || typeof j.access_token !== 'string') throw new Error(`falha ao obter o token (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    const exp = Number(j.expires_in);
    return { accessToken: j.access_token, ...(typeof j.refresh_token === 'string' ? { refreshToken: j.refresh_token } : {}), ...(exp > 0 ? { expiresAt: this.now() + exp * 1000 } : {}) };
  }
}
