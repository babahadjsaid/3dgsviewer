# 3dgsviewer

Embeddable 3D Gaussian Splatting viewer. PlayCanvas under the hood, a React
component on top, and a feature plug-in API for everything optional.

Reads `.ply`, `.compressed.ply`, `.sog`, `.meta.json` and `.lod-meta.json` from
any URL — `http(s):`, `blob:` or a custom protocol.

## Install

```bash
npm install 3dgsviewer playcanvas
```

`playcanvas` is a peer dependency — the viewer must share the host app's copy,
or you end up with two WebGL contexts. `react` / `react-dom` are optional peers,
needed only for the `<GaussianSplatViewer>` component.

## Use

```jsx
import { GaussianSplatViewer } from '3dgsviewer';
import '3dgsviewer/styles.css';

<GaussianSplatViewer src="/scenes/room.ply" />
```

Without React, drive the core directly. It needs a root element containing a
`[data-viewer-element="canvas"]` canvas (it appends one if there isn't):

```js
import { createViewer } from '3dgsviewer/viewer';

const viewer = createViewer({ root: document.querySelector('#stage'), src: url });
await viewer.ready;
viewer.destroy();
```

## `fullScreen`

One switch picks between the two ways to present a scene. It defaults to `true`,
so existing code keeps the complete experience.

| | `fullScreen: true` (default) | `fullScreen: false` |
|---|---|---|
| Title / help panel | yes | — |
| View toolbar, Axes + BBox toggles | yes | — |
| FPS readout | yes | — |
| Spinner, progress bar, status text | yes | — |
| Reveal intro animation | yes | — |
| Orbit camera path (**P**) | yes | — |
| Keyboard (arrows, WASD/QE, P) | yes | — |
| Gamepad | yes | — |
| Drag-and-drop a file onto the viewer | yes | — |
| Mouse: rotate / zoom / pan | yes | yes |
| Touch: one-finger rotate, two-finger pan+zoom | yes | yes |
| Auto-framing of the loaded scene | yes | yes |
| `onReady` / `onError` | yes | yes |

```jsx
<GaussianSplatViewer src={url} fullScreen={false} />
```

Minimal mode renders the model and nothing else — no chrome, no motion, no
keyboard focus. Loading and error UI is yours to draw: `onError` still fires,
and the built-in status text is suppressed rather than hidden, so nothing writes
into a DOM node you did not ask for.

Touch stays on because it is the direct-manipulation equivalent of the mouse,
not a separate control scheme. If you want it off, say so and it becomes its own
flag.

An explicit `features`, `cameraPath`, `overlays` or `loadingEffect` option
always wins over the mode's defaults — so you can run minimal chrome *with* the
orbit path if that is what you want:

```jsx
<GaussianSplatViewer src={url} fullScreen={false} cameraPath={createOrbitCameraPath()} />
```

## Options

Both the component's props and `createViewer(...)` take the same names.

| Option | Meaning |
|---|---|
| `src` | Scene URL. Required. |
| `format` | `'ply'` \| `'compressed.ply'` \| `'sog'` — for extensionless URLs (`blob:`, custom protocols). |
| `fullScreen` | See above. Default `true`. |
| `initialCameraPose` | Starting camera; skips auto-framing. |
| `root` | Core only — the element to mount into. |
| `onReady(:{app, camera})` / `onError(err)` | Lifecycle callbacks. |
| `features` | Full replacement for the default feature list. |
| `cameraPath` / `overlays` / `loadingEffect` | Override one slot; `false` disables it. |
| `revealEffect`, `revealDurationMs`, `revealEpsilon`, `revealExponentMin`, `revealExponentMax` | Reveal intro tuning. |
| `imuWebSocketUrl` | Optional WebSocket feeding live IMU camera orientation. |
| `title`, `showTitle`, `showHelp`, `className`, `style` | Component only, full mode only. |

## Features

`src/features/feature-api.js` documents the contract. A feature touches the
scene only through the `SceneApi` object — never viewer internals, never another
feature — so the orbit path, the bbox/axes overlays and the reveal intro can all
be swapped for your own:

```js
import { createViewer } from '3dgsviewer/viewer';
import { createOrbitCameraPath } from '3dgsviewer/features';

createViewer({ root, src, features: [createOrbitCameraPath({ durationMs: 20000 }), myEffect()] });
```

## Note on the published form

`src/` ships as untranspiled ESM. The `.js` core works in any bundler as-is;
`GaussianSplatViewer.jsx` is raw JSX, so a consumer either transpiles this
package or imports `3dgsviewer/viewer` and writes their own wrapper. Adding a
build step (`vite build --lib` or esbuild) would remove that caveat.
