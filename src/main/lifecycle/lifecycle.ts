// Ciclo de vida: fechar a janela NÃO mata os jobs. Com trabalho em andamento o usuário escolhe segundo plano ou encerrar.
import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron';
import type { Backend } from '../bootstrap/backend.ts';

const ICON = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR4nGNk+M/wn4EIwEiMIgYGBgYmYhTBFTAyMDAwUsMAfF6gigG4DKCaAbgMoJoBAIdjCBHqP8kGAAAAAElFTkSuQmCC';

export function setupLifecycle(be: Backend, getWin: () => BrowserWindow | null, showWin: () => void) {
  let tray: Tray | null = null, quitting = false;
  const busy = () => be.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state NOT IN ('completed','cancelled','failed','paused','awaiting_approval')")!.n > 0;

  const shutdown = async () => {
    if (quitting) return; quitting = true;
    await be.orchestrator.stop(true); // interrompe com segurança; a próxima abertura recupera
    try { be.db.close(); } catch { /* já fechado */ }
    tray?.destroy(); app.exit(0);
  };

  const toBackground = () => {
    getWin()?.hide();
    if (!tray) {
      tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${ICON}`)); tray.setToolTip('Fábrica de Clipe (trabalhando em segundo plano)');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Abrir a fábrica', click: showWin }, { label: 'Encerrar a fábrica', click: () => void shutdown() }]));
      tray.on('double-click', showWin);
    }
  };

  const onClose = (e: Electron.Event) => {
    if (quitting) return;
    e.preventDefault();
    if (!busy()) { void shutdown(); return; }
    const win = getWin();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question', title: 'Fábrica de Clipe', message: 'Há vídeos sendo processados.',
      detail: 'Você pode manter a fábrica trabalhando em segundo plano ou encerrá-la agora (os jobs interrompidos voltam à fila na próxima abertura).',
      buttons: ['Continuar em segundo plano', 'Encerrar a fábrica', 'Voltar'], defaultId: 0, cancelId: 2,
    });
    if (choice === 0) toBackground(); else if (choice === 1) void shutdown();
  };

  app.on('window-all-closed', () => { /* o encerramento é explícito (menu da bandeja ou diálogo) */ });
  app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); void shutdown(); } });
  return { onClose, shutdown };
}
