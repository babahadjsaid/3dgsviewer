#!/usr/bin/env node
/**
 * Compiles src/ into dist/ so consumers never have to transpile node_modules.
 *
 * `preserveModules` keeps the source tree shape instead of bundling everything
 * into one file: the subpath exports (./viewer, ./features) stay real modules,
 * nothing is duplicated between entry points, and the result tree-shakes.
 * React, react-dom and PlayCanvas stay external - they are peers, and bundling
 * a second PlayCanvas would mean a second WebGL context.
 */

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { rm } from 'node:fs/promises';

const EXTERNAL = [/^react($|\/)/, /^react-dom($|\/)/, /^playcanvas($|\/)/];

await rm('dist', { recursive: true, force: true });

await build({
  logLevel: 'warn',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: 'src/index.js',
        viewer: 'src/viewer.js',
        'features/index': 'src/features/index.js',
      },
      formats: ['es'],
      // The stylesheet the JSX imports is extracted; give it a stable name so
      // the "./styles.css" export path does not move between builds.
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: EXTERNAL,
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
});

console.log('built dist/');
