"""Read-only source/evidence audit against the independent review and run start."""
import pathlib, subprocess, hashlib, json, gzip, os
out=pathlib.Path(__file__).resolve().parent; js=out.parents[2]; w=js.parent; fl=w/'handrail-sdk-chat-flutter'
h=lambda b:hashlib.sha256(b).hexdigest()
def sha(p):
 with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def git(r,*args): return subprocess.check_output(['git',*args],cwd=r)
before=json.loads((out/'before.json').read_text()); changes={}; evidence={}
allowed={'handrail-sdk-chat-js':{'docs/releasing.md'},'handrail-sdk-chat-flutter':{'docs/releasing.md','shared-contracts.lock.json'},'handrail-chat-preview-flutter':set()}
for name,old in before.items():
 r=w/name; changed=[]; missing=[]
 assert git(r,'rev-parse','HEAD').decode().strip()==old['head']
 for p,v in old['files'].items():
  current=sha(r/p) if (r/p).is_file() else None
  if v!=current:
   (missing if current is None else changed).append(p)
 assert not missing,(name,missing)
 assert set(changed)<=allowed[name],(name,changed)
 changes[name]={'head':old['head'],'existingFilesChecked':len(old['files']),'changedExistingFiles':changed,'removedFiles':missing}
for r,suffix in [(js,'ack-release-review-20261007'),(js,'read-cursor-ack-20261007'),(fl,'ack-release-review-20261007'),(fl,'link-polish-review-20261007/resume-6857a7d8')]:
 d=r/'docs/validation'/suffix; manifest=d/'evidence-sha256.json'; entries=json.loads(manifest.read_text())
 mismatches=[p for p,v in entries.items() if sha(d/p)!=v]
 assert not mismatches,(str(d),mismatches)
 evidence[str(d.relative_to(w))]={'verifiedFiles':len(entries),'manifestSha256':sha(manifest),'mismatches':mismatches}
j=json.loads((js/'docs/validation/ack-release-review-20261007/final-hashes.json').read_text())
f=json.loads((fl/'docs/validation/ack-release-review-20261007/final-hashes.json').read_text())
production={p:sha(js/p) for p in j['productionFiles']}
assert all(production[p]==v['sha256'] for p,v in j['productionFiles'].items())
patch=h(git(js,'diff','--',*j['productionFiles'])); assert patch==j['productionPatchSha256']
flutter={p:sha(fl/p) for p in {**f['finalSources'],**f['library']}}
assert all(flutter[p]==v for p,v in {**f['finalSources'],**f['library']}.items())
runtimeDiff=h(git(fl,'diff','--','lib')); assert runtimeDiff==f['runtimeDiffSha256']
artifacts={}
for relative,expected in [
 ('.huddle-tmp/ack-review-toolchains/flutter_linux_3.19.0-stable.tar.xz','4cc1706fbd6e2a5c0ee34a6f8de875aae20904c9f47e18c88d2fcb25d9ea1a79'),
 ('handrail-sdk-chat-flutter/docs/validation/link-polish-review-20261007/resume-6857a7d8/final-sources.tar.gz',f['fixtureArchiveSha256']),
 ('handrail-sdk-chat-flutter/build/ack-release-review/minimum/build/web/main.dart.js',f['runtimeQualification']['minimum']['mainDartJsSha256']),
 ('handrail-sdk-chat-flutter/build/ack-release-review/minimum/pubspec.lock',f['runtimeQualification']['minimum']['lockSha256']),
 ('handrail-sdk-chat-flutter/build/ack-release-review/current/pubspec.lock',f['runtimeQualification']['current']['lockSha256'])]:
 actual=sha(w/relative); assert actual==expected,(relative,actual); artifacts[relative]=actual
p=fl/'docs/validation/link-polish-review-20261007/resume-6857a7d8/final-main.dart.js.gz'
with gzip.open(p,'rb') as stream: actual=hashlib.file_digest(stream,'sha256').hexdigest()
assert actual==f['runtimeQualification']['current']['mainDartJsSha256Reused']
artifacts[str(p.relative_to(w))+' (decompressed)']=actual
plan=json.loads((out/'sync-plan.json').read_text())
for e in plan['delta']: assert sha(fl/e['path'])==e['afterSha256']
preview=git(w/'handrail-chat-preview-flutter','status','--short').decode();assert preview==before['handrail-chat-preview-flutter']['status']
result={'repositories':changes,'jsProductionPatchSha256':patch,'jsProductionFiles':production,'flutterReviewManifestSha256':sha(fl/'docs/validation/ack-release-review-20261007/final-hashes.json'),'flutterFinalSourcesAndLibrary':flutter,'flutterLibDiffSha256':runtimeDiff,'priorEvidence':evidence,'retainedQualificationArtifacts':artifacts,'previewStatus':preview}
(out/'preservation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='flutterFinalSourcesAndLibrary'},indent=2))
