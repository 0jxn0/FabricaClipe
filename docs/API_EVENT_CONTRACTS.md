# Contratos de API e eventos (versão 1)

## Envelope
`{ event, eventId (uuid), version: 1, seq, timestamp (ISO), jobId?, stationId?, employeeId?, payload }`. `seq` é gerado pelo barramento ao gravar em `event_logs` (ordem total); `eventId` duplicado é ignorado. Recuperação: `bus.since(seq)` / snapshot recente.

## IPC (Renderer → Main) — `window.fabrica`
| Canal | Tipo | Entrada (zod) | Saída |
|---|---|---|---|
| `fabrica:files:pick` | query | — | caminhos escolhidos no diálogo nativo (valem uma vez) |
| `fabrica:jobs:create` | command | `CreateJobInput` | `JobRow` |
| `fabrica:jobs:list` | query | — | `JobRow[]` |
| `fabrica:jobs:action` | command | `{jobId, action: pause\|resume\|cancel\|retry}` | `JobRow` |
| `fabrica:jobs:history` | query | `{jobId}` | `job_steps[]` |
| `fabrica:approval:decide` | command | `{jobId, decision, note, user}` | `JobRow` |
| `fabrica:events:snapshot` / `since` | query | `{seq}` | eventos legados com `replay:true` |
| `fabrica:system:diagnostics` | query | — | estado do backend, banco, workers, ffmpeg, disco, memória, erros |
| `fabrica:event` | event (Main → Renderer) | — | evento legado |

## Eventos (envelope) → contrato legado (frontend)
| Envelope | Legado |
|---|---|
| `clip.job.queued` | `clip.job.queued` (+ `title`, `platforms`) |
| `clip.station.started` | `clip.job.started` |
| `clip.station.progress` | `clip.job.progress` (só progresso medido) |
| `clip.station.completed` | `clip.job.completed` |
| `clip.station.failed`, `clip.job.failed`, `clip.transfer.failed` | `clip.job.failed` |
| `clip.job.paused` | `clip.job.paused` (mesa livre) |
| `clip.job.cancelled` | `clip.job.cancelled` |
| `clip.transfer.started` | `clip.job.transferred` (`deskId` origem, `toDeskId`) |
| `clip.file.received` | `clip.job.received` |
| `clip.publish.started/completed/failed` | `clip.job.publishing/published/publish_failed` (`platform`) |
Eventos sem tradução (`system.*`, `approval.*`, `clip.job.created/resumed`, `clip.station.idle/unavailable`) são só do envelope; o frontend ainda não os consome (**NECESSITA ADAPTAÇÃO** para exibir aprovação pendente e indisponibilidade).

## Regras do frontend
Dedupe por tipo/job/timestamp/progresso; progresso que regride é ignorado; evento após job finalizado é ignorado (exceto falha após conclusão e reinício com timestamp ≥); `replay:true` não anima.
