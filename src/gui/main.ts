import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { CodexApplication } from '../app/CodexApplication';
import { ProjectType, NativeExportTarget } from '@core/types';

/**
 * Electron main process — spec section 16. Owns exactly one
 * CodexApplication instance and exposes its capabilities to the
 * renderer via ipcMain handlers, which the preload script forwards
 * through a safe `window.codex` bridge (see gui/preload.ts).
 *
 * This is real IPC wiring to real Core logic — every handler below calls
 * directly into the same CodexApplication engines the CLI uses, so GUI
 * and CLI are never two different implementations of the same feature.
 */

let mainWindow: BrowserWindow | null = null;
let codexApp: CodexApplication | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'CodeX Desktop',
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'gui', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(codexApplication: CodexApplication): void {
  // --- Projects ---
  ipcMain.handle('projects:list', () => codexApplication.projectManager.list());

  ipcMain.handle('projects:create', async (_event, args: { name: string; packId: string; type: ProjectType }) => {
    return codexApplication.projectManager.createProject({
      name: args.name,
      type: args.type,
      packId: args.packId,
      workspaceRootDir: codexApplication.config.workspaceRootDir,
      onProgress: (line) => mainWindow?.webContents.send('projects:progress', line),
    });
  });

  ipcMain.handle('projects:history', (_event, projectId: string) => codexApplication.projectManager.getHistory(projectId));
  ipcMain.handle('projects:memory', (_event, projectId: string) => codexApplication.projectManager.getMemory(projectId));

  ipcMain.handle('projects:setNetworkPermission', async (_event, args: { projectId: string; enabled: boolean }) => {
    codexApplication.projectManager.setNetworkPermission(args.projectId, args.enabled);
    if (args.enabled) codexApplication.networkPolicy.grant(args.projectId, 'session');
    else codexApplication.networkPolicy.revoke(args.projectId);
    const project = codexApplication.projectManager.get(args.projectId);
    if (project) {
      const environment = codexApplication.environmentManager.get(project.environmentId);
      if (environment) await codexApplication.processManager.setNetworkEnabled(project, environment, args.enabled);
    }
  });

  // --- Environments ---
  ipcMain.handle('environments:list', () => codexApplication.environmentManager.list());
  ipcMain.handle('environments:packs', () =>
    codexApplication.environmentPackRegistry.list().map((p) => p.definition)
  );
  ipcMain.handle('environments:create', async (_event, args: { packId: string }) => {
    return codexApplication.environmentManager.create({
      packId: args.packId,
      onProgress: (line) => mainWindow?.webContents.send('environments:progress', line),
    });
  });
  ipcMain.handle('environments:availability', () => codexApplication.sandboxRegistry.getAvailability());

  // --- AI planner -> ToolExecutor -> Policy -> Sandbox ---
  ipcMain.handle('ai:plan', async (_event, args: { goal: string; projectId: string }) => {
    const project = codexApplication.projectManager.get(args.projectId);
    if (!project) throw new Error(`Project ${args.projectId} not found`);
    return codexApplication.planner.plan(args.goal, project.type);
  });
  ipcMain.handle('ai:executePlan', async (_event, args: { projectId: string; plan: import('@core/types').ExecutionPlan }) => {
    const project = codexApplication.projectManager.get(args.projectId);
    if (!project) throw new Error(`Project ${args.projectId} not found`);
    return codexApplication.planner.executePlan(args.plan, { projectId: project.id, requestedByAI: true, workspaceRoot: project.sourcePath }, project.networkPermission);
  });

  // --- Build / Test / Run ---
  ipcMain.handle('build:run', async (_event, projectId: string) => {
    const project = codexApplication.projectManager.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const environment = codexApplication.environmentManager.get(project.environmentId);
    if (!environment) throw new Error(`Environment not found`);
    return codexApplication.buildEngine.build(project, environment);
  });

  ipcMain.handle('test:run', async (_event, projectId: string) => {
    const project = codexApplication.projectManager.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const environment = codexApplication.environmentManager.get(project.environmentId);
    if (!environment) throw new Error(`Environment not found`);
    return codexApplication.testEngine.test(project, environment);
  });

  ipcMain.handle('repair:run', async (_event, args: { projectId: string; maxRetries?: number }) => {
    const project = codexApplication.projectManager.get(args.projectId);
    if (!project) throw new Error(`Project ${args.projectId} not found`);
    const environment = codexApplication.environmentManager.get(project.environmentId);
    if (!environment) throw new Error(`Environment not found`);
    return codexApplication.repairEngine.runRepairLoop(project, environment, {
      maxRetries: args.maxRetries,
      onAttempt: (attempt) => mainWindow?.webContents.send('repair:attempt', attempt),
    });
  });

  // --- Jobs ---
  ipcMain.handle('jobs:list', () => codexApplication.jobManager.listAll());
  ipcMain.handle('jobs:listByProject', (_event, projectId: string) => codexApplication.jobManager.listByProject(projectId));
  ipcMain.handle('jobs:cancel', (_event, jobId: string) => codexApplication.jobManager.requestCancellation(jobId));

  codexApplication.jobManager.on('job:log', (job, line) => {
    mainWindow?.webContents.send('jobs:log', { jobId: job.id, line });
  });
  codexApplication.jobManager.on('job:status', (job) => {
    mainWindow?.webContents.send('jobs:status', job);
  });

  // --- Snapshots ---
  ipcMain.handle('snapshots:list', (_event, projectId: string) => codexApplication.snapshotManager.list(projectId));
  ipcMain.handle('snapshots:create', async (_event, args: { projectId: string; label: string }) => {
    const project = codexApplication.projectManager.get(args.projectId);
    if (!project) throw new Error(`Project ${args.projectId} not found`);
    return codexApplication.snapshotManager.createSnapshot(project, args.label);
  });
  ipcMain.handle('snapshots:restore', async (_event, args: { projectId: string; snapshotId: string }) => {
    const project = codexApplication.projectManager.get(args.projectId);
    if (!project) throw new Error(`Project ${args.projectId} not found`);
    return codexApplication.snapshotManager.restore(project, args.snapshotId);
  });

  // --- Export ---
  ipcMain.handle(
    'export:source',
    async (_event, args: { projectId: string; outputDir: string }) => {
      const project = codexApplication.projectManager.get(args.projectId);
      if (!project) throw new Error(`Project ${args.projectId} not found`);
      const environment = codexApplication.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment not found`);
      return codexApplication.projectExporter.exportSource(project, environment, args.outputDir);
    }
  );

  ipcMain.handle(
    'export:native',
    async (_event, args: { projectId: string; target: NativeExportTarget; outputDir: string }) => {
      const project = codexApplication.projectManager.get(args.projectId);
      if (!project) throw new Error(`Project ${args.projectId} not found`);
      const environment = codexApplication.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment not found`);
      return codexApplication.projectExporter.exportNative(project, environment, args.target, args.outputDir, (line) =>
        mainWindow?.webContents.send('export:progress', line)
      );
    }
  );

  // --- Resource usage polling for GUI dashboard ---
  ipcMain.handle('resources:snapshot', (_event, projectId: string) => {
    const handle = codexApplication.processManager.getActiveHandle(projectId);
    if (!handle) return null;
    return codexApplication.resourceManager.getLatest(handle.instanceId) ?? null;
  });

  // --- Plugins ---
  ipcMain.handle('plugins:list', () => codexApplication.pluginManager.list());
}

app.whenReady().then(async () => {
  codexApp = new CodexApplication({ aiProvider: (process.env.CODEX_AI_PROVIDER as 'ollama' | 'llamacpp' | 'none') ?? 'none' });
  await codexApp.initialize();
  registerIpcHandlers(codexApp);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await codexApp?.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await codexApp?.shutdown();
});
