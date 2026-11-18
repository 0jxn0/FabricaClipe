# Auditoria de arquitetura

Escopo: o que **existe no código**, não o que a documentação promete. Legenda: IMPLEMENTADO · PARCIAL · AUSENTE · COM ERRO · NECESSITA ADAPTAÇÃO.

> **Limite da auditoria do projeto Python (VIDEO-MAKER v0.6.0, zip enviado):** foram lidos `esteira.py`, `capture/*`, `pipeline/*`, `publish/*`, `config/*.yaml`, `requirements.txt`, `.mcp.json` e `live/detect.py`. **Não foram auditados** `live/cycle.py`, `live/render_live.py`, `live/setup_assets.py` e `live/cam_probe.py`: a leitura desses arquivos foi interrompida por uma recusa de permissão. Tudo o que é dito sobre eles abaixo vem da documentação (CHANGELOG/README) e deve ser tratado como **não verificado**.

## 1. Projeto Python (VIDEO-MAKER / ClipeiAki)
Linguagem: Python, ~740 linhas em 19 arquivos; sem testes, sem banco, sem servidor HTTP, sem WebSocket (confirmado por inspeção dos arquivos lidos). Fila = lista JSON (`logs/queue.json`). Entry point único: `esteira.py <comando>` que dispara scripts por `subprocess`.

| Funcionalidade | Estado | Observação (evidência) |
|---|---|---|
| Captação de virais (`capture/scrap.py`, yt-dlp, ranking por outlier de views) | IMPLEMENTADO | depende de cookies para YouTube/Reddit (CHANGELOG) |
| Captação de lives (`live/cycle.py`, streamlink) | NÃO AUDITADO | só documentação |
| Detecção de momentos (`live/detect.py`: loudness por janelas de 0,5 s, pico = mediana + 14 dB, 1 corte/45 s) | IMPLEMENTADO | numpy + ffmpeg; limiares em `config/live.yaml` |
| Transcrição (`live/detect.py`: faster-whisper "small", palavra a palavra) | IMPLEMENTADO | exige modelo baixado (huggingface) |
| Título/legenda/hook (`copy.json` escrito pela skill /viralizei do Claude) | PARCIAL | depende de um agente externo escrever o JSON; não é código |
| Render 9:16 com template (`live/render_live.py`, `pipeline/render.py`) | NÃO AUDITADO / NECESSITA ADAPTAÇÃO | `pipeline/run.py:5` usa `rsplit("/")` e quebra no Windows; o fluxo `pipeline/` não é chamado por `esteira.py` |
| Aprovação + agenda (`publish/scheduler.py approve`) | PARCIAL | marca o resto do lote como "reprovado" mesmo se já postado; `queue.json` sem lock/atomicidade |
| Publicação YouTube/Instagram/TikTok (`publish/*.py`) | PARCIAL / COM ERRO | status "postado" se QUALQUER plataforma der certo; tokens em claro; sem refresh/quota (YouTube); `first_comment` de `publish.yaml` não é usado por nenhum código |
| `capture/stack.py` (lote), `harvest.py`, `deliver.py` | PARCIAL | layout fixo 1920×1080; `apply()` depende de `work/stack/pt.txt` com `split("|")` frágil; docstring diz `pt.json` mas lê `pt.txt` |
| Persistência / banco / API / eventos / testes | AUSENTE | — |

## 2. App Fábrica de Clipe (este repositório)
| Camada | Estado | Evidência |
|---|---|---|
| Frontend 2.5D (Three.js, 6 estações, esteira, canos, métricas) | IMPLEMENTADO | `public/` |
| Contratos de eventos + validação (zod) | IMPLEMENTADO | `src/shared/contracts/events.ts` |
| Event bus persistente, dedupe, `seq`, recuperação | IMPLEMENTADO | `EventBus.ts` + testes |
| SQLite + migrations (13 tabelas) | IMPLEMENTADO | `infrastructure/database` |
| Máquina de estados, orquestrador, fila, retry, pausa/cancelamento, recuperação | IMPLEMENTADO | `Orchestrator.ts`, `tests/orchestrator.test.ts`, `tests/qa-backend.test.ts` |
| Worker Captação (FFprobe, cópia com sha256, thumbnail) | IMPLEMENTADO | `workers/capture` |
| Worker Corte (intervalo configurado, FFmpeg) | IMPLEMENTADO | `workers/cutting`; seleção automática de trechos **AUSENTE** (interface `CutPlanner` pronta) |
| Worker Legenda (SRT/VTT, provedores) | PARCIAL | só legenda existente ao lado do vídeo; whisper.cpp **nunca rodou com binário real** |
| Worker Render (FFmpeg, legenda queimada) | IMPLEMENTADO | `workers/rendering` |
| Aprovação humana (backend) | IMPLEMENTADO | `Orchestrator.decide`; UI em desenvolvimento |
| Worker Publicação + OAuth + adapters | AUSENTE | nenhuma plataforma integrada; nada é publicado |
| Electron seguro (sandbox, CSP, IPC validado) | IMPLEMENTADO | `src/main`, `src/preload` |
| Instalador NSIS | PARCIAL | app descompactado empacotado e testado; `Setup.exe` não gerado; sem ícone |
| Servidor WebSocket legado (`server/server.js`) | PARCIAL | só para desenvolvimento/demonstração no navegador |

## 3. Duplicidades e conflitos
- `server/server.js --demo` simula jobs; **não deve** ser usado como produção. O app desktop não o usa.
- O Python e o TypeScript têm a mesma lógica de corte/render. O Python é a **especificação**; não é executado pelo app (exigência: sem Python no instalador).
