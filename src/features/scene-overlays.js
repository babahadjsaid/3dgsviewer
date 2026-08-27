import * as pc from 'playcanvas/build/playcanvas.mjs';

// Scene visualization features: the computed bounding box and world-origin
// reference axes. Each is independent and owns its own toolbar toggle.
//
// The bounding-box *computation* is injected as `computeCorners(fit) -> 8x[x,y,z]`
// so you can swap the fitted-PCA box for an axis-aligned box, a sphere cage, a
// convex hull, etc. without touching the drawing/toggle code.

/** Eight corners of the fitted (PCA-oriented) box - the default computation. */
export function pcaBoxCorners(fit) {
	const { center, axes, halfExtents } = fit;
	const [hx, hy, hz] = halfExtents;
	const local = (x, y, z) => [
		center[0] + axes.right[0] * x + axes.up[0] * y + axes.backward[0] * z,
		center[1] + axes.right[1] * x + axes.up[1] * y + axes.backward[1] * z,
		center[2] + axes.right[2] * x + axes.up[2] * y + axes.backward[2] * z,
	];
	const corners = [];
	for (let bits = 0; bits < 8; bits++) {
		corners.push(local(bits & 1 ? hx : -hx, bits & 2 ? hy : -hy, bits & 4 ? hz : -hz));
	}
	return corners;
}

/** Axis-aligned box around the fitted centre - an alternative computation. */
export function aabbCorners(fit) {
	const { center, halfExtents } = fit;
	const [hx, hy, hz] = halfExtents;
	const corners = [];
	for (let bits = 0; bits < 8; bits++) {
		corners.push([
			center[0] + (bits & 1 ? hx : -hx),
			center[1] + (bits & 2 ? hy : -hy),
			center[2] + (bits & 4 ? hz : -hz),
		]);
	}
	return corners;
}

function wireToggle(scene, elementId, { onChange, showLabel, hideLabel }) {
	const button = scene.queryElement(elementId);
	if (!button) return { setEnabled() {}, isOn: () => false };
	let on = false;
	const sync = (enabled) => {
		button.disabled = !enabled;
		button.setAttribute('aria-pressed', String(enabled && on));
	};
	scene.addListener(button, 'click', () => {
		if (button.disabled) return;
		on = !on;
		button.setAttribute('aria-pressed', String(on));
		button.title = on ? hideLabel : showLabel;
		onChange?.(on);
	});
	sync(false);
	return { setEnabled: sync, isOn: () => on };
}

/**
 * @param {{ computeCorners?: (fit: object) => number[][], color?: number[], toggleElement?: string, edgeBits?: number[] }} [options]
 * @returns {import('./feature-api.js').Feature}
 */
export function createBoundingBox(options = {}) {
	const computeCorners = options.computeCorners || pcaBoxCorners;
	const color = options.color || [0.85, 0.85, 0.9, 0.8];
	const toggleElement = options.toggleElement || 'bbox-toggle';
	const edgeBits = options.edgeBits || [1, 2, 4];
	let toggle = null;

	return {
		id: 'bounding-box',
		setup(scene) {
			toggle = wireToggle(scene, toggleElement, {
				showLabel: 'Show computed bounding box',
				hideLabel: 'Hide computed bounding box',
			});
		},
		sceneReady(scene) {
			toggle?.setEnabled(Boolean(scene.getSceneFit()));
		},
		frame(_now, scene) {
			if (!toggle?.isOn()) return;
			const fit = scene.getSceneFit();
			if (!fit) return;
			const corners = computeCorners(fit);
			for (let corner = 0; corner < corners.length; corner++) {
				for (const bit of edgeBits) {
					if (corner & bit) continue;
					const neighbour = corner | bit;
					if (corners[neighbour]) scene.drawLine(corners[corner], corners[neighbour], color, true);
				}
			}
		},
	};
}

/**
 * World-origin RGB reference axes rendered as actual world-space geometry.
 * @param {{ toggleElement?: string, lengthScale?: number, thicknessScale?: number, colors?: number[][] }} [options]
 * @returns {import('./feature-api.js').Feature}
 */
export function createOriginAxes(options = {}) {
	const toggleElement = options.toggleElement || 'reference-frame-toggle';
	const lengthScale = options.lengthScale ?? 0.75;
	const thicknessScale = options.thicknessScale ?? 0.025;
	const colors = options.colors || [
		[1, 0.15, 0.12, 1],
		[0.15, 1, 0.25, 1],
		[0.2, 0.45, 1, 1],
	];
	let toggle = null;
	let frameRoot = null;
	let materials = [];

	function destroyFrame() {
		frameRoot?.destroy?.();
		frameRoot = null;
		for (const material of materials) material.destroy?.();
		materials = [];
	}

	function makeMaterial(color) {
		const material = new pc.StandardMaterial();
		const rgb = new pc.Color(color[0], color[1], color[2], color[3] ?? 1);
		material.diffuse = rgb;
		material.emissive = rgb;
		material.useLighting = false;
		material.update();
		materials.push(material);
		return material;
	}

	function addPrimitive(parent, type, name, position, scale, rotation, material) {
		const entity = new pc.Entity(name);
		entity.addComponent('render', {
			type,
			castShadows: false,
			receiveShadows: false,
		});
		entity.render.material = material;
		entity.setLocalPosition(...position);
		entity.setLocalScale(...scale);
		if (rotation) entity.setLocalEulerAngles(...rotation);
		parent.addChild(entity);
	}

	function buildFrame(scene, axisLength) {
		if (!scene.app?.root?.addChild) return false;
		destroyFrame();
		frameRoot = new pc.Entity('World origin reference frame');
		scene.app.root.addChild(frameRoot);

		const shaftLength = axisLength * 0.78;
		const headLength = axisLength - shaftLength;
		const thickness = Math.max(axisLength * thicknessScale, 1e-5);
		const headRadius = thickness * 2.4;
		const definitions = [
			{ name: 'X', shaftPosition: [shaftLength * 0.5, 0, 0], shaftScale: [shaftLength, thickness, thickness], headPosition: [shaftLength + headLength * 0.5, 0, 0], headScale: [headRadius, headLength, headRadius], rotation: [0, 0, -90] },
			{ name: 'Y', shaftPosition: [0, shaftLength * 0.5, 0], shaftScale: [thickness, shaftLength, thickness], headPosition: [0, shaftLength + headLength * 0.5, 0], headScale: [headRadius, headLength, headRadius], rotation: null },
			{ name: 'Z', shaftPosition: [0, 0, shaftLength * 0.5], shaftScale: [thickness, thickness, shaftLength], headPosition: [0, 0, shaftLength + headLength * 0.5], headScale: [headRadius, headLength, headRadius], rotation: [90, 0, 0] },
		];

		definitions.forEach((axis, index) => {
			const material = makeMaterial(colors[index]);
			addPrimitive(frameRoot, 'box', `${axis.name} axis shaft`, axis.shaftPosition, axis.shaftScale, null, material);
			addPrimitive(frameRoot, 'cone', `${axis.name} axis arrow`, axis.headPosition, axis.headScale, axis.rotation, material);
		});
		frameRoot.enabled = Boolean(toggle?.isOn());
		return true;
	}

	return {
		id: 'origin-axes',
		setup(scene) {
			toggle = wireToggle(scene, toggleElement, {
				showLabel: 'Show global reference frame at world origin',
				hideLabel: 'Hide global reference frame at world origin',
				onChange: (visible) => {
					if (frameRoot) frameRoot.enabled = visible;
				},
			});
		},
		sceneReady(scene) {
			const fit = scene.getSceneFit();
			toggle?.setEnabled(Boolean(fit));
			if (!fit) return;
			const axisLength = Math.max(0.1, Math.max(...fit.halfExtents) * lengthScale);
			buildFrame(scene, axisLength);
		},
		frame(_now, scene) {
			if (frameRoot || !toggle?.isOn()) return;
			const fit = scene.getSceneFit();
			if (!fit) return;
			// Minimal fallback for a host that implements the feature API without a
			// PlayCanvas entity root. These lines still use depth testing.
			const axisLength = Math.max(0.1, Math.max(...fit.halfExtents) * lengthScale);
			const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
			for (let axis = 0; axis < 3; axis++) {
				scene.drawLine([0, 0, 0], dirs[axis].map((v) => v * axisLength), colors[axis], true);
			}
		},
		teardown() {
			destroyFrame();
		},
	};
}
