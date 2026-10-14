import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseContentJson } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());
describe('authored standalone JSON number preservation', () => {
  it.each(['9007199254740993','9007199254740992','9007199254740991.1','1.0000000000000001','0.10000000000000001','1e309','1e-400','-0','-0.0'])('refuses %s rather than rounding, collapsing or losing its numeric value', (token) => {
    expect(() => parseContentJson(`{"nested":[{"number":${token}}]}`)).toThrow('cannot be preserved without rounding');
  });
  it('accepts equivalent decimal spellings and preserves numeric-looking strings unchanged', () => {
    expect(parseContentJson('{"a":0.70,"b":1e3,"c":-1.25e-2,"d":9007199254740991,"e":"9007199254740993","f":0e999999}'))
      .toEqual({ a: 0.7,b: 1000,c: -0.0125,d: 9007199254740991,e: '9007199254740993',f: 0 });
  });
  it('explicitly refuses numeric documents on a runtime without original-token support', () => {
    const native = JSON.parse;
    vi.spyOn(JSON,'parse').mockImplementation((source,reviver) => native(source,reviver ? (key,value) => reviver(key,value) : undefined));
    expect(() => parseContentJson('{"number":0.7}')).toThrow('cannot safely validate authored JSON numbers');
    expect(parseContentJson('{"number":"9007199254740993"}')).toEqual({ number: '9007199254740993' });
  });
});
