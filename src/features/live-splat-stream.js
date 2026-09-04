/**
 * Live splat stream: a scene driven by snapshots instead of a URL.
 *
 * The platform's stage packs splats with Spark's PackedSplats layout (16 bytes
 * each) and relays them base64-encoded. This inverts that layout into the
 * float arrays PlayCanvas wants, so no PLY or blob URL is needed.
 */
import * as pc from 'playcanvas';

const MAGIC = 0x53504b31; // "SPK1"
const HEADER_SIZE = 16;
const BYTES_PER_SPLAT = 16;
const SH_C0 = 0.28209479177387814;
const SCALE_MIN_EXP = -12;
const SCALE_RANGE = 21;

/** The packer's axis change, as a quaternion (w, x, y, z). */
export const PACK_ROTATION_QUAT = [0, 0.7071067811865476, 0, 0.7071067811865476];

const PROPERTY_NAMES = [
	'x', 'y', 'z',
	'rot_0', 'rot_1', 'rot_2', 'rot_3',
	'scale_0', 'scale_1', 'scale_2',
	'f_dc_0', 'f_dc_1', 'f_dc_2',
	'opacity',
];

/** Octahedral (u, v) in [-1, 1] back to a unit direction. */
function octahedralDecode(u, v) {
	let x = u;
	let y = v;
	const z = 1 - Math.abs(u) - Math.abs(v);
	if (z < 0) {
		const ax = 1 - Math.abs(y);
		const ay = 1 - Math.abs(x);
		x = x >= 0 ? ax : -ax;
		y = y >= 0 ? ay : -ay;
	}
	const length = Math.hypot(x, y, z) || 1;
	return [x / length, y / length, z / length];
}

/**
 * One packed snapshot -> the arrays PlayCanvas indexes by PLY property name.
 *
 * @param {Uint8Array} bytes - header + body, exactly as the packer produced it
 */
export function unpackSnapshot(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_SIZE) {
		throw new Error('snapshot is shorter than its SPK1 header');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = view.getUint32(0, true);
	if (magic !== MAGIC) {
		throw new Error(`bad snapshot magic 0x${magic.toString(16)}, expected SPK1`);
	}
	const iteration = view.getUint32(8, true);
	const numSplats = view.getUint32(12, true);
	const expectedLength = HEADER_SIZE + numSplats * BYTES_PER_SPLAT;
	if (bytes.byteLength !== expectedLength) {
		throw new Error(`bad snapshot length ${bytes.byteLength}, expected ${expectedLength}`);
	}

	const properties = {};
	for (const name of PROPERTY_NAMES) properties[name] = new Float32Array(numSplats);

	for (let i = 0; i < numSplats; i++) {
		const at = HEADER_SIZE + i * BYTES_PER_SPLAT;

		// bytes 0-3: RGBA -> DC colour and pre-sigmoid opacity
		properties.f_dc_0[i] = (view.getUint8(at) / 255 - 0.5) / SH_C0;
		properties.f_dc_1[i] = (view.getUint8(at + 1) / 255 - 0.5) / SH_C0;
		properties.f_dc_2[i] = (view.getUint8(at + 2) / 255 - 0.5) / SH_C0;
		const alpha = view.getUint8(at + 3) / 255;
		properties.opacity[i] = alpha <= 0 ? -40 : alpha >= 1 ? 40 : -Math.log(1 / alpha - 1);

		// bytes 4-9: centre as float16
		properties.x[i] = getFloat16(view, at + 4);
		properties.y[i] = getFloat16(view, at + 6);
		properties.z[i] = getFloat16(view, at + 8);

		// bytes 10-11 + 15: octahedral axis and angle -> quaternion
		const u = (view.getUint8(at + 10) / 255) * 2 - 1;
		const v = (view.getUint8(at + 11) / 255) * 2 - 1;
		const angle = (view.getUint8(at + 15) / 255) * Math.PI;
		const [ax, ay, az] = octahedralDecode(u, v);
		const half = Math.sin(angle / 2);
		properties.rot_0[i] = Math.cos(angle / 2);
		properties.rot_1[i] = ax * half;
		properties.rot_2[i] = ay * half;
		properties.rot_3[i] = az * half;

		// bytes 12-14: log-quantised scales -> log-space scale
		for (let axis = 0; axis < 3; axis++) {
			const raw = view.getUint8(at + 12 + axis);
			properties[`scale_${axis}`][i] = raw === 0
				? -30
				: ((raw - 1) / 254) * SCALE_RANGE + SCALE_MIN_EXP;
		}
	}

	return { numSplats, iteration, properties };
}

/** DataView has no float16 before ES2025; decode it by hand. */
function getFloat16(view, offset) {
	const bits = view.getUint16(offset, true);
	const sign = bits & 0x8000 ? -1 : 1;
	const exponent = (bits >> 10) & 0x1f;
	const mantissa = bits & 0x3ff;
	if (exponent === 0) return sign * mantissa * 2 ** -24;
	if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
	return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

/** The unpacked arrays -> a `pc.GSplatData` PlayCanvas can render. */
export function toSplatData(unpacked) {
	return new pc.GSplatData([{
		name: 'vertex',
		count: unpacked.numSplats,
		properties: PROPERTY_NAMES.map((name) => ({
			name, type: 'float', byteSize: 4, storage: unpacked.properties[name],
		})),
	}]);
}

/**
 * Subscribe on activation, swap the scene on each snapshot, and unsubscribe
 * on teardown.
 *
 * @param {{subscription?: {service: {on: Function}, topic: string}}} options
 */
export function createLiveSplatStream(options = {}) {
	let off = null;

	return {
		id: 'live-splat-stream',
		setup(scene) {
			const { service, topic } = options.subscription || {};
			if (!service || typeof service.on !== 'function' || !topic) return;

			try {
				off = service.on(topic, (event) => {
					const payload = event?.data?.payload;
					if (typeof payload !== 'string') return;
					try {
						const binary = atob(payload);
						const bytes = new Uint8Array(binary.length);
						for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
						scene.showSplatData(toSplatData(unpackSnapshot(bytes)), PACK_ROTATION_QUAT);
					} catch (error) {
						console.warn('[live-splat-stream] dropped a snapshot:', error);
					}
				});
			} catch (error) {
				off = null;
				console.warn('[live-splat-stream] could not subscribe:', error);
			}
		},
		teardown() {
			const unsubscribe = off;
			off = null;
			if (typeof unsubscribe !== 'function') return;
			try {
				unsubscribe();
			} catch (error) {
				console.warn('[live-splat-stream] could not unsubscribe:', error);
			}
		},
	};
}
