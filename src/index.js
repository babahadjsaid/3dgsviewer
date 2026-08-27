export { default as GaussianSplatViewer } from './GaussianSplatViewer.jsx';
export { createViewer, startViewer } from './viewer.js';

// Feature plug-ins: swap or extend the bounding box, the "P" camera path and
// the loading effect. See src/features/feature-api.js for the contract.
export {
  resolveFeature,
  defaultFeatures,
  createOrbitCameraPath,
  createBoundingBox,
  createOriginAxes,
  pcaBoxCorners,
  aabbCorners,
  createRevealLoadingEffect,
  revealGlsl,
  revealWgsl,
} from './features/index.js';
