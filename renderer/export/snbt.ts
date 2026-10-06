export class SnbtLiteral {
  constructor(public literal: string) {}
}

export type SnbtValue = string | number | SnbtLiteral | SnbtValue[] | { [key: string]: SnbtValue };

export function quoteSnbt(value: string, key = false): string {
  if (/^[A-Za-z0-9_.+-]+$/.test(value) && (key || (!/^[0-9.+-]/.test(value) && !/^(true|false)$/i.test(value)))) return value;
  const quoted = JSON.stringify(value);
  const single = "'" + quoted.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
  return single.length < quoted.length ? single : quoted;
}

// Use FloatTag for decimals/exponents and cached IntTag for small integers.
export function shortestFloat(value: number): string {
  value = Math.fround(value);
  if (!Number.isFinite(value)) throw new Error('유한한 float32 숫자만 내보낼 수 있습니다.');
  if (value === 0) return '0';
  if (Number.isInteger(value) && Math.abs(value) < 1000) return String(value);
  let shortest = '';
  let low = 1;
  let high = 9;
  while (low < high) {
    const precision = (low + high) >>> 1;
    if (Math.fround(Number(value.toPrecision(precision))) === value) high = precision;
    else low = precision + 1;
  }
  for (let precision = low; precision <= 9; precision++) {
    const [mantissa, exponent] = value.toExponential(precision - 1).split('e');
    if (Math.fround(Number(mantissa + 'e' + exponent)) !== value) continue;
    const exponentValue = Number(exponent);
    const digits = mantissa.replace('-', '').replace('.', '').replace(/0+$/, '');
    const point = exponentValue + 1;
    const sign = value < 0 ? '-' : '';
    const plain = sign + (point <= 0 ? '.' + '0'.repeat(-point) + digits
      : point >= digits.length ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point));
    const candidates = [plain];
    for (let split = 1; split <= digits.length; split++) {
      const exponent = point - split;
      candidates.push(sign + digits.slice(0, split) + (split < digits.length ? '.' + digits.slice(split) : '') + (exponent ? 'e' + exponent : ''));
    }
    for (const candidate of candidates) {
      // Unsuffixed integers outside int32 are rejected by the SNBT grammar.
      if (!/[.e]/.test(candidate) && (Number(candidate) < -2147483648 || Number(candidate) > 2147483647)) continue;
      if (Math.fround(Number(candidate)) === value && (!shortest || candidate.length < shortest.length)) shortest = candidate;
    }
    if (shortest) break;
  }
  return /[.e]/.test(shortest) ? shortest + 'f' : shortest;
}

export function stringifySnbt(value: SnbtValue, floatCache?: Map<number, string>): string {
  if (value instanceof SnbtLiteral) return value.literal;
  if (typeof value === 'string') return quoteSnbt(value);
  if (typeof value === 'number') {
    const number = Math.fround(value);
    const literal = floatCache?.get(number) ?? shortestFloat(number);
    // Bound memoization so unique translations don't retain hundreds of thousands of strings.
    if (floatCache && floatCache.size < 16_384) floatCache.set(number, literal);
    return literal;
  }
  if (Array.isArray(value)) return '[' + value.map(entry => stringifySnbt(entry, floatCache)).join(',') + ']';
  return '{' + Object.entries(value).map(([key, entry]) => quoteSnbt(key, true) + ':' + stringifySnbt(entry, floatCache)).join(',') + '}';
}

function numberLiteral(token: string, defaultType = 'i'): { type: string; value: number | bigint } | undefined {
  const integer = /^([+-]?)(0[xX][\da-fA-F]+(?:_[\da-fA-F]+)*|0[bB][01]+(?:_[01]+)*|(?:0|[1-9]\d*(?:_\d+)*))([su]?[bsil])?$/i.exec(token);
  if (integer) {
    const [, sign, digits, suffix = defaultType] = integer;
    const value = BigInt(digits.replace(/_/g, '')) * (sign === '-' ? -1n : 1n);
    const type = suffix.slice(-1).toLowerCase();
    const bits = { b: 8n, s: 16n, i: 32n, l: 64n }[type];
    const unsigned = suffix.length > 1 ? suffix[0].toLowerCase() === 'u' : /^0[xb]/i.test(digits);
    const min = unsigned ? 0n : -(1n << (bits - 1n));
    const max = (1n << (unsigned ? bits : bits - 1n)) - 1n;
    if ((unsigned && sign === '-') || value < min || value > max) throw new Error('NBT 정수 범위를 벗어났습니다.');
    return { type, value: BigInt.asIntN(Number(bits), value) };
  }
  if (/^[+-]?(?:(?:0|[1-9]\d*(?:_\d+)*)(?:\.\d*(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:e[+-]?\d+(?:_\d+)*)?[fd]?$/i.test(token)) {
    const type = /f$/i.test(token) ? 'f' : 'd';
    const value = Number(token.replace(/_/g, '').replace(/[fd]$/i, ''));
    if (!Number.isFinite(value) || (type === 'f' && !Number.isFinite(Math.fround(value)))) throw new Error('NBT 실수 범위를 벗어났습니다.');
    return { type, value };
  }
  return undefined;
}

export function snbtNumber(value: SnbtValue | undefined): number | undefined {
  if (typeof value === 'number') return value;
  const numeric = value instanceof SnbtLiteral ? numberLiteral(value.literal) : undefined;
  return numeric ? numeric.type === 'f' ? Math.fround(Number(numeric.value)) : Number(numeric.value) : undefined;
}

export function parseSnbt(source: string): SnbtValue {
  let cursor = 0;
  const fail = (message: string): never => { throw new Error(`${message} (${cursor + 1}번째 글자)`); };
  const whitespace = () => { while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++; };
  const take = (character: string) => { whitespace(); if (source[cursor] !== character) return false; cursor++; return true; };
  const expect = (character: string) => { if (!take(character)) fail(`${character} 필요`); };
  const readString = (): string => {
    whitespace();
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      const token = /^[A-Za-z0-9_.+-]+/.exec(source.slice(cursor))?.[0];
      if (!token) fail('문자열 필요');
      cursor += token.length;
      return token;
    }
    cursor++;
    let value = '';
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === quote) return value;
      if (character !== '\\') { value += character; continue; }
      const escape = source[cursor++];
      const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '\\': '\\', '"': '"', "'": "'" };
      if (Object.prototype.hasOwnProperty.call(escapes, escape)) { value += escapes[escape]; continue; }
      // ponytail: no Unicode name database; use code-point escapes unless named escapes become necessary.
      if (escape === 'N') fail('유니코드 이름 이스케이프 대신 \\u 또는 \\U 숫자 이스케이프를 사용해 주세요.');
      const length = { x: 2, u: 4, U: 8 }[escape];
      if (!length) fail('올바르지 않은 문자열 이스케이프');
      const hex = source.slice(cursor, cursor + length);
      if (hex.length !== length || !/^[\da-f]+$/i.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) fail('올바르지 않은 유니코드 이스케이프');
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      cursor += length;
    }
    return fail('문자열 닫는 따옴표 필요');
  };
  const readValue = (depth: number): SnbtValue => {
    if (depth > 512) fail('NBT 중첩 한도 초과');
    whitespace();
    if (take('{')) {
      const entries: Array<[string, SnbtValue]> = [];
      if (!take('}')) {
        do {
          const key = readString();
          expect(':');
          entries.push([key, readValue(depth + 1)]);
          if (take('}')) return Object.fromEntries(entries);
          expect(',');
        } while (!take('}'));
      }
      return Object.fromEntries(entries);
    }
    if (take('[')) {
      whitespace();
      const prefixMatch = /^([BIL])\s*;/.exec(source.slice(cursor));
      const prefix = prefixMatch?.[1];
      if (prefix) cursor += prefixMatch[0].length;
      const values: SnbtValue[] = [];
      if (!take(']')) {
        do {
          whitespace();
          if (prefix && (source[cursor] === '"' || source[cursor] === "'")) fail('타입 배열에는 정수만 사용할 수 있습니다.');
          const value = prefix ? new SnbtLiteral(readString()) : readValue(depth + 1);
          if (prefix) {
            const type = numberLiteral((value as SnbtLiteral).literal, prefix.toLowerCase())?.type;
            if (!type || !{ B: 'b', I: 'bsi', L: 'bsil' }[prefix].includes(type)) fail('타입 배열의 숫자 타입 불일치');
          }
          values.push(value);
          if (take(']')) break;
          expect(',');
        } while (!take(']'));
      }
      return prefix ? new SnbtLiteral('[' + prefix + ';' + values.map(value => stringifySnbt(value)).join(',') + ']') : values;
    }
    if (source[cursor] === '"' || source[cursor] === "'") return readString();
    const token = readString();
    if (take('(')) {
      const value = readValue(depth + 1);
      expect(')');
      const numeric = value instanceof SnbtLiteral ? numberLiteral(value.literal) : undefined;
      if (token === 'bool' && numeric) {
        return new SnbtLiteral(numeric.value === 0n || numeric.value === 0 ? '0b' : '1b');
      }
      if (token === 'uuid' && typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) {
        const hex = value.replace(/-/g, '');
        return new SnbtLiteral('[I;' + [0, 8, 16, 24].map(start => Number.parseInt(hex.slice(start, start + 8), 16) | 0).join(',') + ']');
      }
      return fail('올바르지 않은 SNBT 연산');
    }
    if (/^(true|false)$/i.test(token)) return new SnbtLiteral(/^true$/i.test(token) ? '1b' : '0b');
    if (numberLiteral(token)) return new SnbtLiteral(token);
    if (/^[0-9.+-]/.test(token)) fail('올바르지 않은 NBT 숫자');
    return token;
  };
  const result = readValue(0);
  whitespace();
  if (cursor !== source.length) fail('NBT 뒤의 불필요한 내용');
  return result;
}
