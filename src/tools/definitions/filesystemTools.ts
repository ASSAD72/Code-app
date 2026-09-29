import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from '@core/types';

/**
 * Filesystem tools — spec section 18. All paths are resolved relative to
 * a workspace root passed in via input; PolicyEngine's `isOutsideWorkspace`
 * check (see policy/PolicyEngine.ts) is what actually prevents an
 * AI-originated call from escaping the project directory — these handlers
 * themselves just do the I/O once policy has cleared the request.
 */

export const filesystemCreateTool: ToolDefinition<{ path: string; isDirectory?: boolean }, { created: string }> = {
  name: 'filesystem.create',
  description: 'Create a new file or directory within the project workspace.',
  requiresSandbox: false,
  requiresNetwork: false,
  destructive: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to create, relative to the project workspace.' },
      isDirectory: { type: 'boolean', description: 'If true, create a directory instead of an empty file.' },
    },
    required: ['path'],
  },
  handler: async (input, context) => {
    const safePath = await requireWorkspacePath(input.path, context.workspaceRoot);
    if (input.isDirectory) {
      await fs.mkdir(safePath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, '', { flag: 'wx' });
    }
    return { created: safePath };
  },
};

export const filesystemReadTool: ToolDefinition<{ path: string }, { content: string }> = {
  name: 'filesystem.read',
  description: 'Read the contents of a file within the project workspace.',
  requiresSandbox: false,
  requiresNetwork: false,
  destructive: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to read, relative to the project workspace.' } },
    required: ['path'],
  },
  handler: async (input, context) => {
    const safePath = await requireWorkspacePath(input.path, context.workspaceRoot);
    const content = await fs.readFile(safePath, 'utf-8');
    return { content };
  },
};

export const filesystemWriteTool: ToolDefinition<{ path: string; content: string }, { written: string; bytes: number }> = {
  name: 'filesystem.write',
  description: 'Write (overwrite) content to a file within the project workspace.',
  requiresSandbox: false,
  requiresNetwork: false,
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to write, relative to the project workspace.' },
      content: { type: 'string', description: 'Full content to write to the file.' },
    },
    required: ['path', 'content'],
  },
  handler: async (input, context) => {
    const safePath = await requireWorkspacePath(input.path, context.workspaceRoot);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, input.content, 'utf-8');
    return { written: safePath, bytes: Buffer.byteLength(input.content, 'utf-8') };
  },
};

export const filesystemDeleteTool: ToolDefinition<{ path: string; recursive?: boolean }, { deleted: string }> = {
  name: 'filesystem.delete',
  description: 'Delete a file or directory within the project workspace.',
  requiresSandbox: false,
  requiresNetwork: false,
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to delete, relative to the project workspace.' },
      recursive: { type: 'boolean', description: 'If true and the path is a directory, delete recursively.' },
    },
    required: ['path'],
  },
  handler: async (input, context) => {
    const safePath = await requireWorkspacePath(input.path, context.workspaceRoot);
    await fs.rm(safePath, { recursive: input.recursive ?? false, force: false });
    return { deleted: safePath };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const filesystemTools: ToolDefinition<any, any>[] = [
  filesystemCreateTool,
  filesystemReadTool,
  filesystemWriteTool,
  filesystemDeleteTool,
];


async function requireWorkspacePath(inputPath: string, workspaceRoot?: string): Promise<string> {
  if (!workspaceRoot) throw new Error('Workspace root is required for filesystem tools.');
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Filesystem path escapes the project workspace.');
  const existing = await fs.realpath(resolved).catch(async () => {
    const parent = await fs.realpath(path.dirname(resolved)).catch(() => null);
    return parent ? path.join(parent, path.basename(resolved)) : resolved;
  });
  const realRelative = path.relative(root, existing);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('Filesystem path escapes the project workspace through a symlink.');
  return resolved;
}
