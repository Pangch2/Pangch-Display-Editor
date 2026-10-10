import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { shortestFloat, snbtNumber, SnbtLiteral, type SnbtValue } from './snbt';

const pairs = [[0, 1], [0, 2], [1, 2]] as const;

export function preserveDisplayTransformation(value: SnbtValue): SnbtValue {
  if (!Array.isArray(value) || value.length !== 16) return value;
  const m = value.every(entry => typeof entry === 'number') ? value as number[] : value.map(snbtNumber);
  if (m.some(entry => entry === undefined || !Number.isFinite(entry))
    || m[12] !== 0 || m[13] !== 0 || m[14] !== 0 || m[15] !== 1) return value;
  const lengths = [m[0] ** 2 + m[4] ** 2 + m[8] ** 2,
    m[1] ** 2 + m[5] ** 2 + m[9] ** 2, m[2] ** 2 + m[6] ** 2 + m[10] ** 2];
  const dots = [m[0] * m[1] + m[4] * m[5] + m[8] * m[9],
    m[0] * m[2] + m[4] * m[6] + m[8] * m[10], m[1] * m[2] + m[5] * m[6] + m[9] * m[10]];
  // 26.3 MatrixUtil: absolute 1e-6 cutoffs in Jacobi (squared off-diagonals) and QR (squared axes).
  // Ignore ordinary float32 orthogonality noise when deciding whether a matrix needs the longer form.
  if (!lengths.some(length => length < 1e-6) && !pairs.some(([p, q], index) =>
    2 * dots[index] ** 2 <= 1e-6 && Math.abs(dots[index]) > 1e-6 * Math.sqrt(lengths[p] * lengths[q]))) return value;

  return decomposeDisplayTransformation(m);
}

export function decomposeDisplayTransformation(m: number[]): SnbtValue {
  const columns = [new Vector3(m[0], m[4], m[8]), new Vector3(m[1], m[5], m[9]), new Vector3(m[2], m[6], m[10])];
  const magnitude = Math.max(...columns.flatMap(column => column.toArray().map(Math.abs)));
  const right = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  if (magnitude) for (const column of columns) column.divideScalar(magnitude);
  // One-sided Jacobi SVD, normalized and computed in double precision with a relative stopping rule.
  // Matrix4.decompose alone cannot preserve shear; the second rotation is required.
  for (let sweep = 0; sweep < 24; sweep++) {
    let changed = false;
    for (const [p, q] of pairs) {
      const alpha = columns[p].lengthSq();
      const beta = columns[q].lengthSq();
      const dot = columns[p].dot(columns[q]);
      if (Math.abs(dot) <= 1e-12 * Math.sqrt(alpha * beta)) continue;
      const zeta = (beta - alpha) / (2 * dot);
      const tangent = (zeta < 0 ? -1 : 1) / (Math.abs(zeta) + Math.hypot(1, zeta));
      const cosine = 1 / Math.hypot(1, tangent);
      const sine = cosine * tangent;
      for (const basis of [columns, right]) {
        const previous = basis[p].clone();
        basis[p].multiplyScalar(cosine).addScaledVector(basis[q], -sine);
        basis[q].multiplyScalar(cosine).addScaledVector(previous, sine);
      }
      changed = true;
    }
    if (!changed) break;
  }
  const scales = columns.map(column => column.length());
  const left = columns.map((column, index) => scales[index] ? column.clone().divideScalar(scales[index]) : new Vector3());
  const nonzero = scales.map((scale, index) => scale ? index : -1).filter(index => index !== -1);
  if (!nonzero.length) left.forEach((column, index) => column.copy(right[index]));
  else if (nonzero.length === 1) {
    const index = nonzero[0];
    const axis = left[index].toArray().map(Math.abs);
    const perpendicular = new Vector3().setComponent(axis.indexOf(Math.min(...axis)), 1);
    left[(index + 1) % 3].crossVectors(perpendicular, left[index]).normalize();
    left[(index + 2) % 3].crossVectors(left[index], left[(index + 1) % 3]).normalize();
  } else if (nonzero.length === 2) {
    const missing = scales.indexOf(0);
    left[missing].crossVectors(left[(missing + 1) % 3], left[(missing + 2) % 3]).normalize();
  } else if (left[0].dot(new Vector3().crossVectors(left[1], left[2])) < 0) {
    left[2].negate();
    scales[2] = -scales[2];
  }
  const rotation = new Matrix4().makeBasis(left[0], left[1], left[2]);
  const leftRotation = new Quaternion().setFromRotationMatrix(rotation).normalize();
  rotation.makeBasis(right[0], right[1], right[2]).transpose();
  const rightRotation = new Quaternion().setFromRotationMatrix(rotation).normalize();
  const floatLiteral = (value: number) => new SnbtLiteral(shortestFloat(value).replace(/f?$/, 'f'));
  return { translation: [m[3], m[7], m[11]], left_rotation: leftRotation.toArray().map(floatLiteral),
    scale: scales.map(scale => scale * magnitude), right_rotation: rightRotation.toArray().map(floatLiteral) };
}
