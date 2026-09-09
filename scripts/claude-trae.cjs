#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const os = require('os');
const {spawn} = require('child_process');

const MODELS = [
  {id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', tier: 'HAIKU'},
  {id: 'glm-5.3', name: 'GLM-5.3', tier: 'SONNET'},
  {id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash 正式版', tier: 'FABLE'},
  {id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro 正式版', tier: 'OPUS'},
];
function resolveModel(name) {
  const normalized = name.toLowerCase();
  const model = MODELS.find(m => [m.id, m.name, m.id.replace(/-Official$/, '')].some(n => n.toLowerCase() === normalized));
  if (!model) throw new Error(`Unsupported model: ${name}. Use --list-models.`);
  return model.id;
}
function parseArgs(args) {
  let model; const rest = [];
  for (let i=0; i<args.length; i++) {
    if (args[i] === '--') {rest.push(...args.slice(i)); break;}
    if (args[i] === '--model') {
      if (!args[i+1] || args[i+1].startsWith('--')) throw new Error('--model requires a model name');
      model = resolveModel(args[++i]);
    } else if (args[i].startsWith('--model=')) model = resolveModel(args[i].slice(8));
    else rest.push(args[i]);
  }
  return {model, args: rest};
}
function overrides(config, selectedModel) {
  if (!config.API_KEY || config.API_KEY === 'none') throw new Error('Set a non-empty API_KEY in the proxy .env');
  const model = resolveModel(selectedModel || config.TRAE_DEFAULT_MODEL || 'glm-5.3-flash');
  return {
    model,
    availableModels: MODELS.map(m => m.id),
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.PORT || 9220}`,
      // Override BOTH settings credentials. Token avoids interactive API-key approval.
      ANTHROPIC_AUTH_TOKEN: config.API_KEY,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: '',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-5.3-flash',
      ANTHROPIC_CUSTOM_MODEL_OPTION: '',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
      // Do not let the built-in Default menu attach an unsupported [1m] suffix.
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_VERTEX: '0',
      CLAUDE_CODE_USE_FOUNDRY: '0',
      CLAUDE_CODE_USE_MANTLE: '0',
      ...Object.fromEntries(MODELS.flatMap(({tier, id, name}) => [
        [`ANTHROPIC_DEFAULT_${tier}_MODEL`, id],
        [`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`, name],
        [`ANTHROPIC_DEFAULT_${tier}_MODEL_DESCRIPTION`, 'Trae 企业模型'],
      ])),
    },
  };
}
function main() {
  if (process.argv.slice(2).includes('--list-models')) {
    for (const m of MODELS) console.log(`${m.id}\t${m.name}`);
    return;
  }
  const parsed = parseArgs(process.argv.slice(2));
  const config = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
  const settings = overrides(config, parsed.model);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trae-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings), {mode: 0o600});
  const cleanup = () => fs.rmSync(dir, {recursive:true, force:true});
  process.once('exit', cleanup);
  // --settings takes precedence over user/project/local settings, but not managed policy.
  // Pass a private filename, not credentials in process arguments.
  const separator = parsed.args.indexOf('--');
  const split = separator < 0 ? parsed.args.length : separator;
  const childArgs = [...parsed.args.slice(0, split), '--model', settings.model, '--settings', file, ...parsed.args.slice(split)];
  const child = spawn('claude', childArgs, {
    env: {...process.env, ...settings.env}, stdio:'inherit',
  });
  child.on('error', e => { console.error(e.message); cleanup(); process.exitCode=1; });
  child.on('exit', (code, signal) => { cleanup(); process.exitCode=code ?? (signal === 'SIGINT' ? 130 : 1); });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
}
if (require.main === module) main();
module.exports = {overrides, resolveModel, parseArgs, MODELS};
