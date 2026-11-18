# Acoplamento da Fábrica ao web app — mapa, planos de alteração e de execução, comparação

Base: branch `claude/awesome-noether-nuave7` (commit `22fea8a`), clone local, branch de trabalho `factory-embed`. Evidências de código: `arquivo:linha` no disco no momento da leitura.

## 1. O que o código realmente é (resumo do mapa)

Três processos sobre o mesmo SQLite (WAL, `busy_timeout` 30 s, autocommit):

| Processo | Comando | Papel |
|---|---|---|
| web | `uvicorn web.app:app` | API REST, SPA estática, SSE do Live, MCP |
| worker | `python -m web.worker` | fila `jobs` (analyze/render), claim com lease + heartbeat |
| live agent | `python -m web.live.agent` | grava lives, detecta, chama Claude, enfileira render |

Não há barramento em memória entre processos: toda comunicação passa por tabelas. O motor do João (`live/detect.py`, `live/render_live.py`, `capture/stack.py`) é importado por `web/engine.py`.

Estados (fonte: `worker.py`, `app.py`): projeto `uploading → queued → processing → rendering → done | failed` (+ `live`); job `queued → running → done | failed`; corte `queued → rendering → ready → approved | discarded | failed`.

Pontos onde o estado muda (candidatos naturais a evento): `worker.progress()` (`worker.py:28`), `claim` (20), `run_analyze` (43, 54-59), `run_render` (67, 78), `finish_project_if_done` (86), `fail` (91-98), `run_once` (115); `app.py` 198, 227, 233, 236-237, 254, 262, 285-287, 298, 305. O motor já informa etapa e % pelo callback `engine.analyze(progress)` (`engine.py:80-95`: "Lendo o áudio" 5, "Detectando webcam e enquadramento" 20, "Transcrevendo momento k de n" 25-85).

Padrão de streaming já existente: `GET /api/live/sessions/{sid}/events` (`live/api.py:80-118`) — SSE que lê a tabela `live_events` (id crescente, `Last-Event-ID`) a cada 1 s e envia um `snapshot` quando o hash muda; limite de 4 conexões por usuário/200 totais (contadores em memória por processo).

Lacunas já conhecidas no motor (não causadas por este trabalho): `finish_project_if_done` assume um único worker (`left <= 1`, `worker.py:85`); o render só grava `progress=10` (`worker.py:68`), então não existe % real de render por corte; `live_events` não tem retenção; publicação não é exposta no web (`factory.py` `NO_PUBLISH`).

## 2. Requisito

Mostrar a Fábrica 2.5D dentro do web app, no menu, refletindo o estado REAL do backend (sem simulação), e **manter o web app funcionando**. Restrições herdadas: CSP `script-src 'self'; style-src 'self'` (sem inline/eval); isolamento por `user_id`; não alterar o motor do João.

## 3. Planos de alteração

### Plano A — Snapshot derivado + polling (IMPLEMENTADO em `factory-embed`)
- **Backend:** `web/factory.py` (função pura) + `GET /api/factory` somente leitura; 3 SELECTs filtrados por `user_id`.
- **Frontend:** componente embutido (`factory.js/css`), `SnapshotAdapter` no navegador compara snapshots e gera os eventos (replay no primeiro; transferência quando a estação muda).
- **Toca:** `web/app.py` (+1 rota), `web/static/{app.js,styles.css}`, arquivos novos. **Não toca** `worker.py`, `engine.py`, `db.py`, motor.

### Plano B — Eventos reais gravados pelo backend + SSE
- **Backend:** tabela nova `factory_events(id AUTOINCREMENT, user_id, project_id, clip_id, kind, station, progress, stage, data, at)` com índice `(user_id, id)`; função `emit()`; chamadas de `emit()` nos ~14 pontos do §1 (`worker.py`, `app.py`); `GET /api/factory/events` SSE no molde de `live/api.py`; retenção (apagar > 7 dias); snapshot inicial = reconstrução a partir das tabelas (como hoje).
- **Frontend:** `EventSource` com `Last-Event-ID` alimentando o EventManager diretamente (sem adapter por diff).
- **Toca:** `db.py` (schema), `worker.py`, `app.py`, `live/agent.py` (opcional), novo `web/factory_events.py`.

### Plano C — Híbrido: SSE do snapshot (sem tabela nova, sem tocar o worker)
- **Backend:** `GET /api/factory/stream` repete o snapshot por hash a cada 1 s no molde do SSE do Live (mesmo mecanismo de `Last-Event-ID`/`retry`, limite de conexões).
- **Frontend:** o mesmo `SnapshotAdapter` do Plano A, alimentado por SSE em vez de polling; polling vira fallback.
- **Toca:** `web/app.py` ou novo `web/factory_api.py`; `app.js` (EventSource). **Não toca** worker/engine/db.

## 4. Planos de execução

| Etapa | Plano A (feito) | Plano C | Plano B |
|---|---|---|---|
| 1 | `factory.py` + rota + testes (13) | reaproveita `factory.py`; novo gerador SSE + contador de conexões | migration `factory_events` + `emit()` + testes de unidade |
| 2 | Bundle do escritório (`build:embed`) | idem | inserir `emit()` em `worker.py`/`app.py` (14 pontos), cada um com teste |
| 3 | Rota `/fabrica`, menu, atalho, fallback textual | trocar polling por `EventSource` + fallback | SSE `/api/factory/events` com `Last-Event-ID` |
| 4 | Teste no navegador (feito) | testes de SSE (reconexão, limite, isolamento) | adaptar o front para consumir eventos nativos; retirar o diff do adapter |
| 5 | QA de fronteira | QA de fronteira | QA + teste e2e com worker real (`VM_TEST_MEDIA`) + migração de dados |
| Reversão | remover rota/menu; sem dados a desfazer | idem | `DROP TABLE` + reverter 14 chamadas (arriscado após dados reais) |

## 5. Comparação

| Critério | A (polling+diff) | C (SSE do snapshot) | B (eventos gravados) |
|---|---|---|---|
| Fidelidade do evento | observa o estado a cada 2 s: pode juntar mudanças rápidas | observa a cada 1 s: idem | exata, na ordem em que ocorreu (nasce no ponto da mudança) |
| Latência até o visual | ≤ 2 s | ≤ 1 s | ≈ 1 s (poll do SSE na tabela) |
| Risco para o motor/fila | nenhum | nenhum | médio: edita `worker.py` (núcleo da fila) e `app.py` |
| Esforço | pronto | baixo (≈ ½ dia) | alto (≈ 2-3 dias com testes) |
| Carga no servidor | 3 SELECTs por 2 s por aba aberta | 3 SELECTs por 1 s por conexão (limite 4/usuário) | 1 SELECT indexado por 1 s por conexão |
| Multi-worker/processo | funciona (lê o banco) | funciona | funciona (ordem pelo AUTOINCREMENT) |
| Dados novos / retenção | nenhum | nenhum | tabela nova a reter; migração |
| Testes | 13 unit + navegador | + testes de SSE | + testes por ponto de emissão + e2e |
| Honestidade ("nada simulado") | sim (estado do banco) | sim | sim (e mais precisa) |
| Dependência de strings do motor | sim (`stage` define desk-2 vs desk-3) | sim | menor (kind explícito), mas `emit` ainda lê o stage |
| Reversibilidade | total | total | parcial |

## 6. Recomendação

1. **Manter A** (já implementado e testado) — entrega o objetivo sem tocar o motor.
2. **Adotar C** como próxima melhoria barata, se o polling a cada 2 s pesar ou se a latência de 1 s importar. Reaproveita o padrão que o próprio projeto já usa.
3. **Fazer B só se** for necessário saber o **instante exato** de cada transição (auditoria, histórico da fábrica, notificações) — porque ele altera `worker.py` e `app.py`, o que exige a aprovação do dono do motor.

Antes de qualquer um: decidir se `progress` de render deve ser real (hoje fixo em 10, `worker.py:68`) — exigiria mudança no motor de render, fora do escopo deste acoplamento.

## 7. Riscos abertos observados no mapa
- `finish_project_if_done` com mais de um worker pode nunca fechar o projeto (`worker.py:85`) — a Fábrica mostraria o projeto preso em render.
- `upload` e `billing` usam `BEGIN IMMEDIATE` sem rollback explícito (`app.py` ≈ 234-238, 387).
- `live_events` cresce sem retenção.
- A estação "Publicação" é sempre indisponível no web até existir OAuth por cliente.
