/**
 * The unpacker inverts the Python packer. The fixture below is one splat
 * encoded by hand with the same constants the packer uses.
 */
import assert from 'node:assert/strict';
import { createLiveSplatStream, unpackSnapshot } from '../src/features/live-splat-stream.js';
import { defaultFeatures } from '../src/features/index.js';

const SH_C0 = 0.28209479177387814;

function fixture() {
  const buffer = new ArrayBuffer(16 + 16);
  const view = new DataView(buffer);
  view.setUint32(0, 0x53504b31, true);   // magic "SPK1"
  view.setUint32(4, 1, true);            // version
  view.setUint32(8, 7000, true);         // iteration
  view.setUint32(12, 1, true);           // numSplats

  const bytes = new Uint8Array(buffer);
  bytes[16] = 128; bytes[17] = 64; bytes[18] = 32;   // RGB
  bytes[19] = 204;                                   // A = 0.8
  // centre (1, 2, 3) as float16
  const halves = new DataView(buffer, 20, 6);
  const f16 = (x) => {
    const f = new Float32Array([x]);
    const u = new Uint32Array(f.buffer)[0];
    const sign = (u >> 16) & 0x8000;
    const exp = ((u >> 23) & 0xff) - 127 + 15;
    const man = (u >> 13) & 0x3ff;
    return sign | (exp << 10) | man;
  };
  halves.setUint16(0, f16(1), true);
  halves.setUint16(2, f16(2), true);
  halves.setUint16(4, f16(3), true);
  bytes[26] = 128; bytes[27] = 128;                  // octahedral axis (0,0)
  bytes[28] = 100; bytes[29] = 100; bytes[30] = 100; // scales
  bytes[31] = 0;                                     // angle 0 -> identity
  return bytes;
}

const out = unpackSnapshot(fixture());

assert.equal(out.numSplats, 1);
assert.equal(out.iteration, 7000);

// centre survives the float16 round trip
assert.ok(Math.abs(out.properties.x[0] - 1) < 1e-2);
assert.ok(Math.abs(out.properties.y[0] - 2) < 1e-2);
assert.ok(Math.abs(out.properties.z[0] - 3) < 1e-2);

// scale is log-space: (100 - 1) / 254 * 21 - 12
const expectedLogScale = ((100 - 1) / 254) * 21 - 12;
assert.ok(Math.abs(out.properties.scale_0[0] - expectedLogScale) < 1e-3);

// colour inverts f_dc * SH_C0 + 0.5
assert.ok(Math.abs(out.properties.f_dc_0[0] - ((128 / 255 - 0.5) / SH_C0)) < 1e-4);

// opacity is stored pre-sigmoid
const a = 204 / 255;
assert.ok(Math.abs(out.properties.opacity[0] - (-Math.log(1 / a - 1))) < 1e-4);

// angle 0 is the identity quaternion
assert.ok(Math.abs(out.properties.rot_0[0] - 1) < 1e-5);

// a foreign magic number is refused
assert.throws(() => unpackSnapshot(new Uint8Array(32)), /magic/i);

// setup/teardown must own the subscription lifecycle. Removing either the
// registration or cleanup branch makes these observable assertions fail.
let registeredTopic;
let registeredHandler;
let unsubscribeCalls = 0;
const feature = createLiveSplatStream({
  subscription: {
    service: {
      on(topic, handler) {
        registeredTopic = topic;
        registeredHandler = handler;
        return () => { unsubscribeCalls += 1; };
      },
    },
    topic: 'gs:job-7',
  },
});
feature.setup({ showSplatData() {} });
assert.equal(registeredTopic, 'gs:job-7');
assert.equal(typeof registeredHandler, 'function');
feature.teardown();
feature.teardown();
assert.equal(unsubscribeCalls, 1);

// A malformed preview is transient transport data, not a viewer-fatal error.
const warn = console.warn;
console.warn = () => {};
try {
  assert.doesNotThrow(() => registeredHandler({ data: { payload: 'not base64' } }));
} finally {
  console.warn = warn;
}

assert.doesNotThrow(() => createLiveSplatStream().setup({ showSplatData() {} }));
assert.doesNotThrow(() => createLiveSplatStream({ subscription: { topic: 'gs:job-7' } }).setup({ showSplatData() {} }));

// A transport registration failure must not abort viewer setup, and its
// teardown must remain safe when registration never produced an unsubscribe.
const registrationFailure = createLiveSplatStream({
  subscription: {
    service: { on() { throw new Error('event bus unavailable'); } },
    topic: 'gs:job-7',
  },
});
const quietWarn = console.warn;
console.warn = () => {};
try {
  assert.doesNotThrow(() => registrationFailure.setup({ showSplatData() {} }));
  assert.doesNotThrow(() => registrationFailure.teardown());
} finally {
  console.warn = quietWarn;
}

// Teardown consumes its subscription before invoking it, so a throwing
// unsubscribe cannot be retried by a later teardown.
let throwingUnsubscribeCalls = 0;
const unsubscribeFailure = createLiveSplatStream({
  subscription: {
    service: {
      on() {
        return () => {
          throwingUnsubscribeCalls += 1;
          throw new Error('event bus cleanup unavailable');
        };
      },
    },
    topic: 'gs:job-7',
  },
});
unsubscribeFailure.setup({ showSplatData() {} });
console.warn = () => {};
try {
  assert.doesNotThrow(() => unsubscribeFailure.teardown());
  assert.doesNotThrow(() => unsubscribeFailure.teardown());
} finally {
  console.warn = quietWarn;
}
assert.equal(throwingUnsubscribeCalls, 1);

const subscription = { service: { on() { return () => {}; } }, topic: 'gs:job-7' };
const featureIds = (options) => defaultFeatures(options).map((feature) => feature.id);
assert.equal(featureIds({ live: false, subscription }).includes('live-splat-stream'), false);
assert.equal(featureIds({ live: true, subscription }).includes('live-splat-stream'), true);

console.log('unpack-check: ok');
