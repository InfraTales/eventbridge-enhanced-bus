/**
 * MODEL CODE, used by tests only. A small subset of EventBridge event pattern matching,
 * enough to run this repo's real filter patterns against sample events.
 *
 * Supported: nested objects, arrays of exact values, prefix, numeric, exists and
 * anything-but (exact values only). Wildcards are rejected, as subscriber filters
 * reject them. Anything else throws, so a test never passes on a pattern this model
 * doesn't understand.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class UnsupportedPatternError extends Error {}

function matchValue(rule: unknown, value: unknown, present: boolean): boolean {
  if (rule === null || typeof rule === 'string' || typeof rule === 'number' || typeof rule === 'boolean') {
    return present && value === rule;
  }
  if (!isObject(rule)) throw new UnsupportedPatternError(`unsupported rule ${JSON.stringify(rule)}`);
  const keys = Object.keys(rule);
  if (keys.length !== 1) throw new UnsupportedPatternError(`rule must have one operator: ${JSON.stringify(rule)}`);
  const op = keys[0] as string;
  const arg = rule[op];
  switch (op) {
    case 'prefix':
      if (typeof arg !== 'string') throw new UnsupportedPatternError('prefix takes a string');
      return present && typeof value === 'string' && value.startsWith(arg);
    case 'exists':
      if (typeof arg !== 'boolean') throw new UnsupportedPatternError('exists takes a boolean');
      return arg === present;
    case 'anything-but': {
      const values = Array.isArray(arg) ? arg : [arg];
      if (values.some((v) => isObject(v))) throw new UnsupportedPatternError('anything-but supports exact values only');
      return present && !values.includes(value);
    }
    case 'numeric': {
      if (!Array.isArray(arg) || arg.length % 2 !== 0) throw new UnsupportedPatternError('numeric takes operator/value pairs');
      if (!present || typeof value !== 'number') return false;
      for (let i = 0; i < arg.length; i += 2) {
        const cmp = arg[i] as string;
        const bound = arg[i + 1] as number;
        const ok =
          cmp === '>' ? value > bound :
          cmp === '>=' ? value >= bound :
          cmp === '<' ? value < bound :
          cmp === '<=' ? value <= bound :
          cmp === '=' ? value === bound :
          (() => { throw new UnsupportedPatternError(`numeric operator ${cmp}`); })();
        if (!ok) return false;
      }
      return true;
    }
    case 'wildcard':
      throw new UnsupportedPatternError('Filter pattern must not contain wildcard matchers (wildcard, anything-but wildcard)');
    default:
      throw new UnsupportedPatternError(`operator ${op} is not modelled`);
  }
}

function matchObject(pattern: Record<string, unknown>, event: unknown): boolean {
  for (const [key, rule] of Object.entries(pattern)) {
    const present = isObject(event) && Object.prototype.hasOwnProperty.call(event, key);
    const value = present ? event[key] : undefined;
    if (isObject(rule)) {
      if (!matchObject(rule, value)) return false;
      continue;
    }
    if (!Array.isArray(rule)) throw new UnsupportedPatternError(`pattern values must be arrays or objects at ${key}`);
    // A field that holds an array matches when any element matches.
    const candidates = Array.isArray(value) ? value : [value];
    const ok = rule.some((r) => candidates.some((c) => matchValue(r, c, present)));
    if (!ok) return false;
  }
  return true;
}

/** True when the event matches the pattern, given as the JSON string a subscriber filter holds. */
export function matchesPattern(patternJson: string, event: unknown): boolean {
  const pattern = JSON.parse(patternJson) as unknown;
  if (!isObject(pattern)) throw new UnsupportedPatternError('pattern must be a JSON object');
  return matchObject(pattern, event);
}
