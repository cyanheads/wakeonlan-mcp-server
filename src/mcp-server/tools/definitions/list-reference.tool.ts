/**
 * @fileoverview wol_list_reference — static Wake-on-LAN reference notes by
 * topic. No network access; the routing target for every recovery hint.
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { REFERENCE, REFERENCE_TOPICS } from '../reference-topics.js';

export const wolListReference = tool('wol_list_reference', {
  title: 'Wake-on-LAN Reference',
  description:
    "Get Wake-on-LAN reference notes by topic: packet-format, prerequisites (firmware, Windows, Linux, and macOS settings a target needs), sleep-states (which power states can wake), troubleshooting (an ordered checklist for a wake that didn't work), host-profiles (the hosts file format), and sender-environment (macOS Local Network permission, WSL2, VPNs, containers). Static text; no network access.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: z.enum(REFERENCE_TOPICS).describe('Reference topic to read.'),
  }),
  output: z.object({
    topic: z.enum(REFERENCE_TOPICS).describe('The topic returned.'),
    title: z.string().describe('Topic title.'),
    content: z.string().describe('The reference notes, as markdown.'),
    topics: z
      .array(z.enum(REFERENCE_TOPICS).describe('A topic name.'))
      .describe('Every available topic, for navigation.'),
  }),

  handler(input) {
    const { title, content } = REFERENCE[input.topic];
    return { topic: input.topic, title, content, topics: [...REFERENCE_TOPICS] };
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `# ${result.title}`,
        '',
        result.content,
        '',
        '---',
        `**Topic:** ${result.topic} · **All topics:** ${result.topics.join(', ')}`,
      ].join('\n'),
    },
  ],
});
