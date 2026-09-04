// Built-in viewer features and the default set.
//
// Each feature is independent (see feature-api.js). Compose your own list and
// pass it as `createViewer({ features: [...] })`, or override single slots with
// `cameraPath` / `overlays` / `loadingEffect` options.

export { resolveFeature } from './feature-api.js';
export { createOrbitCameraPath } from './camera-path-orbit.js';
export { createBoundingBox, createOriginAxes, pcaBoxCorners, aabbCorners } from './scene-overlays.js';
export { createRevealLoadingEffect } from './loading-effect-reveal.js';
export { revealGlsl, revealWgsl } from './reveal-shaders.js';
export { createLiveSplatStream, unpackSnapshot, toSplatData, PACK_ROTATION_QUAT } from './live-splat-stream.js';

import { createOrbitCameraPath } from './camera-path-orbit.js';
import { createBoundingBox, createOriginAxes } from './scene-overlays.js';
import { createRevealLoadingEffect } from './loading-effect-reveal.js';
import { createLiveSplatStream } from './live-splat-stream.js';

/**
 * Build the default feature list from viewer options. The set is the same for
 * every scene format - `.ply`, `.compressed.ply` and `.sog` all get the orbit,
 * the overlays and the loading effect.
 *
 * @param {{
 *   cameraPath?: (import('./feature-api.js').Feature | import('./feature-api.js').FeatureFactory | false),
 *   overlays?: Array<import('./feature-api.js').Feature | import('./feature-api.js').FeatureFactory>,
 *   loadingEffect?: (import('./feature-api.js').Feature | import('./feature-api.js').FeatureFactory | false),
 *   revealEffect?: boolean,
 *   revealDurationMs?: number, revealEpsilon?: number, revealPointSize?: number,
 *   revealExponentMin?: number, revealExponentMax?: number,
 * }} [options]
 */
export function defaultFeatures(options = {}) {
	const list = [];

	if (options.cameraPath !== false) {
		list.push(options.cameraPath ?? createOrbitCameraPath());
	}

	if (Array.isArray(options.overlays)) {
		list.push(...options.overlays);
	} else {
		list.push(createBoundingBox(), createOriginAxes());
	}

	if (options.loadingEffect === false) {
		// explicitly disabled
	} else if (options.loadingEffect) {
		list.push(options.loadingEffect);
	} else if (options.revealEffect !== false) {
		list.push(createRevealLoadingEffect({
			durationMs: options.revealDurationMs,
			epsilon: options.revealEpsilon,
			pointSize: options.revealPointSize,
			exponentMin: options.revealExponentMin,
			exponentMax: options.revealExponentMax,
		}));
	}

	if (options.subscription) {
		list.push(createLiveSplatStream({ subscription: options.subscription }));
	}

	return list;
}
