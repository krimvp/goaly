import { describe, it, expect } from 'vitest';
import { extractBalancedJson, extractJson } from './json-extract';

describe('extractBalancedJson', () => {
  it('extracts a bare JSON object substring', () => {
    expect(extractBalancedJson('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts the first balanced object from surrounding prose', () => {
    expect(extractBalancedJson('prefix {"x": {"y": 2}} suffix')).toBe('{"x": {"y": 2}}');
  });

  it('ignores braces inside strings', () => {
    const text = '{"detail":"contains } brace"}';
    expect(extractBalancedJson(text)).toBe(text);
  });

  it('respects escaped quotes inside strings', () => {
    const text = '{"detail":"a \\" quote and a } brace"}';
    expect(extractBalancedJson(text)).toBe(text);
  });

  it('returns undefined when no object present', () => {
    expect(extractBalancedJson('no json here')).toBeUndefined();
  });

  it('returns undefined for an unclosed object', () => {
    expect(extractBalancedJson('{"a": 1')).toBeUndefined();
  });
});

describe('extractJson', () => {
  it('extracts a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts JSON from ```json fences', () => {
    const text = '```json\n{"pass":true,"confidence":0.9}\n```';
    expect(extractJson(text)).toEqual({ pass: true, confidence: 0.9 });
  });

  it('extracts the first balanced object from surrounding log text', () => {
    const text = 'INFO starting\nresult: {"x": {"y": 2}} trailing log';
    expect(extractJson(text)).toEqual({ x: { y: 2 } });
  });

  it('ignores braces inside strings', () => {
    const text = '{"detail":"contains } brace"}';
    expect(extractJson(text)).toEqual({ detail: 'contains } brace' });
  });

  it('returns null when no object present', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractJson('{not valid}')).toBeNull();
  });
});
