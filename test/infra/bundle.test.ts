/**
 * Each function is one self-contained index.js. Lambda loads index.handler from it.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { BUILD_DIR, FUNCTIONS } from '../../infra/lib/orders-bus-stack';

describe.each(FUNCTIONS)('%s bundle', (name) => {
  const dir = path.join(BUILD_DIR, name);

  test('holds only index.js and its source map', () => {
    expect(fs.readdirSync(dir).sort()).toEqual(['index.js', 'index.js.map']);
  });

  test('imports nothing outside Node.js itself', () => {
    // esbuild's metafile lists every import it left unbundled. Only Node built-ins may remain.
    const meta = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'meta', `${name}.json`), 'utf8')) as {
      outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
    };
    const builtins = new Set(builtinModules);
    const external = Object.values(meta.outputs)
      .flatMap((o) => o.imports)
      .filter((i) => i.external)
      .map((i) => i.path.replace(/^node:/, ''))
      .filter((p) => !builtins.has(p));
    expect([...new Set(external)]).toEqual([]);
  });

  test('loads in a fresh process and exports handler', () => {
    // A separate Node process, as Lambda would load it, with no node_modules on the path.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `process.stdout.write(typeof require(${JSON.stringify(path.join(dir, 'index.js'))}).handler)`], {
      cwd: '/',
      env: { PATH: process.env.PATH ?? '', NODE_PATH: '' },
      timeout: 20_000,
    }).toString();
    expect(out).toBe('function');
  });
});
