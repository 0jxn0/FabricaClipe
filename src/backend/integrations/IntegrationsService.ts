// Orquestra cofre + OAuth + teste de conexão. Tudo que sai daqui para o renderer é só status/rótulo/mensagem: NUNCA segredo ou token.
import type { CredentialVault, AccountStatus, Secrets } from '../services/credentials.ts';
import { OAuthService, assertAllowedUrl, type OAuthDeps } from './oauth.ts';
import { PLATFORM_CONFIG, PUBLISH_NOTE, buildGuide, type PlatformId, type TestResult } from './platforms.ts';
import { PLATFORMS } from '../../shared/contracts/jobs.ts';

export interface PlatformStatus {
  platform: PlatformId; name: string; status: AccountStatus; label: string | null; connectedAt: string | null;
  hasClientId: boolean; hasSecret: boolean; message: string | null; secureStorage: boolean; publishAdapter: false; publishNote: string;
}
export interface ServiceDeps {
  vault: CredentialVault; openExternal(url: string): Promise<void>; fetch?: typeof fetch; guardUrl?: OAuthDeps['guardUrl'];
  timeoutMs?: number; now?: () => number; log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class IntegrationsService {
  private d: ServiceDeps; private oauth: OAuthService;
  private busy = new Set<string>(); private msgs = new Map<string, string>(); private hits = new Map<string, number[]>();
  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.oauth = new OAuthService({ openExternal: deps.openExternal, fetch: deps.fetch, guardUrl: deps.guardUrl, timeoutMs: deps.timeoutMs, now: deps.now });
  }
  private now() { return (this.d.now ?? Date.now)(); }
  private log(l: 'info' | 'warn' | 'error', m: string) { this.d.log?.(l, m); }
  private limit(key: string, max: number, windowMs: number) {
    const t = this.now(), a = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (a.length >= max) throw new Error('muitas tentativas seguidas; aguarde um instante');
    a.push(t); this.hits.set(key, a);
  }
  private safeRead(p: PlatformId): Secrets { try { return this.d.vault.read(p); } catch { return {}; } }

  list(): PlatformStatus[] { return PLATFORMS.map((p) => this.item(p)); }
  item(p: PlatformId): PlatformStatus {
    const m = this.d.vault.meta(p), s = this.safeRead(p);
    return { platform: p, name: PLATFORM_CONFIG[p].name, status: m.status, label: m.label, connectedAt: m.connectedAt, hasClientId: !!s.clientId, hasSecret: !!s.clientSecret,
      message: this.msgs.get(p) ?? (m.status === 'error' ? 'Falha anterior; use Testar conexão ou Conectar de novo.' : null), secureStorage: this.d.vault.available(), publishAdapter: false, publishNote: PUBLISH_NOTE };
  }
  guide(p: PlatformId) { return buildGuide(p); }

  async openConsole(p: PlatformId, consoleId: string): Promise<void> {
    this.limit(`console:${p}`, 10, 60_000);
    const c = PLATFORM_CONFIG[p].consoles.find((x) => x.id === consoleId); if (!c) throw new Error('link desconhecido');
    await this.d.openExternal(assertAllowedUrl(c.url, PLATFORM_CONFIG[p].allowedHosts).href);
  }

  saveCredentials(p: PlatformId, clientId: string, clientSecret?: string): PlatformStatus {
    this.limit(`save:${p}`, 10, 60_000);
    const cfg = PLATFORM_CONFIG[p], old = this.safeRead(p), secret = clientSecret?.trim() || old.clientSecret;
    if (cfg.requiresSecret && !secret) throw new Error('informe o Client Secret');
    if (this.busy.has(p)) throw new Error('conexão em andamento; aguarde terminar');
    this.d.vault.write(p, { clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}) }); // credenciais novas invalidam tokens antigos
    this.msgs.delete(p); this.d.vault.setStatus(p, 'credentials', { label: null, connectedAt: null });
    this.log('info', `integração ${p}: credenciais salvas`);
    return this.item(p);
  }

  async connect(p: PlatformId): Promise<PlatformStatus> {
    this.limit(`connect:${p}`, 5, 60_000);
    const cfg = PLATFORM_CONFIG[p], s = this.d.vault.read(p);
    if (!s.clientId || (cfg.requiresSecret && !s.clientSecret)) throw new Error('salve as credenciais antes de conectar');
    if (this.busy.has(p)) throw new Error('já existe uma conexão em andamento para esta plataforma');
    this.busy.add(p);
    try {
      const t = await this.oauth.authorize(cfg, s);
      this.d.vault.write(p, { ...s, ...t });
      this.d.vault.setStatus(p, 'connected', { label: cfg.name, connectedAt: new Date(this.now()).toISOString() });
      this.msgs.delete(p); this.log('info', `integração ${p}: conectada`);
    } catch (e) {
      this.msgs.set(p, (e as Error).message); this.d.vault.setStatus(p, 'error'); this.log('warn', `integração ${p}: conexão falhou: ${(e as Error).message}`); throw e;
    } finally { this.busy.delete(p); }
    return this.item(p);
  }

  /** Com tokens: remove só os tokens (volta a "Credenciais salvas"). Sem tokens: apaga tudo. */
  disconnect(p: PlatformId): PlatformStatus {
    this.limit(`disc:${p}`, 10, 60_000);
    if (this.busy.has(p)) throw new Error('conexão em andamento; aguarde terminar');
    const s = this.safeRead(p); this.msgs.delete(p);
    if (s.accessToken || s.refreshToken) { this.d.vault.write(p, { clientId: s.clientId, clientSecret: s.clientSecret }); this.d.vault.setStatus(p, 'credentials', { label: null, connectedAt: null }); }
    else this.d.vault.clear(p);
    this.log('info', `integração ${p}: desconectada`);
    return this.item(p);
  }

  /** Token válido para chamadas de API (renova se faltar menos de 60 s). Uso interno do main; não exposto por IPC. */
  async accessToken(p: PlatformId): Promise<string> {
    const cfg = PLATFORM_CONFIG[p]; let s = this.d.vault.read(p);
    if (!s.accessToken) throw new Error('conta não conectada');
    if (s.expiresAt && s.expiresAt - this.now() < 60_000) { s = { ...s, ...(await this.oauth.refresh(cfg, s)) }; this.d.vault.write(p, s); }
    return s.accessToken!;
  }

  async test(p: PlatformId): Promise<TestResult> {
    this.limit(`test:${p}`, 10, 60_000);
    const cfg = PLATFORM_CONFIG[p], st = this.d.vault.meta(p).status;
    if (st !== 'connected' && st !== 'error') return { ok: false, message: 'Conta não conectada. Conecte antes de testar.' };
    if (!this.safeRead(p).accessToken) return { ok: false, message: 'Conta não conectada. Conecte antes de testar.' };
    try {
      const token = await this.accessToken(p);
      const res = await (this.d.fetch ?? fetch)(cfg.test.url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const j = await res.json().catch(() => ({}));
      const r: TestResult = res.ok ? cfg.test.describe(j) : { ok: false, message: `A plataforma respondeu HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (token recusado ou sem permissão); reconecte a conta.' : '.'}` };
      if (r.ok) { this.d.vault.setStatus(p, 'connected', r.label ? { label: r.label } : {}); this.msgs.delete(p); }
      else { this.d.vault.setStatus(p, 'error'); this.msgs.set(p, r.message); }
      return { ok: r.ok, message: r.message };
    } catch (e) {
      const m = `Falha no teste: ${(e as Error).message}`; this.d.vault.setStatus(p, 'error'); this.msgs.set(p, m); return { ok: false, message: m };
    }
  }
}
