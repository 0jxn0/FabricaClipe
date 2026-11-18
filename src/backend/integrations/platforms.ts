// Configuração oficial de cada plataforma de publicação + passo a passo (o mesmo texto vai para a UI e para docs/INTEGRACOES.md).
// Escrito a partir do conhecimento da documentação oficial; NÃO foi possível verificar online. Cada ponto incerto está em `unverified`.
import { PLATFORMS } from '../../shared/contracts/jobs.ts';

export type PlatformId = (typeof PLATFORMS)[number];

export interface TestResult { ok: boolean; message: string; label?: string }

export interface PlatformConfig {
  id: PlatformId; name: string;
  authUrl: string; tokenUrl: string; scopes: string[]; scopeSep: ' ' | ',';
  clientIdParam: 'client_id' | 'client_key'; requiresSecret: boolean;
  pkce: boolean; challenge: 'base64url' | 'hex'; extraAuthParams: Record<string, string>;
  refresh: 'refresh_token' | 'fb_exchange';
  /** Domínios https permitidos para shell.openExternal (login e consoles). Nada fora disto é aberto. */
  allowedHosts: string[];
  consoles: { id: string; label: string; url: string }[];
  /** 0 = porta aleatória (Google aceita qualquer porta em loopback). Meta/TikTok exigem redirect URI exato: porta fixa registrada no console. */
  fixedPort: number;
  clientIdLabel: string;
  test: { url: string; describe(json: any): TestResult };
  setup(redirectUri: string): string[];
  limitations: string[];
  unverified: string[];
}

const GRAPH = 'https://graph.facebook.com/v21.0';
const META_HOSTS = ['www.facebook.com', 'developers.facebook.com'];
const META_CONSOLE = [{ id: 'apps', label: 'Meta for Developers: meus apps', url: 'https://developers.facebook.com/apps/' }];

export const PLATFORM_CONFIG: Record<PlatformId, PlatformConfig> = {
  youtube: {
    id: 'youtube', name: 'YouTube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    // youtube.upload publica; youtube.readonly existe só para o botão "Testar" (channels?mine=true não aceita youtube.upload).
    scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'], scopeSep: ' ',
    clientIdParam: 'client_id', requiresSecret: true, pkce: true, challenge: 'base64url',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' }, refresh: 'refresh_token',
    allowedHosts: ['accounts.google.com', 'console.cloud.google.com'],
    consoles: [
      { id: 'credentials', label: 'Google Cloud: credenciais', url: 'https://console.cloud.google.com/apis/credentials' },
      { id: 'library', label: 'Google Cloud: ativar a YouTube Data API v3', url: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' },
      { id: 'consent', label: 'Google Cloud: tela de consentimento', url: 'https://console.cloud.google.com/apis/credentials/consent' },
    ],
    fixedPort: 0, clientIdLabel: 'Client ID',
    test: {
      url: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      describe: (j) => { const t = j?.items?.[0]?.snippet?.title; return t ? { ok: true, message: `Canal encontrado: ${t}`, label: String(t) } : { ok: false, message: 'Conta autorizada, mas sem canal do YouTube associado.' }; },
    },
    setup: () => [
      'Crie (ou escolha) um projeto no Google Cloud Console e ative a "YouTube Data API v3" (link do console abaixo).',
      'Configure a Tela de consentimento OAuth (modo Externo; em "Teste", adicione seu e-mail como usuário de teste). Depois crie uma credencial "ID do cliente OAuth" do tipo "Aplicativo para computador". Esse tipo aceita o redirect em loopback http://127.0.0.1:<qualquer porta>/callback, sem cadastrar nada.',
      'Escopos usados: youtube.upload (publicar) e youtube.readonly (só para o botão Testar conexão). Em modo "Teste" o Google expira o token de atualização em 7 dias.',
    ],
    limitations: ['O Google exige tela de consentimento configurada e uma credencial do tipo "Aplicativo para computador".', 'Vídeos enviados por projetos de API não auditados ficam privados até a verificação do projeto pelo YouTube.', 'Com a tela de consentimento em "Teste", o token expira em 7 dias e é preciso reconectar.'],
    unverified: ['Cota/auditoria da API de upload do YouTube', 'Prazo de 7 dias do token em modo Teste'],
  },
  facebook: {
    id: 'facebook', name: 'Facebook',
    authUrl: 'https://www.facebook.com/v21.0/dialog/oauth', tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_video'], scopeSep: ',',
    clientIdParam: 'client_id', requiresSecret: true, pkce: false, challenge: 'base64url', extraAuthParams: {}, refresh: 'fb_exchange',
    allowedHosts: META_HOSTS, consoles: META_CONSOLE, fixedPort: 53781, clientIdLabel: 'ID do app (App ID)',
    test: {
      url: `${GRAPH}/me/accounts?fields=id,name&limit=5`,
      describe: (j) => { const p = j?.data?.[0]; return p ? { ok: true, message: `Página encontrada: ${p.name}`, label: String(p.name) } : { ok: false, message: 'Conta autorizada, mas nenhuma Página do Facebook administrada por você foi encontrada.' }; },
    },
    setup: (r) => [
      'Em Meta for Developers crie um app do tipo "Empresa" (Business) e adicione o produto "Login do Facebook".',
      `Em "Login do Facebook > Configurações" adicione em "URIs de redirecionamento OAuth válidos" exatamente: ${r}`,
      'Permissões usadas: pages_show_list, pages_read_engagement, pages_manage_posts, publish_video. Sem "Revisão do app" elas só funcionam para administradores/testadores do app (modo Desenvolvimento).',
    ],
    limitations: ['Publicar em Páginas exige que você administre uma Página do Facebook.', 'Fora do modo Desenvolvimento as permissões exigem Revisão do app pela Meta.', 'A Meta não usa refresh token: o token dura cerca de 60 dias e depois é preciso reconectar.'],
    unverified: ['Versão v21.0 da Graph API (pode estar defasada)', 'A Meta não documenta PKCE no login web: o app usa client_secret + state (PKCE desligado aqui)', 'Conjunto exato de permissões para vídeo em Páginas', 'Redirect em loopback http://127.0.0.1 com porta fixa aceito no modo Desenvolvimento'],
  },
  instagram: {
    id: 'instagram', name: 'Instagram',
    authUrl: 'https://www.facebook.com/v21.0/dialog/oauth', tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'], scopeSep: ',',
    clientIdParam: 'client_id', requiresSecret: true, pkce: false, challenge: 'base64url', extraAuthParams: {}, refresh: 'fb_exchange',
    allowedHosts: META_HOSTS, consoles: META_CONSOLE, fixedPort: 53782, clientIdLabel: 'ID do app (App ID)',
    test: {
      url: `${GRAPH}/me/accounts?fields=id,name,instagram_business_account&limit=25`,
      describe: (j) => {
        const p = (j?.data ?? []).find((x: any) => x?.instagram_business_account?.id);
        return p ? { ok: true, message: `Conta profissional do Instagram ligada à Página: ${p.name}`, label: String(p.name) }
          : { ok: false, message: 'Conta autorizada, mas nenhuma Página tem uma conta profissional do Instagram ligada.' };
      },
    },
    setup: (r) => [
      'ANTES: sua conta do Instagram precisa ser PROFISSIONAL (Comercial ou Criador) e estar LIGADA a uma Página do Facebook que você administra. Conta pessoal não publica pela API.',
      `Em Meta for Developers crie um app "Empresa" com o produto "Login do Facebook" e adicione em "URIs de redirecionamento OAuth válidos" exatamente: ${r}`,
      'Permissões usadas (API do Instagram com Login do Facebook): instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement. Sem Revisão do app só funcionam em modo Desenvolvimento.',
    ],
    limitations: ['Exige conta profissional do Instagram ligada a uma Página do Facebook.', 'Fora do modo Desenvolvimento as permissões exigem Revisão do app pela Meta.', 'O vídeo precisa estar em URL pública para a Graph API buscar: publicar de verdade exige hospedar o arquivo temporariamente (ainda não implementado).'],
    unverified: ['Versão v21.0 da Graph API', 'A Meta não documenta PKCE no login web (desligado aqui)', 'Nomes das permissões do Instagram (mudam com frequência)'],
  },
  tiktok: {
    id: 'tiktok', name: 'TikTok',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/', tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.publish'], scopeSep: ',',
    clientIdParam: 'client_key', requiresSecret: true, pkce: true, challenge: 'hex', extraAuthParams: {}, refresh: 'refresh_token',
    allowedHosts: ['www.tiktok.com', 'developers.tiktok.com'],
    consoles: [{ id: 'apps', label: 'TikTok for Developers: meus apps', url: 'https://developers.tiktok.com/apps/' }],
    fixedPort: 53783, clientIdLabel: 'Client Key',
    test: {
      url: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
      describe: (j) => { const n = j?.data?.user?.display_name; return n ? { ok: true, message: `Conta TikTok: ${n}`, label: String(n) } : { ok: false, message: String(j?.error?.message || 'Resposta sem dados do usuário.').slice(0, 200) }; },
    },
    setup: (r) => [
      'Em TikTok for Developers crie um app e adicione os produtos "Login Kit" e "Content Posting API" (ative "Direct Post").',
      `Em Login Kit, cadastre o Redirect URI exatamente: ${r}`,
      'Escopos usados: user.info.basic e video.publish. App NÃO auditado só publica vídeos PRIVADOS (somente você vê) até passar pela auditoria do TikTok.',
    ],
    limitations: ['App não auditado só consegue publicar com visibilidade privada.', 'É preciso adicionar sua conta como "Target User" enquanto o app está em sandbox.'],
    unverified: ['O code_challenge do TikTok é o SHA-256 em HEX (não base64url, como na RFC 7636)', 'Aceitação de redirect em loopback http://127.0.0.1 com porta fixa', 'Nome dos parâmetros (client_key) e endpoints v2'],
  },
};

export const GUIDE_COMMON = (cfg: PlatformConfig) => [
  `Cole aqui o ${cfg.clientIdLabel}${cfg.requiresSecret ? ' e o Client Secret' : ''} e clique em Salvar. Eles ficam criptografados no cofre do sistema e nunca voltam para esta tela.`,
  'Clique em Conectar: o navegador padrão abre a página oficial de login. Autorize e volte ao app (você pode fechar a aba do navegador).',
  'Clique em Testar conexão para confirmar com uma chamada real à API da plataforma.',
];

export function redirectUri(cfg: PlatformConfig, port = cfg.fixedPort): string { return `http://127.0.0.1:${port || '<porta>'}/callback`; }

export interface Guide { platform: PlatformId; name: string; redirectUri: string; redirectNote: string; consoles: { id: string; label: string; url: string }[]; steps: string[]; fields: { name: 'clientId' | 'clientSecret'; label: string; secret: boolean; required: boolean }[]; limitations: string[]; unverified: string[]; publishAdapter: false; publishNote: string }

export const PUBLISH_NOTE = 'O adaptador de publicação desta plataforma ainda NÃO existe: o app conecta a conta, mas não publica vídeos.';

export function buildGuide(id: PlatformId): Guide {
  const cfg = PLATFORM_CONFIG[id], ru = redirectUri(cfg);
  const steps = [...cfg.setup(ru), ...GUIDE_COMMON(cfg)];
  return {
    platform: id, name: cfg.name, redirectUri: ru,
    redirectNote: cfg.fixedPort ? 'Porta fixa: cadastre este endereço exato no console.' : 'O Google aceita qualquer porta em loopback; a porta real é sorteada a cada conexão.',
    consoles: cfg.consoles, steps,
    fields: [{ name: 'clientId', label: cfg.clientIdLabel, secret: false, required: true }, ...(cfg.requiresSecret ? [{ name: 'clientSecret' as const, label: 'Client Secret', secret: true, required: true }] : [])],
    limitations: cfg.limitations, unverified: cfg.unverified, publishAdapter: false, publishNote: PUBLISH_NOTE,
  };
}
