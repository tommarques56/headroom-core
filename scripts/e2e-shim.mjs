#!/usr/bin/env node
// E2E provider shim: Anthropic /v1/messages <-> OpenAI /chat/completions <-> Scaleway.
// Also answers OpenAI /v1/chat/completions POSTs (OpenCode, Codex with a
// compatible wire format) and /v1/models GETs, plus non-streaming responses
// only -- streaming SSE bodies are consumed and answered non-streamed.
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
  if (Array.isArray(blocks)) return blocks.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
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

function toOpenAI(body) {
  // Accepts either Anthropic /v1/messages (body.messages) or OpenAI
  // /chat/completions (body.model + body.messages). Always routes to MODEL.
  return {
    model: MODEL,
    messages: toMessages(body),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 256,
    temperature: body.temperature ?? undefined,
    stream: false,
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

    const isAnthropic = /\/messages$/.test(req.url ?? '');
    try {
      const upstreamResp = await upstream(openaiBody);
      const json = await upstreamResp.json();
      const logLine = `[shim] ${upstreamResp.status} anthropic=${isAnthropic} model=${openaiBody.model}`;
      console.log(logLine);
      if (!upstreamResp.ok) {
        writeJson(res, upstreamResp.status, json);
        return;
      }
      writeJson(res, 200, isAnthropic ? toAnthropic(json) : toChat(json));
    } catch (e) {
      console.error('[shim] upstream error', e);
      writeJson(res, 502, { error: String(e) });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[shim] listening :${PORT}`));
