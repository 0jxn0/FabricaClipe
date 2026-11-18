# Mapeamento frontend ↔ backend

## Estações
| Componente visual | desk | stationId | Worker | Método | Parâmetros (job.config) | Retorno | Eventos |
|---|---|---|---|---|---|---|---|
| Captação | desk-1 | `capture` | `CaptureWorker` | importa por cópia + ffprobe + sha256 + thumbnail | `sourcePath` | vídeo importado, thumbnail, metadata.json | `station.started/progress/completed/failed`, `transfer.*`, `file.received` |
| Corte | desk-2 | `cutting` | `CuttingWorker` | FFmpeg `-ss/-t`, libx264 | `cut.startSec`, `cut.durationSec` | clipe | idem |
| Legendagem | desk-3 | `subtitles` | `SubtitlesWorker` | extrai áudio, provedor (sidecar/whisper.cpp), SRT+VTT | `subtitles` auto/off, `subtitleLang` | vídeo + .srt + .vtt | idem |
| Render | desk-4 | `rendering` | `RenderWorker` | FFmpeg com letterbox, codec/bitrate, legenda queimada | `render.*` | render + thumbnail | idem |
| Aprovação | desk-5 | `approval` | humano (`Orchestrator.decide`) | decisão persistida em `approvals` | `decision`, `note`, `user` | aprovado/rejeitado | `approval.pending/approved/rejected/revision_requested` |
| Publicação | desk-6 | `publishing` | **ausente** | — | `platforms` | — | `publish.*` (reservados) |

Estados possíveis do job: `queued, validating, processing, transferring, awaiting_approval, approved, rejected, publishing, completed, failed, paused, cancelled`. Erros: o worker lança; o orquestrador grava em `job_steps`, emite `station.failed`/`job.failed` e aplica o retry (máx. 3, recuo crescente).

## Frontend ↔ evento (contrato legado `deskId`)
Traduzido por `src/backend/core/compat/legacyBridge.ts`. Tabela completa em `API_EVENT_CONTRACTS.md`.

## Controles (matriz de botões)
| Controle | Serviço | Evento de retorno | Resultado visual | Estado |
|---|---|---|---|---|
| Selecionar mesa/funcionário | UI local | — | painel de atividade | IMPLEMENTADO |
| Minimizar métricas | UI local | — | painel recolhe | IMPLEMENTADO |
| Importar vídeo / Iniciar | `files.pickVideos` + `jobs.create` | `job.created`, `job.queued` | arquivo entra na mesa 1 | **EM IMPLEMENTAÇÃO (agente de UI)** |
| Analisar | `services/analysis.ts` | — (resposta direta) | relatório de problemas | serviço pronto e testado; **falta o canal IPC e o botão** |
| Pausar / Retomar / Cancelar / Reprocessar | `jobs.action` | `job.paused/resumed/cancelled`, `job.queued(retry)` | mesa livre / volta à fila | backend IMPLEMENTADO; botões em implementação |
| Aprovar / Rejeitar | `jobs.decide` | `approval.*` | arquivo vai à publicação ou à revisão | backend IMPLEMENTADO; painel em implementação |
| Publicar | — | — | — | AUSENTE (sem integração) |
