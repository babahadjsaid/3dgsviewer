// Contract test for the package. Runs as an SSR bundle (see scripts/check.mjs)
// so it exercises the real component and the real feature wiring, no browser.
import { renderToStaticMarkup } from 'react-dom/server';
import { GaussianSplatViewer, createViewer, startViewer } from '../src/index.js';
import { defaultFeatures, createOrbitCameraPath } from '../src/features/index.js';

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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
