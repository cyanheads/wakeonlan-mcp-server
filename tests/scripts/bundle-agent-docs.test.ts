/**
 * @fileoverview The `.mcpb` cleaner and the packaging check select the same
 * agent-doc entries: package-root agent trees are stripped, while runtime
 * modules under a nested `skills/` directory (the MCP SDK's `dist/ext/skills/`)
 * and the server's own root `skills/` survive.
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL so `tsc` never follows the script's repo-only
 * `import('../src/mcp-server/skills.js')` fallback (cyanheads/mcp-ts-core#797).
 */
const lintPackaging: {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], label: string) => string[];
} = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

describe('bundle agent-doc selection', () => {
  it('uses the same selector in the cleaner and the packaging check', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
  });

  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@scope/parent/node_modules/child/dist/skills/index.js',
    'node_modules/child/dist/framework-skills/index.js',
    'node_modules/@scope/skills/index.js',
    'skills/wakeonlan-guide/SKILL.md',
    'dist/index.js',
  ])('keeps %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintPackaging.checkBundleEntries([entry], 'test.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/child/skills/guide/SKILL.md',
    'node_modules/child/skills/guide/reference.md',
    'node_modules/@scope/child/skills/guide/reference.md',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/parent/node_modules/child/framework-skills/guide/SKILL.md',
    'node_modules/@scope/parent/node_modules/@scope/child/.claude/settings.json',
    'node_modules/thread-stream/.claude/settings.json',
    'node_modules/child/.agents/skills/guide.md',
    'node_modules/child/SKILL.md',
    'node_modules/child/docs/SKILL.md',
  ])('strips %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    const errors = lintPackaging.checkBundleEntries([entry], 'test.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(entry);
  });
});
