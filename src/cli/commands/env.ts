import { Command } from 'commander';
import { CodexApplication } from '../../app/CodexApplication';

/** `codex env create/list/export/import` — spec section 15. */
export function registerEnvCommands(program: Command, app: CodexApplication): void {
  const env = program.command('env').description('Manage environments');

  env
    .command('create')
    .description('Create a new environment (e.g. codex env create --pack node)')
    .requiredOption('--pack <packId>', 'Environment pack ID')
    .action(async (options: { pack: string }) => {
      const packId = options.pack.startsWith('codex-pack-') ? options.pack : `codex-pack-${options.pack}`;
      const manifest = await app.environmentManager.create({
        packId,
        onProgress: (line) => console.log(`  ${line}`),
      });
      console.log(`\nEnvironment created: ${manifest.environmentId}`);
      console.log(`  Name: ${manifest.name}`);
      console.log(`  Provider: ${manifest.providerType}`);
      console.log(`  Base image: ${manifest.baseImage}`);
    });

  env
    .command('list')
    .description('List all environments')
    .action(() => {
      const environments = app.environmentManager.list();
      if (environments.length === 0) {
        console.log('No environments found.');
        return;
      }
      for (const e of environments) {
        console.log(`${e.environmentId}  ${e.name.padEnd(24)}  ${e.providerType.padEnd(10)}  v${e.version}`);
      }
    });

  env
    .command('export <environmentId>')
    .description('Export an environment as a portable archive')
    .requiredOption('--out <dir>', 'Output directory')
    .action(async (environmentId: string, options: { out: string }) => {
      const archivePath = await app.environmentManager.exportEnvironment(environmentId, options.out);
      console.log(`Environment exported to: ${archivePath}`);
    });

  env
    .command('import <archivePath>')
    .description('Import a previously exported environment archive')
    .action(async (archivePath: string) => {
      const manifest = await app.environmentManager.importEnvironment(archivePath);
      console.log(`Environment imported: ${manifest.environmentId} (${manifest.name})`);
    });
}
