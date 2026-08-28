import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { startViewer } from './viewer.js';
import './styles.css';

const viewButtons = [
  ['front', '▣', 'Front'],
  ['back', '□', 'Back'],
  ['left', '◀', 'Left'],
  ['right', '▶', 'Right'],
  ['top', '▲', 'Top'],
  ['bottom', '▼', 'Bottom'],
];

const GaussianSplatViewer = forwardRef(function GaussianSplatViewer({
  src,
  format,
  initialCameraPose,
  // `true` (default) renders the full experience. `false` renders the model
  // alone: no title, help, toolbar or fps readout, no reveal intro, no orbit
  // path, no keyboard or gamepad, no drop target - mouse/touch only. Use
  // `onReady` / `onError` to drive your own loading and error UI.
  fullScreen = true,
  title = '3D Gaussian Splat Viewer',
  showHelp = true,
  showTitle = true,
  className = '',
  style,
  imuWebSocketUrl,
  revealEffect,
  revealDurationMs,
  revealEpsilon,
  revealPointSize,
  revealExponentMin,
  revealExponentMax,
  features,
  cameraPath,
  overlays,
  loadingEffect,
  onReady,
  onError,
}, forwardedRef) {
  const rootRef = useRef(null);
  const controllerRef = useRef(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useImperativeHandle(forwardedRef, () => ({
    get ready() {
      return controllerRef.current?.ready;
    },
    destroy() {
      controllerRef.current?.destroy();
    },
  }), []);

  useEffect(() => {
    const controller = startViewer({
      root: rootRef.current,
      src,
      format,
      initialCameraPose,
      fullScreen,
      imuWebSocketUrl,
      revealEffect,
      revealDurationMs,
      revealEpsilon,
      revealPointSize,
  revealPointSize,
      revealExponentMin,
      revealExponentMax,
      // Feature plug-ins (see src/features/feature-api.js). Pass stable
      // references - like `initialCameraPose`, a new value re-initialises the
      // viewer. `features` fully replaces the default set; the others override
      // one slot each.
      features,
      cameraPath,
      overlays,
      loadingEffect,
      onReady: (value) => onReadyRef.current?.(value),
      onError: (error) => onErrorRef.current?.(error),
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [
    src, format, initialCameraPose, imuWebSocketUrl, fullScreen,
    revealEffect, revealDurationMs, revealEpsilon, revealPointSize, revealExponentMin, revealExponentMax,
    features, cameraPath, overlays, loadingEffect,
  ]);

  if (!fullScreen) {
    // Model only. No tabIndex either - nothing here takes keyboard focus.
    return (
      <main
        ref={rootRef}
        className={`viewer-shell viewer-shell-minimal ${className}`.trim()}
        style={style}
        aria-label={title}
      >
        <canvas className="viewer-canvas" data-viewer-element="canvas" />
      </main>
    );
  }

  return (
    <main
      ref={rootRef}
      className={`viewer-shell ${className}`.trim()}
      style={style}
      tabIndex={0}
      aria-label={title}
    >
      <section className="viewer-info" data-viewer-element="info">
        {showTitle && <h3>{title}</h3>}
        {showHelp && (
          <details>
            <summary>Controls</summary>
            <div className="viewer-instructions" data-viewer-element="instructions">{`mouse
- left-drag: rotate
- middle-drag or wheel: zoom
- right-drag: pan

keyboard
- arrows: move
- WASD/QE: rotate
- P: start or stop the fitted orbit

other
- use the bottom toolbar for fitted side views
- Axes toggles the global origin frame
- BBox toggles the computed bounding box
- drop a supported Gaussian scene onto the viewer`}</div>
          </details>
        )}
      </section>

      <div className="viewer-progress" data-viewer-element="progress" />
      <div className="viewer-message" data-viewer-element="message" />
      <div className="scene" data-viewer-element="spinner" aria-label="Loading scene">
        <div className="cube-wrapper">
          <div className="cube">
            <div className="cube-faces">
              {['bottom', 'top', 'left', 'right', 'back', 'front'].map((face) => (
                <div className={`cube-face ${face}`} key={face} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <canvas className="viewer-canvas" data-viewer-element="canvas" />

      <nav className="view-toolbar" data-viewer-element="view-toolbar" aria-label="Scene views">
        {viewButtons.map(([view, icon, label]) => (
          <button type="button" data-pca-view={view} title={`${label} view`} disabled key={view}>
            <span className="view-icon">{icon}</span>{label}
          </button>
        ))}
        <button type="button" data-viewer-element="reference-frame-toggle" title="Show global reference frame at world origin" aria-pressed="false" disabled>
          <span className="view-icon">⌖</span>Axes
        </button>
        <button type="button" data-viewer-element="bbox-toggle" title="Show computed bounding box" aria-pressed="false" disabled>
          <span className="view-icon">◇</span>BBox
        </button>
      </nav>

      <div className="viewer-quality" data-viewer-element="quality"><span data-viewer-element="fps" /></div>
    </main>
  );
});

export default GaussianSplatViewer;
