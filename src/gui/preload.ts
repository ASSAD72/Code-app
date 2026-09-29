import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script — spec section 16/19. Runs in an isolated context with
 * access to Node/Electron APIs, and exposes ONLY a curated, named set of
 * functions to the renderer via contextBridge. The renderer (untrusted
 * web content, even though it's our own HTML/JS) never gets direct
 * ipcRenderer or Node access — this mirrors the same "no raw shell to
 * the AI" principle from spec section 19, applied to the GUI's own
 * process boundary.
 */
contextBridge.exposeInMainWorld('codex', {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (args: { name: string; packId: string; type: string }) => ipcRenderer.invoke('projects:create', args),
    history: (projectId: string) => ipcRenderer.invoke('projects:history', projectId),
    memory: (projectId: string) => ipcRenderer.invoke('projects:memory', projectId),
    setNetworkPermission: (projectId: string, enabled: boolean) =>
      ipcRenderer.invoke('projects:setNetworkPermission', { projectId, enabled }),
    onProgress: (callback: (line: string) => void) => {
      ipcRenderer.on('projects:progress', (_event, line) => callback(line));
    },
  },
  environments: {
    list: () => ipcRenderer.invoke('environments:list'),
    packs: () => ipcRenderer.invoke('environments:packs'),
    create: (packId: string) => ipcRenderer.invoke('environments:create', { packId }),
    availability: () => ipcRenderer.invoke('environments:availability'),
    onProgress: (callback: (line: string) => void) => {
      ipcRenderer.on('environments:progress', (_event, line) => callback(line));
    },
  },
  ai: {
    plan: (goal: string, projectId: string) => ipcRenderer.invoke('ai:plan', { goal, projectId }),
    executePlan: (projectId: string, plan: unknown) => ipcRenderer.invoke('ai:executePlan', { projectId, plan }),
  },
  build: {
    run: (projectId: string) => ipcRenderer.invoke('build:run', projectId),
  },
  test: {
    run: (projectId: string) => ipcRenderer.invoke('test:run', projectId),
  },
  repair: {
    run: (projectId: string, maxRetries?: number) => ipcRenderer.invoke('repair:run', { projectId, maxRetries }),
    onAttempt: (callback: (attempt: unknown) => void) => {
      ipcRenderer.on('repair:attempt', (_event, attempt) => callback(attempt));
    },
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    listByProject: (projectId: string) => ipcRenderer.invoke('jobs:listByProject', projectId),
    cancel: (jobId: string) => ipcRenderer.invoke('jobs:cancel', jobId),
    onLog: (callback: (payload: { jobId: string; line: unknown }) => void) => {
      ipcRenderer.on('jobs:log', (_event, payload) => callback(payload));
    },
    onStatus: (callback: (job: unknown) => void) => {
      ipcRenderer.on('jobs:status', (_event, job) => callback(job));
    },
  },
  snapshots: {
    list: (projectId: string) => ipcRenderer.invoke('snapshots:list', projectId),
    create: (projectId: string, label: string) => ipcRenderer.invoke('snapshots:create', { projectId, label }),
    restore: (projectId: string, snapshotId: string) => ipcRenderer.invoke('snapshots:restore', { projectId, snapshotId }),
  },
  exportProject: {
    source: (projectId: string, outputDir: string) => ipcRenderer.invoke('export:source', { projectId, outputDir }),
    native: (projectId: string, target: string, outputDir: string) =>
      ipcRenderer.invoke('export:native', { projectId, target, outputDir }),
    onProgress: (callback: (line: string) => void) => {
      ipcRenderer.on('export:progress', (_event, line) => callback(line));
    },
  },
  resources: {
    snapshot: (projectId: string) => ipcRenderer.invoke('resources:snapshot', projectId),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
  },
});
