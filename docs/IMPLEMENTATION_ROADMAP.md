# Roadmap de implementação

| # | Fase | Estado | Pendências |
|---|---|---|---|
| 1 | Auditoria | feita (limites em `ARCHITECTURE_AUDIT.md`) | auditar `live/*.py` (leitura foi recusada) |
| 2 | Contratos | feita | — |
| 3 | Inicialização integrada (Electron + backend) | feita, testada no app empacotado | — |
| 4 | Frontend ↔ backend (IPC, eventos, recuperação) | feita | eventos de aprovação/indisponibilidade na UI |
| 5 | Status real dos serviços | feita (diagnóstico + estações indisponíveis) | tela de diagnóstico |
| 6 | Iniciar e Analisar | Analisar: serviço pronto; Iniciar: em implementação | IPC + botões |
| 7 | Seis funcionários | Captação, Corte, Legenda, Render reais; Aprovação humana (backend) | Publicação |
| 8 | Esteira | feita (transferências por evento) | — |
| 9 | Demais ações | backend feito | botões e confirmações na UI |
| 10 | Persistência e recuperação | feita e testada | recuperação de publicação (depende da fase 11) |
| 11 | Integrações externas | **ausente** | adapters YouTube/Instagram/TikTok/Facebook, OAuth, cofre de tokens (Electron `safeStorage`), conta de teste |
| 12 | Empacotamento | app descompactado OK | `Setup.exe` NSIS, ícone oficial, teste em máquina limpa |
| 13 | QA completo | QA de backend e de fronteira feitos | re-validação após o código novo; testes de instalação |
