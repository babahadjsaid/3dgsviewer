// Contract test for the package. Runs as an SSR bundle (see scripts/check.mjs)
// so it exercises the real component and the real feature wiring, no browser.
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
// Imports the BUILT output - the exact files a consumer resolves through the
// package's "exports" map - so the gate covers the compiled JSX too.
import { GaussianSplatViewer, createViewer, startViewer } from '../dist/index.js';
import { defaultFeatures, createOrbitCameraPath } from '../dist/features/index.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

// --- exports -----------------------------------------------------------------
check('exports createViewer', typeof createViewer, 'function');
check('exports startViewer', typeof startViewer, 'function');
check('exports GaussianSplatViewer', typeof GaussianSplatViewer, 'object'); // forwardRef

// --- markup per mode ---------------------------------------------------------
const full = renderToStaticMarkup(<GaussianSplatViewer src="scene.ply" />);
const min = renderToStaticMarkup(<GaussianSplatViewer src="scene.ply" fullScreen={false} />);

const chrome = {
  'view toolbar': 'data-pca-view',
  'fps readout': 'viewer-quality',
  'title/help panel': 'viewer-info',
  'progress bar': 'viewer-progress',
  'status text': 'viewer-message',
  'loading cube': 'cube-face',
  'axes toggle': 'reference-frame-toggle',
  'bbox toggle': 'bbox-toggle',
  'keyboard focus': 'tabindex',
};
for (const [label, needle] of Object.entries(chrome)) {
  check(`full mode renders ${label}`, full.includes(needle), true);
  check(`minimal mode omits ${label}`, min.includes(needle), false);
}
check('full mode renders canvas', full.includes('data-viewer-element="canvas"'), true);
check('minimal mode renders canvas', min.includes('data-viewer-element="canvas"'), true);
check('minimal mode is canvas only', min.replace(/<main[^>]*>|<\/main>/g, ''),
  '<canvas class="viewer-canvas" data-viewer-element="canvas"></canvas>');

// Streaming: model-only chrome, but the fps readout stays.
{
  const html = renderToStaticMarkup(<GaussianSplatViewer mode="streaming" src="x.ply" />);
  assert(!html.includes('view-toolbar'), 'streaming must not render the toolbar');
  assert(!html.includes('data-viewer-element="spinner"'), 'streaming must not render the spinner');
  assert(!html.includes('data-viewer-element="instructions"'), 'streaming must not render the controls hint');
  assert(html.includes('data-viewer-element="fps"'), 'streaming must keep the fps readout');
  assert(html.includes('data-viewer-element="canvas"'), 'streaming must render the canvas');
}

// Back-compat: the old prop still means exactly what it meant.
{
  const minimal = renderToStaticMarkup(<GaussianSplatViewer fullScreen={false} src="x.ply" />);
  assert(!minimal.includes('data-viewer-element="fps"'), 'fullScreen={false} must stay model-only');
  const full = renderToStaticMarkup(<GaussianSplatViewer fullScreen src="x.ply" />);
  assert(full.includes('view-toolbar'), 'fullScreen must still render the toolbar');
}

// --- feature wiring per mode -------------------------------------------------
// Mirrors buildFeatureList() in src/viewer.js.
const build = (motion, opts = {}) => defaultFeatures({
  cameraPath: opts.cameraPath ?? (motion ? undefined : false),
  overlays: opts.overlays ?? (motion ? undefined : []),
  loadingEffect: opts.loadingEffect ?? (motion ? undefined : false),
}).map((f) => (typeof f === 'function' ? f() : f).id);

check('full mode features', build(true),
  ['camera-path-orbit', 'bounding-box', 'origin-axes', 'loading-effect-reveal']);
check('minimal mode has no orbit or reveal', build(false), []);
check('explicit cameraPath overrides minimal mode',
  build(false, { cameraPath: createOrbitCameraPath() }), ['camera-path-orbit']);

// --- PlayCanvas gsplat renderer -------------------------------------------
// Regression guard for the reveal effect. Under the unified renderer
// `gsplat.material` is null, so features have no material to touch and the
// two-stage reveal silently does nothing. The default flipped to unified in
// PlayCanvas 2.14+, which broke the effect for anyone on a current release.
// src/viewer.js passes `unified: false`; this asserts that option is still
// honoured by whatever PlayCanvas is installed.
{
  // Half one: the viewer still asks for a per-instance material. Asserted
  // against the built output, since exercising the real code path needs WebGL
  // and a loaded splat asset.
  // Resolved from the package root, not this file: the test runs as a bundle
  // from .check-out/, so import.meta.url points somewhere else.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const built = readFileSync(join(process.cwd(), 'dist', 'viewer.js'), 'utf8');
  check('viewer creates the gsplat component with unified:false',
    /addComponent\(\s*["']gsplat["']\s*,\s*\{\s*unified:\s*false/.test(built), true);

  // Half two: PlayCanvas still honours the option.
  const pc = await import('playcanvas/build/playcanvas.mjs');
  const app = new pc.AppBase({ id: 'contract-test' });
  app.init({
    graphicsDevice: new pc.NullGraphicsDevice({}),
    componentSystems: [pc.GSplatComponentSystem],
    resourceHandlers: [],
  });

  // --- the reveal effect must target a hook this engine actually has --------
  // PlayCanvas renamed the gsplat customisation chunk in 2.14:
  // `gsplatCustomizeVS` -> `gsplatModifyVS`. Setting a chunk the engine does
  // not include is a silent no-op, which is exactly how the reveal effect died
  // on modern engines without a single warning. These chunks are registered per
  // material rather than in the global ShaderChunks registry, so the engine
  // bundle is the thing to ask.
  {
    const engine = readFileSync(
      join(process.cwd(), 'node_modules', 'playcanvas', 'build', 'playcanvas.mjs'), 'utf8');
    const effect = readFileSync(
      join(process.cwd(), 'dist', 'features', 'loading-effect-reveal.js'), 'utf8');

    const hooks = ['gsplatModifyVS', 'gsplatCustomizeVS'];
    const inEngine = hooks.filter((h) => engine.includes(h));
    // Match the actual `.set('<hook>'` call - a bare name match would also hit
    // the comments that mention both hooks, and pass while the code is broken.
    const inEffect = hooks.filter((h) => new RegExp(`set\\(\\s*["']${h}["']`).test(effect));
    const shared = inEngine.filter((h) => inEffect.includes(h));

    console.log(`     engine offers [${inEngine.join(', ') || 'none'}]; effect sets [${inEffect.join(', ')}]`);
    check('the reveal effect sets a hook the installed engine includes',
      shared.length > 0, true);
  }

  const forced = new pc.Entity('forced', app);
  forced.addComponent('gsplat', { unified: false });
  check('gsplat honours unified:false (reveal effect needs a material)',
    forced.gsplat.unified, false);

  const bare = new pc.Entity('bare', app);
  bare.addComponent('gsplat', {});
  console.log(`     note: this PlayCanvas defaults unified to ${bare.gsplat.unified}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
