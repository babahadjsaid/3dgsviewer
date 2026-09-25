// Loading effect: the two-stage "point cloud -> gaussian" reveal.
//
// Isolated: it acts on the splat's shader (its material, or for streamed LOD
// the unified renderer's work-buffer modifier) and (optionally) asks the scene's
// camera path to start via `scene.cameraPath` - it never imports the camera
// path module and the camera path never imports this one.
//
// A loading effect is any object with `{ id, sceneReady, frame,
// userInteraction, teardown }`. To use a different intro (a fade, a
// dissolve, nothing at all), pass your own object as a `features` entry.

import * as pc from 'playcanvas';
import { revealGlsl, revealWgsl, revealModifyGlsl, revealModifyWgsl } from './reveal-shaders.js';

const DEFAULTS = {
	durationMs: 5000,       // stage 1; stage 2 is half of this, total = x1.5
	epsilon: 0.12,          // stage-1 dot size as a fraction of the splat's own size
	pointSize: 0,           // > 0 forces one world-space dot size for every splat
	exponentMin: 1.5,
	exponentMax: 4.0,
	stage1Fraction: 2 / 3,  // split point of the 0..1 timeline
	startCameraPath: true,  // also run the fitted orbit during the reveal
	glsl: revealGlsl,             // gsplatCustomizeVS  - PlayCanvas 2.13.x
	wgsl: revealWgsl,
	modifyGlsl: revealModifyGlsl, // gsplatModifyVS     - PlayCanvas 2.14+
	modifyWgsl: revealModifyWgsl,
};

/**
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {import('./feature-api.js').Feature}
 */
export function createRevealLoadingEffect(options = {}) {
	const opts = { ...DEFAULTS, ...options };
	const durationMs = Math.max(200, Number.isFinite(opts.durationMs) ? opts.durationMs : DEFAULTS.durationMs);
	const epsilon = Math.min(0.99, Math.max(0, Number.isFinite(opts.epsilon) ? opts.epsilon : DEFAULTS.epsilon));
	const pointSize = Math.max(0, Number.isFinite(opts.pointSize) ? opts.pointSize : DEFAULTS.pointSize);
	const exponentMin = Math.max(1.001, Number.isFinite(opts.exponentMin) ? opts.exponentMin : DEFAULTS.exponentMin);
	const exponentMax = Math.max(exponentMin, Number.isFinite(opts.exponentMax) ? opts.exponentMax : DEFAULTS.exponentMax);
	const stage1Fraction = Math.min(0.95, Math.max(0.05, opts.stage1Fraction ?? DEFAULTS.stage1Fraction));

	// Where the reveal's uniforms go: `set(name, value)` and `finish()`.
	let target = null;
	let sceneRef = null;
	let active = false;
	let startAt = -1;

	function end() {
		if (!active) return;
		active = false;
		try {
			target?.finish();
		} catch { /* material / component already torn down */ }
		target = null;
		sceneRef = null;
	}

	// Per-instance renderer: the shader goes on the splat's own material.
	function materialTarget(mat, isWebGPU) {
		// PlayCanvas renamed this hook in 2.14: `gsplatCustomizeVS` became
		// `gsplatModifyVS`, with different entry points. Setting a chunk the
		// running engine does not include is a no-op, so set both and let
		// whichever one it compiles take effect. Without this the effect
		// silently does nothing on any engine newer than 2.13.x.
		if (isWebGPU) {
			mat.shaderChunks.wgsl.set('gsplatCustomizeVS', opts.wgsl);
			mat.shaderChunks.wgsl.set('gsplatModifyVS', opts.modifyWgsl);
		} else {
			mat.shaderChunks.glsl.set('gsplatCustomizeVS', opts.glsl);
			mat.shaderChunks.glsl.set('gsplatModifyVS', opts.modifyGlsl);
		}
		return {
			set: (name, value) => mat.setParameter(name, value),
			commit: () => mat.update(),
			// At t = 1 the shader early-exits and returns the trained covariance.
			finish: () => mat.setParameter('splatRevealTime', 1),
		};
	}

	// Unified renderer (streamed LOD): there is no per-instance material, but
	// the same `gsplatModifyVS` code runs as the component's work-buffer
	// modifier, where splats are copied in with world-space centres and
	// scales - the model's own space, as the viewer places scenes at the
	// origin unscaled - so the effect looks the same. The copy normally runs
	// only when a chunk changes, so it is forced every frame while the reveal
	// animates, and the uniforms, which no material owns here, are set on the
	// device scope the copy shader reads them from.
	function workBufferTarget(gsplat, device) {
		gsplat.setWorkBufferModifier({ glsl: opts.modifyGlsl, wgsl: opts.modifyWgsl });
		gsplat.workBufferUpdate = pc.WORKBUFFER_UPDATE_ALWAYS;
		return {
			set: (name, value) => device.scope.resolve(name).setValue(value),
			commit: () => {},
			// Dropping the modifier re-copies every splat once with the trained
			// shape; then back to copying only on change.
			finish: () => {
				gsplat.setWorkBufferModifier(null);
				gsplat.workBufferUpdate = pc.WORKBUFFER_UPDATE_AUTO;
			},
		};
	}

	function begin(scene) {
		if (active || scene.isDestroyed()) return;
		const runOrbit = () => {
			if (opts.startCameraPath && scene.cameraPath && !scene.cameraPath.isActive()) {
				scene.setAutoFraming(false);
				scene.cameraPath.start();
			}
		};

		const device = scene.graphicsDevice;
		let next = null;
		try {
			if (scene.isStreamedLod?.()) {
				const gsplat = scene.getSplatEntity?.()?.gsplat;
				if (gsplat?.setWorkBufferModifier && device?.scope) next = workBufferTarget(gsplat, device);
			} else {
				const mat = scene.getSplatMaterial();
				if (mat?.shaderChunks) next = materialTarget(mat, device?.isWebGPU);
			}
			if (!next) {
				// Neither hook is reachable (an engine without work-buffer
				// modifiers, or a material that never got created): skip the
				// shader effect but still run the accompanying motion, and say
				// so - a silent no-op here is very hard to diagnose.
				console.warn('[3dgsviewer] no gsplat shader hook; skipping the reveal effect.');
				runOrbit();
				return;
			}
			const origin = scene.getOriginDistances();
			const inner = Number.isFinite(origin?.minDist) ? Math.max(0, origin.minDist) : 0;
			const radius = Number.isFinite(origin?.maxDist) && origin.maxDist > inner
				? origin.maxDist
				: Math.max(inner + 1e-3, scene.getOrbitDistance() || 1);
			next.set('splatRevealTime', 0);
			next.set('splatRevealSplit', stage1Fraction);
			next.set('splatRevealInner', inner);
			next.set('splatRevealRadius', radius);
			next.set('splatRevealEpsilon', epsilon);
			next.set('splatRevealPointSize', pointSize);
			next.set('splatRevealExponentMin', exponentMin);
			next.set('splatRevealExponentMax', exponentMax);
			next.commit();
		} catch (err) {
			console.warn('Reveal effect unavailable; rendering normally.', err);
			try { next?.finish(); } catch { /* already torn down */ }
			runOrbit();
			return;
		}

		target = next;
		sceneRef = scene;
		active = true;
		startAt = -1; // anchored to the first drawable frame, on the render clock
		runOrbit();
	}

	return {
		id: 'loading-effect-reveal',
		sceneReady(scene) {
			begin(scene);
		},
		frame(now) {
			if (!active || !target) return;
			if (startAt < 0) {
				// A streamed LOD's chunks are still in flight when the scene is
				// ready; start the sphere once there is something for it to reveal.
				if (sceneRef?.hasResidentSplats && !sceneRef.hasResidentSplats()) {
					target.set('splatRevealTime', 0);
					return;
				}
				startAt = now;
			}
			// stage 1 lasts durationMs, stage 2 half that -> total x1.5
			const t = Math.min(1, Math.max(0, (now - startAt) / (durationMs * 1.5)));
			target.set('splatRevealTime', t);
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
