/**
 * A minimal vitest `Environment` backed by `@edge-runtime/vm`'s `EdgeVM`, for the edge-runtime test leg. There
 * is no maintained `vitest-environment-edge-runtime` package on npm (vitest resolves the built-in name
 * "edge-runtime" to exactly that package name, which 404s) — so this fills the same role: overlay
 * the Vercel Edge Runtime's own primitives (its `fetch`, `crypto.subtle`, `TextEncoder`/`Decoder`, `atob`/`btoa`)
 * onto the Node global vitest hands us, so the code under test really exercises the edge platform's
 * implementations rather than Node's.
 */
import { EdgeVM } from '@edge-runtime/vm';
import type { Environment } from 'vitest/environments';

const OVERLAY_KEYS = [
  'crypto',
  'Crypto',
  'CryptoKey',
  'SubtleCrypto',
  'fetch',
  'Request',
  'Response',
  'Headers',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'atob',
  'btoa',
  'structuredClone',
  'DOMException',
  'URL',
  'URLSearchParams',
] as const;

export default {
  name: 'presto-edge-runtime',
  transformMode: 'ssr',
  setup(global) {
    const vm = new EdgeVM();
    const previous = new Map<string, PropertyDescriptor | undefined>();

    // Node defines several of these (crypto, fetch, ...) as getter-only accessors, so a plain assignment
    // throws; redefine the property outright instead, and restore the original descriptor on teardown.
    for (const key of OVERLAY_KEYS) {
      if (!(key in vm.context)) continue;
      previous.set(key, Object.getOwnPropertyDescriptor(global, key));
      Object.defineProperty(global, key, {
        value: (vm.context as Record<string, unknown>)[key],
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    return {
      teardown() {
        for (const [key, descriptor] of previous) {
          if (descriptor) {
            Object.defineProperty(global, key, descriptor);
          } else {
            delete (global as Record<string, unknown>)[key];
          }
        }
      },
    };
  },
} satisfies Environment;
