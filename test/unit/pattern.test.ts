import { matchesPattern, UnsupportedPatternError } from '../../src/model/pattern';

const event = { source: 'com.x', detail: { total: 600, tags: ['a', 'b'], name: 'order-1' } };

test.each([
  ['exact', '{"source":["com.x"]}', true],
  ['exact miss', '{"source":["com.y"]}', false],
  ['numeric', '{"detail":{"total":[{"numeric":[">",500]}]}}', true],
  ['numeric range miss', '{"detail":{"total":[{"numeric":[">",500,"<",600]}]}}', false],
  ['prefix', '{"detail":{"name":[{"prefix":"order-"}]}}', true],
  ['exists false', '{"detail":{"missing":[{"exists":false}]}}', true],
  ['exists true miss', '{"detail":{"missing":[{"exists":true}]}}', false],
  ['anything-but', '{"source":[{"anything-but":["com.y"]}]}', true],
  ['array field', '{"detail":{"tags":["b"]}}', true],
  ['missing nested object', '{"nothing":{"here":["x"]}}', false],
])('%s', (_name, pattern, expected) => {
  expect(matchesPattern(pattern, event)).toBe(expected);
});

test('wildcards are rejected, as subscriber filters reject them', () => {
  expect(() => matchesPattern('{"source":[{"wildcard":"com.*"}]}', event)).toThrow(/wildcard/);
});

test('operators the model does not know throw instead of guessing', () => {
  expect(() => matchesPattern('{"source":[{"suffix":".x"}]}', event)).toThrow(UnsupportedPatternError);
});
