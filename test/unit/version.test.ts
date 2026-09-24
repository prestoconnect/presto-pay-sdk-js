import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SDK_VERSION } from '../../src/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(here, '../../package.json'), 'utf8'),
) as { version: string };

describe('SDK_VERSION', () => {
  it('matches package.json', () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
