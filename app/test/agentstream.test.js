'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, LOOP_EXIT } = require('../agentstream');

test('opencode tracker counts tools, tracks tokens, and triggers loop guard on identical results', () => {
  const printed = [];
  const { st, onEvent } = createTracker('opencode', 3, (l) => printed.push(l));

  onEvent({ type: 'tool_use', part: { tool: 'read', state: { input: { filePath: 'src/a.js' }, status: 'completed', output: 'const x = 1;' } } });
  onEvent({ type: 'step_finish', part: { tokens: { input: 1200, cache: { read: 800 } } } });
  assert.equal(st.tools, 1);
  assert.equal(st.maxPromptTokens, 2000);
  assert.equal(st.loop, null);

  // Repeat twice more with same args and result -> triggers at 3
  onEvent({ type: 'tool_use', part: { tool: 'read', state: { input: { filePath: 'src/a.js' }, status: 'completed', output: 'const x = 1;' } } });
  assert.equal(st.loop, null);
  onEvent({ type: 'tool_use', part: { tool: 'read', state: { input: { filePath: 'src/a.js' }, status: 'completed', output: 'const x = 1;' } } });
  assert.ok(st.loop);
  assert.equal(st.loop.times, 3);
  assert.equal(st.loop.call, 'read src/a.js');
  assert.equal(LOOP_EXIT, 86);
});

test('opencode tracker does not trigger loop guard when tool result changes', () => {
  const { st, onEvent } = createTracker('opencode', 3, () => {});
  for (let i = 0; i < 5; i++) {
    onEvent({ type: 'tool_use', part: { tool: 'bash', state: { input: { command: 'npm test' }, status: 'completed', output: `pass ${i}` } } });
  }
  assert.equal(st.tools, 5);
  assert.equal(st.loop, null);
});

test('pi tracker correlates tool_execution_start and end, captures text and errors', () => {
  const printed = [];
  const { st, onEvent } = createTracker('pi', 2, (l) => printed.push(l));

  onEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'edit', args: { path: 'index.js' } });
  onEvent({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'edit', result: { content: [{ text: 'failed: not found' }] }, isError: true });
  onEvent({ type: 'message_end', message: { role: 'assistant', usage: { input: 500, cacheRead: 100 }, content: [{ type: 'text', text: 'Retrying edit' }], stopReason: 'error', errorMessage: 'boom' } });

  assert.equal(st.tools, 1);
  assert.equal(st.maxPromptTokens, 600);
  assert.equal(st.lastText, 'Retrying edit');
  assert.deepEqual(st.errors, ['boom']);
  assert.equal(st.loop, null);

  // Same call + same error result again -> triggers loop at 2
  onEvent({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'edit', args: { path: 'index.js' } });
  onEvent({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'edit', result: { content: [{ text: 'failed: not found' }] }, isError: true });
  assert.ok(st.loop);
  assert.equal(st.loop.times, 2);
});

test('claude tracker correlates tool_use and tool_result, captures tokens and detects loops', () => {
  const { st, onEvent } = createTracker('claude', 2, () => {});
  onEvent({
    type: 'assistant',
    message: {
      usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 150 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'app.js' } }],
    },
  });
  onEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'same content', is_error: false }] },
  });
  assert.equal(st.tools, 1);
  assert.equal(st.maxPromptTokens, 1200);
  assert.equal(st.totalOutputTokens, 150);
  assert.equal(st.loop, null);

  onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'app.js' } }] } });
  onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'same content', is_error: false }] } });
  assert.ok(st.loop);
  assert.equal(st.loop.times, 2);
});

test('codex tracker counts command_execution, file_change, usage, and loops', () => {
  const { st, onEvent } = createTracker('codex', 2, () => {});
  onEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'fail', exit_code: 1 } });
  onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Investigating' } });
  onEvent({ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 80 } });
  assert.equal(st.tools, 1);
  assert.equal(st.lastText, 'Investigating');
  assert.equal(st.maxPromptTokens, 1000);
  assert.equal(st.loop, null);

  onEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'fail', exit_code: 1 } });
  assert.ok(st.loop);
  assert.equal(st.loop.times, 2);
});

test('gemini tracker parses tool_use, tool_result, message, and stats', () => {
  const { st, onEvent } = createTracker('gemini', 2, () => {});
  onEvent({ type: 'tool_use', tool_id: 'g1', tool_name: 'read_file', parameters: { path: 'README.md' } });
  onEvent({ type: 'tool_result', tool_id: 'g1', status: 'success', output: '# readme' });
  onEvent({ type: 'message', role: 'assistant', content: 'Done reading' });
  onEvent({ type: 'result', stats: { input_tokens: 400, output_tokens: 50 } });
  assert.equal(st.tools, 1);
  assert.equal(st.lastText, 'Done reading');
  assert.equal(st.maxPromptTokens, 400);
  assert.equal(st.totalOutputTokens, 50);

  onEvent({ type: 'tool_use', tool_id: 'g2', tool_name: 'read_file', parameters: { path: 'README.md' } });
  onEvent({ type: 'tool_result', tool_id: 'g2', status: 'success', output: '# readme' });
  assert.ok(st.loop);
  assert.equal(st.loop.times, 2);
});

test('qwen tracker parses tool_use, tool_result, usage, and detects loops', () => {
  const { st, onEvent } = createTracker('qwen', 2, () => {});
  onEvent({
    type: 'assistant',
    message: {
      usage: { input_tokens: 5000, cache_read_input_tokens: 1000, output_tokens: 40 },
      content: [{ type: 'tool_use', id: 'q1', name: 'read_file', input: { file_path: 'secret.txt' } }],
    },
  });
  onEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'q1', is_error: false, content: 'OK' }] },
  });
  onEvent({ type: 'result', is_error: false, result: 'OK' });
  assert.equal(st.tools, 1);
  assert.equal(st.maxPromptTokens, 6000);
  assert.equal(st.lastText, 'OK');
  assert.equal(st.loop, null);

  onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q2', name: 'read_file', input: { file_path: 'secret.txt' } }] } });
  onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q2', is_error: false, content: 'OK' }] } });
  assert.ok(st.loop);
  assert.equal(st.loop.times, 2);
});

test('dsh tracker parses tool_call, tool_result, step_end usage, final text, and detects loops', () => {
  const { st, onEvent } = createTracker('dsh', 2, () => {});
  onEvent({ type: 'tool_call', callId: 'c1', tool: 'read', input: { file_path: 'src/server.js' } });
  onEvent({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'server.listen(3000)' });
  onEvent({ type: 'status', phase: 'step_end', usage: { inputTokens: 1700, cacheReadTokens: 4100, outputTokens: 25 } });
  onEvent({ type: 'final', text: 'src/server.js' });
  assert.equal(st.tools, 1);
  assert.equal(st.maxPromptTokens, 5800);
  assert.equal(st.totalOutputTokens, 25);
  assert.equal(st.lastText, 'src/server.js');
  assert.equal(st.loop, null);

  onEvent({ type: 'tool_call', callId: 'c2', tool: 'read', input: { file_path: 'src/server.js' } });
  onEvent({ type: 'tool_result', callId: 'c2', status: 'completed', result: 'server.listen(3000)' });
  assert.ok(st.loop);
  assert.equal(st.loop.times, 2);
});

test('tracker triggers error_loop guard on consecutive errors and maxTools cap', () => {
  const { st, onEvent } = createTracker('dsh', 3, () => {});
  for (let i = 0; i < 6; i++) {
    onEvent({ type: 'tool_call', callId: `e${i}`, tool: 'edit', input: { path: `f${i}.js` } });
    onEvent({ type: 'tool_result', callId: `e${i}`, status: 'error', error: `err ${i}` });
  }
  assert.ok(st.loop);
  assert.equal(st.loop.kind, 'error_loop');

  const cap = createTracker('pi', 4, () => {}, { maxTools: 3 });
  for (let i = 0; i < 3; i++) {
    cap.onEvent({ type: 'tool_execution_start', toolCallId: `m${i}`, toolName: 'read', args: { path: `a${i}.js` } });
    cap.onEvent({ type: 'tool_execution_end', toolCallId: `m${i}`, toolName: 'read', result: `body ${i}`, isError: false });
  }
  assert.ok(cap.st.loop);
  assert.equal(cap.st.loop.kind, 'max_tools');
});
