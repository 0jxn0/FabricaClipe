// Ponte mínima e tipada. Não expõe ipcRenderer nem Node: só as funções abaixo.
import { contextBridge, ipcRenderer } from 'electron';
import { CH, type FabricaApi } from '../shared/contracts/ipc.ts';

const call = <T>(ch: string, arg?: unknown) => ipcRenderer.invoke(ch, arg) as Promise<T>;

const api: FabricaApi = {
  version: 1,
  jobs: {
    create: (i) => call(CH.jobsCreate, i), list: () => call(CH.jobsList), action: (i) => call(CH.jobsAction, i),
    history: (jobId) => call(CH.jobsHistory, { jobId }), decide: (i) => call(CH.approvalDecide, i),
  },
  files: { pickVideos: () => call(CH.filesPick), analyze: (path) => call(CH.filesAnalyze, { path }) },
  media: { url: (jobId) => call(CH.mediaUrl, { jobId }) },
  events: {
    snapshot: () => call(CH.eventsSnapshot), since: (seq) => call(CH.eventsSince, { seq }),
    onEvent: (cb) => { const h = (_: unknown, e: Record<string, unknown>) => cb(e); ipcRenderer.on(CH.eventPush, h); return () => ipcRenderer.removeListener(CH.eventPush, h); },
  },
  integrations: {
    list: () => call(CH.integList), guide: (platform) => call(CH.integGuide, { platform }), saveCredentials: (i) => call(CH.integSave, i),
    connect: (platform) => call(CH.integConnect, { platform }), disconnect: (platform) => call(CH.integDisconnect, { platform }),
    test: (platform) => call(CH.integTest, { platform }), openConsole: (platform, consoleId) => call(CH.integConsole, { platform, consoleId }),
  },
  system: { diagnostics: () => call(CH.diagnostics), quitFactory: () => call(CH.quit) },
};
contextBridge.exposeInMainWorld('fabrica', Object.freeze(api));
