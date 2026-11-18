// Toda operação privilegiada passa por aqui: valida remetente, valida payload (zod), executa no backend.
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { CH, IpcSchemas } from '../../shared/contracts/ipc.ts';
import type { Backend } from '../bootstrap/backend.ts';
import { diagnostics } from '../../backend/services/diagnostics.ts';
import { toLegacy } from '../../backend/core/compat/legacyBridge.ts';
import { validateImportFile, VIDEO_EXT } from '../../backend/infrastructure/filesystem/safePaths.ts';
import { fromApp } from '../security/security.ts';

export function registerIpc(be: Backend, getWin: () => BrowserWindow | null, quit: () => void) {
  const approved = new Set<string>(); // só caminhos escolhidos pelo usuário no diálogo nativo podem virar job
  const guard = <T>(fn: (e: IpcMainInvokeEvent, a: unknown) => T) => (e: IpcMainInvokeEvent, a: unknown) => {
    if (!fromApp(e.senderFrame?.url)) throw new Error('origem não autorizada');
    try { return fn(e, a); } catch (err) { be.logger.error(`ipc falhou: ${(err as Error).message}`); throw new Error((err as Error).message); }
  };

  ipcMain.handle(CH.filesPick, guard(async () => {
    const win = getWin(); const opts = { title: 'Importar vídeos', properties: ['openFile' as const, 'multiSelections' as const], filters: [{ name: 'Vídeos', extensions: [...VIDEO_EXT].map((x) => x.slice(1)) }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const ok: string[] = []; for (const p of r.filePaths) { try { approved.add(validateImportFile(p)); ok.push(p); } catch (e) { be.logger.warn(`arquivo recusado: ${(e as Error).message}`); } }
    return ok;
  }));
  ipcMain.handle(CH.jobsCreate, guard((_e, a) => {
    const input = IpcSchemas.create.parse(a);
    if (!approved.has(input.sourcePath)) throw new Error('arquivo não selecionado pelo diálogo de importação');
    return be.orchestrator.createJob(input);
  }));
  ipcMain.handle(CH.jobsList, guard(() => be.orchestrator.listJobs()));
  ipcMain.handle(CH.jobsAction, guard((_e, a) => be.orchestrator.act(IpcSchemas.action.parse(a))));
  ipcMain.handle(CH.jobsHistory, guard((_e, a) => be.orchestrator.history(IpcSchemas.history.parse(a).jobId)));
  ipcMain.handle(CH.approvalDecide, guard((_e, a) => be.orchestrator.decide(IpcSchemas.decide.parse(a))));
  ipcMain.handle(CH.eventsSnapshot, guard(() => ({ lastSeq: be.bus.lastSeq(), events: be.bus.since(0, 2000).map((e) => toLegacy(e, true)).filter(Boolean) })));
  ipcMain.handle(CH.eventsSince, guard((_e, a) => be.bus.since(IpcSchemas.since.parse(a).seq).map((e) => toLegacy(e, true)).filter(Boolean)));
  ipcMain.handle(CH.diagnostics, guard(() => diagnostics({ db: be.db, orch: be.orchestrator, dataDir: be.dataDir })));
  ipcMain.handle(CH.quit, guard(() => { quit(); }));

  // empurra eventos novos ao renderer (contrato legado; o envelope completo fica no event_logs)
  be.bus.subscribe((env) => {
    const l = toLegacy(env); const w = getWin();
    if (l && w && !w.isDestroyed()) w.webContents.send(CH.eventPush, l);
  });
}
