import assert from 'node:assert/strict';
import { viewPyramidPoints, PYRAMID_EDGES, createCameraFrustums } from '../src/features/camera-frustums.js';

const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const points = viewPyramidPoints({
	fx: 100, fy: 100, cx: 50, cy: 50, R_c2w: identity, C_w: [0, 0, 0],
	w: 100, h: 100, scale: 1,
});

assert.equal(points.length, 5, 'apex plus four image corners');
assert.deepEqual(points[0], [0, 0, 0], 'apex sits at the camera centre');
assert.equal(PYRAMID_EDGES.length, 8, 'four apex spokes plus the image rectangle');
for (const [a, b] of PYRAMID_EDGES) {
	assert.ok(a >= 0 && a < 5 && b >= 0 && b < 5, 'edges index real points');
}
// With a centred principal point the four corners are symmetric about the axis.
const xs = points.slice(1).map((p) => p[0]);
assert.ok(Math.abs(xs.reduce((a, b) => a + b, 0)) < 1e-9, 'corners are symmetric in x');

const received = [];
let unsubscribeCalls = 0;
const service = {
	on(topic, handler) {
		assert.equal(topic, 'viewer.camera-poses', 'subscribes on the configured topic');
		received.push(handler);
		return () => { unsubscribeCalls += 1; };
	},
};
const lines = [];
const feature = createCameraFrustums({
	subscription: { service, topic: 'viewer.camera-poses' },
	scale: 1,
});
feature.setup({});
assert.equal(received.length, 1, 'sets up one camera subscription');

received[0]({ event: 'not_gs_cameras', data: { poses: [], intrs: [] } });
received[0]({ event: 'gs_cameras', data: { poses: null, intrs: [] } });
feature.frame(0, { drawLine: (...args) => lines.push(args) });
assert.equal(lines.length, 0, 'ignores unrelated and malformed events');

received[0]({
	event: 'gs_cameras',
	data: {
		poses: [
			[[1, 0, 0, 1], [0, 1, 0, 2], [0, 0, 1, 3], [0, 0, 0, 1]],
			[[1, 0, 0, 4], [0, 1, 0, 5], [0, 0, 1, 6], [0, 0, 0, 1]],
		],
		intrs: [
			[[100, 0, 50], [0, 100, 50], [0, 0, 1]],
			[[100, 0, 50], [0, 100, 50], [0, 0, 1]],
		],
	},
});
feature.frame(0, { drawLine: (...args) => lines.push(args) });
assert.equal(lines.length, 16, 'draws eight lines per received camera');
assert.deepEqual(lines[0][0], [1, 2, 3], 'uses each pose camera centre as the pyramid apex');

feature.teardown({});
feature.teardown({});
assert.equal(unsubscribeCalls, 1, 'unsubscribes exactly once');

// Event-bus failures are preview-only faults and never escape feature setup.
const registrationFailure = createCameraFrustums({
	subscription: {
		service: { on() { throw new Error('camera event bus unavailable'); } },
		topic: 'viewer.camera-poses',
	},
});
const warn = console.warn;
console.warn = () => {};
try {
	assert.doesNotThrow(() => registrationFailure.setup({}));
	assert.doesNotThrow(() => registrationFailure.teardown({}));
} finally {
	console.warn = warn;
}

// A failed unsubscribe is contained and cleared before it can be retried.
let throwingUnsubscribeCalls = 0;
const unsubscribeFailure = createCameraFrustums({
	subscription: {
		service: {
			on() {
				return () => {
					throwingUnsubscribeCalls += 1;
					throw new Error('camera event bus cleanup unavailable');
				};
			},
		},
		topic: 'viewer.camera-poses',
	},
});
unsubscribeFailure.setup({});
console.warn = () => {};
try {
	assert.doesNotThrow(() => unsubscribeFailure.teardown({}));
	assert.doesNotThrow(() => unsubscribeFailure.teardown({}));
} finally {
	console.warn = warn;
}
assert.equal(throwingUnsubscribeCalls, 1, 'throwing unsubscribe remains one-shot');

console.log('frustum-check: ok');
