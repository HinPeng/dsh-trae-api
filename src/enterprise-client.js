// TRAE CLI enterprise backend. Credentials stay in macOS Keychain, never in .env.
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const BASE_URL = 'https://console.enterprise.trae.cn';
function failure(message, status = 502) { return Object.assign(new Error(message), { status }); }
function readAuth() {
  let raw;
  try { raw = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'trae_cli', '-a', 'auth_info', '-w'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw failure('Cannot read TRAE CLI Keychain entry. Log in with trae-cli on this Mac.', 401); }
  if (raw.startsWith('go-keyring-base64:')) raw = Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  let auth;
  try { auth = JSON.parse(raw); } catch { throw failure('Invalid TRAE CLI Keychain data', 401); }
  if (!auth.OauthToken?.Token) throw failure('TRAE CLI token missing', 401);
  // Never silently send a private-deployment credential to the public enterprise host.
  const host = auth.LoginBaseURL || auth.Host;
  if (host && new URL(host).origin !== BASE_URL) throw failure('This backend supports console.enterprise.trae.cn only', 400);
  return auth;
}
function headers(auth) {
  return { Authorization: `Cloud-IDE-JWT ${auth.OauthToken.Token}`, 'X-App-Id': '7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0', 'X-IDE-Version-Code': '20260206', 'X-IDE-Version': '99.99.99', 'X-IDE-Function': 'chat', 'Content-Type': 'application/json' };
}
async function configs(auth) {
  const r = await fetch(`${BASE_URL}/api/ide/v1/cli/get_config_list`, { method: 'POST', headers: headers(auth), body: JSON.stringify({ function: 'chat' }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!r.ok) throw failure(`Enterprise model list HTTP ${r.status}`, r.status);
  const d = await r.json();
  if (d.code || !Array.isArray(d.config_info_list)) throw failure('Enterprise model list rejected');
  return d.config_info_list.filter(c => c.config_switch && !c.display_config?.is_custom_model && !c.display_config?.is_invisible_to_user);
}
function selectModel(list, requested) {
  const name = requested === 'auto' ? (process.env.TRAE_DEFAULT_MODEL || 'glm-5.3-flash') : requested;
  const c = list.find(c => c.config_name === name || c.display_config?.display_name === name);
  if (!c?.model_detail_list?.[0]?.model_name) throw failure(`Enterprise model not available: ${name}`, 404);
  return c;
}
async function getModels() {
  return (await configs(readAuth())).map(c => ({ id: c.config_name, object: 'model', owned_by: 'trae-enterprise', display_name: c.display_config?.display_name }));
}
// Parse event frames rather than TCP chunks. Handles CRLF, UTF-8 boundaries and EOF.
async function* events(body) {
  const decoder = new TextDecoder(); let buffer = '';
  function parse(frame) {
    let event = 'message'; const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return { event, data: data.join('\n') };
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (frame.trim()) yield parse(frame); }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield parse(buffer);
}
async function* validatedEvents(body) {
  let text = false; let done = false;
  for await (const item of events(body)) {
    let d; try { d = JSON.parse(item.data); } catch { continue; }
    if (item.event === 'error') throw failure(`TRAE enterprise error ${d.code || ''}: ${d.message || 'request failed'}`);
    if (item.event === 'output') text ||= Boolean(d.response || d.tool_calls?.length);
    if (item.event === 'done') { if (!text) throw failure('TRAE enterprise returned no text or tools'); done = true; }
    // Only pass supported events; omit extra_info (contains duplicated reasoning).
    if (['output', 'done', 'request_wait_in_queue'].includes(item.event)) yield `event: ${item.event}\ndata: ${JSON.stringify(d)}\n\n`;
    if (done) return;
  }
  throw failure('TRAE enterprise stream ended without done');
}
async function sendChatRequest(messages, requested, stream, unusedBase, options = {}) {
  const auth = readAuth(); const c = selectModel(await configs(auth), requested); const id = randomUUID();
  const body = { model_name: c.model_detail_list[0].model_name, config_name: c.config_name, user_input: '', conversation_id: id, session_id: id, messages: messages.map(m => ({ ...m, content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content })), stream: true };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  const r = await fetch(`${BASE_URL}/api/ide/v2/llm_raw_chat`, { method: 'POST', headers: headers(auth), body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.TRAE_REQUEST_TIMEOUT_MS || 600000)), redirect: 'error' });
  if (!r.ok) throw failure(`TRAE enterprise HTTP ${r.status}`, r.status);
  const iterator = validatedEvents(r.body); const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); } catch (e) { controller.error(e); } },
    async cancel() { await iterator.return(); }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  return { response, model: c.config_name, endpoint: '/api/ide/v2/llm_raw_chat' };
}
module.exports = { BASE_URL, readAuth, getModels, selectModel, events, validatedEvents, sendChatRequest };
