# Fábrica de Clipe

Escritório 2.5D (Three.js, câmera ortográfica top-down, pixel art procedural) que mostra em tempo real os jobs da esteira
[VIDEO-MAKER](https://github.com/eclyssai-glitch/VIDEO-MAKER). Seis estações = seis etapas da `esteira.py`
(Captação, Corte, Legenda, Render, Aprovação, Publicação — editável em `public/src/config.js`).

```powershell
npm install
npm run demo     # servidor + simulador de jobs  -> http://127.0.0.1:8787
npm start        # só a ponte (sem simulação)
# escuta em 0.0.0.0:8787 (HOST/PORT por env): o painel abre de outras máquinas da rede
npm test         # testes da lógica de eventos
```

## Integração
- Navegador: WebSocket em `/ws` (mude com `?ws=ws://host:porta/ws` ou `window.FABRICA_CONFIG.wsUrl`).
- Backend/pipeline: `POST http://127.0.0.1:8787/event` com o JSON do evento (`integration/fabrica_events.py` já faz isso para o Python).
  O servidor repassa aos navegadores e reenvia o histórico recente a quem conectar. Ele escuta em `0.0.0.0`: qualquer máquina da rede vê o painel, mas `POST /event` só vem de localhost ou com o header `x-event-token` igual à env `EVENT_TOKEN` (defina-a se o pipeline rodar em outra máquina; no Python use `FABRICA_TOKEN`).
- Eventos: `clip.job.queued|started|progress|completed|failed|cancelled` com `deskId` (`desk-1`..`desk-6`) e `jobId`.

## Estrutura (`public/src`)
`core/` (sem DOM): `WebSocketClient` (reconexão com backoff), `EventManager` (validação, duplicados, ordem, estado por estação).
`view/`: `SceneManager`, `OfficeLayout`, `ResponsiveManager`, `WorkerManager`, `WorkerAnimation`, `MonitorRenderer`, `UIController`,
`characters.js` (sprites — ponto de troca), `art.js` (mesa/fundo), `pixelfont.js`.

## Regras de eventos
Estado independente por estação; duplicado (mesmo tipo/job/timestamp/progresso) ignorado; progresso que regride ignorado;
evento de job já finalizado ignorado (reinício só com timestamp mais novo); conclusão sem início é aceita; progresso nunca é inventado
(sem `progress` o monitor mostra barra indeterminada). Erro permanece até o próximo job; concluído volta a idle após 6 s.

## Contrato de eventos (fluxo e publicação)
Além dos seis `clip.job.*` originais, o front aceita eventos **opcionais**; sem eles a interface continua igual à anterior.

| Evento | Campos extras | Efeito |
|---|---|---|
| `clip.job.transferred` | `deskId` (origem), `toDeskId` | arquivo sai da origem e percorre a esteira até o destino |
| `clip.job.received` | `deskId` (destino) | estação recebe o arquivo (fica "na fila" até o `started`) |
| `clip.job.publishing` | `platform` (opcional) | plataforma passa a "publicando" |
| `clip.job.published` | `platform` (opcional) | plataforma "publicada" (só aqui) |
| `clip.job.publish_failed` | `platform`, `error` | plataforma "falhou" |

Qualquer evento pode trazer `platforms: ["instagram","tiktok","youtube","facebook",...]` e `thumb` (data:image ou caminho do mesmo servidor).
Sem `transferred`, a transferência é deduzida de evidência real: job `completed` na estação A e depois visto (`queued`/`received`/`started`/`progress`) em B.
Se nada aparecer, o arquivo fica na bandeja de saída de A, nunca é "empurrado" sozinho. `failed` bloqueia o arquivo naquela estação; só um novo `started` na mesma estação libera.
`completed` na estação 06 não marca nenhuma plataforma como publicada. Eventos reenviados após reconexão chegam com `replay:true` e não geram animação.
Ícones de plataforma são aproximações em pixel art desenhadas no código (não os arquivos oficiais das marcas).
