# Fábrica de Clipe — arquitetura e auditoria (Fases 1 e 2)

## 1. Auditoria do repositório
**Frontend (referência visual oficial)** — `public/`: JS puro + Three.js (WebGL). Módulos `core/` (EventManager, FlowManager, StatsManager, WebSocketClient, IpcTransport) e `view/` (cena, estações, esteira, canos, monitores). Já recebe apenas eventos e desenha; não decide estado.

**Motor existente do projeto VIDEO-MAKER/ClipeiAki (Python, v0.6.0)** — é o comportamento de referência das estações:

| Estação | Código Python existente | O que faz hoje |
|---|---|---|
| Captação | `capture/scrap.py`, `harvest.py`, `live/cycle.py`, `esteira.py add` | yt-dlp/streamlink, ranking por views, gravação de lives em ciclos |
| Corte | `live/detect.py` | picos de loudness com ffmpeg (janela 0,5 s, +14 dB sobre a mediana, 1 corte/45 s) |
| Legenda | `live/detect.py` (`transcribe`) | faster-whisper "small" só nos trechos, palavra a palavra |
| Render | `live/render_live.py`, `pipeline/render.py` | ffmpeg + libass, template 1080×1920, áudio −14 LUFS, 30 fps |
| Aprovação | `publish/scheduler.py approve` | aprovar → agendar em horários de pico |
| Publicação | `publish/youtube.py`, `instagram.py`, `tiktok.py` | APIs oficiais, credenciais em `config/secrets/` |

**Decisão:** o app não pode exigir Python. As estações serão reimplementadas em TypeScript sobre FFmpeg/FFprobe, usando o Python acima como especificação de comportamento (Fases 3–5). Provedores opcionais (ex.: whisper) entram atrás de interface.

**Contratos existentes preservados** — `clip.job.{queued,started,progress,completed,failed,cancelled,transferred,received,publishing,published,publish_failed}` + `deskId`. O backend novo emite o envelope padronizado e a ponte `backend/core/compat/legacyBridge.ts` traduz para o contrato antigo; o frontend não precisou mudar de linguagem.

## 2. Estrutura
```
src/shared/contracts   estações, estados, envelope de eventos (zod), contratos de job e de IPC
src/backend/core       event-bus · state-machine · orchestrator · compat (ponte legada)
src/backend/workers    contrato Worker (as 6 estações implementam)
src/backend/infrastructure  database (SQLite+migrations) · filesystem (caminhos seguros) · logging
src/backend/services   diagnostics
src/main               bootstrap · ipc · security · lifecycle (Electron main)
src/preload            API mínima tipada (contextBridge)
public/                renderer = frontend existente (servido por app://fabrica/)
```
`node:sqlite` (sem módulo nativo) é usado atrás de `Db`; trocar por better-sqlite3 só exige reescrever essa classe.

## 3. Garantias implementadas (Fases 1–2)
- Job com máquina de estados (12 estados); transição inválida lança erro.
- Estação só muda depois do resultado validado (arquivo existe, não vazio) **e persistido**; a transferência é registrada em `transfers`.
- Evento só é emitido depois do commit. Envelope com `eventId`, `seq` (ordem total), `timestamp`, versão; dedupe por `eventId`; recuperação por `seq`.
- Fila persistente: prioridade, concorrência por estação e global, reserva atômica (um job nunca roda duas vezes), retry com recuo, pausa, retomada, cancelamento.
- Recuperação na abertura: jobs interrompidos voltam à fila (ou falham, quando o worker exige decisão — caso da publicação) e transferências pendentes são concluídas se o arquivo existir.
- Aprovação humana: job fica em `awaiting_approval` até `decide()`; rejeição volta à estação de revisão e o histórico (`job_steps`) é preservado.
- **Sem dados falsos:** sem worker registrado a estação fica `unavailable` e o job espera na fila.

## 4. Segurança do Electron
`contextIsolation`, `nodeIntegration:false`, `sandbox:true`; preload expõe só `window.fabrica`; IPC valida remetente (`app://fabrica/`) e payload (zod); CSP por cabeçalho (importmap liberado por hash); navegação externa e `window.open` bloqueados; permissões negadas; arquivos de entrada só os escolhidos no diálogo nativo e validados (`safePaths`).

## 5. Estado das fases
| Fase | Estado |
|---|---|
| 1 Auditoria e fundação | feita (este documento) |
| 2 Backend principal | feita e testada (`tests/orchestrator.test.ts`) |
| 3 Captação/Corte (FFprobe/FFmpeg) | **pendente** — nenhum worker real ainda |
| 4 Legenda/Render | pendente |
| 5 Aprovação UI, adapters, OAuth, publicação | pendente (a regra de aprovação já existe no backend; falta a tela) |
| 6 Integração visual (importar vídeo, aprovar, controles) | parcial: transporte IPC + ponte de eventos prontos; faltam os controles na interface |
| 7 Instalador NSIS | `electron-builder.yml` escrito, **não executado**; faltam ícone e binários FFmpeg |
| 8 QA | pendente |
