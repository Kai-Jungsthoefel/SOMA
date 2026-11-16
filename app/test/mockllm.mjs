// A fake model for SOMA AI tests: an OpenAI-compatible chat completions server on 127.0.0.1 that plays a script.
// Step n answers the request that already has n assistant messages, so every tool result leads to the next step.
// A step is { tool, args } (one tool call) or { text } (final answer). Every request body is kept in `requests`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export async function startMockLlm(steps) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'mock-cad' }] })); return; }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* empty */ }
      requests.push(parsed);
      const turn = (parsed.messages ?? []).filter((m) => m.role === 'assistant').length;
      const step = steps[Math.min(turn, steps.length - 1)];
      // { status, message }: the provider refuses, e.g. 401 for a wrong key
      if (step.status) {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.message ?? 'error', type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const base = { id: `mock-${turn}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-cad' };
      const send = (delta, finish = null, usage) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
      if (step.tool) {
        send({ role: 'assistant', content: `Step ${turn + 1}. ` });
        const a = JSON.stringify(step.args);
        send({ tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: step.tool, arguments: a.slice(0, 8) } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: a.slice(8) } }] });
        send({}, 'tool_calls', { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 });
      } else {
        for (const w of step.text.split(' ')) send({ content: `${w} ` });
        send({}, 'stop', { prompt_tokens: 1200, completion_tokens: 20, total_tokens: 1220 });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { port, requests, close: () => new Promise((r) => srv.close(r)) };
}

/** Points pi in SOMA's app data (`ud`) at the fake model: a provider "mock" in models.json, chosen in settings.json. */
export function useMockModel(ud, port) {
  const dir = path.join(ud, 'somaai');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
    providers: {
      mock: {
        name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'mock-key',
        models: [{ id: 'mock-cad', name: 'Mock CAD', input: ['text', 'image'], contextWindow: 200000, maxTokens: 8000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-cad', defaultThinkingLevel: 'off' }, null, 2));
}
