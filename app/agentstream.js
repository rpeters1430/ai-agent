#!/usr/bin/env node
'use strict';
// Runs coding agents in JSON stream mode, prints a readable transcript, records token/tool metrics,
// and stops the agent when it loops (the same tool call with the same result over and over,
// or repeated consecutive tool errors, or exceeding an optional --max-tools cap).
//
//   node agentstream.js --agent opencode|pi|claude|codex|gemini|qwen|dsh [--loop 4] [--max-tools 0] [--summary file.json] -- <command...>
//
// Exit code: the agent's own, or 86 when the loop guard stopped it.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const LOOP_EXIT = 86;
const SUPPORTED_AGENTS = ['opencode', 'pi', 'claude', 'codex', 'gemini', 'qwen', 'dsh'];

function parseArgs(argv) {
  const o = { agent: '', loop: 4, maxTools: 0, summary: '', cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.cmd = argv.slice(i + 1); break; }
    if (a === '--agent') o.agent = argv[++i];
    else if (a === '--loop') o.loop = Number(argv[++i]) || 0;
    else if (a === '--max-tools') o.maxTools = Number(argv[++i]) || 0;
    else if (a === '--summary') o.summary = argv[++i];
  }
  return o;
}

const brief = (args) => {
  const a = args || {};
  const v = a.filePath || a.path || a.file_path || a.pattern || a.command || a.cmd || a.url || a.query || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 120);
};
const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim()) || '';
const resultText = (r) => {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r.content)) return r.content.map((c) => c.text || '').join('\n');
  return JSON.stringify(r);
};
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Turns one agent's JSON events into { tool calls, text, tokens } and watches for repeats.
function createTracker(agent, limit, print, opts = {}) {
  const maxTools = Number(opts.maxTools) || 0;
  const st = {
    tools: 0,
    calls: [],
    repeats: {},
    loop: null,
    lastText: '',
    maxPromptTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    errors: [],
  };
  const pending = new Map(); // toolCallId -> { name, args }
  const counts = new Map();
  let consecutiveErrors = 0;

  function addUsage(inp, out) {
    const i = Number(inp) || 0;
    const o = Number(out) || 0;
    if (i > 0) {
      st.maxPromptTokens = Math.max(st.maxPromptTokens, i);
      st.totalInputTokens += i;
    }
    if (o > 0) st.totalOutputTokens += o;
  }

  function call(name, args, result, isError) {
    st.tools++;
    const label = `${name}${brief(args) ? ' ' + brief(args) : ''}`;
    st.calls.push(label);
    print(`▸ ${label}`);
    if (isError) {
      consecutiveErrors++;
      print(`  ✗ ${firstLine(resultText(result)).slice(0, 200)}`);
    } else {
      consecutiveErrors = 0;
    }
    // Same call AND same result = no progress. (Re-running tests after an edit gives a different result, so it's fine.)
    const key = hash(`${name}\0${JSON.stringify(args ?? {})}\0${resultText(result)}`);
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n >= 2) st.repeats[label] = n;
    if (limit && n >= limit && !st.loop) st.loop = { call: label, times: n, kind: 'repeat' };
    else if (limit && consecutiveErrors >= Math.max(limit * 2, 6) && !st.loop) {
      st.loop = { call: `${label} (consecutive errors)`, times: consecutiveErrors, kind: 'error_loop' };
    } else if (maxTools && st.tools >= maxTools && !st.loop) {
      st.loop = { call: `exceeded ${maxTools} tool calls (last: ${label})`, times: st.tools, kind: 'max_tools' };
    }
  }
  function text(t) {
    if (!t || !t.trim()) return;
    st.lastText = t.trim();
    print(t.trim());
  }

  function onEvent(e) {
    if (agent === 'opencode') {
      if (e.type === 'tool_use' && e.part) {
        const s = e.part.state || {};
        call(e.part.tool, s.input, s.status === 'error' ? s.error : s.output, s.status === 'error');
      } else if (e.type === 'text' && e.part?.text) text(e.part.text);
      else if (e.type === 'step_finish' && e.part?.tokens) {
        const t = e.part.tokens;
        addUsage((t.input || 0) + (t.cache?.read || 0), t.output || 0);
      } else if (e.type === 'error') {
        const m = e.error?.data?.message || e.error?.message || JSON.stringify(e.error || e);
        st.errors.push(m); print(`✗ ${m}`);
      }
    } else if (agent === 'pi') {
      if (e.type === 'tool_execution_start') pending.set(e.toolCallId, { name: e.toolName, args: e.args });
      else if (e.type === 'tool_execution_end') {
        const p = pending.get(e.toolCallId) || { name: e.toolName, args: {} };
        pending.delete(e.toolCallId);
        call(p.name, p.args, e.result, e.isError);
      } else if (e.type === 'message_end' && e.message?.role === 'assistant') {
        const u = e.message.usage;
        if (u) addUsage((u.input || 0) + (u.cacheRead || 0), u.output || 0);
        for (const b of e.message.content || []) if (b.type === 'text') text(b.text);
        if (e.message.stopReason === 'error' && e.message.errorMessage) { st.errors.push(e.message.errorMessage); print(`✗ ${e.message.errorMessage}`); }
      }
    } else if (agent === 'claude' || agent === 'qwen') {
      if (e.type === 'assistant' && e.message) {
        const u = e.message.usage;
        if (u) addUsage((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.output_tokens || 0);
        for (const b of e.message.content || []) {
          if (b.type === 'tool_use') pending.set(b.id, { name: b.name, args: b.input || {} });
          else if (b.type === 'text') text(b.text);
        }
      } else if (e.type === 'user' && e.message) {
        for (const b of e.message.content || []) {
          if (b.type === 'tool_result') {
            const p = pending.get(b.tool_use_id) || { name: 'tool', args: {} };
            pending.delete(b.tool_use_id);
            call(p.name, p.args, b.content, !!b.is_error);
          }
        }
      } else if (e.type === 'result') {
        if (e.usage) addUsage((e.usage.input_tokens || 0) + (e.usage.cache_read_input_tokens || 0), e.usage.output_tokens || 0);
        if (e.is_error && e.result) { st.errors.push(String(e.result)); print(`✗ ${e.result}`); }
        else if (e.result && !st.lastText) text(String(e.result));
      } else if (e.type === 'error') {
        const m = e.error?.message || e.message || JSON.stringify(e.error || e);
        st.errors.push(m); print(`✗ ${m}`);
      }
    } else if (agent === 'codex') {
      if (e.type === 'item.completed' && e.item) {
        const it = e.item;
        if (it.type === 'command_execution') {
          call('bash', { command: it.command }, it.aggregated_output ?? it.output ?? '', Number(it.exit_code || 0) !== 0);
        } else if (it.type === 'file_change') {
          const paths = (it.changes || []).map((c) => c.path).join(', ');
          call('file_change', { path: paths }, it.status || 'ok', it.status === 'failed');
        } else if (it.type === 'mcp_tool_call') {
          call(it.tool || 'mcp', it.arguments || {}, it.result ?? it.error ?? '', !!it.error);
        } else if (it.type === 'agent_message' && it.text) {
          text(it.text);
        }
      } else if (e.type === 'turn.completed' && e.usage) {
        addUsage((e.usage.input_tokens || 0) + (e.usage.cached_input_tokens || 0), e.usage.output_tokens || 0);
      } else if (e.type === 'error' || e.type === 'turn.failed') {
        const m = e.error?.message || e.message || JSON.stringify(e.error || e);
        if (!/^Reconnecting\.\.\./i.test(m)) st.errors.push(m);
        print(`✗ ${m}`);
      }
    } else if (agent === 'gemini') {
      if (e.type === 'tool_use') {
        pending.set(e.tool_id || e.id || e.tool_name, { name: e.tool_name || e.name || 'tool', args: e.parameters || e.args || {} });
      } else if (e.type === 'tool_result') {
        const id = e.tool_id || e.id || e.tool_name;
        const p = pending.get(id) || { name: e.tool_name || 'tool', args: {} };
        pending.delete(id);
        const isErr = e.status === 'error' || !!e.error;
        call(p.name, p.args, isErr ? (e.error || e.output) : e.output, isErr);
      } else if (e.type === 'message' && e.role === 'assistant' && e.content) {
        text(e.content);
      } else if (e.type === 'result' && e.stats) {
        addUsage(e.stats.input_tokens || e.stats.total_tokens || 0, e.stats.output_tokens || 0);
      } else if (e.type === 'error') {
        const m = e.message || e.error?.message || JSON.stringify(e);
        st.errors.push(m); print(`✗ ${m}`);
      }
    } else if (agent === 'dsh') {
      if (e.type === 'tool_call') {
        pending.set(e.callId || e.id || e.tool, { name: e.tool || 'tool', args: e.input || {} });
      } else if (e.type === 'tool_result') {
        const id = e.callId || e.id || e.tool;
        const p = pending.get(id) || { name: e.tool || 'tool', args: {} };
        pending.delete(id);
        const isErr = e.status === 'error' || !!e.error;
        call(p.name, p.args, isErr ? (e.error || e.result) : e.result, isErr);
      } else if (e.type === 'text' && e.text) {
        text(e.text);
      } else if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
        const u = e.usage;
        addUsage((u.inputTokens || 0) + (u.cacheReadTokens || 0), u.outputTokens || 0);
      } else if (e.type === 'final' && e.text && !st.lastText) {
        text(e.text);
      } else if (e.type === 'error') {
        const m = e.message || e.error?.message || JSON.stringify(e);
        st.errors.push(m); print(`✗ ${m}`);
      }
    }
  }
  return { st, onEvent };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.cmd.length || !SUPPORTED_AGENTS.includes(o.agent)) {
    console.error(`usage: agentstream.js --agent ${SUPPORTED_AGENTS.join('|')} [--loop N] [--max-tools N] [--summary file] -- command...`);
    process.exit(2);
  }
  const print = (s) => process.stdout.write(s + '\n');
  const { st, onEvent } = createTracker(o.agent, o.loop, print, { maxTools: o.maxTools });
  const started = Date.now();
  // stdin must not be a TTY/pipe we hold open: `opencode run --format json` waits on it otherwise.
  const child = spawn(o.cmd[0], o.cmd.slice(1), { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  const killAll = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
    killAll(sig);
    setTimeout(() => killAll('SIGKILL'), 2000).unref();
    setTimeout(() => process.exit(130), 3000).unref();
  });

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { print(line); continue; }
      try { onEvent(e); } catch {}
      if (st.loop && !st.stopping) {
        st.stopping = true;
        print(`\n⛔ Loop guard: "${st.loop.call}" ran ${st.loop.times} times with the same result. Stopping the agent.`);
        killAll('SIGTERM');
        setTimeout(() => killAll('SIGKILL'), 5000).unref();
      }
    }
  });
  child.on('error', (err) => { print(`✗ could not start ${o.cmd[0]}: ${err.message}`); finish(127); });
  child.on('close', (code, signal) => finish(st.loop ? LOOP_EXIT : code ?? (signal ? 128 : 1)));

  let done = false;
  function finish(code) {
    if (done) return; done = true;
    if (o.summary) {
      try { fs.writeFileSync(o.summary, JSON.stringify({ ...st, stopping: undefined, exit: code, secs: Math.round((Date.now() - started) / 1000) }, null, 2)); } catch {}
    }
    process.exit(code);
  }
}

if (require.main === module) main();
module.exports = { createTracker, LOOP_EXIT, SUPPORTED_AGENTS };
