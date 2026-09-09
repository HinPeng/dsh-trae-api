const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseToolCalls } = require('../src/anthropic-format');

test('parses square-bracket tool calls emitted by the prompt', () => {
  const text = 'Checking first.\n[[TOOL_CALL]]\n{"name":"Bash","arguments":{"command":"ls"}}\n[[/TOOL_CALL]]\nThen continuing.';
  assert.deepEqual(parseToolCalls(text), [
    { type: 'text', text: 'Checking first.\n' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'text', text: '\nThen continuing.' },
  ]);
});
