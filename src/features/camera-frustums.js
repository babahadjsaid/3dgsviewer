/** The training cameras, drawn as view pyramids. Click one to fly the view
 *  camera to its exact pose. */

import * as pc from 'playcanvas/build/playcanvas.mjs';

const GREEN = [0, 1, 0, 1];

/** apex, then the four image corners, in world space. */
export function viewPyramidPoints({ fx, fy, cx, cy, R_c2w, C_w, w, h, scale }) {
	const corners = [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];
	const points = [[...C_w]];
	for (const [u, v] of corners) {
		// Preserve the prototype HTML's compact visualization (not a physical
		// image plane): normalize each spoke and keep its length at scale.
		const camera = [(u - cx) / fx, (v - cy) / fy, scale / 10];
		const direction = R_c2w.map((row) => row.reduce((sum, value, i) => sum + value * camera[i], 0));
		const length = Math.hypot(...direction) || 1;
		points.push(direction.map((value, i) => C_w[i] + scale * value / length));
	}
	return points;
}

/** Four spokes from the apex, then the image rectangle. */
export const PYRAMID_EDGES = [
	[0, 1], [0, 2], [0, 3], [0, 4],
	[1, 2], [2, 3], [3, 4], [4, 1],
];

// The four side faces plus the two base triangles - PYRAMID_EDGES is only
// the wireframe and has no notion of a face to ray-test against.
const PYRAMID_FACES = [
	[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1],
	[1, 2, 3], [1, 3, 4],
];

function isMatrix(matrix, rows, columns) {
	return Array.isArray(matrix)
		&& matrix.length >= rows
		&& matrix.slice(0, rows).every((row) => Array.isArray(row) && row.length >= columns);
}

function parsePose(pose) {
	if (!isMatrix(pose, 4, 4)) return null;
	// GSStream emits raw world-to-camera [R|t], unlike the prototype's
	// preprocessed CAMR packets. Invert it: C=-R^T t, R_c2w=R^T.
	// The live splat entity already undoes the packer's axis rotation, so
	// these original world coordinates need no additional axis conversion.
	const R_c2w = [0, 1, 2].map((column) => [pose[0][column], pose[1][column], pose[2][column]]);
	const t = [pose[0][3], pose[1][3], pose[2][3]];
	return { R_c2w, C_w: R_c2w.map((row) => -row.reduce((sum, value, i) => sum + value * t[i], 0)) };
}

function parseIntrinsics(intr) {
	if (!isMatrix(intr, 3, 3)) return null;
	return {
		fx: intr[0][0], fy: intr[1][1],
		cx: intr[0][2], cy: intr[1][2],
		w: intr[0][2] * 2, h: intr[1][2] * 2,
	};
}

// --- minimal vector helpers for ray/triangle picking ------------------------
// Kept local: this is the only place in the viewer that needs them.

function sub3(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

function dot3(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(v) {
	const length = Math.hypot(v[0], v[1], v[2]);
	return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 1, 0];
}

function lerp3(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Moller-Trumbore ray/triangle intersection. Returns the distance along the
// ray to the hit point, or null when the ray misses the triangle.
function intersectTriangle(origin, dir, a, b, c) {
	const edge1 = sub3(b, a);
	const edge2 = sub3(c, a);
	const pvec = cross3(dir, edge2);
	const det = dot3(edge1, pvec);
	if (Math.abs(det) < 1e-9) return null;
	const invDet = 1 / det;
	const tvec = sub3(origin, a);
	const u = dot3(tvec, pvec) * invDet;
	if (u < -1e-6 || u > 1 + 1e-6) return null;
	const qvec = cross3(tvec, edge1);
	const v = dot3(dir, qvec) * invDet;
	if (v < -1e-6 || u + v > 1 + 1e-6) return null;
	const t = dot3(edge2, qvec) * invDet;
	return t > 1e-6 ? t : null;
}

// Nearest hit (smallest t) across a pyramid's four side faces and two base
// triangles, or null if the ray misses every face.
function intersectPyramid(origin, dir, points) {
	let nearest = null;
	for (const [a, b, c] of PYRAMID_FACES) {
		const t = intersectTriangle(origin, dir, points[a], points[b], points[c]);
		if (t != null && (nearest === null || t < nearest)) nearest = t;
	}
	return nearest;
}

// A click is a press-and-release with little movement and no dawdling -
// anything else is a drag (camera rotate/pan) and must not pick.
const CLICK_MAX_MOVE_PX = 6;
const CLICK_MAX_DURATION_MS = 500;

// Short and eased, not a teleport - see flyTo().
const FLY_DURATION_MS = 550;

export function createCameraFrustums(options = {}) {
	const scale = options.scale ?? 0.1;
	let off = null;
	let cameras = [];   // { points, eye, forward, up } per camera, world space
	let flight = null;  // in-flight camera transition, see flyTo()
	let visible = true;
	let root = null;
	let mesh = null;
	let material = null;
	let toggle = null;

	function destroyGeometry() {
		root?.destroy();
		mesh?.destroy();
		material?.destroy();
		root = mesh = material = null;
	}

	function updateToggle() {
		if (!toggle) return;
		toggle.disabled = cameras.length === 0;
		toggle.setAttribute('aria-pressed', String(visible));
		toggle.title = cameras.length
			? `${visible ? 'Hide' : 'Show'} training camera pyramids`
			: 'No camera poses are available';
	}

	function setVisible(next) {
		visible = Boolean(next);
		if (root) root.enabled = visible;
		updateToggle();
	}

	function setPacket(packet, scene) {
		const { poses, intrs } = packet || {};
		if (!Array.isArray(poses) || !Array.isArray(intrs)) return;
		const next = [];
		for (let i = 0; i < Math.min(poses.length, intrs.length); i++) {
			const pose = parsePose(poses[i]);
			const intrinsics = parseIntrinsics(intrs[i]);
			if (!pose || !intrinsics) continue;
			const points = viewPyramidPoints({ ...intrinsics, ...pose, scale });
			next.push({
				points,
				eye: points[0],
				// Camera-local +Z is the view direction; +Y points down the
				// image, so -Y (column 1, negated) is world "up".
				forward: normalize3([pose.R_c2w[0][2], pose.R_c2w[1][2], pose.R_c2w[2][2]]),
				up: normalize3([-pose.R_c2w[0][1], -pose.R_c2w[1][1], -pose.R_c2w[2][1]]),
			});
		}
		cameras = next;
		buildGeometry(scene);
		updateToggle();
	}

	function buildGeometry(scene) {
		destroyGeometry();
		if (!cameras.length || !scene.app?.graphicsDevice || !scene.app?.root) return;
		// Opaque world geometry renders before transparent splats, just like
		// the origin axes. Immediate debug lines render after the splats and
		// cannot be occluded by their accumulated opacity.
		mesh = new pc.Mesh(scene.app.graphicsDevice);
		mesh.setPositions(cameras.flatMap((camera) => camera.points.flat()));
		mesh.setIndices(cameras.flatMap((_, i) => PYRAMID_EDGES.flatMap(([a, b]) => [i * 5 + a, i * 5 + b])));
		mesh.update(pc.PRIMITIVE_LINES);
		material = new pc.StandardMaterial();
		material.diffuse = new pc.Color(...GREEN);
		material.emissive = new pc.Color(...GREEN);
		material.useLighting = false;
		material.depthTest = true;
		material.depthWrite = true;
		material.update();
		root = new pc.Entity('Training camera frustums');
		root.addComponent('render', {
			meshInstances: [new pc.MeshInstance(mesh, material)],
			castShadows: false,
			receiveShadows: false,
		});
		scene.app.root.addChild(root);
		root.enabled = visible;
	}

	// Pick the pyramid nearest along the ray under (clientX, clientY) and, if
	// there is one, start flying the view camera to its pose.
	function pickAndFly(scene, canvas, clientX, clientY) {
		const cameraEntity = scene.getCameraEntity?.();
		if (!cameraEntity?.camera || !cameras.length) return;
		const rect = canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		const near = cameraEntity.camera.screenToWorld(x, y, cameraEntity.camera.nearClip);
		const far = cameraEntity.camera.screenToWorld(x, y, cameraEntity.camera.farClip);
		if (!near || !far) return;
		const origin = [near.x, near.y, near.z];
		const dir = normalize3([far.x - near.x, far.y - near.y, far.z - near.z]);

		let best = null;
		for (const camera of cameras) {
			const t = intersectPyramid(origin, dir, camera.points);
			if (t != null && (!best || t < best.t)) best = { t, camera };
		}
		if (best) flyTo(scene, best.camera);
	}

	// Start (or retarget) an eased transition of the view camera onto
	// `camera`'s exact position and orientation. `orbitTarget` /
	// `orbitDistance` are kept in step every frame of the flight so a drag
	// that interrupts it - or one that starts right after it lands - orbits
	// around a sane pivot instead of snapping.
	function flyTo(scene, camera) {
		const basis = scene.getCameraBasis?.();
		if (!basis) return;
		const fit = scene.getSceneFit?.();
		flight = {
			startedAt: scene.now ? scene.now() : Date.now(),
			eyeStart: basis.eye,
			lookAtStart: sub3(basis.eye, basis.backward),
			upStart: basis.up,
			eyeEnd: camera.eye,
			lookAtEnd: [
				camera.eye[0] + camera.forward[0],
				camera.eye[1] + camera.forward[1],
				camera.eye[2] + camera.forward[2],
			],
			upEnd: camera.up,
			orbitTarget: fit ? [...fit.center] : camera.eye,
		};
	}

	function stepFlight(now, scene) {
		const elapsed = Math.max(0, now - flight.startedAt);
		const t = Math.min(1, elapsed / FLY_DURATION_MS);
		const blend = t * t * (3 - 2 * t); // smoothstep - eased in and out
		const eye = lerp3(flight.eyeStart, flight.eyeEnd, blend);
		const lookAt = lerp3(flight.lookAtStart, flight.lookAtEnd, blend);
		const up = normalize3(lerp3(flight.upStart, flight.upEnd, blend));
		scene.setCameraPose(eye, lookAt, up);
		scene.setOrbitTarget(flight.orbitTarget);
		scene.setOrbitDistance(Math.max(0.01, Math.hypot(...sub3(eye, flight.orbitTarget))));
		if (t >= 1) flight = null;
	}

	function attachPicking(scene) {
		if (typeof scene.addListener !== 'function' || typeof scene.queryElement !== 'function') return;
		const canvas = scene.queryElement('canvas');
		if (!canvas) return;
		let down = null; // { x, y, at }
		scene.addListener(canvas, 'mousedown', (e) => {
			if (e.button !== 0) return;
			down = { x: e.clientX, y: e.clientY, at: scene.now ? scene.now() : Date.now() };
		});
		scene.addListener(window, 'mouseup', (e) => {
			if (!down || e.button !== 0) return;
			const start = down;
			down = null;
			const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
			const elapsed = (scene.now ? scene.now() : Date.now()) - start.at;
			if (moved > CLICK_MAX_MOVE_PX || elapsed > CLICK_MAX_DURATION_MS) return;
			pickAndFly(scene, canvas, e.clientX, e.clientY);
		});
	}

	return {
		id: 'camera-frustums',
		setup(scene) {
			toggle = scene.queryElement?.('camera-frustums-toggle');
			if (toggle) {
				scene.addListener(toggle, 'click', () => setVisible(!visible));
				updateToggle();
			}

			const { service, topic } = options.subscription || {};
			if (service && typeof service.on === 'function' && topic) {
				try {
					off = service.on(topic, (event) => {
						if (event?.event === 'gs_cameras') setPacket(event.data, scene);
					});
				} catch (error) {
					off = null;
					console.warn('[camera-frustums] could not subscribe:', error);
				}
			}

			if (options.cameraPoses) setPacket(options.cameraPoses, scene);
			attachPicking(scene);
		},
		frame(now, scene) {
			if (flight) stepFlight(now, scene);
			if (!visible || root) return;
			for (const { points } of cameras) {
				for (const [a, b] of PYRAMID_EDGES) scene.drawLine(points[a], points[b], GREEN, true);
			}
		},
		// Any user-driven input cancels an in-flight transition right where
		// it is - the next drag then orbits from the camera's actual current
		// pose instead of jumping to wherever the flight would have ended.
		userInteraction() {
			flight = null;
		},
		teardown() {
			flight = null;
			toggle = null;
			const unsubscribe = off;
			off = null;
			cameras = [];
			destroyGeometry();
			if (typeof unsubscribe !== 'function') return;
			try {
				unsubscribe();
			} catch (error) {
				console.warn('[camera-frustums] could not unsubscribe:', error);
			}
		},
	};
}
