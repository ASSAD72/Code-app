import { Command } from 'commander';
import { CodexApplication } from '../../app/CodexApplication';
import { findProject } from './projectLifecycle';
import { NativeExportTarget } from '@core/types';

/** `codex snapshot`, `codex restore`, `codex export`, `codex import` — spec section 15. */
export function registerSnapshotAndExportCommands(program: Command, app: CodexApplication): void {
  program
    .command('snapshot <projectNameOrId>')
    .description('Create a snapshot of a project')
    .option('--label <label>', 'Label for the snapshot', 'Manual snapshot')
    .action(async (projectNameOrId: string, options: { label: string }) => {
      const project = findProject(app, projectNameOrId);
      const snapshot = await app.snapshotManager.createSnapshot(project, options.label);
      console.log(`Snapshot created: ${snapshot.id}`);
    });

  program
    .command('restore <projectNameOrId> <snapshotId>')
    .description('Restore a project to a previous snapshot')
    .action(async (projectNameOrId: string, snapshotId: string) => {
      const project = findProject(app, projectNameOrId);
      await app.snapshotManager.restore(project, snapshotId);
      console.log(`Project "${project.name}" restored to snapshot ${snapshotId}.`);
    });

  const exportCmd = program.command('export <projectNameOrId>').description('Export a project');
  exportCmd
    .option('--source', 'Export source code + manifests (default)')
    .option('--native <target>', 'Export a native build (windows-exe, windows-msi, android-apk, android-aab, web-bundle, linux-binary)')
    .requiredOption('--out <dir>', 'Output directory')
    .action(async (projectNameOrId: string, options: { source?: boolean; native?: string; out: string }) => {
      const project = findProject(app, projectNameOrId);
      const environment = app.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment for project "${project.name}" not found.`);

      if (options.native) {
        const archivePath = await app.projectExporter.exportNative(
          project,
          environment,
          options.native as NativeExportTarget,
          options.out,
          (line) => console.log(`  ${line}`)
        );
        console.log(`Native artifact exported to: ${archivePath}`);
      } else {
        const archivePath = await app.projectExporter.exportSource(project, environment, options.out);
        console.log(`Source exported to: ${archivePath}`);
      }
    });

  program
    .command('import <archivePath>')
    .description('Import a previously exported project archive')
    .action(async (archivePath: string) => {
      const project = await app.importer.importProject(archivePath, app.config.workspaceRootDir);
      console.log(`Project imported: ${project.id} (${project.name})`);
      console.log(`  Location: ${project.sourcePath}`);
    });
}
