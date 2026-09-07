/** The training cameras, drawn as view pyramids. */

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

export function createCameraFrustums(options = {}) {
	const scale = options.scale ?? 0.1;
	let off = null;
	let cameras = [];
	let root = null;
	let mesh = null;
	let material = null;

	function destroyGeometry() {
		root?.destroy();
		mesh?.destroy();
		material?.destroy();
		root = mesh = material = null;
	}

	function buildGeometry(scene) {
		destroyGeometry();
		if (!cameras.length || !scene.app?.graphicsDevice || !scene.app?.root) return;
		// Opaque world geometry renders before transparent splats, just like
		// the origin axes. Immediate debug lines render after the splats and
		// cannot be occluded by their accumulated opacity.
		mesh = new pc.Mesh(scene.app.graphicsDevice);
		mesh.setPositions(cameras.flat(2));
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
	}

	return {
		id: 'camera-frustums',
		setup(scene) {
			const { service, topic } = options.subscription || {};
			if (!service || typeof service.on !== 'function' || !topic) return;

			try {
				off = service.on(topic, (event) => {
					if (event?.event !== 'gs_cameras') return;
					const { poses, intrs } = event.data || {};
					if (!Array.isArray(poses) || !Array.isArray(intrs)) return;
					const next = [];
					for (let i = 0; i < Math.min(poses.length, intrs.length); i++) {
						const pose = parsePose(poses[i]);
						const intrinsics = parseIntrinsics(intrs[i]);
						if (!pose || !intrinsics) continue;
						next.push(viewPyramidPoints({ ...intrinsics, ...pose, scale }));
					}
					cameras = next;
					buildGeometry(scene);
				});
			} catch (error) {
				off = null;
				console.warn('[camera-frustums] could not subscribe:', error);
			}
		},
		frame(now, scene) {
			if (root) return;
			for (const points of cameras) {
				for (const [a, b] of PYRAMID_EDGES) scene.drawLine(points[a], points[b], GREEN, true);
			}
		},
		teardown(scene) {
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
