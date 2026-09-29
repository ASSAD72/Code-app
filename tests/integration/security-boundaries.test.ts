import { describe, expect, it } from 'vitest';
import path from 'path';

describe('security boundary invariants', () => {
  it('rejects workspace traversal by lexical path resolution', () => {
    const root = path.resolve('/workspace/project');
    const target = path.resolve(root, '../secrets.txt');
    const relative = path.relative(root, target);
    expect(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(true);
  });

  it('keeps an in-workspace artifact inside the project', () => {
    const root = path.resolve('/workspace/project');
    const target = path.resolve(root, 'dist/app.apk');
    const relative = path.relative(root, target);
    expect(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))).toBe(true);
  });
});
