#!/usr/bin/env node
// E2E provider shim: Anthropic /v1/messages <-> OpenAI /chat/completions <-> Scaleway.
// Also answers OpenAI /v1/chat/completions POSTs (OpenCode), OpenAI /v1/responses
// (Codex wire_api=responses), and /v1/models GETs.
//
// Streaming: when the client sends stream:true we answer in the matching SSE
// protocol (Anthropic message events, OpenAI chat chunks, or OpenAI Responses
// events) so SDKs that require a real stream (e.g. Pi's Anthropic client) get a
// valid stop reason.
//
// Env: SCALEWAY_BASE_URL, SCALEWAY_MODEL, SCALEWAY_API_KEY, SHIM_PORT.
// The model is pinned: whatever model a harness asks for, we route to the
// pinned SCALEWAY_MODEL so a harness default (e.g. claude-opus-5-5) can't
// 404 on Scaleway.

import http from 'node:http';

const SCW = process.env.SCALEWAY_BASE_URL;
const MODEL = process.env.SCALEWAY_MODEL;
const KEY = process.env.SCALEWAY_API_KEY;
const PORT = Number(process.env.SHIM_PORT || 4010);

function text(blocks) {
  if (Array.isArray(blocks)) {
    return blocks.map((c) => {
      if (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') return c.text ?? '';
      if (c.type === 'image_url') return '[image]';
      return c.text ?? '';
    }).join('\n');
  }
  return String(blocks ?? '');
}

function toMessages(anthropic) {
  // Anthropic content blocks -> OpenAI messages.
  const out = [];
  for (const m of anthropic.messages || []) {
    const content = text(m.content);
    if (content.trim()) out.push({ role: m.role, content });
  }
  return out;
}

function inputToMessages(body) {
  // OpenAI Responses API: `input` is either a string or an array of
  // {role, content: [...]|string} items. Normalize to OpenAI chat messages.
  const input = body.input ?? [];
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  const out = [];
  for (const item of input) {
    if (typeof item === 'string') { out.push({ role: 'user', content: item }); continue; }
    if (!item || typeof item !== 'object') continue;
    const role = item.role || 'user';
    out.push({ role, content: text(item.content) || (typeof item.content === 'string' ? item.content : '') });
  }
  return out.filter((m) => m.content && String(m.content).trim());
}

function toOpenAI(body) {
  // Accepts either Anthropic /v1/messages (body.messages), OpenAI
  // /chat/completions (body.model + body.messages) or OpenAI /v1/responses
  // (body.model + body.input). Always routes to MODEL.
  // Clamp max_tokens: Pi sends 64000 by default, but Scaleway caps
  // deepseek-v4.1-flash-1017 at 32768 -> anything above is a 400.
  const MAX_TOKENS = 32768;
  const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? 256);
  const mx = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_TOKENS) : 256;
  return {
    model: MODEL,
    messages: Array.isArray(body.messages) ? toMessages(body) : inputToMessages(body),
    max_tokens: mx,
    temperature: body.temperature ?? undefined,
    stream: false, // we always collect the full upstream answer, then stream locally
  };
}

function toAnthropic(payload) {
  const u = payload.usage || {};
  const text = payload.choices?.[0]?.message?.content || '';
  const finish = payload.choices?.[0]?.finish_reason || 'stop';
  return {
    id: 'msg_' + Math.random().toString(36).slice(2),
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text }],
    stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
    },
  };
}

function toChat(payload) {
  const u = payload.usage || {};
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: payload.choices?.[0]?.message?.content || '' },
      finish_reason: payload.choices?.[0]?.finish_reason || 'stop',
    }],
    usage: {
      prompt_tokens: u.prompt_tokens || 0,
      completion_tokens: u.completion_tokens || 0,
      total_tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    },
  };
}

// OpenAI Responses API reply shape (Codex wire_api=responses).
function toResponses(payload) {
  const u = payload.usage || {};
  const text = payload.choices?.[0]?.message?.content || '';
  return {
    id: 'resp_' + Math.random().toString(36).slice(2),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: MODEL,
    output: [{
      id: 'msg_' + Math.random().toString(36).slice(2),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: {
      input_tokens: u.prompt_tokens || 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: u.completion_tokens || 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    },
  };
}

async function upstream(openaiBody) {
  const resp = await fetch(`${SCW}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(openaiBody),
  });
  return resp;
}

function writeJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function pathOnly(url) {
  // Strip query string so /v1/messages?beta=true matches the message path.
  return (url ?? '').split('?')[0];
}

function converterFor(path) {
  // Map the shim's request endpoint to the non-streamed answer.
  const p = pathOnly(path);
  if (/\/(messages|responses)$/.test(p)) {
    return /\/messages$/.test(p) ? toAnthropic : toResponses;
  }
  return toChat; // /v1/chat/completions and anything else OpenAI-shaped
}

// ---- streaming helpers -------------------------------------------------------

function sse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// Anthropic message stream (Pi, Claude Code, etc.).
function streamAnthropic(res, payload) {
  const u = payload.usage || {};
  const text = payload.choices?.[0]?.message?.content || '';
  const finish = (payload.choices?.[0]?.finish_reason || 'stop') === 'length' ? 'max_tokens' : 'end_turn';
  const msgId = 'msg_' + Math.random().toString(36).slice(2);
  sse(res, {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model: MODEL,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: u.prompt_tokens || 0, output_tokens: 0 },
    },
  });
  sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  if (text) sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  sse(res, { type: 'content_block_stop', index: 0 });
  sse(res, {
    type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null },
    usage: { output_tokens: u.completion_tokens || 0 },
  });
  sse(res, {
    type: 'message_stop',
  });
}

// OpenAI chat completion stream (OpenCode).
function streamChat(res, payload) {
  const u = payload.usage || {};
  const text = payload.choices?.[0]?.message?.content || '';
  const finish = payload.choices?.[0]?.finish_reason || 'stop';
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2);
  const chunk = (delta, fu) =>
    `event: chat.completion.chunk\ndata: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, delta, finish_reason: fu }] })}\n\n`;
  res.write(chunk({ role: 'assistant' }, null));
  if (text) res.write(chunk({ content: text }, null));
  res.write(chunk({}, finish) + `data: [DONE]\n\n`);
}

// OpenAI Responses stream (Codex wire_api=responses).
function streamResponses(res, payload) {
  const u = payload.usage || {};
  const text = payload.choices?.[0]?.message?.content || '';
  const respId = 'resp_' + Math.random().toString(36).slice(2);
  const msgId = 'msg_' + Math.random().toString(36).slice(2);
  const itemId = 'item_' + Math.random().toString(36).slice(2);
  sse(res, { type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress' } });
  sse(res, { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
  sse(res, { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  if (text) sse(res, { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text });
  sse(res, { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
  sse(res, { type: 'response.output_item.done', output_index: 0, item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
  sse(res, { type: 'response.completed', response: toResponses(payload) });
}

function streamFor(path) {
  const p = pathOnly(path);
  if (/\/responses$/.test(p)) return streamResponses;
  if (/\/messages$/.test(p)) return streamAnthropic;
  return streamChat;
}

const server = http.createServer((req, res) => {
  // GET /v1/models -> a small list containing the pinned model.
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    writeJson(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'e2e-shim' }] });
    return;
  }
  if (req.method !== 'POST') { writeJson(res, 404, { error: 'not found' }); return; }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw); } catch { writeJson(res, 400, { error: 'bad json' }); return; }

    let openaiBody;
    try { openaiBody = toOpenAI(body); } catch (e) { writeJson(res, 400, { error: String(e) }); return; }

    const path = req.url ?? '';
    const isStream = body.stream === true;
    const wantStream = isStream && !(path.endsWith('/chat/completions') && false); // keep chat stream support
    try {
      const upstreamResp = await upstream(openaiBody);
      const json = await upstreamResp.json();
      const logLine = `[shim] ${upstreamResp.status} path=${path} stream=${isStream} model=${openaiBody.model}`;
      console.log(logLine);
      if (!upstreamResp.ok) {
        writeJson(res, upstreamResp.status, json);
        return;
      }
      if (wantStream) {
        const st = streamFor(path);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        try { st(res, json); } finally { res.end(); }
        return;
      }
      writeJson(res, 200, converterFor(path)(json));
    } catch (e) {
      console.error('[shim] upstream error', e);
      writeJson(res, 502, { error: String(e) });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[shim] listening :${PORT}`));
