#!/usr/bin/env node
// A bundle size budget. Bundles the built dist/index.js with esbuild (minified, tree-shaken) the way a
// consumer's bundler would, then measures the gzipped size — zero runtime dependencies means this should stay
// small, and a regression here is a real regression a merchant's bundle will carry.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import esbuild from 'esbuild';

const BUDGET_BYTES = 20 * 1024; // 20 KiB gzipped; revisit if a real feature needs more.

const result = await esbuild.build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});

const output = result.outputFiles?.[0];
if (!output) {
  console.error('esbuild produced no output for dist/index.js');
  process.exit(1);
}

const gzipped = gzipSync(Buffer.from(output.contents)).length;
console.log(`dist/index.js: ${output.contents.length} bytes minified, ${gzipped} bytes gzipped (budget ${BUDGET_BYTES})`);

if (gzipped > BUDGET_BYTES) {
  console.error(`Bundle size ${gzipped} bytes exceeds the ${BUDGET_BYTES} byte budget.`);
  process.exit(1);
}
