#!/usr/bin/env node
/**
 * Pre-publish gate. Two passes, both must succeed:
 *
 *   1. Browser bundle - proves src/ bundles for real: PlayCanvas resolves, the
 *      JSX compiles, the CSS is loadable, no bundler-specific syntax sneaks in
 *      (this is what would have caught `import.meta.env`).
 *   2. Contract test  - SSR-renders the component in both `fullScreen` modes
 *      and asserts what each one does and does not put on the page.
 *
 * Nothing here ships: `files` in package.json is limited to src/, README and
 * LICENSE.
 */

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { rm, mkdir, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const OUT = resolve('.check-out');

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log('· bundling package for the browser…');
  await build({
    logLevel: 'warn',
    plugins: [react()],
    build: {
      outDir: `${OUT}/browser`,
      emptyOutDir: true,
      lib: { entry: './src/index.js', formats: ['es'], fileName: 'bundle' },
      rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'] },
    },
  });

  console.log('· building contract test…');
  await build({
    logLevel: 'warn',
    plugins: [react()],
    build: {
      ssr: './test/render-check.jsx',
      outDir: `${OUT}/test`,
      emptyOutDir: true,
      minify: false,
    },
  });

  console.log('· running contract test…\n');
  // Vite names the SSR output .js or .mjs depending on the package `type`.
  const dir = `${OUT}/test`;
  const entry = (await readdir(dir)).find((f) => /^render-check\.m?js$/.test(f));
  if (!entry) throw new Error(`no contract-test bundle emitted in ${dir}`);
  await import(pathToFileURL(join(dir, entry)).href);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
