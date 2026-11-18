// Cofre de credenciais: segredos só em disco CIFRADOS pelo safeStorage do SO (DPAPI no Windows). O banco guarda apenas metadados.
// Sem safeStorage disponível o cofre RECUSA gravar: nunca há texto claro em disco ou no banco.
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../infrastructure/database/db.ts';

/** Subconjunto do `safeStorage` do Electron (injetado para poder testar com um fake). */
export interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }

export interface Secrets { clientId?: string; clientSecret?: string; accessToken?: string; refreshToken?: string; expiresAt?: number }
export type AccountStatus = 'none' | 'credentials' | 'connected' | 'error';
export interface AccountMeta { platform: string; label: string | null; status: AccountStatus; connectedAt: string | null; secretFile: string | null }

const ID = /^[a-z]{2,20}$/;

export class CredentialVault {
  private db: Db; private dir: string; private safe: SafeStorageLike;
  constructor(db: Db, dir: string, safe: SafeStorageLike) { this.db = db; this.dir = dir; this.safe = safe; }

  available(): boolean { try { return this.safe.isEncryptionAvailable(); } catch { return false; } }
  private need() { if (!this.available()) throw new Error('armazenamento seguro do sistema indisponível: as credenciais NÃO foram gravadas'); }
  private file(platform: string) { if (!ID.test(platform)) throw new Error('plataforma inválida'); return path.join(this.dir, `${platform}.bin`); }

  meta(platform: string): AccountMeta {
    const r = this.db.get<{ label: string | null; status: AccountStatus; connected_at: string | null; secret_file: string | null }>('SELECT label, status, connected_at, secret_file FROM platform_accounts WHERE platform = ?', platform);
    return { platform, label: r?.label ?? null, status: r?.status ?? 'none', connectedAt: r?.connected_at ?? null, secretFile: r?.secret_file ?? null };
  }

  /** Lê e decifra. Só para uso do main process: nunca devolva isto ao renderer. */
  read(platform: string): Secrets {
    const f = this.file(platform); if (!fs.existsSync(f)) return {};
    this.need();
    try { return JSON.parse(this.safe.decryptString(fs.readFileSync(f))) as Secrets; }
    catch { throw new Error('cofre ilegível (outro usuário do Windows ou arquivo corrompido): salve as credenciais de novo'); }
  }

  /** Cifra e grava (atômico). Preserva status/label já existentes. */
  write(platform: string, secrets: Secrets): void {
    this.need(); const f = this.file(platform);
    const blob = this.safe.encryptString(JSON.stringify(secrets));
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, blob, { mode: 0o600 }); fs.renameSync(tmp, f);
    this.db.run('INSERT INTO platform_accounts (platform, secret_file) VALUES (?, ?) ON CONFLICT(platform) DO UPDATE SET secret_file = excluded.secret_file', platform, path.basename(f));
  }

  setStatus(platform: string, status: AccountStatus, extra: { label?: string | null; connectedAt?: string | null } = {}): void {
    const m = this.meta(platform);
    this.db.run('INSERT INTO platform_accounts (platform, status, label, connected_at) VALUES (?, ?, ?, ?) ON CONFLICT(platform) DO UPDATE SET status = excluded.status, label = excluded.label, connected_at = excluded.connected_at',
      platform, status, extra.label !== undefined ? extra.label : m.label, extra.connectedAt !== undefined ? extra.connectedAt : m.connectedAt);
  }

  /** Apaga o arquivo cifrado e zera os metadados. */
  clear(platform: string): void {
    fs.rmSync(this.file(platform), { force: true });
    this.db.run('DELETE FROM platform_accounts WHERE platform = ?', platform);
  }
}
