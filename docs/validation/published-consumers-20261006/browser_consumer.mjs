import {createChatClient,CHAT_CLIENT_PACKAGE_VERSION} from '@handrail/chat/client';
async function main() {
try {
 const {api:base,cors}=Object.fromEntries(new URL(location.href).searchParams);
 const results=[];
 for(const mode of ['seconds','date','invalid','cancel','real']){
  if(cors==='hidden' && ['cancel','real'].includes(mode))continue;
  let time=Date.parse('Tue, 06 Oct 2026 19:00:00 GMT'),start;
  const waits=[],responses=[],started=new Promise(r=>{start=r}),cancel=new AbortController();
  const client=createChatClient({endpoint:`${base}/api/js/${cors}/${mode}`,getAccessToken:()=> 'synthetic-loopback-token',
   fetch:async (...args)=>{const response=await fetch(...args);responses.push({status:response.status,headers:{'retry-after':response.headers.get('retry-after')}});return response;},
   commands:{generateIdempotencyKey:()=>`synthetic-js-${cors}-${mode}`,retry: mode==='real'?{}:{now:()=>time,wait:async delay=>{waits.push(delay);if(mode==='cancel'){start();await new Promise(()=>{});}time+=delay;}}}});
  const then=performance.now();
  const future=client.dispatch({name:'fixture.command',method:'POST',path:'/commands',retry:'safe',validateInput:x=>x,parseResult:x=>x},{synthetic:true},{signal:cancel.signal});
  if(mode==='cancel'){await started;cancel.abort();}
  const result=await future;
  results.push({mode,status:result.status,waits,responses,elapsedMs:performance.now()-then,version:CHAT_CLIENT_PACKAGE_VERSION});
  client.close();
 }
 document.querySelector('#result').textContent=JSON.stringify({sdk:'js',cors,results});
}catch(e){document.querySelector('#result').textContent=JSON.stringify({error:String(e),stack:e.stack});}

}
main();
