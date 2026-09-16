"""Compare installed regular payload files with SRI-authenticated lock archives.
Usage: python3 audit-payloads.py CHECKOUT PRIVATE_ARCHIVE_CACHE OUTPUT_JSON
No installation or shared-cache writes. Optional platform omissions are recorded.
Generated extra files are inventoried separately; shipped file changes fail.
"""
import base64,hashlib,io,json,pathlib,sys,tarfile,urllib.request
root,cache,out=map(pathlib.Path,sys.argv[1:]);cache.mkdir(parents=True,exist_ok=True)
lock=json.loads((root/'package-lock.json').read_text());results=[];errors=[]
for rel,e in lock['packages'].items():
 if not rel:continue
 p=root/rel; record={'path':rel,'locked_version':e['version'],'integrity':e.get('integrity')};results.append(record)
 if not (p/'package.json').exists():
  record['omitted_optional']=bool(e.get('optional'))
  if not e.get('optional'):errors.append([rel,'missing'])
  continue
 record['actual_version']=json.loads((p/'package.json').read_text())['version']
 if record['actual_version']!=e['version']:errors.append([rel,'version'])
 archive=cache/(hashlib.sha256(e['resolved'].encode()).hexdigest()+'.tgz')
 if not archive.exists():
  with urllib.request.urlopen(e['resolved'],timeout=60) as r:archive.write_bytes(r.read())
 data=archive.read_bytes();sri=e['integrity'].split()[0];alg,digest=sri.split('-',1)
 if base64.b64encode(hashlib.new(alg,data).digest()).decode()!=digest:raise ValueError('archive integrity '+rel)
 record['archive_sha256']=hashlib.sha256(data).hexdigest();files={};bad=[]
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:
  for m in t:
   if not m.isfile():continue
   name=m.name.split('/',1)[1];target=p/name
   if not target.resolve().is_relative_to(p.resolve()):raise ValueError('unsafe path')
   expected=hashlib.sha256(t.extractfile(m).read()).hexdigest();actual=hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
   files[name]={'expected':expected,'actual':actual}
   if expected!=actual and pathlib.PurePosixPath(name).name=='.gitignore' and not target.exists():
    renamed=target.with_name('.npmignore')
    if renamed.is_file() and hashlib.sha256(renamed.read_bytes()).hexdigest()==expected:
     files[name]['verified_transform']='npm .gitignore to .npmignore';continue
   if expected!=actual and rel=='node_modules/esbuild' and name=='bin/esbuild':
    native=root/'node_modules/@esbuild/linux-x64/bin/esbuild'
    if native.is_file() and hashlib.sha256(native.read_bytes()).hexdigest()==actual:
     files[name]['verified_transform']='esbuild install.js native binary; separately audited @esbuild/linux-x64';continue
   if expected!=actual:bad.append(name)
 record['files']=files;record['mismatches']=bad
 record['extra_files']={str(f.relative_to(p)):hashlib.sha256(f.read_bytes()).hexdigest() for f in p.rglob('*') if f.is_file() and 'node_modules' not in f.relative_to(p).parts and str(f.relative_to(p)) not in files}
 if bad:errors.append([rel,bad])
out.write_text(json.dumps({'lock_sha256':hashlib.sha256((root/'package-lock.json').read_bytes()).hexdigest(),'packages':results,'errors':errors},indent=2));print(json.dumps({'packages':len(results),'installed':sum('actual_version' in r for r in results),'errors':errors}));sys.exit(bool(errors))
