import { promises as fs } from 'fs';
import path from 'path';
import { EnvironmentPack } from '../environments/EnvironmentPack';
import { EnvironmentPackRegistry } from '../environments/EnvironmentPackRegistry';
import { ToolDefinition } from '@core/types';
import { ToolRegistry } from '../tools/ToolRegistry';

/**
 * Plugin system — spec section 21. A plugin can add a Language, Runtime,
 * SDK, Environment, Tool, Build system, Emulator, or Exporter, WITHOUT
 * Core depending on any specific plugin (spec: "Core must not depend on
 * a specific Plugin").
 *
 * A plugin package (e.g. `codex-plugin-unity`) is a directory containing
 * a `codex-plugin.json` manifest and a CommonJS entry point exporting a
 * `register(context: PluginContext)` function. PluginManager loads these
 * dynamically at startup from the user's plugins directory — Core itself
 * never imports a named plugin.
 */

export interface PluginManifestFile {
  id: string; // e.g. "codex-plugin-unity"
  displayName: string;
  version: string;
  entryPoint: string; // relative path to the compiled JS entry point
  description?: string;
}

export interface PluginContext {
  registerEnvironmentPack(pack: EnvironmentPack): void;
  registerTool(tool: ToolDefinition): void;
}

export interface PluginModule {
  register(context: PluginContext): void | Promise<void>;
}

export interface InstalledPlugin {
  manifest: PluginManifestFile;
  enabled: boolean;
  installedAt: string;
  directory: string;
}

export class PluginManager implements PluginContext {
  private installedPlugins = new Map<string, InstalledPlugin>();

  constructor(
    private readonly pluginsDir: string,
    private readonly environmentPackRegistry: EnvironmentPackRegistry,
    private readonly toolRegistry: ToolRegistry
  ) {}

  registerEnvironmentPack(pack: EnvironmentPack): void {
    this.environmentPackRegistry.register(pack);
  }

  registerTool(tool: ToolDefinition): void {
    this.toolRegistry.register(tool);
  }

  /**
   * Scan the plugins directory for installed plugins (each a subdirectory
   * containing codex-plugin.json) and load+register every enabled one.
   * Errors in one plugin are isolated and reported, not allowed to crash
   * the whole app (spec section 21's plugin architecture implies
   * resilience — a broken third-party plugin should not take down Core).
   */
  async loadAll(onError?: (pluginId: string, error: Error) => void): Promise<InstalledPlugin[]> {
    await fs.mkdir(this.pluginsDir, { recursive: true });
    const entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });
    const loaded: InstalledPlugin[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(this.pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, 'codex-plugin.json');

      try {
        const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestRaw) as PluginManifestFile;
        validatePluginId(manifest.id);
        if (!manifest.entryPoint || typeof manifest.entryPoint !== 'string') throw new Error('Plugin entryPoint is required.');

        const installed: InstalledPlugin = {
          manifest,
          enabled: true,
          installedAt: new Date().toISOString(),
          directory: pluginDir,
        };

        const entryPointPath = resolveChildPath(pluginDir, manifest.entryPoint);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pluginModule = require(entryPointPath) as PluginModule;
        await pluginModule.register(this);

        this.installedPlugins.set(manifest.id, installed);
        loaded.push(installed);
      } catch (err) {
        onError?.(entry.name, err instanceof Error ? err : new Error(String(err)));
      }
    }

    return loaded;
  }

  list(): InstalledPlugin[] {
    return Array.from(this.installedPlugins.values());
  }

  async install(sourceDir: string): Promise<InstalledPlugin> {
    const manifestPath = path.join(sourceDir, 'codex-plugin.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as PluginManifestFile;

    validatePluginId(manifest.id);
    const destDir = path.join(this.pluginsDir, manifest.id);
    await fs.cp(sourceDir, destDir, { recursive: true });

    const installed: InstalledPlugin = {
      manifest,
      enabled: true,
      installedAt: new Date().toISOString(),
      directory: destDir,
    };
    this.installedPlugins.set(manifest.id, installed);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pluginModule = require(resolveChildPath(destDir, manifest.entryPoint)) as PluginModule;
    await pluginModule.register(this);

    return installed;
  }

  async uninstall(pluginId: string): Promise<void> {
    const installed = this.installedPlugins.get(pluginId);
    if (!installed) return;
    await fs.rm(installed.directory, { recursive: true, force: true });
    this.installedPlugins.delete(pluginId);
    // Note: registered packs/tools from this plugin remain registered
    // until the app restarts, since EnvironmentPackRegistry/ToolRegistry
    // don't currently support per-plugin unregistration of already-issued
    // references. A restart is required for a full clean removal.
  }
}


function validatePluginId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error(`Invalid plugin id: ${id}`);
}

function resolveChildPath(root: string, requested: string): string {
  const base = path.resolve(root);
  const candidate = path.resolve(base, requested);
  const relative = path.relative(base, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Plugin entry point escapes its plugin directory.');
  return candidate;
}
