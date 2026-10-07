import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const requests=[],counts=new Map(),consoleMessages=[],pageErrors=[];
const headers={seconds:'2',date:'Tue, 06 Oct 2026 19:00:05 GMT',invalid:'nonsense',cancel:'120',real:'1'};
function handler(req,res){
 if(req.url.startsWith('/api/')){
  const mode=req.url.split('/')[4],cors=req.url.split('/')[3];
  const origin=req.headers.origin;
  if(origin){assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);res.setHeader('Access-Control-Allow-Origin',origin);}
  if(req.method==='OPTIONS'){
   requests.push({path:req.url,method:'OPTIONS',origin});
   res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers']||'');res.writeHead(204);res.end();return;
  }
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
   const n=(counts.get(req.url)||0)+1;counts.set(req.url,n);
   requests.push({path:req.url,method:req.method,origin:origin??null,body,key:req.headers['idempotency-key'],time:Date.now()});
   res.setHeader('Content-Type','application/json');res.setHeader('Retry-After',headers[mode]);
   if(cors==='exposed')res.setHeader('Access-Control-Expose-Headers','Retry-After');
   res.writeHead(n===1?429:200);res.end('{}');
  });return;
 }
 if(req.url.startsWith('/bundle-')){const file=req.url.split('?')[0].slice(1);readFile(file).then(data=>{res.setHeader('Content-Type','application/javascript');res.end(data);},()=>{res.writeHead(404);res.end();});return;}
 res.setHeader('Content-Type','text/html');res.end(`<div id="result"></div><script src="/bundle-${req.url.startsWith('/flutter')?'flutter':'js'}.js"></script>`);
}
const pageServer=createServer(handler),crossServer=createServer(handler);
pageServer.listen(0,'127.0.0.1');crossServer.listen(0,'127.0.0.1');await Promise.all([once(pageServer,'listening'),once(crossServer,'listening')]);
const origin=`http://127.0.0.1:${pageServer.address().port}`,cross=`http://127.0.0.1:${crossServer.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:'/opt/handrail/.handrail/flutter-sdk/bin/cache/mock-authority-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
const results=[];
try{
 for(const sdk of ['js','flutter'])for(const cors of ['same','exposed','hidden']){
  const page=await browser.newPage();
  page.on('console',msg=>consoleMessages.push({sdk,cors,type:msg.type(),text:msg.text()}));
  page.on('pageerror',error=>pageErrors.push(String(error)));
  page.on('request',request=>assert.equal(new URL(request.url()).hostname,'127.0.0.1'));
  await page.goto(`${origin}/${sdk}?api=${encodeURIComponent(cors==='same'?origin:cross)}&cors=${cors}`);
  await page.waitForFunction(()=>document.querySelector('#result')?.textContent,{},{timeout:30000});
  const result=JSON.parse(await page.locator('#result').textContent());results.push(result);
  assert.equal(result.error,undefined,JSON.stringify(result));
  for(const row of result.results){
   assert.equal(row.version,sdk==='js'?'1.0.53':'0.1.31');
   assert.equal(row.status,row.mode==='cancel'?'aborted':'success');
   assert.equal(row.responses.length,row.mode==='cancel'?1:2);
   const visible=row.responses[0].headers['retry-after']??null;
   assert.equal(visible,cors==='hidden'?null:headers[row.mode]);
   if(row.mode==='real'){assert.ok(row.elapsedMs>=950);}
   else assert.deepEqual(row.waits,[cors==='hidden'||row.mode==='invalid'?60000:row.mode==='date'?5000:row.mode==='cancel'?60000:2000]);
   const wire=requests.filter(r=>r.path===`/api/${sdk}/${cors}/${row.mode}/commands`&&r.method==='POST');
   assert.equal(wire.length,row.mode==='cancel'?1:2);
   assert.equal(new Set(wire.map(r=>r.key)).size,1);assert.ok(wire[0].key);
   assert.equal(new Set(wire.map(r=>r.body)).size,1);
   if(row.mode==='real')assert.ok(wire[1].time-wire[0].time>=950);
  }
  await page.close();
 }
 assert.deepEqual(pageErrors,[]);
 assert.ok(requests.some(r=>r.method==='OPTIONS'), 'real cross-origin preflights must reach the fixture');
 console.log('PASS: Chromium runtime, same-origin and loopback cross-origin exposed/hidden headers, date/seconds/fallback, cancellation, stable identity/body, real one-second timers');
}finally{
 await writeFile('browser-results.json',JSON.stringify({browser:browser.version(),origins:{origin,cross},results,requests,consoleMessages,pageErrors,limitations:['Loopback fixtures only: not production CORS/host acceptance.','Injected advancing clock for long delays; real timers separately checked at one second.','No PostgreSQL, Preview two-client limiter window or native-device acceptance.']},null,2)+'\n');
 await browser.close();pageServer.closeAllConnections();crossServer.closeAllConnections();await Promise.all([new Promise(r=>pageServer.close(r)),new Promise(r=>crossServer.close(r))]);
}
