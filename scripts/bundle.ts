/**
 * Builds build/<function>/index.js for each Lambda function: one file with every
 * dependency inside, including the AWS SDK clients (the Lambda runtime's bundled SDK
 * may not include @aws-sdk/client-eventbridgev2 yet, and we want the version we tested).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.join(__dirname, '..');
const functions = ['publisher', 'ledger'];

for (const name of functions) {
  const outdir = path.join(root, 'build', name);
  rmSync(outdir, { recursive: true, force: true });
  const result = buildSync({
    entryPoints: [path.join(root, 'src', name, 'handler.ts')],
    outfile: path.join(outdir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    sourcemap: true,
    legalComments: 'none',
    metafile: true,
  });
  // Kept outside the asset folder so it isn't deployed. The bundle test reads it.
  mkdirSync(path.join(root, 'build', 'meta'), { recursive: true });
  writeFileSync(path.join(root, 'build', 'meta', `${name}.json`), JSON.stringify(result.metafile));
  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
  console.log(`bundled build/${name}/index.js (${(bytes / 1024).toFixed(0)} KiB with source map)`);
}
