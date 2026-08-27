// Minimal vector helpers shared by feature modules (kept independent of the
// viewer core so features have no back-dependency on it).

export function normalize3(v) {
	const length = Math.hypot(v[0], v[1], v[2]);
	return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 1, 0];
}

export function dot3(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function add3(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a, s) {
	return [a[0] * s, a[1] * s, a[2] * s];
}

export function length3(a) {
	return Math.hypot(a[0], a[1], a[2]);
}
