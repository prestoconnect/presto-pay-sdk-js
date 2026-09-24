#!/usr/bin/env node
// An import test per export condition, including the browser guard and a bundler config that sets
// browser: true while targeting Workers, which must still resolve the real module.
//
// Two different resolvers are exercised on purpose:
//   - Real `node --conditions=...`: Node always has an implicit "node" condition, so this can prove the
//     workerd/edge-light branches resolve correctly, but can never exercise "browser" in isolation — there is
//     no flag to remove Node's own implicit condition.
//   - esbuild, given explicit `conditions`/`platform` and no bundling of Node's own defaults: this is what a
//     real bundler resolver looks like, and it's the one that can hit the exact bug this checks for — a
//     Vite/webpack Workers build that also sets `browser: true`.
import { execFileSync } from 'node:child_process';
import esbuild from 'esbuild';

const root = new URL('..', import.meta.url);

function resolveViaNode(conditions) {
  const args = conditions.flatMap((c) => ['--conditions', c]);
  const script =
    `import('@prestouniverse/presto-pay-sdk').then(m => console.log(typeof m.createPrestoPay))` +
    `.catch(e => { console.error('REJECTED:' + e.message); process.exit(1); });`;
  return execFileSync(process.execPath, ['--input-type=module', ...args, '-e', script], {
    encoding: 'utf8',
    cwd: root,
  }).trim();
}

async function resolveViaBundler(conditions, platform) {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from '@prestouniverse/presto-pay-sdk';`,
      resolveDir: new URL('.', root).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      loader: 'js',
    },
    bundle: true,
    write: false,
    metafile: true,
    conditions,
    platform,
    logLevel: 'silent',
  });
  const inputPaths = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, '/'));
  if (inputPaths.some((p) => p.endsWith('dist/browser.js'))) return 'browser.js';
  if (inputPaths.some((p) => p.endsWith('dist/index.js'))) return 'index.js';
  throw new Error(`could not find dist/index.js or dist/browser.js among: ${inputPaths.join(', ')}`);
}

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${message}`);
  } else {
    console.log(`OK   ${message}`);
  }
}

// The browser guard: executing dist/browser.js directly must throw the server-only error, unconditionally.
try {
  execFileSync(process.execPath, ['--input-type=module', '-e', `import('./dist/browser.js')`], {
    encoding: 'utf8',
    cwd: root,
  });
  check(false, 'dist/browser.js should throw on import, but it did not');
} catch (err) {
  const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  check(/server-only/.test(text), 'dist/browser.js throws the server-only guard on import');
}

// Real Node resolution: these all have the implicit "node" condition active too, so they mainly prove that
// adding workerd/edge-light/browser to the mix doesn't accidentally break resolution of the real module.
for (const conditions of [[], ['workerd'], ['edge-light'], ['browser', 'workerd']]) {
  const label = conditions.length === 0 ? 'plain node' : conditions.join('+');
  const output = resolveViaNode(conditions);
  check(output === 'function', `node --conditions=${label || '(none)'} resolves the real module`);
}

// Bundler resolution, §10's actual bug: browser:true set while conditions still include workerd/edge-light —
// the runtime-specific condition must win because it is ordered first in package.json "exports".
const workersWithBrowserTrue = await resolveViaBundler(['workerd', 'browser'], 'neutral');
check(
  workersWithBrowserTrue === 'index.js',
  `bundler with conditions=[workerd,browser] resolves dist/index.js, not dist/browser.js (got dist/${workersWithBrowserTrue})`,
);

const edgeWithBrowserTrue = await resolveViaBundler(['edge-light', 'browser'], 'neutral');
check(
  edgeWithBrowserTrue === 'index.js',
  `bundler with conditions=[edge-light,browser] resolves dist/index.js, not dist/browser.js (got dist/${edgeWithBrowserTrue})`,
);

// And a real browser-only bundler target (no runtime condition at all) correctly gets the guard.
const browserOnly = await resolveViaBundler([], 'browser');
check(browserOnly === 'browser.js', `a browser-platform bundler with no runtime condition resolves dist/browser.js (got dist/${browserOnly})`);

if (failures > 0) {
  console.error(`\n${failures} export-condition check(s) failed.`);
  process.exit(1);
}
console.log('\nAll export-condition checks passed.');
