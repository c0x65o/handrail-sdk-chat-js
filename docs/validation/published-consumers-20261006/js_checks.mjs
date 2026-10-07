import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {build} from 'esbuild';
import {builtinModules} from 'node:module';
import {createHash} from 'node:crypto';
const root=new URL('./node_modules/@handrail/chat/',import.meta.url);
const pkg=JSON.parse(await readFile(new URL('package.json',root)));
assert.equal(pkg.version,'1.0.53');
assert.equal((await import('@handrail/chat/client')).CHAT_CLIENT_PACKAGE_VERSION,'1.0.53');
const result={version:pkg.version,exports:{},browserGraphs:{}};
for(const key of Object.keys(pkg.exports)){
 const spec='@handrail/chat'+key.slice(1), resolved=import.meta.resolve(spec);
 assert.ok(resolved.startsWith(root.href));
 if(key.endsWith('.css')){await access(new URL(resolved));result.exports[spec]={resolved};continue;}
 const module=await import(spec);
 const types=new URL(pkg.exports[key].types,root);
 await access(types);
 result.exports[spec]={resolved,types:types.href,names:Object.keys(module)};
}
const builtins=new Set(builtinModules.flatMap(x=>[x,`node:${x}`]));
for(const key of ['','/client','/react','/ui']){
 const built=await build({stdin:{contents:`export * from '@handrail/chat${key}';`,resolveDir:process.cwd(),loader:'js'},bundle:true,format:'esm',platform:'browser',external:['react'],metafile:true,write:false});
 for(const [file,info] of Object.entries(built.metafile.inputs)){
  assert.doesNotMatch(file,/\/(server|testing|providers?)\//);
  assert.doesNotMatch(file,/node_modules\/(pg|ws|@testcontainers)\//);
  for(const dep of info.imports)assert.equal(builtins.has(dep.path),false);
 }
 result.browserGraphs[key||'/']={inputs:built.metafile.inputs,outputSha256:createHash('sha256').update(built.outputFiles[0].contents).digest('hex')};
}
await assert.rejects(build({stdin:{contents:"import '@handrail/chat/server';",resolveDir:process.cwd()},bundle:true,platform:'browser',write:false,logLevel:'silent'}),/Could not resolve/);
await writeFile('exports-browser-graph.json',JSON.stringify(result,null,2)+'\n');
console.log('PASS: installed public exports, version, declaration files, browser graphs, server browser rejection');
