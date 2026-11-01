import { decomposeDisplayMatrix, needsDecomposedTransformation } from '../animation/display-transformation';
import { shortestFloat, snbtNumber, SnbtLiteral, type SnbtValue } from './snbt';

export function preserveDisplayTransformation(value: SnbtValue): SnbtValue {
  if (!Array.isArray(value) || value.length !== 16) return value;
  const m = value.every(entry => typeof entry === 'number') ? value as number[] : value.map(snbtNumber);
  if (m.some(entry => entry === undefined || !Number.isFinite(entry))
    || m[12] !== 0 || m[13] !== 0 || m[14] !== 0 || m[15] !== 1 || !needsDecomposedTransformation(m)) return value;
  return decomposeDisplayTransformation(m);
}

export function decomposeDisplayTransformation(m: number[]): SnbtValue {
  const parts = decomposeDisplayMatrix(m);
  const floatLiteral = (value: number) => new SnbtLiteral(shortestFloat(value).replace(/f?$/, 'f'));
  return { ...parts, left_rotation: parts.left_rotation.map(floatLiteral), right_rotation: parts.right_rotation.map(floatLiteral) };
}
