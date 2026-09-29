import { EnvironmentPack } from './EnvironmentPack';
import { NodeEnvironmentPack } from './packs/NodeEnvironmentPack';
import { PythonEnvironmentPack } from './packs/PythonEnvironmentPack';
import { RustEnvironmentPack } from './packs/RustEnvironmentPack';
import { CppEnvironmentPack } from './packs/CppEnvironmentPack';
import { GoEnvironmentPack } from './packs/GoEnvironmentPack';
import { JavaEnvironmentPack } from './packs/JavaEnvironmentPack';
import { DotNetEnvironmentPack } from './packs/DotNetEnvironmentPack';
import { AndroidEnvironmentPack } from './packs/AndroidEnvironmentPack';
import { FlutterEnvironmentPack } from './packs/FlutterEnvironmentPack';
import { ReactNativeEnvironmentPack } from './packs/ReactNativeEnvironmentPack';
import {
  PostgresEnvironmentPack,
  MySqlEnvironmentPack,
  RedisEnvironmentPack,
  MongoEnvironmentPack,
  SqliteEnvironmentPack,
} from './packs/DatabaseEnvironmentPacks';

/**
 * EnvironmentPackRegistry — the plugin registration point referenced by
 * spec sections 6, 17, and 21. Core never imports a specific language
 * pack directly; it asks this registry for "the pack for packId X" or
 * "all packs in category Y". Third-party plugins (spec section 21, e.g.
 * `codex-plugin-unity`) register themselves here through PluginManager
 * at startup — see plugins/PluginManager.ts.
 */
export class EnvironmentPackRegistry {
  private packs = new Map<string, EnvironmentPack>();

  constructor(registerBuiltins = true) {
    if (registerBuiltins) {
      this.registerBuiltinPacks();
    }
  }

  private registerBuiltinPacks(): void {
    const builtins: EnvironmentPack[] = [
      new NodeEnvironmentPack(),
      new PythonEnvironmentPack(),
      new RustEnvironmentPack(),
      new CppEnvironmentPack(),
      new GoEnvironmentPack(),
      new JavaEnvironmentPack(),
      new DotNetEnvironmentPack(),
      new AndroidEnvironmentPack(),
      new FlutterEnvironmentPack(),
      new ReactNativeEnvironmentPack(),
      new PostgresEnvironmentPack(),
      new MySqlEnvironmentPack(),
      new RedisEnvironmentPack(),
      new MongoEnvironmentPack(),
      new SqliteEnvironmentPack(),
    ];
    for (const pack of builtins) {
      this.register(pack);
    }
  }

  register(pack: EnvironmentPack): void {
    if (this.packs.has(pack.definition.packId)) {
      throw new Error(`Environment pack "${pack.definition.packId}" is already registered.`);
    }
    this.packs.set(pack.definition.packId, pack);
  }

  unregister(packId: string): void {
    this.packs.delete(packId);
  }

  get(packId: string): EnvironmentPack {
    const pack = this.packs.get(packId);
    if (!pack) throw new Error(`Unknown environment pack "${packId}"`);
    return pack;
  }

  has(packId: string): boolean {
    return this.packs.has(packId);
  }

  list(): EnvironmentPack[] {
    return Array.from(this.packs.values());
  }

  listByCategory(category: string): EnvironmentPack[] {
    return this.list().filter((p) => p.definition.category === category);
  }
}
