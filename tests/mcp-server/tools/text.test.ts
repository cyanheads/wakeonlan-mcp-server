/**
 * @fileoverview The alias renderer the tools' `content[]` headings share: every
 * alias `ALIAS_PATTERN` accepts renders as a code span that a CommonMark parse
 * reads back exactly, with no backslash in the raw text, so a model can copy it
 * into `alias` as shown.
 * @module tests/mcp-server/tools/text.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { aliasSpan } from '@/mcp-server/tools/text.js';
import { ALIAS_PATTERN } from '@/services/hosts/hosts-config.js';
import { parseMarkdown } from '../../helpers/fixtures.js';

describe('aliasSpan', () => {
  // Aliases whose plain rendering a CommonMark parse would change: emphasis and strong
  // runs of `_`, an ordered-list marker, a run of `-`, and the 64-character maximum.
  it.each([
    ['nas._x_', '`nas._x_`'],
    ['a.-_b_.c', '`a.-_b_.c`'],
    ['gpu__box__', '`gpu__box__`'],
    ['x_', '`x_`'],
    ['1.', '`1.`'],
    ['a---b', '`a---b`'],
    ['gpu-box', '`gpu-box`'],
    ['A'.repeat(64), `\`${'A'.repeat(64)}\``],
  ])('renders %s as %s, which reads back exactly in a heading', (alias, span) => {
    expect(ALIAS_PATTERN.test(alias)).toBe(true);
    expect(aliasSpan(alias)).toBe(span);
    expect(parseMarkdown(`## ${aliasSpan(alias)}`).headings).toEqual([alias]);
    expect(parseMarkdown(`## ${aliasSpan(alias)}: awake`).headings).toEqual([`${alias}: awake`]);
  });

  it('renders every alias ALIAS_PATTERN accepts as one backtick span, no backslash, read back exactly', () => {
    fc.assert(
      fc.property(fc.stringMatching(ALIAS_PATTERN), (alias) => {
        const span = aliasSpan(alias);
        expect(span).toBe(`\`${alias}\``);
        expect(span).not.toContain('\\');
        expect(parseMarkdown(`## ${span}: open`).headings).toEqual([`${alias}: open`]);
      }),
      { numRuns: 500 },
    );
  });
});
