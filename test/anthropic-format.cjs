const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseToolCalls, StreamingToolCallParser } = require('../src/anthropic-format');

test('parses square-bracket tool calls emitted by the prompt', () => {
  const text = 'Checking first.\n[[TOOL_CALL]]\n{"name":"Bash","arguments":{"command":"ls"}}\n[[/TOOL_CALL]]\nThen continuing.';
  assert.deepEqual(parseToolCalls(text), [
    { type: 'text', text: 'Checking first.\n' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'text', text: '\nThen continuing.' },
  ]);
});

test('normalizes nonstandard name-only tool call syntax', () => {
  const text = '[[TOOL_CALL]]{"Bash"}\n{"command":"ls","description":"List files"}[[/TOOL_CALL]]';
  assert.deepEqual(parseToolCalls(text), [
    { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } },
  ]);
});

test('normalizes tool wrapper syntax', () => {
  const text = '[[TOOL_CALL]]\n[[tool_bash]]\n{"command":"ls","description":"List files"}[[/TOOL_CALL]]';
  assert.deepEqual(parseToolCalls(text), [
    { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } },
  ]);
});


test('parses model-emitted XML-like tool calls with arg_key and arg_value', () => {
  const text = '我先找配置。\n<tool_call>Bash\n  <arg_key>command</arg_key>\n  <arg_value>ls -la ~/.cc-switch/</arg_value>\n  <arg_key>description</arg_key>\n  <arg_value>Locate cc-switch config directory</arg_value>\n</tool_call>\n然后继续。';
  assert.deepEqual(parseToolCalls(text), [
    { type: 'text', text: '我先找配置。\n' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls -la ~/.cc-switch/', description: 'Locate cc-switch config directory' } },
    { type: 'text', text: '\n然后继续。' },
  ]);
});

test('XML-like streaming tool parser handles split chunks', () => {
  const parser = new StreamingToolCallParser();
  parser.push('先执行\n<tool_ca');
  assert.deepEqual(parser.takeBlocks(), [{ type: 'text', text: '先执行\n' }]);
  parser.push('ll>Bash><arg_key>command</arg_key><arg_value>pwd</arg_value></tool_call>');
  assert.deepEqual(parser.takeBlocks(), [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }]);
  assert.deepEqual(parser.flush(), []);
});

test('XML entities in XML-like tool arguments are decoded', () => {
  const blocks = parseToolCalls('<tool_call>Bash><arg_key>command</arg_key><arg_value>echo &quot;a&amp;b&quot;</arg_value></tool_call>');
  assert.deepEqual(blocks, [{ type: 'tool_use', name: 'Bash', input: { command: 'echo "a&b"' } }]);
});
