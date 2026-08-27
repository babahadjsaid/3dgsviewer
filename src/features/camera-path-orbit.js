// Camera-path feature: a fitted circular orbit around the scene, toggled with
// the "P" key (or driven by another feature via `scene.cameraPath`).
//
// Isolated: it only reads the scene fit / camera basis and writes the camera
// pose through `scene`. It knows nothing about the loading effect or overlays.
//
// Swap it for any object with `{ id, role:'cameraPath', start, stop, toggle,
// isActive, frame, userInteraction }` to get a different "P" motion.

import { normalize3, dot3 } from './vec3.js';

const DEFAULTS = {
	durationMs: 14000,      // seconds per full revolution
	transitionMs: 900,      // ease-in from the current pose onto the circle
	elevation: 0,           // height above the fitted plane
	radiusScale: 1.2,       // safety factor on the auto-framed radius
	fallbackRadiusFloor: 0.1,
};

/**
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {import('./feature-api.js').Feature}
 */
export function createOrbitCameraPath(options = {}) {
	const opts = { ...DEFAULTS, ...options };
	let path = null;       // { center, axisX, axisZ, up, radius, elevation, halfExtents? }
	let runState = null;   // { startedAt, startAngle, startEye, startUp, transitionMs }
	let active = false;

	function framedRadius(fit, scene) {
		const verticalFov = (scene.getCameraFov() || 36) * Math.PI / 180;
		const [vw, vh] = scene.getViewportSize();
		const aspect = Math.max(0.5, (vw || 1) / Math.max(vh || 1, 1));
		const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * aspect);
		const [halfWidth, halfHeight, halfDepth] = fit.halfExtents;
		let required = 0;
		for (let sample = 0; sample < 72; sample++) {
			const angle = (sample / 72) * Math.PI * 2;
			const c = Math.abs(Math.cos(angle));
			const s = Math.abs(Math.sin(angle));
			const projectedWidth = s * halfWidth + c * halfDepth;
			const projectedDepth = c * halfWidth + s * halfDepth;
			const framingDistance = Math.max(
				halfHeight / Math.tan(verticalFov * 0.5),
				projectedWidth / Math.tan(horizontalFov * 0.5),
			) + projectedDepth;
			required = Math.max(required, framingDistance);
		}
		return Math.max(fit.distance, required * opts.radiusScale);
	}

	function buildFromFit(scene) {
		const fit = scene.getSceneFit();
		if (!fit) return null;
		return {
			center: [...fit.center],
			axisX: [...fit.axes.right],
			axisZ: [...fit.axes.backward],
			up: [...fit.axes.up],
			radius: framedRadius(fit, scene),
			elevation: opts.elevation,
			halfExtents: [...fit.halfExtents],
		};
	}

	function buildFromCurrentPose(scene) {
		const basis = scene.getCameraBasis();
		if (!basis) return null;
		return {
			center: [...scene.getOrbitTarget()],
			axisX: [...basis.right],
			axisZ: [...basis.backward],
			up: [...basis.up],
			radius: Math.max(scene.getOrbitDistance(), opts.fallbackRadiusFloor),
			elevation: opts.elevation,
		};
	}

	function start(scene, now) {
		if (!path) path = buildFromCurrentPose(scene);
		if (!path) return false;
		const basis = scene.getCameraBasis();
		if (!basis) return false;
		const offset = basis.eye.map((value, axis) => value - path.center[axis]);
		runState = {
			startedAt: now ?? scene.now(),
			startAngle: Math.atan2(dot3(offset, path.axisZ), dot3(offset, path.axisX)),
			startEye: [...basis.eye],
			startUp: [...basis.up],
			transitionMs: opts.transitionMs,
		};
		active = true;
		return true;
	}

	function stop(scene) {
		if (!active) return;
		active = false;
		runState = null;
		scene.setDefaultViewMatrix(scene.getViewMatrix() ? [...scene.getViewMatrix()] : scene.getDefaultViewMatrix());
		const basis = scene.getCameraBasis();
		if (basis) {
			const target = scene.getOrbitTarget();
			scene.setOrbitDistance(Math.max(0.01, Math.hypot(
				basis.eye[0] - target[0], basis.eye[1] - target[1], basis.eye[2] - target[2],
			)));
		}
	}

	function step(scene, now) {
		if (!active || !runState || !path) return;
		const elapsed = Math.max(0, now - runState.startedAt);
		const angle = runState.startAngle + (elapsed / opts.durationMs) * Math.PI * 2;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const desiredEye = path.center.map((value, axis) =>
			value
			+ path.axisX[axis] * cos * path.radius
			+ path.axisZ[axis] * sin * path.radius
			+ path.up[axis] * path.elevation,
		);
		const transition = Math.min(1, elapsed / runState.transitionMs);
		const blend = transition * transition * (3 - 2 * transition);
		const eye = desiredEye.map((value, axis) => runState.startEye[axis] * (1 - blend) + value * blend);
		const up = normalize3(path.up.map((value, axis) => runState.startUp[axis] * (1 - blend) + value * blend));
		scene.setOrbitTarget([...path.center]);
		scene.setOrbitDistance(Math.hypot(...eye.map((value, axis) => value - path.center[axis])));
		scene.setCameraPose(eye, path.center, up);
	}

	let boundScene = null;
	const control = {
		start: (now) => (boundScene ? start(boundScene, now) : false),
		stop: () => { if (boundScene) stop(boundScene); },
		toggle: () => {
			if (!boundScene) return false;
			if (active) { stop(boundScene); return false; }
			return start(boundScene);
		},
		isActive: () => active,
	};

	return {
		id: 'camera-path-orbit',
		role: 'cameraPath',
		...control,
		setup(scene) {
			boundScene = scene;
		},
		sceneReady(scene) {
			boundScene = scene;
			path = buildFromFit(scene) ?? path;
		},
		frame(now, scene) {
			step(scene, now);
		},
		userInteraction(scene) {
			stop(scene);
		},
		teardown() {
			active = false;
			runState = null;
			path = null;
			boundScene = null;
		},
	};
}
