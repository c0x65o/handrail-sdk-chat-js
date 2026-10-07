import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import * as candidateClient from '../../../dist/client/index.js';
import * as baselineClient from '../../../build/ack-review-baseline/dist/client/index.js';
import * as candidateServer from '../../../dist/server/index.js';
import * as baselineServer from '../../../build/ack-review-baseline/dist/server/index.js';
import {createPostgresTestBackend} from '../../../dist/testing/index.js';

const rows=[];
const actor={tenantId:'matrix-tenant',userId:'matrix-reader',roles:[]};
test('actual baseline/candidate public JS client x HTTP server, durable and non-durable',async()=>{
 const backend=await createPostgresTestBackend();
 try {
 for(const [serverName,S] of [['baseline',baselineServer],['candidate',candidateServer]]) {
  const h=await backend.createHarness({schemaPrefix:'ack_matrix'});
  let runtime,server;
  try {
   await S.createPostgresMigrationRunner({database:h.pool,schema:h.schema,migrations:S.handrailChatPostgresMigrations}).apply();
   runtime=S.createChatServer({database:{pool:h.pool,schema:h.schema},auth:{resolveActor:async()=>actor},directory:{getUser:async()=>undefined,searchUsers:async()=>[]},permissions:{getCapabilities:async()=>[],authorizeEntity:async()=>false}});
   await runtime.postgresMaintenance.stop();await runtime.outboxPublisher.stop();
   server=createServer(runtime.router);await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const endpoint=`http://127.0.0.1:${server.address().port}`;
   for(const [clientName,C] of [['baseline',baselineClient],['candidate',candidateClient]]) for(const durable of [false,true]) {
    const id=`${clientName}-${durable}`; const prefix=`"${h.schema}"`;
    await h.pool.query(`INSERT INTO ${prefix}.chat_conversations (tenant_id,id,type,visibility,name,current_message_sequence) VALUES ($1,$2,'channel','private',$2,10)`,[actor.tenantId,id]);
    await h.pool.query(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state) VALUES ($1,$2,$3,'member','active')`,[actor.tenantId,id,actor.userId]);
    const at='2020-01-01T00:00:00.000Z';
    const cache=C.createNormalizedChatCache({...actor,sessionId:'matrix'});
    cache.hydrateConversationList({kind:'conversation_list',scope:{type:'organization'},page:{},_meta:{packageVersion:'1.0.54',protocolVersion:4,schemaVersion:9,enabledFeatures:{},supportedProtocolRange:{minimumVersion:4,maximumVersion:4},feature:{name:'conversation_snapshots',version:1}},items:[{id,tenantId:actor.tenantId,type:'channel',visibility:'private',name:id,createdAt:at,updatedAt:at,activityAt:at,latestSequence:10,unreadMentionCount:0,activeMemberUserIds:[actor.userId],currentMember:{tenantId:actor.tenantId,conversationId:id,userId:actor.userId,role:'member',state:'active',joinedAt:at,updatedAt:at},currentReadState:{conversationId:id,userId:actor.userId,lastReadSequence:6,updatedAt:at},currentPreference:{conversationId:id,userId:actor.userId,notificationPreference:'all',mute:{muted:false},updatedAt:at}}]});
    const stored=new Map();const storage=C.createApplicationChatStorage({read:async(i,k)=>stored.get(k)??null,replace:async(i,k,v)=>{stored.set(k,v)},remove:async(i,k)=>{stored.delete(k)},clearForLogout:async()=>stored.clear()});
    let key='';const requests=[];
    const client=C.createChatClient({endpoint,getAccessToken:()=> 'matrix',cache,commands:{retry:{maxAttempts:1}},readState:{generateIdempotencyKey:()=>key},...(durable?{normalizedCachePersistence:{storage,resolveIdentity:()=>({tenantId:actor.tenantId,userId:actor.userId,deviceId:'matrix'})}}:{}),fetch:async(url,init)=>{const response=await fetch(url,init);if(init.method==='PATCH')requests.push({input:JSON.parse(init.body),httpStatus:response.status,body:await response.clone().json()});return response;}});
    try {
     const readiness=await client.start();assert.equal(readiness.state,'ready',JSON.stringify(readiness));
     const results=[];
     for(const operation of (durable?['mark_read']:['mark_read','mark_unread'])) {
      key=`${id}-${operation}`;
      for(const phase of (durable?['first']:['first','repeat'])) {
       const result=operation==='mark_read'?await client.markRead({conversationId:id,throughSequence:6}):await client.markUnread({conversationId:id,fromSequence:4});
       const expected=serverName==='baseline'?(durable?'malformed_response':'success'):(clientName==='baseline'&&!durable?'malformed_response':'success');
       assert.equal(result.status,expected,`${serverName}/${clientName}/${durable}/${operation}/${phase}: ${JSON.stringify(result)}`);
       results.push({operation,phase,status:result.status,...(result.status==='success'?{reconciliationStatus:result.value.reconciliationStatus}: {})});
      }
     }
     const counts=(await h.pool.query(`SELECT (SELECT count(*)::int FROM ${prefix}.chat_idempotency_keys WHERE response_body->>'conversationId'=$1) receipts,(SELECT count(*)::int FROM ${prefix}.chat_audit_events WHERE target_id=$1) audits`,[id])).rows[0];
     assert.deepEqual(counts,{receipts:durable?1:2,audits:durable?1:2});
     rows.push({server:serverName,client:clientName,durable,readiness:readiness.state,results,requests,counts});
    }finally{client.close()}
   }
  }finally{if(server)await new Promise(r=>server.close(r));await runtime?.close();await h.teardown()}
 }
 }finally{await backend.teardown();await writeFile(new URL('matrix.json',import.meta.url),JSON.stringify(rows,null,2)+'\n')}
});
