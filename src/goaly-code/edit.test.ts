import { describe, it, expect } from 'vitest';
import { applyEdit } from './edit';

/** The heaviest table in the slice: edit_file reliability is the #1 determinant of run length (§2.6). */
describe('applyEdit', () => {
  describe('exact matching', () => {
    it('replaces a unique exact match', () => {
      const r = applyEdit('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 99;');
      expect(r).toEqual({ ok: true, content: 'const a = 99;\nconst b = 2;\n', strategy: 'exact' });
    });

    it('replaces a multi-line exact match', () => {
      const r = applyEdit('line1\nline2\nline3\n', 'line1\nline2', 'X\nY\nZ');
      expect(r.ok && r.content).toBe('X\nY\nZ\nline3\n');
    });

    it('fails closed when the exact string is not unique', () => {
      const r = applyEdit('foo\nfoo\n', 'foo', 'bar');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not unique \(2 exact matches\)/);
    });

    it('handles regex-special characters literally (no regex injection)', () => {
      const r = applyEdit('value = a.b[0];', 'a.b[0]', 'c.d[1]');
      expect(r.ok && r.content).toBe('value = c.d[1];');
    });
  });

  describe('whitespace-tolerant fallback', () => {
    it('matches when the model over-indents old_string (exact fails, trimmed lands)', () => {
      const content = 'return x;\n';
      const r = applyEdit(content, '    return x;', 'return y;');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.strategy).toBe('whitespace');
        expect(r.content).toBe('return y;\n');
      }
    });

    it('matches a multi-line block ignoring per-line whitespace', () => {
      const content = 'function f() {\n      doThing();\n      doOther();\n}\n';
      const r = applyEdit(content, 'doThing();\ndoOther();', 'doNew();');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.content).toBe('function f() {\ndoNew();\n}\n');
    });

    it('fails closed when the whitespace match is ambiguous', () => {
      // ' x' has no exact match (no space-then-x substring), but trimmed it matches two lines.
      const r = applyEdit('x\nx\n', ' x', 'b');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/whitespace/);
    });

    it('reports a clear not-found error when nothing matches', () => {
      const r = applyEdit('hello\n', 'goodbye', 'x');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not found.*write_file/s);
    });
  });

  describe('guards', () => {
    it('rejects an empty old_string', () => {
      const r = applyEdit('abc', '', 'x');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/must not be empty/);
    });

    it('rejects a no-op (old_string === new_string)', () => {
      const r = applyEdit('abc', 'abc', 'abc');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/identical/);
    });

    it('prefers exact over whitespace when both could match', () => {
      // exact "  a" is unique; whitespace would also match — exact must win (strategy: exact)
      const r = applyEdit('  a\nb\n', '  a', '  z');
      expect(r.ok && r.strategy).toBe('exact');
    });
  });

  describe('substring-vs-line uniqueness (review finding [3])', () => {
    it('replaces a line-unique old_string that is a substring of a deeper-indented line', () => {
      // "  return x;" occurs as a raw substring of "    return x;" too → naive counting = 2.
      const r = applyEdit('  return x;\n    return x;', '  return x;', '  return y;');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.strategy).toBe('exact');
        expect(r.content).toBe('  return y;\n    return x;'); // only the whole-line match changed
      }
    });

    it('still fails closed when there is no UNIQUE whole-line block (truly ambiguous)', () => {
      const r = applyEdit('foo\nfoo\n', 'foo', 'bar');
      expect(r.ok).toBe(false); // two identical whole lines → genuinely not unique
    });
  });

  describe('line-ending preservation (review finding [5])', () => {
    it('keeps CRLF endings when the whitespace branch splices new lines into a CRLF file', () => {
      const content = 'a\r\nreturn x;\r\nb\r\n'; // CRLF; line 2 has no indent
      const r = applyEdit(content, '    return x;', 'return y;'); // over-indented → whitespace branch
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.strategy).toBe('whitespace');
        expect(r.content).toContain('return y;\r\n'); // inserted line carries CRLF, not a bare LF
        expect(r.content).not.toContain('return y;\nb'); // no LF-only smear
      }
    });
  });
});
