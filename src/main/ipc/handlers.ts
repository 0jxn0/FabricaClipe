// Toda operação privilegiada passa por aqui: valida remetente, valida payload (zod), executa no backend.
import os from 'node:os';
import path from 'node:path';
import { dialog, ipcMain, safeStorage, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { CredentialVault } from '../../backend/services/credentials.ts';
import { IntegrationsService } from '../../backend/integrations/IntegrationsService.ts';
import { CH, IpcSchemas } from '../../shared/contracts/ipc.ts';
import type { Backend } from '../bootstrap/backend.ts';
import { diagnostics } from '../../backend/services/diagnostics.ts';
import { toLegacy } from '../../backend/core/compat/legacyBridge.ts';
import { validateImportFile, VIDEO_EXT } from '../../backend/infrastructure/filesystem/safePaths.ts';
import { check as ffCheck } from '../../backend/infrastructure/ffmpeg/ffmpeg.ts';
import { analyzeFile } from '../../backend/services/analysis.ts';
import { fromApp } from '../security/security.ts';
import { mediaUrl, resolveJobMedia } from '../media/media.ts';

export function registerIpc(be: Backend, getWin: () => BrowserWindow | null, quit: () => void, isQuitting: () => boolean = () => false) {
  const approved = new Set<string>(); // só caminhos escolhidos pelo usuário no diálogo nativo podem virar job
  const guard = <T>(fn: (e: IpcMainInvokeEvent, a: unknown) => T) => (e: IpcMainInvokeEvent, a: unknown) => {
    if (!fromApp(e.senderFrame?.url) || e.senderFrame !== e.sender.mainFrame) throw new Error('origem não autorizada');
    try { return fn(e, a); } catch (err) { be.logger.error(`ipc falhou: ${(err as Error).message}`); throw new Error((err as Error).message); }
  };

  ipcMain.handle(CH.filesAnalyze, guard(async (_e, a) => { // só arquivos escolhidos no diálogo; não consome a seleção
    const { path } = IpcSchemas.analyze.parse(a); if (!approved.has(path)) throw new Error('arquivo não selecionado pelo diálogo de importação');
    return analyzeFile(path);
  }));
  ipcMain.handle(CH.filesPick, guard(async () => {
    approved.clear(); // seleções antigas (diálogo cancelado ou já usadas) deixam de valer
    const win = getWin(); const opts = { title: 'Importar vídeos', properties: ['openFile' as const, 'multiSelections' as const], filters: [{ name: 'Vídeos', extensions: [...VIDEO_EXT].map((x) => x.slice(1)) }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const ok: string[] = []; for (const p of r.filePaths) { try { approved.add(validateImportFile(p)); ok.push(p); } catch (e) { be.logger.warn(`arquivo recusado: ${(e as Error).message}`); } }
    return ok;
  }));
  ipcMain.handle(CH.jobsCreate, guard((_e, a) => {
    const input = IpcSchemas.create.parse(a);
    if (isQuitting()) throw new Error('a fábrica está sendo encerrada');
    if (!approved.delete(input.sourcePath)) throw new Error('arquivo não selecionado pelo diálogo de importação (a seleção vale uma vez)');
    return be.orchestrator.createJob(input);
  }));
  ipcMain.handle(CH.jobsList, guard(() => be.orchestrator.listJobs()));
  ipcMain.handle(CH.jobsAction, guard((_e, a) => be.orchestrator.act(IpcSchemas.action.parse(a))));
  ipcMain.handle(CH.jobsHistory, guard((_e, a) => be.orchestrator.history(IpcSchemas.history.parse(a).jobId)));
  ipcMain.handle(CH.approvalDecide, guard((_e, a) => be.orchestrator.decide({ ...IpcSchemas.decide.parse(a), user: os.userInfo().username || 'operador' })));
  ipcMain.handle(CH.mediaUrl, guard((_e, a) => { const { jobId } = IpcSchemas.mediaUrl.parse(a); resolveJobMedia(be.db, be.dataDir, jobId); return mediaUrl(jobId); }));
  ipcMain.handle(CH.eventsSnapshot, guard(() => ({ lastSeq: be.bus.lastSeq(), events: be.bus.recent(1500).map((e) => toLegacy(e, true)).filter(Boolean) })));
  ipcMain.handle(CH.eventsSince, guard((_e, a) => be.bus.since(IpcSchemas.since.parse(a).seq).map((e) => toLegacy(e, true)).filter(Boolean)));
  ipcMain.handle(CH.diagnostics, guard(() => diagnostics({ db: be.db, orch: be.orchestrator, dataDir: be.dataDir, ffmpeg: () => ffCheck() })));
  ipcMain.handle(CH.quit, guard(() => { quit(); }));

  // Contas das plataformas: segredos só no cofre (safeStorage); nenhum handler devolve token/segredo.
  const integ = new IntegrationsService({
    vault: new CredentialVault(be.db, path.join(be.dataDir, 'secrets'), safeStorage), openExternal: (u) => shell.openExternal(u),
    log: (l, m) => be.logger[l](m),
  });
  const P = (a: unknown) => IpcSchemas.integPlatform.parse(a).platform;
  ipcMain.handle(CH.integList, guard(() => integ.list()));
  ipcMain.handle(CH.integGuide, guard((_e, a) => integ.guide(P(a))));
  ipcMain.handle(CH.integSave, guard((_e, a) => { const i = IpcSchemas.integSave.parse(a); return integ.saveCredentials(i.platform, i.clientId, i.clientSecret); }));
  ipcMain.handle(CH.integConnect, guard((_e, a) => integ.connect(P(a))));
  ipcMain.handle(CH.integDisconnect, guard((_e, a) => integ.disconnect(P(a))));
  ipcMain.handle(CH.integTest, guard((_e, a) => integ.test(P(a))));
  ipcMain.handle(CH.integConsole, guard((_e, a) => { const i = IpcSchemas.integConsole.parse(a); return integ.openConsole(i.platform, i.consoleId); }));

  // empurra eventos novos ao renderer (contrato legado; o envelope completo fica no event_logs)
  be.bus.subscribe((env) => {
    const l = toLegacy(env); const w = getWin();
    if (l && w && !w.isDestroyed()) w.webContents.send(CH.eventPush, l);
  });
}
