import * as pc from 'playcanvas/build/playcanvas.mjs';
import { resolveFeature } from './features/feature-api.js';
import { defaultFeatures } from './features/index.js';

export function createViewer(options = {}) {
let viewerRoot = document;
let listenerController = null;
let animationFrameId = 0;
let imuSocket = null;
let resizeObserver = null;
let viewerDestroyed = false;
let runtimeOptions = {};
let loadController = null;
let features = [];
let sceneApi = null;
let mode = resolveMode({});
let sceneFit = null;          // { center, axes:{right,up,backward}, halfExtents, distance }
let originDistances = null;   // { minDist, maxDist }

/**
 * Translate `mode` (or the legacy `fullScreen`) into capability flags.
 *
 * `full`      the complete experience: title, help, view toolbar, overlay
 *             toggles, fps, spinner/progress/status, the reveal intro, the
 *             "P" orbit, keyboard + gamepad + drag-and-drop.
 * `embedded`  model only: no chrome, no reveal, no orbit, no keyboard,
 *             gamepad or drop target. Mouse and touch still drive the camera.
 * `streaming` `embedded` plus the fps readout, and `live` so the splat stream
 *             feature knows to drive the scene from a subscription rather
 *             than a URL.
 *
 * `fullScreen: false` remains exactly `embedded` and `fullScreen: true`
 * exactly `full`, so existing consumers are untouched.
 */
function resolveMode(options = {}) {
	const named = typeof options === 'string' ? options : options.mode;
	const legacy = typeof options === 'object' ? options.fullScreen : undefined;
	const name = named || (legacy === false ? 'embedded' : 'full');
	const full = name === 'full';
	const streaming = name === 'streaming';
	return {
		full,
		chrome: full,      // title, help, toolbar, spinner, progress, status
		fps: full || streaming,
		motion: full,      // reveal intro + orbit camera path
		keyboard: full,
		gamepad: full,
		dragDrop: full,
		pointer: true,     // mouse / wheel / touch: always on
		live: streaming,
	};
}

function getViewerElement(id) {
	return viewerRoot.querySelector(`[data-viewer-element="${id}"]`);
}

function getViewerElements(selector) {
	return viewerRoot.querySelectorAll(selector);
}

function listen(target, type, handler, options = {}) {
	const normalized = typeof options === 'boolean' ? { capture: options } : options;
	target.addEventListener(type, handler, { ...normalized, signal: listenerController.signal });
}

function scheduleFrame(callback) {
	if (viewerDestroyed) return 0;
	animationFrameId = requestAnimationFrame(callback);
	return animationFrameId;
}

			let viewMatrix = null;
			let defaultViewMatrix = null;
			let cameraEntity = null;
			let app = null;
			let splatEntity = null;
			let splatAsset = null;
			let activeKeys = [];
			let jumpDelta = 0;
			let lastFrame = 0;
			let avgFps = 0;
			let lastPoseLogAt = 0;
			let autoFramePending = true;
			let orbitTarget = [0, 0, 0];
			let orbitDistance = 4;

			function resetViewerState() {
				viewMatrix = null;
				defaultViewMatrix = null;
				cameraEntity = null;
				app = null;
				splatEntity = null;
				splatAsset = null;
				activeKeys = [];
				jumpDelta = 0;
				lastFrame = 0;
				avgFps = 0;
				lastPoseLogAt = 0;
				autoFramePending = true;
				orbitTarget = [0, 0, 0];
				orbitDistance = 4;
				sceneFit = null;
				originDistances = null;
			}
			
			function invert4(a) {
				const b00 = a[0] * a[5] - a[1] * a[4];
				const b01 = a[0] * a[6] - a[2] * a[4];
				const b02 = a[0] * a[7] - a[3] * a[4];
				const b03 = a[1] * a[6] - a[2] * a[5];
				const b04 = a[1] * a[7] - a[3] * a[5];
				const b05 = a[2] * a[7] - a[3] * a[6];
				const b06 = a[8] * a[13] - a[9] * a[12];
				const b07 = a[8] * a[14] - a[10] * a[12];
				const b08 = a[8] * a[15] - a[11] * a[12];
				const b09 = a[9] * a[14] - a[10] * a[13];
				const b10 = a[9] * a[15] - a[11] * a[13];
				const b11 = a[10] * a[15] - a[11] * a[14];
				const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
				if (!det) return null;

				return [
					(a[5] * b11 - a[6] * b10 + a[7] * b09) / det,
					(a[2] * b10 - a[1] * b11 - a[3] * b09) / det,
					(a[13] * b05 - a[14] * b04 + a[15] * b03) / det,
					(a[10] * b04 - a[9] * b05 - a[11] * b03) / det,
					(a[6] * b08 - a[4] * b11 - a[7] * b07) / det,
					(a[0] * b11 - a[2] * b08 + a[3] * b07) / det,
					(a[14] * b02 - a[12] * b05 - a[15] * b01) / det,
					(a[8] * b05 - a[10] * b02 + a[11] * b01) / det,
					(a[4] * b10 - a[5] * b08 + a[7] * b06) / det,
					(a[1] * b08 - a[0] * b10 - a[3] * b06) / det,
					(a[12] * b04 - a[13] * b02 + a[15] * b00) / det,
					(a[9] * b02 - a[8] * b04 - a[11] * b00) / det,
					(a[5] * b07 - a[4] * b09 - a[6] * b06) / det,
					(a[0] * b09 - a[1] * b07 + a[2] * b06) / det,
					(a[13] * b01 - a[12] * b03 - a[14] * b00) / det,
					(a[8] * b03 - a[9] * b01 + a[10] * b00) / det,
				];
			}

			function rotate4(a, rad, x, y, z) {
				let len = Math.hypot(x, y, z);
				if (len < 1e-12) return a.slice();
				x /= len;
				y /= len;
				z /= len;

				const s = Math.sin(rad);
				const c = Math.cos(rad);
				const t = 1 - c;

				const b00 = x * x * t + c;
				const b01 = y * x * t + z * s;
				const b02 = z * x * t - y * s;
				const b10 = x * y * t - z * s;
				const b11 = y * y * t + c;
				const b12 = z * y * t + x * s;
				const b20 = x * z * t + y * s;
				const b21 = y * z * t - x * s;
				const b22 = z * z * t + c;

				return [
					a[0] * b00 + a[4] * b01 + a[8] * b02,
					a[1] * b00 + a[5] * b01 + a[9] * b02,
					a[2] * b00 + a[6] * b01 + a[10] * b02,
					a[3] * b00 + a[7] * b01 + a[11] * b02,

					a[0] * b10 + a[4] * b11 + a[8] * b12,
					a[1] * b10 + a[5] * b11 + a[9] * b12,
					a[2] * b10 + a[6] * b11 + a[10] * b12,
					a[3] * b10 + a[7] * b11 + a[11] * b12,

					a[0] * b20 + a[4] * b21 + a[8] * b22,
					a[1] * b20 + a[5] * b21 + a[9] * b22,
					a[2] * b20 + a[6] * b21 + a[10] * b22,
					a[3] * b20 + a[7] * b21 + a[11] * b22,

					...a.slice(12, 16),
				];
			}

			function translate4(a, x, y, z) {
				return [
					...a.slice(0, 12),
					a[0] * x + a[4] * y + a[8] * z + a[12],
					a[1] * x + a[5] * y + a[9] * z + a[13],
					a[2] * x + a[6] * y + a[10] * z + a[14],
					a[3] * x + a[7] * y + a[11] * z + a[15],
				];
			}

			function applyViewMatrixToCamera() {
				if (!cameraEntity || !viewMatrix) return;

				const world = invert4(viewMatrix);
				if (!world) return;

				const mat = new pc.Mat4();
				mat.data.set(world);

				const pos = new pc.Vec3();
				const rot = new pc.Quat();

				mat.getTranslation(pos);
				rot.setFromMat4(mat);

				cameraEntity.setLocalPosition(pos);
				cameraEntity.setLocalRotation(rot);

				const now = performance.now();
				if (now - lastPoseLogAt >= 200) {
					const d = mat.data;
					const orientation = [
						[d[0], d[4], d[8]],
						[d[1], d[5], d[9]],
						[d[2], d[6], d[10]],
					];
					
					lastPoseLogAt = now;
				}
			}

			function setStatus(text) {
				if (!mode.chrome) return;
				const el = getViewerElement("message");
				if (el) el.innerText = text;
			}

			function setSpinnerVisible(visible) {
				if (!mode.chrome) return;
				const el = getViewerElement("spinner");
				if (el) el.style.display = visible ? "" : "none";
			}

			function setProgress(p) {
				if (!mode.chrome) return;
				const el = getViewerElement("progress");
				if (!el) return;
				if (p >= 100) {
					el.style.display = "none";
				} else {
					el.style.display = "";
					el.style.width = `${p}%`;
				}
			}

			function readPlyNumber(view, byteOffset, type) {
				switch (type) {
					case "char": case "int8": return view.getInt8(byteOffset);
					case "uchar": case "uint8": return view.getUint8(byteOffset);
					case "short": case "int16": return view.getInt16(byteOffset, true);
					case "ushort": case "uint16": return view.getUint16(byteOffset, true);
					case "int": case "int32": return view.getInt32(byteOffset, true);
					case "uint": case "uint32": return view.getUint32(byteOffset, true);
					case "float": case "float32": return view.getFloat32(byteOffset, true);
					case "double": case "float64": return view.getFloat64(byteOffset, true);
					default: return NaN;
				}
			}

			function percentile(values, fraction) {
				if (!values.length) return 0;
				values.sort((a, b) => a - b);
				const index = Math.max(0, Math.min(values.length - 1, Math.round((values.length - 1) * fraction)));
				return values[index];
			}

			function normalize3(v) {
				const length = Math.hypot(v[0], v[1], v[2]);
				return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 1, 0];
			}

			function dot3(a, b) {
				return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
			}

			function cross3(a, b) {
				return [
					a[1] * b[2] - a[2] * b[1],
					a[2] * b[0] - a[0] * b[2],
					a[0] * b[1] - a[1] * b[0],
				];
			}

			function toMatrix4(value) {
				const source = value?.data ?? value;
				if ((!Array.isArray(source) && !ArrayBuffer.isView(source)) || source.length !== 16) return null;
				const matrix = Array.from(source);
				return matrix.every(Number.isFinite) ? matrix : null;
			}

			function viewMatrixFromLookAt(position, target, upHint = [0, -1, 0]) {
				if (![position, target, upHint].every((value) =>
					Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
				)) return null;

				const backward = normalize3(position.map((value, axis) => value - target[axis]));
				const rawRight = cross3(upHint, backward);
				if (Math.hypot(...rawRight) < 1e-6) return null;
				const right = normalize3(rawRight);
				const up = normalize3(cross3(backward, right));
				return invert4([
					right[0], right[1], right[2], 0,
					up[0], up[1], up[2], 0,
					backward[0], backward[1], backward[2], 0,
					position[0], position[1], position[2], 1,
				]);
			}

			function resolveInitialViewMatrix(pose) {
				if (pose == null) return null;
				const directMatrix = toMatrix4(pose);
				if (directMatrix) {
					if (!invert4(directMatrix)) throw new TypeError("initialCameraPose view matrix is not invertible.");
					return directMatrix;
				}
				const view = toMatrix4(pose.viewMatrix);
				if (view) {
					if (!invert4(view)) throw new TypeError("initialCameraPose.viewMatrix is not invertible.");
					return view;
				}
				const cameraToWorld = toMatrix4(pose.cameraToWorld);
				if (cameraToWorld) {
					const inverted = invert4(cameraToWorld);
					if (!inverted) throw new TypeError("initialCameraPose.cameraToWorld is not invertible.");
					return inverted;
				}
				if (pose.position && pose.target) {
					const lookAtView = viewMatrixFromLookAt(pose.position, pose.target, pose.up);
					if (!lookAtView) throw new TypeError("initialCameraPose look-at vectors do not form a valid camera basis.");
					return lookAtView;
				}
				throw new TypeError(
					"initialCameraPose must be a 16-number view matrix, { viewMatrix }, " +
					"{ cameraToWorld }, or { position, target, up? }."
				);
			}

			function sceneFormatFromUrl(url) {
				let pathname;
				try {
					pathname = new URL(url, window.location.href).pathname.toLowerCase();
				} catch (_) {
					pathname = String(url).split(/[?#]/, 1)[0].toLowerCase();
				}
				for (const format of ["lod-meta.json", "meta.json", "compressed.ply", "ply", "sog"]) {
					if (pathname.endsWith(`.${format}`)) return format;
				}
				return null;
			}

			function rotateVector3(vector, axis, angle) {
				const unitAxis = normalize3(axis);
				const cosine = Math.cos(angle);
				const sine = Math.sin(angle);
				const parallel = dot3(unitAxis, vector) * (1 - cosine);
				const crossed = cross3(unitAxis, vector);
				return [
					vector[0] * cosine + crossed[0] * sine + unitAxis[0] * parallel,
					vector[1] * cosine + crossed[1] * sine + unitAxis[1] * parallel,
					vector[2] * cosine + crossed[2] * sine + unitAxis[2] * parallel,
				];
			}

			function getTrackballState() {
				const world = invert4(viewMatrix);
				if (!world) return null;
				return {
					world,
					eye: [world[12], world[13], world[14]],
					right: normalize3([world[0], world[1], world[2]]),
					up: normalize3([world[4], world[5], world[6]]),
					backward: normalize3([world[8], world[9], world[10]]),
				};
			}

			function setTrackballPose(eye, target, upHint) {
				const backward = normalize3([
					eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]
				]);
				const rawRight = cross3(upHint, backward);
				let right = Math.hypot(...rawRight) > 1e-6 ? normalize3(rawRight) : [1, 0, 0];
				const up = normalize3(cross3(backward, right));
				const world = [
					right[0], right[1], right[2], 0,
					up[0], up[1], up[2], 0,
					backward[0], backward[1], backward[2], 0,
					eye[0], eye[1], eye[2], 1,
				];
				viewMatrix = invert4(world);
				if (viewMatrix) applyViewMatrixToCamera();
			}

			function rotateTrackball(deltaX, deltaY) {
				const state = getTrackballState();
				if (!state) return;
				let offset = state.eye.map((value, axis) => value - orbitTarget[axis]);
				if (Math.hypot(...offset) < 1e-6) offset = state.backward.map((value) => value * orbitDistance);
				// Yaw around physical world +Y so camera raster-Y convention does not
				// change the expected left/right mouse direction. Dragging left
				// orbits the scene left (camera swings right).
				offset = rotateVector3(offset, [0, 1, 0], (2.8 * deltaX) / Math.max(innerWidth, 1));
				const pitchAxis = normalize3(cross3(state.up, offset));
				offset = rotateVector3(offset, pitchAxis, (-2.8 * deltaY) / Math.max(innerHeight, 1));
				const up = rotateVector3(state.up, pitchAxis, (-2.8 * deltaY) / Math.max(innerHeight, 1));
				orbitDistance = Math.max(0.01, Math.hypot(...offset));
				setTrackballPose(orbitTarget.map((value, axis) => value + offset[axis]), orbitTarget, up);
			}

			function zoomTrackball(delta) {
				const state = getTrackballState();
				if (!state) return;
				const currentDistance = Math.max(0.01, Math.hypot(
					state.eye[0] - orbitTarget[0], state.eye[1] - orbitTarget[1], state.eye[2] - orbitTarget[2]
				));
				orbitDistance = Math.max(0.01, Math.min(1e5, currentDistance * Math.exp(delta)));
				const eye = orbitTarget.map((value, axis) => value + state.backward[axis] * orbitDistance);
				setTrackballPose(eye, orbitTarget, state.up);
			}

			function panTrackball(deltaX, deltaY) {
				const state = getTrackballState();
				if (!state) return;
				const scale = Math.max(orbitDistance, 0.1) * 1.5 / Math.max(innerHeight, 1);
				const translation = state.right.map((value, axis) =>
					value * deltaX * scale - state.up[axis] * deltaY * scale
				);
				orbitTarget = orbitTarget.map((value, axis) => value + translation[axis]);
				const eye = state.eye.map((value, axis) => value + translation[axis]);
				setTrackballPose(eye, orbitTarget, state.up);
			}

			// --- feature registry glue -------------------------------------------

			// The scene surface features act on. Everything a feature is allowed
			// to touch goes through here - never viewer internals directly.
			function createSceneApi() {
				return {
					get app() { return app; },
					get graphicsDevice() { return app?.graphicsDevice ?? null; },
					getCameraEntity: () => cameraEntity,
					drawLine: (a, b, color, depthTest = false) => {
						if (!app) return;
						app.drawLine(
							new pc.Vec3(a[0], a[1], a[2]),
							new pc.Vec3(b[0], b[1], b[2]),
							new pc.Color(color[0], color[1], color[2], color[3] ?? 1),
							Boolean(depthTest),
						);
					},

					getViewMatrix: () => viewMatrix,
					setViewMatrix: (m) => { viewMatrix = m; applyViewMatrixToCamera(); },
					getCameraBasis: () => getTrackballState(),
					setCameraPose: (eye, target, up) => setTrackballPose(eye, target, up),
					getOrbitTarget: () => orbitTarget,
					setOrbitTarget: (t) => { orbitTarget = [...t]; },
					getOrbitDistance: () => orbitDistance,
					setOrbitDistance: (d) => { orbitDistance = d; },
					getDefaultViewMatrix: () => defaultViewMatrix,
					setDefaultViewMatrix: (m) => { defaultViewMatrix = m ? [...m] : null; },
					isAutoFraming: () => autoFramePending,
					setAutoFraming: (v) => { autoFramePending = Boolean(v); },
					getCameraFov: () => (cameraEntity?.camera?.fov || 36),
					getViewportSize: () => [innerWidth, innerHeight],

					getSplatEntity: () => splatEntity,
					getSplatMaterial: () => splatEntity?.gsplat?.material ?? null,
					getSceneFit: () => sceneFit,
					getOriginDistances: () => originDistances,

					// set by registerFeatures() to the role:'cameraPath' feature
					cameraPath: undefined,

					queryElement: (id) => getViewerElement(id),
					queryElements: (sel) => getViewerElements(sel),
					addListener: (target, type, handler, opts) => listen(target, type, handler, opts),
					now: () => performance.now(),
					setStatus: (t) => setStatus(t),
					setProgress: (p) => setProgress(p),
					setSpinner: (v) => setSpinnerVisible(v),
					isDestroyed: () => viewerDestroyed,
				};
			}

			function registerFeatures(list) {
				features = list.map(resolveFeature);
				sceneApi = createSceneApi();
				const cameraPathFeature = features.find((feature) => feature.role === 'cameraPath');
				if (cameraPathFeature) {
					sceneApi.cameraPath = {
						start: (now) => cameraPathFeature.start?.(now),
						stop: () => cameraPathFeature.stop?.(),
						toggle: () => cameraPathFeature.toggle?.(),
						isActive: () => cameraPathFeature.isActive?.() ?? false,
					};
				}
				for (const feature of features) feature.setup?.(sceneApi);
			}

			function notifySceneReady() {
				for (const feature of features) feature.sceneReady?.(sceneApi);
			}

			function teardownFeatures() {
				for (const feature of features) feature.teardown?.(sceneApi);
				features = [];
				sceneApi = null;
			}

			function notifyInteraction() {
				if (!sceneApi) return;
				for (const feature of features) feature.userInteraction?.(sceneApi);
			}

			function runFeatureFrame(now) {
				if (!sceneApi) return;
				for (const feature of features) feature.frame?.(now, sceneApi);
			}


			// The shared PCA fit of the loaded volume. Camera-path and bounding-box
			// features consume it; neither owns it.
			function setSceneFit(result) {
				sceneFit = result
					? {
						center: [...result.center],
						axes: {
							right: [...result.axes.right],
							up: [...result.axes.up],
							backward: [...result.axes.backward],
						},
						halfExtents: [...result.halfExtents],
						distance: result.distance,
					}
					: null;
				updateViewToolbarAvailability();
			}

			// --- fitted side views (Front/Back/... toolbar buttons) --------------

			function updateViewToolbarAvailability() {
				if (!mode.chrome) return;
				const enabled = Boolean(sceneFit);
				getViewerElements("[data-pca-view]").forEach((button) => {
					button.disabled = !enabled;
				});
			}

			function distanceForPcaView(direction, upHint) {
				const backward = normalize3(direction);
				const screenRight = normalize3(cross3(upHint, backward));
				const screenUp = normalize3(cross3(backward, screenRight));
				const boxAxes = [sceneFit.axes.right, sceneFit.axes.up, sceneFit.axes.backward];
				const extents = sceneFit.halfExtents;
				const support = (axis) => boxAxes.reduce(
					(sum, boxAxis, index) => sum + Math.abs(dot3(axis, boxAxis)) * extents[index],
					0
				);
				const verticalFov = (cameraEntity?.camera?.fov || 36) * Math.PI / 180;
				const aspect = Math.max(0.5, (innerWidth || 1) / Math.max(innerHeight || 1, 1));
				const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * aspect);
				return 1.2 * (
					Math.max(
						support(screenUp) / Math.tan(verticalFov * 0.5),
						support(screenRight) / Math.tan(horizontalFov * 0.5)
					) + support(backward)
				);
			}

			function setPcaSideView(side) {
				if (!sceneFit) return;
				notifyInteraction();
				const negate = (axis) => axis.map((value) => -value);
				let direction = sceneFit.axes.backward;
				let upHint = sceneFit.axes.up;
				if (side === "back") direction = negate(sceneFit.axes.backward);
				else if (side === "right") direction = sceneFit.axes.right;
				else if (side === "left") direction = negate(sceneFit.axes.right);
				else if (side === "top") {
					direction = [0, 1, 0];
					upHint = negate(sceneFit.axes.backward);
				} else if (side === "bottom") {
					direction = [0, -1, 0];
					upHint = sceneFit.axes.backward;
				}
				orbitTarget = [...sceneFit.center];
				orbitDistance = distanceForPcaView(direction, upHint);
				const eye = orbitTarget.map((value, axis) => value + direction[axis] * orbitDistance);
				setTrackballPose(eye, orbitTarget, upHint);
				defaultViewMatrix = viewMatrix ? [...viewMatrix] : defaultViewMatrix;
			}

			function attachViewToolbar() {
				if (!mode.chrome) return;
				getViewerElements("[data-pca-view]").forEach((button) => {
					listen(button, "click", () => setPcaSideView(button.dataset.pcaView));
				});
				updateViewToolbarAvailability();
			}

			function eigenvectorsSymmetric3(covariance) {
				const a = covariance.map((row) => row.slice());
				const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

				for (let iteration = 0; iteration < 16; iteration++) {
					let p = 0;
					let q = 1;
					let largest = Math.abs(a[0][1]);
					for (const pair of [[0, 2], [1, 2]]) {
						const value = Math.abs(a[pair[0]][pair[1]]);
						if (value > largest) {
							largest = value;
							[p, q] = pair;
						}
					}
					if (largest < 1e-10) break;

					const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
					const c = Math.cos(angle);
					const s = Math.sin(angle);
					const app = c * c * a[p][p] - 2 * s * c * a[p][q] + s * s * a[q][q];
					const aqq = s * s * a[p][p] + 2 * s * c * a[p][q] + c * c * a[q][q];

					for (let r = 0; r < 3; r++) {
						if (r === p || r === q) continue;
						const arp = c * a[r][p] - s * a[r][q];
						const arq = s * a[r][p] + c * a[r][q];
						a[r][p] = a[p][r] = arp;
						a[r][q] = a[q][r] = arq;
					}
					a[p][p] = app;
					a[q][q] = aqq;
					a[p][q] = a[q][p] = 0;

					for (let r = 0; r < 3; r++) {
						const vrp = c * vectors[r][p] - s * vectors[r][q];
						const vrq = s * vectors[r][p] + c * vectors[r][q];
						vectors[r][p] = vrp;
						vectors[r][q] = vrq;
					}
				}

				return [0, 1, 2]
					.map((index) => ({
						value: a[index][index],
						vector: normalize3([vectors[0][index], vectors[1][index], vectors[2][index]])
					}))
					.sort((left, right) => right.value - left.value);
			}

			function computeDensityView(bytes, byteLength, headerInfo) {
				if (!headerInfo || !headerInfo.properties) return null;
				const { properties } = headerInfo;
				const xProperty = properties.x;
				const yProperty = properties.y;
				const zProperty = properties.z;
				if (!xProperty || !yProperty || !zProperty) return null;

				const availableVertices = Math.min(
					headerInfo.totalVertices,
					Math.floor(Math.max(0, byteLength - headerInfo.headerBytes) / headerInfo.rowBytes)
				);
				if (availableVertices < 128) return null;

				const view = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
				const sampleStep = Math.max(1, Math.ceil(availableVertices / 60000));
				const points = [];
				const opacityProperty = properties.opacity;
				const scaleProperties = [properties.scale_0, properties.scale_1, properties.scale_2];

				for (let vertex = 0; vertex < availableVertices; vertex += sampleStep) {
					const base = headerInfo.headerBytes + vertex * headerInfo.rowBytes;
					const x = readPlyNumber(view, base + xProperty.offset, xProperty.type);
					const y = readPlyNumber(view, base + yProperty.offset, yProperty.type);
					const z = readPlyNumber(view, base + zProperty.offset, zProperty.type);
					if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

					let opacity = 1;
					if (opacityProperty) {
						const rawOpacity = readPlyNumber(view, base + opacityProperty.offset, opacityProperty.type);
						const bounded = Math.max(-30, Math.min(30, rawOpacity));
						opacity = bounded >= 0
							? 1 / (1 + Math.exp(-bounded))
							: Math.exp(bounded) / (1 + Math.exp(bounded));
					}

					let scaleQuality = 1;
					if (scaleProperties.every(Boolean)) {
						const meanLogScale = scaleProperties.reduce(
							(sum, property) => sum + readPlyNumber(view, base + property.offset, property.type),
							0
						) / 3;
						const linearScale = Math.exp(Math.max(-10, Math.min(5, meanLogScale)));
						scaleQuality = 1 / (1 + 4 * linearScale);
					}

					points.push({ x, y, z, weight: (0.1 + 0.9 * opacity) * scaleQuality, cell: -1 });
				}
				if (points.length < 128) return null;

				const coordinates = [
					points.map((point) => point.x),
					points.map((point) => point.y),
					points.map((point) => point.z),
				];
				const lower = coordinates.map((values) => percentile(values, 0.02));
				const upper = coordinates.map((values) => percentile(values, 0.98));
				const spans = upper.map((value, axis) => Math.max(value - lower[axis], 1e-6));

				const gridSize = 24;
				const gridArea = gridSize * gridSize;
				const gridCells = gridArea * gridSize;
				const density = new Float64Array(gridCells);
				const cellIndex = (ix, iy, iz) => ix + iy * gridSize + iz * gridArea;

				for (const point of points) {
					const values = [point.x, point.y, point.z];
					if (values.some((value, axis) => value < lower[axis] || value > upper[axis])) continue;
					const ix = Math.min(gridSize - 1, Math.floor(((point.x - lower[0]) / spans[0]) * gridSize));
					const iy = Math.min(gridSize - 1, Math.floor(((point.y - lower[1]) / spans[1]) * gridSize));
					const iz = Math.min(gridSize - 1, Math.floor(((point.z - lower[2]) / spans[2]) * gridSize));
					point.cell = cellIndex(ix, iy, iz);
					density[point.cell] += point.weight;
				}

				const smoothed = new Float64Array(gridCells);
				let bestCell = 0;
				let bestScore = -1;
				for (let iz = 0; iz < gridSize; iz++) {
					for (let iy = 0; iy < gridSize; iy++) {
						for (let ix = 0; ix < gridSize; ix++) {
							let score = 0;
							for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
								const x = ix + dx;
								const y = iy + dy;
								const z = iz + dz;
								if (x >= 0 && x < gridSize && y >= 0 && y < gridSize && z >= 0 && z < gridSize) {
									score += density[cellIndex(x, y, z)];
								}
							}
							const index = cellIndex(ix, iy, iz);
							smoothed[index] = score;
							if (score > bestScore) {
								bestScore = score;
								bestCell = index;
							}
						}
					}
				}

				const selectedCells = new Uint8Array(gridCells);
				const queue = new Int32Array(gridCells);
				let queueStart = 0;
				let queueEnd = 1;
				queue[0] = bestCell;
				selectedCells[bestCell] = 1;
				const densityThreshold = bestScore * 0.2;

				while (queueStart < queueEnd) {
					const current = queue[queueStart++];
					const iz = Math.floor(current / gridArea);
					const remainder = current - iz * gridArea;
					const iy = Math.floor(remainder / gridSize);
					const ix = remainder - iy * gridSize;
					for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						if (dx === 0 && dy === 0 && dz === 0) continue;
						const x = ix + dx;
						const y = iy + dy;
						const z = iz + dz;
						if (x < 0 || x >= gridSize || y < 0 || y >= gridSize || z < 0 || z >= gridSize) continue;
						const neighbor = cellIndex(x, y, z);
						if (!selectedCells[neighbor] && smoothed[neighbor] >= densityThreshold) {
							selectedCells[neighbor] = 1;
							queue[queueEnd++] = neighbor;
						}
					}
				}

				let cluster = points.filter((point) => point.cell >= 0 && selectedCells[point.cell]);
				if (cluster.length < Math.max(128, points.length * 0.01)) {
					cluster = points.filter((point) => point.cell >= 0 && smoothed[point.cell] >= bestScore * 0.1);
				}
				if (cluster.length < 128) return null;

				let totalWeight = 0;
				const center = [0, 0, 0];
				for (const point of cluster) {
					totalWeight += point.weight;
					center[0] += point.x * point.weight;
					center[1] += point.y * point.weight;
					center[2] += point.z * point.weight;
				}
				for (let axis = 0; axis < 3; axis++) center[axis] /= Math.max(totalWeight, 1e-9);

				const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
				for (const point of cluster) {
					const delta = [point.x - center[0], point.y - center[1], point.z - center[2]];
					for (let row = 0; row < 3; row++) for (let column = row; column < 3; column++) {
						covariance[row][column] += point.weight * delta[row] * delta[column];
					}
				}
				for (let row = 0; row < 3; row++) for (let column = row; column < 3; column++) {
					covariance[row][column] /= Math.max(totalWeight, 1e-9);
					covariance[column][row] = covariance[row][column];
				}

				const axes = eigenvectorsSymmetric3(covariance);
				const worldUp = [0, 1, 0];
				const cameraUp = [0, -1, 0];
				// Keep camera raster +Y aligned with world -Y. Prefer the largest PCA component for
				// image X when it is horizontal; otherwise use the next horizontal one.
				const horizontalThreshold = 0.25;
				let horizontalAxis = axes.find((axis) => Math.abs(dot3(axis.vector, worldUp)) <= horizontalThreshold);
				if (!horizontalAxis) {
					horizontalAxis = axes.reduce((best, axis) =>
						Math.abs(dot3(axis.vector, worldUp)) < Math.abs(dot3(best.vector, worldUp)) ? axis : best
					);
				}
				const verticalPart = dot3(horizontalAxis.vector, worldUp);
				const projectedHorizontal = [
					horizontalAxis.vector[0],
					horizontalAxis.vector[1] - verticalPart,
					horizontalAxis.vector[2],
				];
				let right = Math.hypot(...projectedHorizontal) > 1e-6 ? normalize3(projectedHorizontal) : [1, 0, 0];
				const up = cameraUp;
				let backward = normalize3(cross3(right, up));

				const previousWorld = defaultViewMatrix ? invert4(defaultViewMatrix) : null;
				if (previousWorld) {
					const previousDirection = [previousWorld[12] - center[0], previousWorld[13] - center[1], previousWorld[14] - center[2]];
					if (dot3(previousDirection, backward) < 0) {
						backward = backward.map((value) => -value);
						right = right.map((value) => -value);
					}
				}

				const projected = [[], [], []];
				for (const point of cluster) {
					const delta = [point.x - center[0], point.y - center[1], point.z - center[2]];
					projected[0].push(dot3(delta, right));
					projected[1].push(dot3(delta, up));
					projected[2].push(dot3(delta, backward));
				}
				const projectionBounds = projected.map((values) => [percentile(values, 0.02), percentile(values, 0.98)]);
				for (let axis = 0; axis < 3; axis++) {
					const midpoint = (projectionBounds[axis][0] + projectionBounds[axis][1]) * 0.5;
					const basis = [right, up, backward][axis];
					center[0] += basis[0] * midpoint;
					center[1] += basis[1] * midpoint;
					center[2] += basis[2] * midpoint;
				}

				const halfWidth = Math.max(0.05, (projectionBounds[0][1] - projectionBounds[0][0]) * 0.5);
				const halfHeight = Math.max(0.05, (projectionBounds[1][1] - projectionBounds[1][0]) * 0.5);
				const halfDepth = Math.max(0.05, (projectionBounds[2][1] - projectionBounds[2][0]) * 0.5);
				const verticalFov = (cameraEntity?.camera?.fov || 36) * Math.PI / 180;
				const aspect = Math.max(0.5, (innerWidth || 1) / Math.max(innerHeight || 1, 1));
				const distance = 1.25 * (
					Math.max(halfHeight / Math.tan(verticalFov * 0.5), halfWidth / (Math.tan(verticalFov * 0.5) * aspect)) +
					halfDepth
				);
				const eye = center.map((value, axis) => value + backward[axis] * distance);
				const worldMatrix = [
					right[0], right[1], right[2], 0,
					up[0], up[1], up[2], 0,
					backward[0], backward[1], backward[2], 0,
					eye[0], eye[1], eye[2], 1,
				];
				const fittedView = invert4(worldMatrix);
				if (!fittedView) return null;

				return {
					viewMatrix: fittedView,
					center,
					distance,
					axes: { right, up, backward },
					halfExtents: [halfWidth, halfHeight, halfDepth],
					sampleCount: points.length,
					clusterCount: cluster.length,
				};
			}

			// Distance of the nearest / farthest splat from the world origin,
			// sampled from the vertex positions. The reveal effect uses this as
			// the inner and outer radius of its two expanding spheres.
			function computeOriginDistances(bytes, byteLength, headerInfo) {
				const { properties, headerBytes, rowBytes, totalVertices } = headerInfo || {};
				const px = properties?.x;
				const py = properties?.y;
				const pz = properties?.z;
				if (!px || !py || !pz || !rowBytes) return null;

				const available = Math.min(
					totalVertices,
					Math.floor(Math.max(0, byteLength - headerBytes) / rowBytes)
				);
				if (available < 1) return null;

				const view = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
				const step = Math.max(1, Math.ceil(available / 40000));
				let minDist = Infinity;
				let maxDist = 0;
				for (let vertex = 0; vertex < available; vertex += step) {
					const base = headerBytes + vertex * rowBytes;
					const x = readPlyNumber(view, base + px.offset, px.type);
					const y = readPlyNumber(view, base + py.offset, py.type);
					const z = readPlyNumber(view, base + pz.offset, pz.type);
					if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
					const dist = Math.hypot(x, y, z);
					if (dist < minDist) minDist = dist;
					if (dist > maxDist) maxDist = dist;
				}
				if (!Number.isFinite(minDist) || maxDist <= 0 || maxDist <= minDist) return null;
				return { minDist, maxDist };
			}

			function applyDensityView(bytes, byteLength, headerInfo) {
				const result = computeDensityView(bytes, byteLength, headerInfo);
				if (!result) return false;
				orbitTarget = [...result.center];
				setSceneFit(result);
				if (!autoFramePending) {
					const state = getTrackballState();
					if (state) orbitDistance = Math.max(0.01, Math.hypot(
						...state.eye.map((value, axis) => value - orbitTarget[axis])
					));
					return true;
				}
				viewMatrix = result.viewMatrix;
				defaultViewMatrix = [...result.viewMatrix];
				orbitDistance = result.distance;
				autoFramePending = false;
				applyViewMatrixToCamera();
				console.log("density-framed initial view", {
					center: result.center.map((value) => Number(value.toFixed(5))),
					distance: Number(result.distance.toFixed(5)),
					samples: result.sampleCount,
					clusterSamples: result.clusterCount,
				});
				return true;
			}

			// Scene framing + reveal bounds, derived the same way for every format:
			// from the splat centres PlayCanvas exposes after the asset loads.
			// (`resource.centers` is a flat Float32Array of x,y,z per splat, for
			// plain .ply, .compressed.ply and .sog alike.)
			function deriveSceneInfo() {
				const resource =
					splatEntity?.gsplat?.instance?.resource ??
					splatAsset?.resource ??
					null;
				const centers = resource?.centers;

				if (centers && centers.length >= 3) {
					const count = Math.floor(centers.length / 3);
					const bytes = new Uint8Array(centers.buffer, centers.byteOffset, centers.byteLength);
					const headerInfo = {
						totalVertices: count,
						rowBytes: 12,
						headerBytes: 0,
						properties: {
							x: { offset: 0, type: "float" },
							y: { offset: 4, type: "float" },
							z: { offset: 8, type: "float" },
						},
					};
					applyDensityView(bytes, bytes.byteLength, headerInfo);
					originDistances = computeOriginDistances(bytes, bytes.byteLength, headerInfo);
				}

				// Fall back to the axis-aligned bounds when the density fit could
				// not be computed (degenerate / very small scenes).
				if (!sceneFit && resource?.aabb) {
					const c = resource.aabb.center;
					const h = resource.aabb.halfExtents;
					setSceneFit({
						center: [c.x, c.y, c.z],
						axes: { right: [1, 0, 0], up: [0, 1, 0], backward: [0, 0, 1] },
						halfExtents: [h.x, h.y, h.z],
						distance: Math.max(h.x, h.y, h.z, 0.1) * 3,
					});
				}
				if (!originDistances && sceneFit) {
					const [hx, hy, hz] = sceneFit.halfExtents;
					const centerDist = Math.hypot(...sceneFit.center);
					originDistances = {
						minDist: Math.max(0, centerDist - Math.hypot(hx, hy, hz)),
						maxDist: centerDist + Math.hypot(hx, hy, hz),
					};
				}
			}

			async function loadSource(sceneUrl, formatHint) {
				setSceneFit(null);
				originDistances = null;
				updateViewToolbarAvailability();
				loadController?.abort();
				loadController = new AbortController();

				const format = formatHint || sceneFormatFromUrl(sceneUrl);
				if (!format) {
					throw new Error("Unsupported scene URL. Use .ply, .compressed.ply, .sog, .meta.json or .lod-meta.json.");
				}

				setSpinnerVisible(true);
				setStatus("");
				setProgress(1);

				// One path for every format: hand the URL to PlayCanvas, then
				// derive the scene fit from the loaded splats.
				await loadGsplatFromUrl(sceneUrl);
				if (viewerDestroyed || loadController.signal.aborted) return;
				deriveSceneInfo();
				setStatus("");
			}

			async function loadGsplatFromUrl(url, options = {}) {
				const resetProgress = options.resetProgress !== false;
				const loadProgress = typeof options.loadProgress === "number" ? options.loadProgress : 50;
				const keepPreviousOnError = options.keepPreviousOnError === true;
				return new Promise((resolve, reject) => {
					let previousEntity = splatEntity;
					let previousAsset = splatAsset;

					setSpinnerVisible(true);
					if (resetProgress) {
						setProgress(10);
						setStatus("");
					}

					const nextAsset = new pc.Asset("scene", "gsplat", { url });
					app.assets.add(nextAsset);

					nextAsset.once("load", () => {
						const nextEntity = new pc.Entity("Splat");
						// `unified: false` is load-bearing, not a preference. Under the
						// unified renderer PlayCanvas returns null from
						// `component.material`, so there is no per-instance material for
						// features to touch and the reveal effect silently does nothing.
						// The default flipped to unified in PlayCanvas 2.14+, which is
						// why this used to work without saying so. `unified` is first in
						// the component schema, so it is applied before `asset`.
						nextEntity.addComponent("gsplat", { unified: false, asset: nextAsset });
						app.root.addChild(nextEntity);

						if (previousEntity) {
							previousEntity.destroy();
							previousEntity = null;
						}
						if (previousAsset) {
							app.assets.remove(previousAsset);
							previousAsset.unload();
							previousAsset = null;
						}

						splatEntity = nextEntity;
						splatAsset = nextAsset;

						setSpinnerVisible(false);
						setProgress(100);
						resolve(splatEntity);
					});

					nextAsset.once("error", (err) => {
						app.assets.remove(nextAsset);
						nextAsset.unload();

						if (!keepPreviousOnError) {
							if (previousEntity) {
								previousEntity.destroy();
								previousEntity = null;
								splatEntity = null;
							}
							if (previousAsset) {
								app.assets.remove(previousAsset);
								previousAsset.unload();
								previousAsset = null;
								splatAsset = null;
							}
						}

						setSpinnerVisible(false);
						reject(err || new Error(`Failed to load gsplat asset: ${url}`));
					});

					app.assets.load(nextAsset);
					setProgress(loadProgress);
				});
			}

			// ---------------- IMU control ----------------

			let fov_x = Math.PI / 9;
			let fov_y = Math.PI / 5;
			let accumulatedRoll = 0;
			let accumulatedPitch = 0;
			let lastTimestamp = null;
			const gyroBias = [-0.00323298, 0.00238332, 0.00071362];
			const eps = 0.005;

			function isValidIMUData(data) {
				return (
					data &&
					typeof data === "object" &&
					"angular_velocity" in data &&
					"linear_acceleration" in data &&
					"timestamp" in data &&
					Array.isArray(data.angular_velocity) &&
					data.angular_velocity.length === 3 &&
					data.angular_velocity.every((n) => typeof n === "number") &&
					typeof data.timestamp === "number"
				);
			}

			function message_handle_default(event) {
				let data;
				try {
					data = JSON.parse(event.data);
				} catch (_) {
					return;
				}
				if (!isValidIMUData(data)) {
					console.warn("Invalid IMU data received:", data);
					return;
				}

				let omega = [...data.angular_velocity];
				const t = data.timestamp;

				if (lastTimestamp !== null) {
					const dt = (t - lastTimestamp) / 1000;

					omega[0] -= gyroBias[0];
					omega[1] -= gyroBias[1];
					omega[2] -= gyroBias[2];

					if (Math.hypot(omega[0], omega[1], omega[2]) < eps) {
						omega = [0, 0, 0];
					}

					const dTheta = [omega[0] * dt, omega[1] * dt, 0];

					const newRoll = accumulatedRoll + dTheta[0];
					const newPitch = accumulatedPitch + dTheta[1];

					if (Math.abs(newRoll) > fov_x) dTheta[0] = 0;
					if (Math.abs(newPitch) > fov_y) dTheta[1] = 0;

					accumulatedRoll += dTheta[0];
					accumulatedPitch += dTheta[1];

					const angle = Math.hypot(dTheta[0], dTheta[1], dTheta[2]);
					if (angle > 1e-6) {
						const axis = [dTheta[0] / angle, dTheta[1] / angle, dTheta[2] / angle];
						viewMatrix = rotate4(viewMatrix, angle, axis[0], axis[1], axis[2]);
						applyViewMatrixToCamera();
					}
				}

				lastTimestamp = t;
			}

			// ---------------- controls ----------------

			function attachControls(canvas) {
				let startX = 0;
				let startY = 0;
				let down = 0;
				let altX = 0;
				let altY = 0;

				// Keyboard is opt-out (`fullScreen: false`). With no keydown
				// listener `activeKeys` stays empty, so every key branch in
				// frame() is inert - nothing else needs to know.
				if (mode.keyboard) {
					listen(viewerRoot, "keydown", (e) => {
						if (e.code !== "KeyP") notifyInteraction();
						autoFramePending = false;
						if (!activeKeys.includes(e.code)) activeKeys.push(e.code);

						if (e.code === "KeyP" && !e.repeat) sceneApi?.cameraPath?.toggle();
					});

					listen(window, "keyup", (e) => {
						activeKeys = activeKeys.filter((k) => k !== e.code);
					});

					listen(window, "blur", () => {
						activeKeys = [];
					});
				}

				listen(canvas, "wheel", (e) => {
					notifyInteraction();
					autoFramePending = false;
					e.preventDefault();
					const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
					zoomTrackball(e.deltaY * scale * 0.0015);
				}, { passive: false });

				listen(canvas, "mousedown", (e) => {
					viewerRoot.focus?.();
					notifyInteraction();
					autoFramePending = false;
					e.preventDefault();
					startX = e.clientX;
					startY = e.clientY;
					down = e.button === 1 ? 2 : e.button === 2 ? 3 : 1;
				});

				listen(canvas, "contextmenu", (e) => {
					notifyInteraction();
					e.preventDefault();
				});

				listen(canvas, "mousemove", (e) => {
					e.preventDefault();
					if (!down) return;

					if (down === 1) {
						rotateTrackball(e.clientX - startX, e.clientY - startY);
					} else if (down === 2) {
						zoomTrackball((e.clientY - startY) * 0.01);
					} else if (down === 3) {
						panTrackball(e.clientX - startX, e.clientY - startY);
					}

					startX = e.clientX;
					startY = e.clientY;
				});

				listen(window, "mouseup", (e) => {
					e.preventDefault();
					down = 0;
				});

				listen(canvas, "touchstart", (e) => {
					viewerRoot.focus?.();
					e.preventDefault();
					autoFramePending = false;
					notifyInteraction();

					if (e.touches.length === 1) {
						startX = e.touches[0].clientX;
						startY = e.touches[0].clientY;
						down = 1;
					} else if (e.touches.length === 2) {
						startX = e.touches[0].clientX;
						altX = e.touches[1].clientX;
						startY = e.touches[0].clientY;
						altY = e.touches[1].clientY;
						down = 1;
					}
				}, { passive: false });

				listen(canvas, "touchmove", (e) => {
					e.preventDefault();

					let inv = invert4(viewMatrix);
					if (!inv) return;

					if (e.touches.length === 1 && down) {
						const dx = (4 * (e.touches[0].clientX - startX)) / innerWidth;
						const dy = (4 * (e.touches[0].clientY - startY)) / innerHeight;
						const d = 4;

						inv = translate4(inv, 0, 0, d);
						inv = rotate4(inv, dx, 0, 1, 0);
						inv = rotate4(inv, -dy, 1, 0, 0);
						inv = translate4(inv, 0, 0, -d);

						viewMatrix = invert4(inv);
						applyViewMatrixToCamera();

						startX = e.touches[0].clientX;
						startY = e.touches[0].clientY;
					} else if (e.touches.length === 2) {
						const dtheta =
							Math.atan2(startY - altY, startX - altX) -
							Math.atan2(
								e.touches[0].clientY - e.touches[1].clientY,
								e.touches[0].clientX - e.touches[1].clientX
							);

						const dscale =
							Math.hypot(startX - altX, startY - altY) /
							Math.hypot(
								e.touches[0].clientX - e.touches[1].clientX,
								e.touches[0].clientY - e.touches[1].clientY
							);

						const dx = (
							e.touches[0].clientX +
							e.touches[1].clientX -
							(startX + altX)
						) / 2;

						const dy = (
							e.touches[0].clientY +
							e.touches[1].clientY -
							(startY + altY)
						) / 2;

						inv = rotate4(inv, dtheta, 0, 0, 1);
						inv = translate4(inv, -dx / innerWidth, -dy / innerHeight, 0);
						inv = translate4(inv, 0, 0, 3 * (1 - dscale));

						viewMatrix = invert4(inv);
						applyViewMatrixToCamera();

						startX = e.touches[0].clientX;
						altX = e.touches[1].clientX;
						startY = e.touches[0].clientY;
						altY = e.touches[1].clientY;
					}
				}, { passive: false });

				listen(canvas, "touchend", (e) => {
					e.preventDefault();
					down = 0;
				}, { passive: false });

			}

			function attachDragDrop() {
				if (!mode.dragDrop) return;
				const preventDefault = (e) => {
					e.preventDefault();
					e.stopPropagation();
				};

				listen(viewerRoot, "dragenter", preventDefault);
				listen(viewerRoot, "dragover", preventDefault);
				listen(viewerRoot, "dragleave", preventDefault);

				listen(viewerRoot, "drop", async (e) => {
					e.preventDefault();
					e.stopPropagation();

					const file = e.dataTransfer?.files?.[0];
					if (!file) return;

					const lower = file.name.toLowerCase();

					if (
						lower.endsWith(".ply") ||
						lower.endsWith(".sog") ||
						lower.endsWith(".compressed.ply") ||
						lower.endsWith(".meta.json") ||
						lower.endsWith(".lod-meta.json")
					) {
						const objectUrl = URL.createObjectURL(file);
						try {
							autoFramePending = true;
							defaultViewMatrix = null;
							await loadSource(objectUrl, sceneFormatFromUrl(file.name));
							if (!viewerDestroyed) notifySceneReady();
						} catch (err) {
							console.error(err);
							setStatus(String(err));
						}
					} else {
						setStatus("Unsupported file. Use .ply, .sog, .compressed.ply, .meta.json or .lod-meta.json");
					}
				});
			}

			function frame(now, fpsEl) {
				if (viewerDestroyed) return;
				let inv = invert4(viewMatrix);
				if (!inv) {
					scheduleFrame((t) => frame(t, fpsEl));
					return;
				}

				const shiftKey =
					activeKeys.includes("Shift") ||
					activeKeys.includes("ShiftLeft") ||
					activeKeys.includes("ShiftRight");

				if (activeKeys.includes("ArrowUp")) {
					inv = shiftKey ? translate4(inv, 0, -0.03, 0) : translate4(inv, 0, 0, 0.1);
				}
				if (activeKeys.includes("ArrowDown")) {
					inv = shiftKey ? translate4(inv, 0, 0.03, 0) : translate4(inv, 0, 0, -0.1);
				}
				if (activeKeys.includes("ArrowLeft")) inv = translate4(inv, -0.03, 0, 0);
				if (activeKeys.includes("ArrowRight")) inv = translate4(inv, 0.03, 0, 0);

				if (activeKeys.includes("KeyA")) inv = rotate4(inv, -0.01, 0, 1, 0);
				if (activeKeys.includes("KeyD")) inv = rotate4(inv, 0.01, 0, 1, 0);
				if (activeKeys.includes("KeyQ")) inv = rotate4(inv, 0.01, 0, 0, 1);
				if (activeKeys.includes("KeyE")) inv = rotate4(inv, -0.01, 0, 0, 1);
				if (activeKeys.includes("KeyW")) inv = rotate4(inv, 0.005, 1, 0, 0);
				if (activeKeys.includes("KeyS")) inv = rotate4(inv, -0.005, 1, 0, 0);

				if (["KeyJ", "KeyK", "KeyL", "KeyI"].some((k) => activeKeys.includes(k))) {
					const d = 4;
					inv = translate4(inv, 0, 0, d);
					inv = rotate4(
						inv,
						activeKeys.includes("KeyJ") ? -0.05 : activeKeys.includes("KeyL") ? 0.05 : 0,
						0, 1, 0
					);
					inv = rotate4(
						inv,
						activeKeys.includes("KeyI") ? 0.05 : activeKeys.includes("KeyK") ? -0.05 : 0,
						1, 0, 0
					);
					inv = translate4(inv, 0, 0, -d);
				}

				const gamepads = mode.gamepad && navigator.getGamepads ? navigator.getGamepads() : [];
				let isJumping = activeKeys.includes("Space");

				for (const gamepad of gamepads) {
					if (!gamepad) continue;

					const axisThreshold = 0.1;
					const moveSpeed = 0.06;
					const rotateSpeed = 0.02;

					if (Math.abs(gamepad.axes[0]) > axisThreshold) {
						notifyInteraction();
						inv = translate4(inv, moveSpeed * gamepad.axes[0], 0, 0);
					}
					if (Math.abs(gamepad.axes[1]) > axisThreshold) {
						notifyInteraction();
						inv = translate4(inv, 0, 0, -moveSpeed * gamepad.axes[1]);
					}
					if (gamepad.buttons[12]?.pressed || gamepad.buttons[13]?.pressed) {
						notifyInteraction();
						inv = translate4(inv, 0, -moveSpeed * ((gamepad.buttons[12]?.pressed ? 1 : 0) - (gamepad.buttons[13]?.pressed ? 1 : 0)), 0);
					}
					if (gamepad.buttons[14]?.pressed || gamepad.buttons[15]?.pressed) {
						notifyInteraction();
						inv = translate4(inv, -moveSpeed * ((gamepad.buttons[14]?.pressed ? 1 : 0) - (gamepad.buttons[15]?.pressed ? 1 : 0)), 0, 0);
					}

					if (Math.abs(gamepad.axes[2]) > axisThreshold) {
						notifyInteraction();
						inv = rotate4(inv, rotateSpeed * gamepad.axes[2], 0, 1, 0);
					}
					if (Math.abs(gamepad.axes[3]) > axisThreshold) {
						notifyInteraction();
						inv = rotate4(inv, -rotateSpeed * gamepad.axes[3], 1, 0, 0);
					}

					const tiltAxis = (gamepad.buttons[6]?.value || 0) - (gamepad.buttons[7]?.value || 0);
					if (Math.abs(tiltAxis) > axisThreshold) {
						notifyInteraction();
						inv = rotate4(inv, rotateSpeed * tiltAxis, 0, 0, 1);
					}

					if (gamepad.buttons[0]?.pressed) {
						isJumping = true;
						notifyInteraction();
					}
					if (gamepad.buttons[3]?.pressed && !sceneApi?.cameraPath?.isActive()) {
						sceneApi?.cameraPath?.start(now);
					}
				}

				viewMatrix = invert4(inv);

				runFeatureFrame(now);

				if (isJumping) {
					jumpDelta = Math.min(1, jumpDelta + 0.05);
				} else {
					jumpDelta = Math.max(0, jumpDelta - 0.05);
				}

				let inv2 = invert4(viewMatrix);
				if (inv2) {
					inv2 = translate4(inv2, 0, -jumpDelta, 0);
					inv2 = rotate4(inv2, -0.1 * jumpDelta, 1, 0, 0);
					viewMatrix = invert4(inv2);
				}

				applyViewMatrixToCamera();

				const currentFps = lastFrame ? 1000 / (now - lastFrame) : 0;
				avgFps = avgFps * 0.9 + currentFps * 0.1;

				if (fpsEl) fpsEl.innerText = `${Math.round(avgFps)} fps`;
				lastFrame = now;
				scheduleFrame((t) => frame(t, fpsEl));
			}

			function connectImu(wsUrl) {
				if (!wsUrl || imuSocket) return;
				console.log("Attempting to connect to the configured IMU WebSocket");
				try {
					imuSocket = new WebSocket(wsUrl);
				} catch (_) {
					imuSocket = null;
				}
				if (imuSocket) {
					imuSocket.onopen = () => console.log("Connected to the IMU WebSocket");
					imuSocket.onerror = () => {};
					imuSocket.onmessage = message_handle_default;
				}
			}

			function buildFeatureList() {
				// An explicit `features` array always wins, in either mode.
				if (Array.isArray(runtimeOptions.features)) return runtimeOptions.features;
				// With `fullScreen: false` the defaults collapse to nothing: no
				// orbit path, no reveal intro, and no overlays (their toggle
				// buttons are not rendered). A caller who passes `cameraPath`,
				// `overlays` or `loadingEffect` explicitly still gets them.
				const defaultsOff = mode.motion ? undefined : false;
				return defaultFeatures({
					cameraPath: runtimeOptions.cameraPath ?? defaultsOff,
					overlays: runtimeOptions.overlays ?? (mode.motion ? undefined : []),
					loadingEffect: runtimeOptions.loadingEffect ?? defaultsOff,
					revealEffect: runtimeOptions.revealEffect,
					revealDurationMs: runtimeOptions.revealDurationMs,
					revealEpsilon: runtimeOptions.revealEpsilon,
					revealPointSize: runtimeOptions.revealPointSize,
					revealExponentMin: runtimeOptions.revealExponentMin,
					revealExponentMax: runtimeOptions.revealExponentMax,
				});
			}

			async function main() {
				try {
					const sceneUrl = typeof runtimeOptions.src === "string" ? runtimeOptions.src.trim() : "";
					if (!sceneUrl) throw new Error("GaussianSplatViewer requires a non-empty src URL or path.");

					const suppliedView = resolveInitialViewMatrix(runtimeOptions.initialCameraPose);
					defaultViewMatrix = suppliedView ? [...suppliedView] : null;
					viewMatrix = suppliedView || viewMatrixFromLookAt([0, 0, 4], [0, 0, 0]);
					autoFramePending = !suppliedView;
					if (!viewMatrix) throw new Error("Unable to construct the initial camera pose.");

					const canvas = getViewerElement("canvas") || (() => {
						const c = document.createElement("canvas");
						c.id = "canvas";
						viewerRoot.appendChild(c);
						return c;
					})();

					const fpsEl = mode.fps ? getViewerElement("fps") : null;

					app = new pc.Application(canvas, {
						graphicsDeviceOptions: {
							antialias: false,
							alpha: true,
							powerPreference: "high-performance"
						}
					});

					app.setCanvasFillMode(pc.FILLMODE_NONE);
					app.setCanvasResolution(pc.RESOLUTION_AUTO);
					app.start();

					app.scene.skyboxMip = 0;
					app.scene.exposure = 1.0;
					app.scene.ambientLight = new pc.Color(0, 0, 0);

					const resize = () => app?.resizeCanvas(
						viewerRoot.clientWidth || window.innerWidth,
						viewerRoot.clientHeight || window.innerHeight
					);
					if (typeof ResizeObserver !== "undefined" && viewerRoot !== document) {
						resizeObserver = new ResizeObserver(resize);
						resizeObserver.observe(viewerRoot);
					} else {
						listen(window, "resize", resize);
					}
					resize();

					cameraEntity = new pc.Entity("Camera");
					cameraEntity.addComponent("camera", {
						clearColor: new pc.Color(0, 0, 0, 0),
						fov: 36,
						nearClip: 0.1,
						farClip: 500
					});
					app.root.addChild(cameraEntity);
					applyViewMatrixToCamera();

					// Bundler-agnostic: the host app passes the URL in (the app
					// version of this file read import.meta.env, which only
					// exists under Vite).
					const imuUrl = runtimeOptions.imuWebSocketUrl;

					registerFeatures(buildFeatureList());

					// `format` lets callers with an extensionless URL (blob:, custom
					// protocol, ...) tell the loader which parser to use.
					await loadSource(sceneUrl, runtimeOptions.format);
					if (viewerDestroyed) return;

					attachControls(canvas);
					attachViewToolbar();
					attachDragDrop();

					connectImu(imuUrl);

					scheduleFrame((t) => frame(t, fpsEl));
					runtimeOptions.onReady?.({ app, camera: cameraEntity });

					notifySceneReady();
				} catch (err) {
					console.error(err);
					setSpinnerVisible(false);
					setStatus(err instanceof Error ? err.message : String(err));
					runtimeOptions.onError?.(err);
				}
			}

function destroyViewer() {
	viewerDestroyed = true;
	try {
		teardownFeatures();
	} catch (_) { /* features already gone */ }
	listenerController?.abort();
	listenerController = null;
	// Cancel an in-flight file request when the component unmounts or src changes.
	loadController?.abort();
	loadController = null;
	if (animationFrameId) cancelAnimationFrame(animationFrameId);
	animationFrameId = 0;
	if (imuSocket) {
		imuSocket.close();
		imuSocket = null;
	}
	resizeObserver?.disconnect();
	resizeObserver = null;
	if (app) {
		app.destroy();
		app = null;
	}
}

function startViewer(options = {}) {
	destroyViewer();
	runtimeOptions = options;
	mode = resolveMode(options);
	viewerRoot = options.root || document;
	resetViewerState();
	viewerDestroyed = false;
	listenerController = new AbortController();
	const ready = main();
	return { ready, destroy: destroyViewer };
}

return startViewer(options);
}

export const startViewer = createViewer;
