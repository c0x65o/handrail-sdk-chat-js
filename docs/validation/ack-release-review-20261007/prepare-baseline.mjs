import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Compiled test fixture only; no checkout, installation, or tracked source writes.
const root = new URL('../../../', import.meta.url);
const baseline = new URL('build/ack-review-baseline/', root);
await mkdir(baseline, {recursive:true});
await cp(new URL('dist/', root), new URL('dist/', baseline), {recursive:true});
await cp(new URL('package.json',root),new URL('package.json',baseline));
const records = [];
for (const path of ['src/client/read-state.ts','src/server/create-chat-server.ts','src/server/update-read-cursor-command.ts']) {
  const source = execFileSync('git',['show',`248fb8890b8e7e1ba15799aff06ef48156cca451:${path}`], {cwd:root,encoding:'utf8'});
  const compiled = stripTypeScriptTypes(source,{mode:'transform'});
  await writeFile(new URL(path.replace(/^src\//,'dist/').replace(/\.ts$/,'.js'),baseline),compiled);
  records.push({path,sourceSha256:createHash('sha256').update(source).digest('hex'),compiledSha256:createHash('sha256').update(compiled).digest('hex')});
}
await writeFile(new URL('baseline-fixture.json',import.meta.url),JSON.stringify({base:'248fb8890b8e7e1ba15799aff06ef48156cca451',records,note:'Node 22 built-in TypeScript transform of unchanged Git bytes; other dist modules reused from typed candidate build; git production diff is exactly these three source modules.'},null,2)+'\n');
