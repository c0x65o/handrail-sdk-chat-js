import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { build } from 'esbuild';
const bundle = await build({entryPoints:['src/contracts/thread-list.ts'],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022'});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const f = JSON.parse(readFileSync('test/fixtures/thread-list.json','utf8'));
function wire(entry) {
  const value = structuredClone(f.base);
  for (const {path, value: next} of entry.changes) {
    const parts = path.split('.'); const key = parts.pop();
    parts.reduce((o,k) => o[k],value)[key] = next;
  }
  for (const path of entry.remove) { const parts=path.split('.');const key=parts.pop();delete parts.reduce((o,k)=>o[k],value)[key]; }
  return value;
}
for (const entry of f.valid) test(`round trip: ${entry.name}`, () => {
  const value = wire(entry); const request = entry.request ?? f.request;
  assert.deepEqual(api.parseThreadListResult(value,request),value);
  assert.deepEqual(api.serializeThreadListResult(JSON.parse(JSON.stringify(value)),request),value);
});
for (const entry of f.invalid) test(`reject response: ${entry.name}`, () => assert.throws(()=>api.parseThreadListResult(wire(entry),entry.request??f.request),api.ThreadListParseError));
test('invalid parent, selector, cursor, limit and caller identity input',()=> {
  for (const input of f.invalidRequests) assert.throws(()=>api.parseThreadListRequest(input),api.ThreadListParseError);
  assert.deepEqual(api.parseThreadListRequest(f.request),{...f.request,view:'active',limit:50});
  for (const limit of [NaN, Infinity]) assert.throws(()=>api.parseThreadListRequest({...f.request,limit}));
});
test('HTTP parsing and query serialization',()=> {
  assert.deepEqual(api.parseThreadListHttpRequest('parent-1',{limit:'100',view:'all'}),{parentConversationId:'parent-1',limit:100,view:'all'});
  assert.deepEqual(api.serializeThreadListQuery(f.request),{view:'active',limit:'50'});
  for (const query of [{limit:'01'},{limit:'1.0'},{limit:['1']},{view:['all']},{tenantId:'x'}]) assert.throws(()=>api.parseThreadListHttpRequest('parent-1',query));
});
function item(id, createdAt=f.cursor.position.createdAt) {
  const i=structuredClone(f.base.items[0]);i.thread.id=id;i.thread.createdAt=createdAt;
  for (const key of ['currentMember','currentReadState','currentPreference']) i.thread[key].conversationId=id;
  i.currentThreadFollow.follow.target.id=id; return i;
}
test('deterministic creation ties, Unicode C collation, exclusive scoped cursor and continuation',()=> {
  assert.equal(api.encodeThreadListCursor(f.cursor.position),f.cursor.token);
  assert.deepEqual(api.decodeThreadListCursor(f.cursor.token,{...f.request,view:'active'}),f.cursor.position);
  const ids=['thread-a','thread-b','é','\ue000','😀'];
  const items=ids.map(id=>item(id));
  const last={...f.cursor.position,threadId:ids.at(-1)};
  const page={...f.base,items,nextCursor:api.encodeThreadListCursor(last)};
  assert.equal(api.parseThreadListResult(page,{...f.request,limit:5}).items.length,5);
  assert.throws(()=>api.parseThreadListResult({...page,items:[...items].reverse()},{...f.request,limit:5}));
  assert.throws(()=>api.parseThreadListResult({...page,items:[items[0],items[0]]},{...f.request,limit:2}));
  assert.throws(()=>api.parseThreadListResult(page,{...f.request,limit:4}));
  const next={...f.base,items:[item('thread-b')]};
  assert.equal(api.parseThreadListResult(next,{...f.request,cursor:f.cursor.token}).items[0].thread.id,'thread-b');
  assert.throws(()=>api.parseThreadListResult(f.base,{...f.request,cursor:f.cursor.token}));
  assert.throws(()=>api.parseThreadListResult({...f.base,nextCursor:f.cursor.token},f.request));
  assert.throws(()=>api.parseThreadListResult({...f.base,items:[],nextCursor:f.cursor.token},{...f.request,limit:1}));
  assert.throws(()=>api.parseThreadListResult({...f.base,nextCursor:api.encodeThreadListCursor({...f.cursor.position,threadId:'other'})},{...f.request,limit:1}));
  assert.ok(api.compareThreadListPositions({...f.cursor.position,createdAt:'2026-09-06T11:01:00.000Z'},f.cursor.position)<0);
});
test('invalid non-finite policy, UTF-8 bounds and public exports',()=> {
  for (const hideAfterMs of [NaN,Infinity,-Infinity]) assert.throws(()=>api.parseThreadListResult({...f.base,inactivityPolicy:{hideAfterMs}},f.request));
  for (const id of ['x'.repeat(255),'é'.repeat(127)+'x']) assert.equal(api.parseThreadListRequest({parentConversationId:id}).parentConversationId,id);
  assert.throws(()=>api.parseThreadListRequest({parentConversationId:'\ud800'}));
  for (const p of ['src/contracts/index.ts','src/client/index.ts','src/server/index.ts']) assert.match(readFileSync(p,'utf8'),/export \* from ".*thread-list\.js"/);
});
