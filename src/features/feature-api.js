// Feature plug-in contract for the viewer.
//
// A "feature" is a self-contained behaviour that acts on the scene *only*
// through the `scene` object below - never on viewer internals and never on
// another feature. The bounding box, the camera path (the "P" orbit) and the
// loading effect are all features; each lives in its own module and can be
// swapped for any other object that respects this contract.
//
//   import { createViewer } from './viewer.js';
//   import { createOrbitCameraPath } from './features/camera-path-orbit.js';
//   import { createRevealLoadingEffect } from './features/loading-effect-reveal.js';
//
//   createViewer({
//     root,
//     src,
//     features: [
//       createOrbitCameraPath({ durationMs: 20000 }),
//       myCustomLoadingEffect(),          // any object matching the Feature shape
//     ],
//   });
//
// ---------------------------------------------------------------------------
//
// @typedef {(options?: object) => Feature} FeatureFactory
//
// @typedef {Object} Feature
// @property {string} id                              Unique, stable name.
// @property {'cameraPath'|string} [role]             A feature with role
//     'cameraPath' is also published as `scene.cameraPath` so other features
//     (and the "P" key) can drive it without importing it. It must then also
//     expose `start()`, `stop()`, `toggle()` and `isActive()`.
// @property {(scene: SceneApi) => void} [setup]      Once, after the PlayCanvas
//     app and camera exist. Wire DOM / listeners here via `scene.addListener`.
// @property {(scene: SceneApi) => void} [sceneReady] After the splat asset has
//     loaded and the scene framed. `scene.getSceneFit()` and
//     `scene.getOriginDistances()` are derived (the same way for every format,
//     from the loaded splat centres); they can still be null for a degenerate
//     scene, so guard for it.
// @property {(now: number, scene: SceneApi) => void} [frame]  Every animation
//     frame. `now` is a `performance.now()`-style timestamp.
// @property {(scene: SceneApi) => void} [userInteraction]  Any mouse / wheel /
//     touch / keyboard / gamepad input from the user. The camera path stops
//     itself here; the loading effect ends itself here.
// @property {(scene: SceneApi) => void} [teardown]   On viewer destroy or when
//     the feature set is replaced.
//
// ---------------------------------------------------------------------------
//
// @typedef {Object} SceneApi   The surface features are allowed to touch.
//
//   PlayCanvas
//   ----------
// @property {import('playcanvas').AppBase} app
// @property {object} graphicsDevice
// @property {() => object|null} getCameraEntity
// @property {(a: number[], b: number[], color: number[], depthTest?: boolean) => void} drawLine
//     World-space line for the current frame. `a`/`b` are [x,y,z];
//     `color` is [r,g,b,a] in 0..1.
//
//   Camera / view
//   -------------
// @property {() => number[]|null} getViewMatrix
// @property {(m: number[]) => void} setViewMatrix
// @property {() => (null | { world:number[], eye:number[], right:number[], up:number[], backward:number[] })} getCameraBasis
// @property {(eye: number[], target: number[], up: number[]) => void} setCameraPose
// @property {() => number[]} getOrbitTarget
// @property {(t: number[]) => void} setOrbitTarget
// @property {() => number} getOrbitDistance
// @property {(d: number) => void} setOrbitDistance
// @property {() => number[]|null} getDefaultViewMatrix
// @property {(m: number[]|null) => void} setDefaultViewMatrix
// @property {() => boolean} isAutoFraming
// @property {(v: boolean) => void} setAutoFraming
// @property {() => number} getCameraFov          Vertical FOV in degrees.
// @property {() => [number, number]} getViewportSize
//
//   Scene content
//   -------------
// @property {() => object|null} getSplatEntity
// @property {() => object|null} getSplatMaterial   The gsplat entity's
//     per-instance material (the viewer always uses per-instance rendering), or
//     null if it is not ready.
// @property {() => (null | { center:number[], axes:{right:number[],up:number[],backward:number[]}, halfExtents:number[], distance:number })} getSceneFit
// @property {() => (null | { minDist:number, maxDist:number })} getOriginDistances
//
//   Camera-path capability (present when a role:'cameraPath' feature is registered)
//   ----------------------
// @property {undefined | { start: (now?: number) => void, stop: () => void, toggle: () => void, isActive: () => boolean }} cameraPath
//
//   DOM / lifecycle
//   ---------------
// @property {(id: string) => Element|null} queryElement
// @property {(sel: string) => NodeListOf<Element>} queryElements
// @property {(target: EventTarget, type: string, handler: Function, opts?: object) => void} addListener
// @property {() => number} now
// @property {(text: string) => void} setStatus
// @property {(pct: number) => void} setProgress
// @property {(visible: boolean) => void} setSpinner
// @property {() => boolean} isDestroyed

/**
 * Normalise a feature list entry: a factory is called, an object is used as-is.
 * @param {Feature | FeatureFactory} entry
 * @returns {Feature}
 */
export function resolveFeature(entry) {
	const feature = typeof entry === 'function' ? entry() : entry;
	if (!feature || typeof feature !== 'object' || typeof feature.id !== 'string') {
		throw new TypeError('A viewer feature must be an object with a string `id` (or a factory returning one).');
	}
	return feature;
}
