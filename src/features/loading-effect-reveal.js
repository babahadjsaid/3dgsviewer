// Loading effect: the two-stage "point cloud -> gaussian" reveal.
//
// Isolated: it acts on the splat *material* and (optionally) asks the scene's
// camera path to start via `scene.cameraPath` - it never imports the camera
// path module and the camera path never imports this one.
//
// A loading effect is any object with `{ id, sceneReady, frame,
// userInteraction, teardown }`. To use a different intro (a fade, a
// dissolve, nothing at all), pass your own object as a `features` entry.

import { revealGlsl, revealWgsl } from './reveal-shaders.js';

const DEFAULTS = {
	durationMs: 5000,       // stage 1; stage 2 is half of this, total = x1.5
	epsilon: 0.12,          // point size as a fraction of the trained gaussian
	exponentMin: 1.5,
	exponentMax: 4.0,
	stage1Fraction: 2 / 3,  // split point of the 0..1 timeline
	startCameraPath: true,  // also run the fitted orbit during the reveal
	glsl: revealGlsl,
	wgsl: revealWgsl,
};

/**
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {import('./feature-api.js').Feature}
 */
export function createRevealLoadingEffect(options = {}) {
	const opts = { ...DEFAULTS, ...options };
	const durationMs = Math.max(200, Number.isFinite(opts.durationMs) ? opts.durationMs : DEFAULTS.durationMs);
	const epsilon = Math.min(0.99, Math.max(0, Number.isFinite(opts.epsilon) ? opts.epsilon : DEFAULTS.epsilon));
	const exponentMin = Math.max(1.001, Number.isFinite(opts.exponentMin) ? opts.exponentMin : DEFAULTS.exponentMin);
	const exponentMax = Math.max(exponentMin, Number.isFinite(opts.exponentMax) ? opts.exponentMax : DEFAULTS.exponentMax);
	const stage1Fraction = Math.min(0.95, Math.max(0.05, opts.stage1Fraction ?? DEFAULTS.stage1Fraction));

	let material = null;
	let active = false;
	let startAt = -1;

	function end() {
		if (!active) return;
		active = false;
		try {
			// At t = 1 the shader early-exits and returns the trained covariance.
			material?.setParameter('splatRevealTime', 1);
		} catch { /* material already torn down */ }
		material = null;
	}

	function begin(scene) {
		if (active || scene.isDestroyed()) return;
		const mat = scene.getSplatMaterial();
		const runOrbit = () => {
			if (opts.startCameraPath && scene.cameraPath && !scene.cameraPath.isActive()) {
				scene.setAutoFraming(false);
				scene.cameraPath.start();
			}
		};

		if (!mat || !mat.shaderChunks) {
			// Unified renderer / no per-instance material: skip the shader effect
			// but still run the accompanying motion.
			runOrbit();
			return;
		}

		try {
			if (scene.graphicsDevice?.isWebGPU) {
				mat.shaderChunks.wgsl.set('gsplatCustomizeVS', opts.wgsl);
			} else {
				mat.shaderChunks.glsl.set('gsplatCustomizeVS', opts.glsl);
			}
			const origin = scene.getOriginDistances();
			const inner = Number.isFinite(origin?.minDist) ? Math.max(0, origin.minDist) : 0;
			const radius = Number.isFinite(origin?.maxDist) && origin.maxDist > inner
				? origin.maxDist
				: Math.max(inner + 1e-3, scene.getOrbitDistance() || 1);
			mat.setParameter('splatRevealTime', 0);
			mat.setParameter('splatRevealSplit', stage1Fraction);
			mat.setParameter('splatRevealInner', inner);
			mat.setParameter('splatRevealRadius', radius);
			mat.setParameter('splatRevealEpsilon', epsilon);
			mat.setParameter('splatRevealExponentMin', exponentMin);
			mat.setParameter('splatRevealExponentMax', exponentMax);
			mat.update();
		} catch (err) {
			console.warn('Reveal effect unavailable; rendering normally.', err);
			runOrbit();
			return;
		}

		material = mat;
		active = true;
		startAt = -1; // anchored to the first frame so it shares the render clock
		runOrbit();
	}

	return {
		id: 'loading-effect-reveal',
		sceneReady(scene) {
			begin(scene);
		},
		frame(now) {
			if (!active || !material) return;
			if (startAt < 0) startAt = now;
			// stage 1 lasts durationMs, stage 2 half that -> total x1.5
			const t = Math.min(1, Math.max(0, (now - startAt) / (durationMs * 1.5)));
			material.setParameter('splatRevealTime', t);
			if (t >= 1) end();
		},
		userInteraction() {
			end();
		},
		teardown() {
			end();
		},
	};
}
