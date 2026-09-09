const {test} = require('node:test');
const assert = require('node:assert/strict');
const {selectModel, events, validatedEvents} = require('../src/enterprise-client');
const list=[{config_name:'glm-5.3-flash',display_config:{display_name:'GLM-5.3-Flash'},model_detail_list:[{model_name:'glm-5.3-flash__dev'}]}];
test('exact model resolution, no silent fallback',()=>{
 assert.equal(selectModel(list,'glm-5.3-flash'),list[0]); assert.equal(selectModel(list,'GLM-5.3-Flash'),list[0]);
 assert.throws(()=>selectModel(list,'glm-5.3'),{status:404});
});
async function* bytes(s){for(const byte of Buffer.from(s))yield Uint8Array.of(byte)}
test('SSE parses UTF8 and CRLF across single-byte chunks',async()=>{
 const result=[];for await(const e of events(bytes('event: output\r\ndata: {"response":"你好"}\r\n\r\nevent: done\ndata: {}')))result.push(e);
 assert.deepEqual(result,[{event:'output',data:'{"response":"你好"}'},{event:'done',data:'{}'}]);
});
test('upstream errors are not empty successful messages',async()=>{
 await assert.rejects(async()=>{for await(const e of validatedEvents(bytes('event: error\ndata: {"code":3003,"message":"bad parameter"}\n\n'))){}},/3003.*bad parameter/);
 await assert.rejects(async()=>{for await(const e of validatedEvents(bytes('event: done\ndata: {}\n\n'))){}},/no text/);
 await assert.rejects(async()=>{for await(const e of validatedEvents(bytes('event: output\ndata: {"response":"partial"}\n\n'))){}},/without done/);
});
test('normal success passes output and done',async()=>{
 let out='';for await(const e of validatedEvents(bytes('event: output\ndata: {"response":"OK"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n')))out+=e;
 assert.match(out,/OK/);assert.match(out,/event: done/);
});
