// `gsplatCustomizeVS` overrides for the two-stage reveal loading effect. Two
// expanding spheres centred on the world origin, driven by one 0..1
// `splatRevealTime` uniform split at `splatRevealSplit`:
//   stage 1 - reveal each splat as a small point once the sphere reaches it
//   stage 2 - grow each point back to its trained covariance as a second,
//             faster sphere reaches it (axis-dependent rate via a Jacobi
//             eigendecomposition of the covariance).
//
// NOTE on `revealCenter`: the engine hands `modifyCovariance` the splat centre
// through `SplatCenter`, which `initCenter` fills as an `out` parameter. GLSL
// copies an `out` struct back wholesale on return, so the members `initCenter`
// does not write (`modelCenterOriginal` / `modelCenterModified`) come back
// undefined - some drivers preserve them, others return zeros, which collapses
// the reveal sphere and makes the whole scene appear at once. `modifyCenter`
// runs before that call and receives the real model-space centre, so we stash
// it there and use it as the distance source.
//
// Pass a different `{ glsl, wgsl }` pair to `createRevealLoadingEffect` to
// change the look without touching the timing / lifecycle code.

export const revealGlsl = `
uniform float splatRevealTime;
uniform float splatRevealSplit;
uniform float splatRevealInner;
uniform float splatRevealRadius;
uniform float splatRevealEpsilon;
uniform float splatRevealExponentMin;
uniform float splatRevealExponentMax;
void revealJacobi(inout mat3 a, inout mat3 eigenvectors, int p, int q) {
	float apq = a[p][q];
	if (abs(apq) < 1e-12) return;
	float tau = (a[q][q] - a[p][p]) / (2.0 * apq);
	float tangent = (tau >= 0.0 ? 1.0 : -1.0) / (abs(tau) + sqrt(1.0 + tau * tau));
	float cosine = inversesqrt(1.0 + tangent * tangent);
	float sine = tangent * cosine;
	mat3 rotation = mat3(1.0);
	rotation[p][p] = cosine;
	rotation[q][q] = cosine;
	rotation[p][q] = -sine;
	rotation[q][p] = sine;
	a = transpose(rotation) * a * rotation;
	eigenvectors = eigenvectors * rotation;
}
vec3 revealCenter = vec3(0.0);
void modifyCenter(inout vec3 center) { revealCenter = center; }
void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
	if (splatRevealTime >= 1.0) return;

	float span = max(splatRevealRadius - splatRevealInner, 1e-4);
	float band = 0.12 * span;
	float d = length(revealCenter);

	// Stage 1: an expanding sphere from the origin reveals each splat as a point.
	if (splatRevealTime < splatRevealSplit) {
		float w1 = splatRevealTime / max(splatRevealSplit, 1e-4);
		float front1 = splatRevealInner + w1 * (span + band);
		if (d > front1) {
			covA = vec3(0.0);
			covB = vec3(0.0);
			return;
		}
		float s2 = splatRevealEpsilon * splatRevealEpsilon;
		covA *= s2;
		covB *= s2;
		return;
	}

	// Stage 2: a second expanding sphere grows each point to its trained shape.
	float w2 = (splatRevealTime - splatRevealSplit) / max(1.0 - splatRevealSplit, 1e-4);
	float front2 = splatRevealInner + w2 * (span + band);
	float local = clamp((front2 - d) / (2.0 * band) + 0.5, 0.0, 1.0);

	mat3 covariance = mat3(
		vec3(covA.x, covA.y, covA.z),
		vec3(covA.y, covB.x, covB.y),
		vec3(covA.z, covB.y, covB.z)
	);
	mat3 diagonalized = covariance;
	mat3 eigenvectors = mat3(1.0);
	for (int sweep = 0; sweep < 3; ++sweep) {
		revealJacobi(diagonalized, eigenvectors, 0, 1);
		revealJacobi(diagonalized, eigenvectors, 0, 2);
		revealJacobi(diagonalized, eigenvectors, 1, 2);
	}
	vec3 scales = sqrt(max(vec3(diagonalized[0][0], diagonalized[1][1], diagonalized[2][2]), vec3(1e-16)));
	float maxScale = max(max(scales.x, scales.y), max(scales.z, 1e-8));
	vec3 ratios = scales / maxScale;
	vec3 exponents = mix(vec3(splatRevealExponentMin), vec3(splatRevealExponentMax), ratios);
	vec3 factors = vec3(splatRevealEpsilon) + (1.0 - splatRevealEpsilon) * pow(vec3(local), exponents);
	mat3 axisScale = eigenvectors * mat3(
		vec3(factors.x, 0.0, 0.0),
		vec3(0.0, factors.y, 0.0),
		vec3(0.0, 0.0, factors.z)
	) * transpose(eigenvectors);
	mat3 grown = axisScale * covariance * axisScale;
	covA = vec3(grown[0][0], grown[0][1], grown[0][2]);
	covB = vec3(grown[1][1], grown[1][2], grown[2][2]);
}
void modifyColor(vec3 center, inout vec4 color) {}
`;

export const revealWgsl = `
uniform splatRevealTime: f32;
uniform splatRevealSplit: f32;
uniform splatRevealInner: f32;
uniform splatRevealRadius: f32;
uniform splatRevealEpsilon: f32;
uniform splatRevealExponentMin: f32;
uniform splatRevealExponentMax: f32;
fn revealJacobi(a_ptr: ptr<function, mat3x3f>, eigenvectors_ptr: ptr<function, mat3x3f>, p: u32, q: u32) {
	var a = *a_ptr;
	let apq = a[p][q];
	if (abs(apq) < 1e-12) { return; }
	let tau = (a[q][q] - a[p][p]) / (2.0 * apq);
	let direction = select(-1.0, 1.0, tau >= 0.0);
	let tangent = direction / (abs(tau) + sqrt(1.0 + tau * tau));
	let cosine = inverseSqrt(1.0 + tangent * tangent);
	let sine = tangent * cosine;
	var rotation = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
	rotation[p][p] = cosine;
	rotation[q][q] = cosine;
	rotation[p][q] = -sine;
	rotation[q][p] = sine;
	*a_ptr = transpose(rotation) * a * rotation;
	*eigenvectors_ptr = *eigenvectors_ptr * rotation;
}
var<private> revealCenter: vec3f = vec3f(0.0);
fn modifyCenter(center: ptr<function, vec3f>) { revealCenter = *center; }
fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
	if (uniform.splatRevealTime >= 1.0) { return; }

	let span = max(uniform.splatRevealRadius - uniform.splatRevealInner, 1e-4);
	let band = 0.12 * span;
	let d = length(revealCenter);

	if (uniform.splatRevealTime < uniform.splatRevealSplit) {
		let w1 = uniform.splatRevealTime / max(uniform.splatRevealSplit, 1e-4);
		let front1 = uniform.splatRevealInner + w1 * (span + band);
		if (d > front1) {
			*covA = vec3f(0.0);
			*covB = vec3f(0.0);
			return;
		}
		let s2 = uniform.splatRevealEpsilon * uniform.splatRevealEpsilon;
		*covA = *covA * s2;
		*covB = *covB * s2;
		return;
	}

	let w2 = (uniform.splatRevealTime - uniform.splatRevealSplit) / max(1.0 - uniform.splatRevealSplit, 1e-4);
	let front2 = uniform.splatRevealInner + w2 * (span + band);
	let local = clamp((front2 - d) / (2.0 * band) + 0.5, 0.0, 1.0);

	let covariance = mat3x3f(
		vec3f((*covA).x, (*covA).y, (*covA).z),
		vec3f((*covA).y, (*covB).x, (*covB).y),
		vec3f((*covA).z, (*covB).y, (*covB).z)
	);
	var diagonalized = covariance;
	var eigenvectors = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
	for (var sweep: i32 = 0; sweep < 3; sweep = sweep + 1) {
		revealJacobi(&diagonalized, &eigenvectors, 0u, 1u);
		revealJacobi(&diagonalized, &eigenvectors, 0u, 2u);
		revealJacobi(&diagonalized, &eigenvectors, 1u, 2u);
	}
	let scales = sqrt(max(vec3f(diagonalized[0][0], diagonalized[1][1], diagonalized[2][2]), vec3f(1e-16)));
	let maxScale = max(max(scales.x, scales.y), max(scales.z, 1e-8));
	let ratios = scales / maxScale;
	let exponents = mix(vec3f(uniform.splatRevealExponentMin), vec3f(uniform.splatRevealExponentMax), ratios);
	let factors = vec3f(uniform.splatRevealEpsilon) + (1.0 - uniform.splatRevealEpsilon) * pow(vec3f(local), exponents);
	let axisScale = eigenvectors * mat3x3f(
		vec3f(factors.x, 0.0, 0.0),
		vec3f(0.0, factors.y, 0.0),
		vec3f(0.0, 0.0, factors.z)
	) * transpose(eigenvectors);
	let grown = axisScale * covariance * axisScale;
	*covA = vec3f(grown[0][0], grown[0][1], grown[0][2]);
	*covB = vec3f(grown[1][1], grown[1][2], grown[2][2]);
}
fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {}
`;
