import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const repo = process.cwd();
const evidence = path.join(repo, 'docs/validation/edit-message-fractional-claim');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const json = (name, data) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2)+'\n');
const git = (...args) => spawnSync('git', args, {cwd:repo, encoding:'utf8'}).stdout;
const walk = root => fs.existsSync(root) ? fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(root,e.name)):e.isFile()?[path.join(root,e.name)]:[]) : [];
const manifest = files => Object.fromEntries(files.sort().map(f=>[path.relative(repo,f),hash(fs.readFileSync(f))]));
const inputs = [...walk(path.join(repo,'src')),path.join(repo,'test/postgres-edit-message-command.test.mjs'),...['package.json','package-lock.json','tsconfig.json'].map(f=>path.join(repo,f))];
const before = manifest(inputs);
const shared = manifest(walk(path.join(repo,'dist')));
const status = git('status','--porcelain=v1');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'edit-message-evidence-'));
const pass = path.join(root,'passing');
fs.mkdirSync(pass);
for(const f of ['src','package.json','package-lock.json','tsconfig.json'])fs.cpSync(path.join(repo,f),path.join(pass,f),{recursive:true});
fs.mkdirSync(path.join(pass,'test'));
fs.copyFileSync(path.join(repo,'test/postgres-edit-message-command.test.mjs'),path.join(pass,'test/postgres-edit-message-command.test.mjs'));
fs.symlinkSync(path.join(repo,'node_modules'),path.join(pass,'node_modules'),'dir');
const url = process.env.DATABASE_URL;
const secrets = [url];
if(url){const u=new URL(url);secrets.push(u.password,decodeURIComponent(u.password));}
const redact = s => secrets.filter(Boolean).reduce((v,k)=>v.split(k).join('[REDACTED]'),s).replace(/postgres(?:ql)?:\/\/[^\s'"`]+/g,'[REDACTED_DATABASE_URL]');
const commands=[];
function run(label,cmd,args,cwd,env={}){
 const started=new Date().toISOString();
 const result=spawnSync(cmd,args,{cwd,env:{...process.env,...env},encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000});
 const entry={label,command:[cmd,...args],cwd,environment:Object.fromEntries(Object.entries(env).map(([k,v])=>[k,k==='TEST_DATABASE_URL'?'[worker DATABASE_URL; verified dev endpoint]':v])),started,finished:new Date().toISOString(),exit_code:result.status,signal:result.signal,error:result.error?.message};
 commands.push(entry);json('commands.json',commands);
 fs.writeFileSync(path.join(evidence,label+'.log'),redact(JSON.stringify(entry)+'\n--- stdout ---\n'+(result.stdout||'')+'\n--- stderr ---\n'+(result.stderr||'')));
 console.log(label,JSON.stringify({exit_code:result.status,signal:result.signal}));return result;
}
json('source-identity.json',{revision:git('rev-parse','HEAD').trim(),status_before:status,node:process.version,compiler:JSON.parse(fs.readFileSync(path.join(repo,'node_modules/typescript/package.json'))).version,temporary_root:root,input_sha256:before,shared_dist_sha256:shared});
const compiled=run('compilation',process.execPath,[path.join(repo,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json','--outDir','dist','--incremental','false'],pass);
if(compiled.status!==0)throw new Error('Compilation failed; see compilation.log');
const negative=path.join(root,'negative');fs.cpSync(pass,negative,{recursive:true,verbatimSymlinks:true});
const target=path.join(negative,'dist/server/edit-message-command.js');
const original=fs.readFileSync(target,'utf8');
const old=original.replace('completed_at = GREATEST($3::timestamptz, created_at)','completed_at = $3').replace('updated_at = GREATEST($3::timestamptz, created_at)','updated_at = $3');
if(old===original || (original.match(/GREATEST\(\$3::timestamptz, created_at\)/g)||[]).length!==2)throw new Error('Unexpected completion assignments');
fs.writeFileSync(target,old);
json('compiled-identity.json',{passing:manifest(walk(path.join(pass,'dist'))),negative:manifest(walk(path.join(negative,'dist'))),negative_mutations:['completed_at = GREATEST($3::timestamptz, created_at) -> completed_at = $3','updated_at = GREATEST($3::timestamptz, created_at) -> updated_at = $3'],test_sha256:hash(fs.readFileSync(path.join(pass,'test/postgres-edit-message-command.test.mjs')))});
const require=createRequire(path.join(repo,'package.json'));
const {Pool}=require('pg');
const u=url?new URL(url):null;
let pool;
let resultStatus='blocked';
try{
 if(!u || u.hostname!=='127.0.0.1'||u.port!=='34371'||u.pathname!=='/handrail_chat')throw new Error('Worker DATABASE_URL does not match MCP-verified project dev endpoint 127.0.0.1:34371/handrail_chat');
 pool=new Pool({connectionString:url,connectionTimeoutMillis:5000});
 const result=await pool.query('SELECT current_database() AS database, current_user AS role, version() AS version, inet_server_addr()::text AS server_address, inet_server_port() AS server_port, pg_is_in_recovery() AS recovery');
 json('backend-probe.json',{checked_at:new Date().toISOString(),endpoint:{host:u.hostname,port:u.port,database:u.pathname.slice(1)},source:'worker DATABASE_URL matched read-only Handrail dev resource inspection',result:result.rows,exit_code:0});
 const preload=`import assert from 'node:assert/strict';\nimport {fileURLToPath} from 'node:url';\nimport pg from 'pg';\nfor(const spec of ['@handrail/chat','@handrail/chat/server','@handrail/chat/testing']){const resolved=import.meta.resolve(spec);assert.ok(resolved.startsWith(new URL('./dist/',import.meta.url).href));console.log('ARTIFACT_RESOLUTION',spec,resolved);}\nconst query=pg.Pool.prototype.query;\npg.Pool.prototype.query=function(sql,...args){const result=query.call(this,sql,...args);if(typeof sql==='string' && /^(CREATE SCHEMA|DROP SCHEMA)/.test(sql)){return result.then(value=>{console.log('FIXTURE_SQL_SUCCESS',sql);return value;});}return result;};\n`;
 const runs=[];
 for(const [label,dir] of [['passing-test',pass],['negative-control',negative]]){
  fs.writeFileSync(path.join(dir,'verify.mjs'),preload);
  const r=run(label,process.execPath,['--import','./verify.mjs','--test','test/postgres-edit-message-command.test.mjs'],dir,{TEST_DATABASE_URL:url});
  const output=r.stdout||'';
  const schemas=[...output.matchAll(/FIXTURE_SQL_SUCCESS CREATE SCHEMA "([a-z0-9_]+)"/g)].map(m=>m[1]);
  const remaining=schemas.length?(await pool.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])',[schemas])).rows:[];
  runs.push({label,exit_code:r.status,schemas,remaining,counts:Object.fromEntries([...output.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(m=>[m[1],Number(m[2])])),fractional_pass:/^\s*ok \d+ - a fractional-millisecond claim completes and replays a revision conflict$/m.test(output),timestamp_constraint_failure:/chat_idempotency_keys_timestamp_order/.test(output)});
 }
 json('test-results.json',runs);
 resultStatus=runs[0].exit_code===0&&runs[0].fractional_pass&&runs[0].counts.skipped===0&&runs[1].exit_code!==0&&runs[1].timestamp_constraint_failure&&runs.every(r=>r.schemas.length===1&&r.remaining.length===0)?'passed':'failed';
}catch(error){fs.writeFileSync(path.join(evidence,'prerequisite-failure.log'),redact(error.stack)+'\n');console.log('Prerequisite failure recorded');}
finally{
 if(pool)await pool.end();
 json('preservation-cleanup.json',{status:resultStatus,input_hashes_unchanged:JSON.stringify(before)===JSON.stringify(manifest(inputs)),shared_dist_hashes_unchanged:JSON.stringify(shared)===JSON.stringify(manifest(walk(path.join(repo,'dist')))),status_after:git('status','--porcelain=v1'),temporary_root:root,temporary_artifacts_retained:true,fixture_cleanup:'See test-results.json: exact owned schema names checked after harness teardown; no manual schema drops performed.'});
 console.log('Evidence result:',resultStatus);
}
