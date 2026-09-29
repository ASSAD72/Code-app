import { promises as fs } from 'fs';
import path from 'path';
import { BaseEnvironmentPack } from '../EnvironmentPack';
import { EnvironmentPackDefinition } from '@core/types';

/**
 * Database packs (spec section 6). These differ from language packs in
 * one important way: they are typically composed ALONGSIDE a language
 * environment rather than standalone (e.g. a Python project + a Postgres
 * sidecar). EnvironmentManager supports this via `linkedServicePacks` on
 * a project's environment configuration — see EnvironmentManager.createLinkedService().
 * scaffoldProject() for a database pack produces a docker-compose service
 * fragment plus a connection-info file, rather than application source code.
 */

export class PostgresEnvironmentPack extends BaseEnvironmentPack {
  readonly definition: EnvironmentPackDefinition = {
    packId: 'codex-pack-postgres',
    displayName: 'PostgreSQL',
    description: 'PostgreSQL database service',
    category: 'database',
    version: '1.0.0',
    baseImageTag: 'postgres:16-alpine',
    defaultRuntimes: [{ name: 'postgres', version: '16' }],
    defaultPackageManagers: [],
    defaultCapabilities: ['filesystem', 'network'],
    supportedProviderTypes: ['docker'],
  };

  async scaffoldProject(targetDir: string, projectName: string): Promise<string[]> {
    const composePath = path.join(targetDir, 'docker-compose.postgres.yml');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      composePath,
      `services:\n  ${sanitizeServiceName(projectName)}-postgres:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: codex\n      POSTGRES_PASSWORD: codex\n      POSTGRES_DB: ${sanitizeServiceName(projectName)}\n    ports:\n      - "5432:5432"\n    networks:\n      - codex-net\n`,
      'utf-8'
    );
    return [composePath];
  }
}

export class MySqlEnvironmentPack extends BaseEnvironmentPack {
  readonly definition: EnvironmentPackDefinition = {
    packId: 'codex-pack-mysql',
    displayName: 'MySQL',
    description: 'MySQL database service',
    category: 'database',
    version: '1.0.0',
    baseImageTag: 'mysql:8.4',
    defaultRuntimes: [{ name: 'mysql', version: '8.4' }],
    defaultPackageManagers: [],
    defaultCapabilities: ['filesystem', 'network'],
    supportedProviderTypes: ['docker'],
  };

  async scaffoldProject(targetDir: string, projectName: string): Promise<string[]> {
    const composePath = path.join(targetDir, 'docker-compose.mysql.yml');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      composePath,
      `services:\n  ${sanitizeServiceName(projectName)}-mysql:\n    image: mysql:8.4\n    environment:\n      MYSQL_ROOT_PASSWORD: codex\n      MYSQL_DATABASE: ${sanitizeServiceName(projectName)}\n    ports:\n      - "3306:3306"\n    networks:\n      - codex-net\n`,
      'utf-8'
    );
    return [composePath];
  }
}

export class RedisEnvironmentPack extends BaseEnvironmentPack {
  readonly definition: EnvironmentPackDefinition = {
    packId: 'codex-pack-redis',
    displayName: 'Redis',
    description: 'Redis in-memory data store service',
    category: 'database',
    version: '1.0.0',
    baseImageTag: 'redis:7-alpine',
    defaultRuntimes: [{ name: 'redis', version: '7' }],
    defaultPackageManagers: [],
    defaultCapabilities: ['filesystem', 'network'],
    supportedProviderTypes: ['docker'],
  };

  async scaffoldProject(targetDir: string, projectName: string): Promise<string[]> {
    const composePath = path.join(targetDir, 'docker-compose.redis.yml');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      composePath,
      `services:\n  ${sanitizeServiceName(projectName)}-redis:\n    image: redis:7-alpine\n    ports:\n      - "6379:6379"\n    networks:\n      - codex-net\n`,
      'utf-8'
    );
    return [composePath];
  }
}

export class MongoEnvironmentPack extends BaseEnvironmentPack {
  readonly definition: EnvironmentPackDefinition = {
    packId: 'codex-pack-mongo',
    displayName: 'MongoDB',
    description: 'MongoDB document database service',
    category: 'database',
    version: '1.0.0',
    baseImageTag: 'mongo:7',
    defaultRuntimes: [{ name: 'mongod', version: '7' }],
    defaultPackageManagers: [],
    defaultCapabilities: ['filesystem', 'network'],
    supportedProviderTypes: ['docker'],
  };

  async scaffoldProject(targetDir: string, projectName: string): Promise<string[]> {
    const composePath = path.join(targetDir, 'docker-compose.mongo.yml');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      composePath,
      `services:\n  ${sanitizeServiceName(projectName)}-mongo:\n    image: mongo:7\n    environment:\n      MONGO_INITDB_ROOT_USERNAME: codex\n      MONGO_INITDB_ROOT_PASSWORD: codex\n    ports:\n      - "27017:27017"\n    networks:\n      - codex-net\n`,
      'utf-8'
    );
    return [composePath];
  }
}

export class SqliteEnvironmentPack extends BaseEnvironmentPack {
  readonly definition: EnvironmentPackDefinition = {
    packId: 'codex-pack-sqlite',
    displayName: 'SQLite',
    description: 'Embedded SQLite database (no service container needed)',
    category: 'database',
    version: '1.0.0',
    baseImageTag: 'n/a', // embedded, runs in-process with the host language runtime
    defaultRuntimes: [{ name: 'sqlite', version: '3.46' }],
    defaultPackageManagers: [],
    defaultCapabilities: ['filesystem'],
    supportedProviderTypes: ['docker', 'wsl2', 'process'],
  };

  async scaffoldProject(targetDir: string, projectName: string): Promise<string[]> {
    const readmePath = path.join(targetDir, 'DATABASE.md');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      readmePath,
      `# ${projectName} — SQLite\n\nThis project uses an embedded SQLite database. No separate service\ncontainer is required; the database file lives at \`./data/${sanitizeServiceName(
        projectName
      )}.db\` inside the project workspace.\n`,
      'utf-8'
    );
    return [readmePath];
  }
}

function sanitizeServiceName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
