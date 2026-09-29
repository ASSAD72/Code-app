#!/usr/bin/env node
import { Command } from 'commander';
import { CodexApplication } from '../app/CodexApplication';
import { registerDoctorCommand } from './commands/doctor';
import { registerProjectLifecycleCommands } from './commands/projectLifecycle';
import { registerEnvCommands } from './commands/env';
import { registerSnapshotAndExportCommands } from './commands/snapshotExport';

/**
 * CodeX Desktop CLI — spec section 15:
 *   codex create, codex env create/list/export/import, codex build,
 *   codex test, codex run, codex snapshot, codex restore, codex export,
 *   codex import, codex doctor
 */
async function main(): Promise<void> {
  const program = new Command();
  program.name('codex').description('CodeX Desktop — local software development, build, and execution environment.').version('1.0.0');

  const aiProviderEnv = process.env.CODEX_AI_PROVIDER as 'ollama' | 'llamacpp' | 'none' | undefined;
  const app = new CodexApplication({
    aiProvider: aiProviderEnv ?? 'none',
    ollamaBaseUrl: process.env.CODEX_OLLAMA_URL,
    ollamaModel: process.env.CODEX_OLLAMA_MODEL,
    llamaCppBaseUrl: process.env.CODEX_LLAMACPP_URL,
  });

  await app.initialize();

  registerDoctorCommand(program, app);
  registerProjectLifecycleCommands(program, app);
  registerEnvCommands(program, app);
  registerSnapshotAndExportCommands(program, app);

  program
    .command('project-list')
    .alias('projects')
    .description('List all projects')
    .action(() => {
      const projects = app.projectManager.list();
      if (projects.length === 0) {
        console.log('No projects found. Use "codex create <name> --env <pack>" to create one.');
        return;
      }
      for (const p of projects) {
        console.log(`${p.id}  ${p.name.padEnd(24)}  ${p.type.padEnd(14)}  ${p.sourcePath}`);
      }
    });

  program
    .command('repair <projectNameOrId>')
    .description('Run the self-healing build/test/repair loop on a project')
    .option('--max-retries <n>', 'Maximum repair attempts', '8')
    .action(async (projectNameOrId: string, options: { maxRetries: string }) => {
      const { findProject } = await import('./commands/projectLifecycle');
      const project = findProject(app, projectNameOrId);
      const environment = app.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment for project "${project.name}" not found.`);

      const session = await app.repairEngine.runRepairLoop(project, environment, {
        maxRetries: parseInt(options.maxRetries, 10),
        onAttempt: (attempt) => {
          console.log(`Attempt #${attempt.attemptNumber}: ${attempt.outcome}`);
          if (attempt.errorAnalysis) console.log(`  Error: ${attempt.errorAnalysis.message}`);
          if (attempt.patch) console.log(`  Patch applied: ${attempt.patch.description}`);
        },
      });

      console.log(`\nRepair session ${session.status}: ${session.attempts.length} attempt(s).`);
      process.exitCode = session.status === 'success' ? 0 : 1;
    });

  try {
    await program.parseAsync(process.argv);
  } finally {
    await app.shutdown();
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
