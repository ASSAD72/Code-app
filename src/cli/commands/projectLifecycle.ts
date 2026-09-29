import { Command } from 'commander';
import { CodexApplication } from '../../app/CodexApplication';
import { ProjectType } from '@core/types';

/**
 * `codex create`, `codex build`, `codex test`, `codex run` — spec section
 * 15's core project lifecycle commands.
 */
export function registerProjectLifecycleCommands(program: Command, app: CodexApplication): void {
  program
    .command('create <name>')
    .description('Create a new project (e.g. codex create my-app --env node)')
    .requiredOption('--env <packId>', 'Environment pack to use (e.g. node, python, rust, android)')
    .action(async (name: string, options: { env: string }) => {
      const packId = resolvePackId(options.env);
      const pack = app.environmentPackRegistry.get(packId);
      const projectType = inferProjectType(packId);

      console.log(`Creating project "${name}" using pack ${packId}...`);
      const project = await app.projectManager.createProject({
        name,
        type: projectType,
        packId,
        workspaceRootDir: app.config.workspaceRootDir,
        onProgress: (line) => console.log(`  ${line}`),
      });
      console.log(`\nProject created: ${project.id}`);
      console.log(`  Location: ${project.sourcePath}`);
      console.log(`  Environment: ${pack.definition.displayName}`);
    });

  program
    .command('build <projectNameOrId>')
    .description('Build a project (e.g. codex build my-app)')
    .action(async (projectNameOrId: string) => {
      const project = findProject(app, projectNameOrId);
      const environment = app.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment for project "${project.name}" not found.`);

      console.log(`Building ${project.name}...`);
      const result = await app.buildEngine.build(project, environment);
      console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      console.log(result.success ? `\n✔ Build succeeded (${result.durationMs}ms)` : `\n✘ Build failed (exit ${result.exitCode})`);
      process.exitCode = result.success ? 0 : 1;
    });

  program
    .command('test <projectNameOrId>')
    .description('Run a project\'s tests (e.g. codex test my-app)')
    .action(async (projectNameOrId: string) => {
      const project = findProject(app, projectNameOrId);
      const environment = app.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment for project "${project.name}" not found.`);

      console.log(`Testing ${project.name}...`);
      const result = await app.testEngine.test(project, environment);
      console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      const summary = [
        result.passed !== undefined ? `${result.passed} passed` : null,
        result.failed !== undefined ? `${result.failed} failed` : null,
        result.skipped !== undefined ? `${result.skipped} skipped` : null,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(result.success ? `\n✔ Tests passed${summary ? ` (${summary})` : ''}` : `\n✘ Tests failed${summary ? ` (${summary})` : ''}`);
      process.exitCode = result.success ? 0 : 1;
    });

  program
    .command('run <projectNameOrId>')
    .description('Run a project using its configured run command')
    .action(async (projectNameOrId: string) => {
      const project = findProject(app, projectNameOrId);
      if (!project.commands.runCommand) throw new Error(`Project "${project.name}" has no run command configured.`);
      const environment = app.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment for project "${project.name}" not found.`);

      const commandParts = project.commands.runCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [project.commands.runCommand];
      const result = await app.processManager.exec(project, environment, commandParts, {
        onStdout: (chunk) => process.stdout.write(chunk),
        onStderr: (chunk) => process.stderr.write(chunk),
      });
      process.exitCode = result.exitCode;
    });
}

export function findProject(app: CodexApplication, nameOrId: string) {
  const byId = app.projectManager.get(nameOrId);
  if (byId) return byId;
  const byName = app.projectManager.list().find((p) => p.name === nameOrId);
  if (!byName) throw new Error(`Project "${nameOrId}" not found.`);
  return byName;
}

function resolvePackId(env: string): string {
  return env.startsWith('codex-pack-') ? env : `codex-pack-${env}`;
}

function inferProjectType(packId: string): ProjectType {
  const map: Record<string, ProjectType> = {
    'codex-pack-node': 'node',
    'codex-pack-python': 'python',
    'codex-pack-rust': 'rust',
    'codex-pack-cpp': 'cpp',
    'codex-pack-go': 'go',
    'codex-pack-java': 'java',
    'codex-pack-dotnet': 'dotnet',
    'codex-pack-android': 'android',
    'codex-pack-flutter': 'flutter',
    'codex-pack-react-native': 'react-native',
  };
  return map[packId] ?? 'custom';
}
