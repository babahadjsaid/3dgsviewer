/** The training cameras, drawn as view pyramids. */

const GREEN = [0, 1, 0, 1];

/** apex, then the four image corners, in world space. */
export function viewPyramidPoints({ fx, fy, cx, cy, R_c2w, C_w, w, h, scale }) {
	const corners = [[0, 0], [w, 0], [w, h], [0, h]];
	const points = [[...C_w]];
	for (const [u, v] of corners) {
		const camera = [((u - cx) / fx) * scale, ((v - cy) / fy) * scale, scale];
		points.push([
			C_w[0] + R_c2w[0][0] * camera[0] + R_c2w[0][1] * camera[1] + R_c2w[0][2] * camera[2],
			C_w[1] + R_c2w[1][0] * camera[0] + R_c2w[1][1] * camera[1] + R_c2w[1][2] * camera[2],
			C_w[2] + R_c2w[2][0] * camera[0] + R_c2w[2][1] * camera[1] + R_c2w[2][2] * camera[2],
		]);
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
	return {
		R_c2w: [
			[pose[0][0], pose[0][1], pose[0][2]],
			[pose[1][0], pose[1][1], pose[1][2]],
			[pose[2][0], pose[2][1], pose[2][2]],
		],
		C_w: [pose[0][3], pose[1][3], pose[2][3]],
	};
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
				});
			} catch (error) {
				off = null;
				console.warn('[camera-frustums] could not subscribe:', error);
			}
		},
		frame(now, scene) {
			for (const points of cameras) {
				for (const [a, b] of PYRAMID_EDGES) scene.drawLine(points[a], points[b], GREEN);
			}
		},
		teardown(scene) {
			const unsubscribe = off;
			off = null;
			cameras = [];
			if (typeof unsubscribe !== 'function') return;
			try {
				unsubscribe();
			} catch (error) {
				console.warn('[camera-frustums] could not unsubscribe:', error);
			}
		},
	};
}
