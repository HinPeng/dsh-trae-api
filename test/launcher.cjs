const {test}=require('node:test');
const assert=require('node:assert/strict');
const {overrides}=require('../scripts/claude-trae.cjs');
test('launcher overrides settings gateway, credentials and every model alias',()=>{
 const o=overrides({API_KEY:'test-only-key'});
 assert.equal(o.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:9220');
 assert.equal(o.env.ANTHROPIC_AUTH_TOKEN,'test-only-key');
 assert.equal(o.env.ANTHROPIC_API_KEY,'');
 assert.equal(o.model,'glm-5.3-flash');
 assert.equal(o.env.CLAUDE_CODE_SUBAGENT_MODEL,'');
 assert.deepEqual(o.availableModels,MODELS.map(m=>m.id));
 for(const m of MODELS) assert.equal(o.env[`ANTHROPIC_DEFAULT_${m.tier}_MODEL`],m.id);
 assert.throws(()=>overrides({API_KEY:'none'}));
});
const {resolveModel, parseArgs, MODELS}=require('../scripts/claude-trae.cjs');
test('four explicit models; DeepSeek non-official configs are available',()=>{
 assert.equal(MODELS.length,4);
 assert.equal(resolveModel('GLM-5.3'),'glm-5.3');
 assert.equal(resolveModel('DeepSeek-V4-Flash'),'DeepSeek-V4-Flash');
 assert.equal(resolveModel('DeepSeek-V4-Pro'),'DeepSeek-V4-Pro');
 assert.throws(()=>resolveModel('DeepSeek-V3-Pro'));
});
test('model flag selects initial model but leaves all four menu options distinct',()=>{
 for(const model of MODELS){
  const p=parseArgs(['-p','OK','--model',model.id]);
  assert.deepEqual(p.args,['-p','OK']);
  const o=overrides({API_KEY:'test-only-key'},p.model);
  assert.equal(o.model,model.id);
  for(const m of MODELS) assert.equal(o.env[`ANTHROPIC_DEFAULT_${m.tier}_MODEL`],m.id);
  assert.equal(o.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,undefined);
  assert.equal(o.env.CLAUDE_CODE_DISABLE_1M_CONTEXT,'1');
 }
 assert.equal(parseArgs(['--model=GLM-5.3']).model,'glm-5.3');
 assert.throws(()=>parseArgs(['--model']));
 assert.deepEqual(parseArgs(['--','--model','literal']),{model:undefined,args:['--','--model','literal']});
});
