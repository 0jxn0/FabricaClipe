# Integrações de contas (YouTube, Instagram, TikTok, Facebook)

Botão **Integrações** no cabeçalho do app. Cada plataforma tem um cartão com status honesto (Não configurada / Credenciais salvas / Conectada / Erro), passo a passo, campos de credencial e os botões Salvar, Conectar, Testar conexão e Desconectar. Os textos abaixo são os mesmos exibidos na UI (gerados de `src/backend/integrations/platforms.ts`).

> **O adaptador de publicação de cada plataforma AINDA NÃO EXISTE.** O app conecta e testa a conta, mas não publica vídeos. Os jobs com plataforma marcada terminam na estação de Publicação indisponível.

## Como funciona (segurança)

- OAuth 2.0 Authorization Code (+ PKCE S256 quando a plataforma suporta) com redirect em loopback `http://127.0.0.1:<porta>/callback`: servidor temporário só em 127.0.0.1, `state` aleatório validado, Host verificado, timeout de 3 min, porta fechada após o retorno.
- O navegador PADRÃO do sistema abre via `shell.openExternal`, somente para URLs https dos domínios da allowlist da plataforma. Nenhuma automação de navegador.
- Segredos e tokens ficam cifrados em `<dados>/secrets/<plataforma>.bin` com `safeStorage` (DPAPI no Windows). Se o armazenamento seguro estiver indisponível o app RECUSA salvar. O banco (`platform_accounts`) guarda só: plataforma, rótulo, status, data de conexão e nome do arquivo.
- O renderer nunca recebe segredo ou token: só status, rótulo e mensagens. Nada de segredo em logs.
- Redirect URI: o Google aceita qualquer porta em loopback. Meta e TikTok exigem URI exata, então usam porta FIXA (Facebook 53781, Instagram 53782, TikTok 53783) que deve ser cadastrada no console.
- Desconectar: com tokens, remove só os tokens (volta a "Credenciais salvas"); sem tokens, o botão vira "Apagar credenciais" e remove tudo.
- CSP: sem alteração (as chamadas de rede acontecem no processo principal, não no renderer).

## YouTube

1. Crie (ou escolha) um projeto no Google Cloud Console e ative a "YouTube Data API v3" (link do console abaixo).
2. Configure a Tela de consentimento OAuth (modo Externo; em "Teste", adicione seu e-mail como usuário de teste). Depois crie uma credencial "ID do cliente OAuth" do tipo "Aplicativo para computador". Esse tipo aceita o redirect em loopback http://127.0.0.1:<qualquer porta>/callback, sem cadastrar nada.
3. Escopos usados: youtube.upload (publicar) e youtube.readonly (só para o botão Testar conexão). Em modo "Teste" o Google expira o token de atualização em 7 dias.
4. Cole aqui o Client ID e o Client Secret e clique em Salvar. Eles ficam criptografados no cofre do sistema e nunca voltam para esta tela.
5. Clique em Conectar: o navegador padrão abre a página oficial de login. Autorize e volte ao app (você pode fechar a aba do navegador).
6. Clique em Testar conexão para confirmar com uma chamada real à API da plataforma.

Links do console: [Google Cloud: credenciais](https://console.cloud.google.com/apis/credentials) · [Google Cloud: ativar a YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) · [Google Cloud: tela de consentimento](https://console.cloud.google.com/apis/credentials/consent)

Redirect URI: `http://127.0.0.1:<porta>/callback` (O Google aceita qualquer porta em loopback; a porta real é sorteada a cada conexão.)

Escopos: `https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly`

Limitações:
- O Google exige tela de consentimento configurada e uma credencial do tipo "Aplicativo para computador".
- Vídeos enviados por projetos de API não auditados ficam privados até a verificação do projeto pelo YouTube.
- Com a tela de consentimento em "Teste", o token expira em 7 dias e é preciso reconectar.

Não verificado online (conferir na documentação oficial):
- Cota/auditoria da API de upload do YouTube
- Prazo de 7 dias do token em modo Teste

## Instagram

1. ANTES: sua conta do Instagram precisa ser PROFISSIONAL (Comercial ou Criador) e estar LIGADA a uma Página do Facebook que você administra. Conta pessoal não publica pela API.
2. Em Meta for Developers crie um app "Empresa" com o produto "Login do Facebook" e adicione em "URIs de redirecionamento OAuth válidos" exatamente: http://127.0.0.1:53782/callback
3. Permissões usadas (API do Instagram com Login do Facebook): instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement. Sem Revisão do app só funcionam em modo Desenvolvimento.
4. Cole aqui o ID do app (App ID) e o Client Secret e clique em Salvar. Eles ficam criptografados no cofre do sistema e nunca voltam para esta tela.
5. Clique em Conectar: o navegador padrão abre a página oficial de login. Autorize e volte ao app (você pode fechar a aba do navegador).
6. Clique em Testar conexão para confirmar com uma chamada real à API da plataforma.

Links do console: [Meta for Developers: meus apps](https://developers.facebook.com/apps/)

Redirect URI: `http://127.0.0.1:53782/callback` (Porta fixa: cadastre este endereço exato no console.)

Escopos: `instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement`

Limitações:
- Exige conta profissional do Instagram ligada a uma Página do Facebook.
- Fora do modo Desenvolvimento as permissões exigem Revisão do app pela Meta.
- O vídeo precisa estar em URL pública para a Graph API buscar: publicar de verdade exige hospedar o arquivo temporariamente (ainda não implementado).

Não verificado online (conferir na documentação oficial):
- Versão v21.0 da Graph API
- A Meta não documenta PKCE no login web (desligado aqui)
- Nomes das permissões do Instagram (mudam com frequência)

## TikTok

1. Em TikTok for Developers crie um app e adicione os produtos "Login Kit" e "Content Posting API" (ative "Direct Post").
2. Em Login Kit, cadastre o Redirect URI exatamente: http://127.0.0.1:53783/callback
3. Escopos usados: user.info.basic e video.publish. App NÃO auditado só publica vídeos PRIVADOS (somente você vê) até passar pela auditoria do TikTok.
4. Cole aqui o Client Key e o Client Secret e clique em Salvar. Eles ficam criptografados no cofre do sistema e nunca voltam para esta tela.
5. Clique em Conectar: o navegador padrão abre a página oficial de login. Autorize e volte ao app (você pode fechar a aba do navegador).
6. Clique em Testar conexão para confirmar com uma chamada real à API da plataforma.

Links do console: [TikTok for Developers: meus apps](https://developers.tiktok.com/apps/)

Redirect URI: `http://127.0.0.1:53783/callback` (Porta fixa: cadastre este endereço exato no console.)

Escopos: `user.info.basic, video.publish`

Limitações:
- App não auditado só consegue publicar com visibilidade privada.
- É preciso adicionar sua conta como "Target User" enquanto o app está em sandbox.

Não verificado online (conferir na documentação oficial):
- O code_challenge do TikTok é o SHA-256 em HEX (não base64url, como na RFC 7636)
- Aceitação de redirect em loopback http://127.0.0.1 com porta fixa
- Nome dos parâmetros (client_key) e endpoints v2

## Facebook

1. Em Meta for Developers crie um app do tipo "Empresa" (Business) e adicione o produto "Login do Facebook".
2. Em "Login do Facebook > Configurações" adicione em "URIs de redirecionamento OAuth válidos" exatamente: http://127.0.0.1:53781/callback
3. Permissões usadas: pages_show_list, pages_read_engagement, pages_manage_posts, publish_video. Sem "Revisão do app" elas só funcionam para administradores/testadores do app (modo Desenvolvimento).
4. Cole aqui o ID do app (App ID) e o Client Secret e clique em Salvar. Eles ficam criptografados no cofre do sistema e nunca voltam para esta tela.
5. Clique em Conectar: o navegador padrão abre a página oficial de login. Autorize e volte ao app (você pode fechar a aba do navegador).
6. Clique em Testar conexão para confirmar com uma chamada real à API da plataforma.

Links do console: [Meta for Developers: meus apps](https://developers.facebook.com/apps/)

Redirect URI: `http://127.0.0.1:53781/callback` (Porta fixa: cadastre este endereço exato no console.)

Escopos: `pages_show_list, pages_read_engagement, pages_manage_posts, publish_video`

Limitações:
- Publicar em Páginas exige que você administre uma Página do Facebook.
- Fora do modo Desenvolvimento as permissões exigem Revisão do app pela Meta.
- A Meta não usa refresh token: o token dura cerca de 60 dias e depois é preciso reconectar.

Não verificado online (conferir na documentação oficial):
- Versão v21.0 da Graph API (pode estar defasada)
- A Meta não documenta PKCE no login web: o app usa client_secret + state (PKCE desligado aqui)
- Conjunto exato de permissões para vídeo em Páginas
- Redirect em loopback http://127.0.0.1 com porta fixa aceito no modo Desenvolvimento

## O que falta para publicar de verdade

1. Adaptadores de publicação por plataforma (hoje inexistentes): YouTube `videos.insert` (upload resumível), Meta Graph API (Páginas: `/{page}/videos`; Instagram: contêiner + `media_publish`, exige URL pública do arquivo), TikTok Content Posting API (`video/init` + upload).
2. Estação de Publicação no orquestrador usando `IntegrationsService.accessToken(plataforma)` (já renova token expirado) e a tabela `publications`.
3. Passar pelas revisões/auditorias: verificação do projeto Google (vídeos privados até lá), Revisão do app Meta, auditoria TikTok (app não auditado só publica privado).
4. Validar os pontos "não verificado online" acima com credenciais reais; renovar token Meta (~60 dias) automaticamente e tratar revogação.
