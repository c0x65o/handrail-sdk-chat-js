from consumer_setup import *
import hashlib,re,datetime
hash=lambda b:hashlib.sha256(b).hexdigest()
js=TMP/'js';flutter=TMP/'flutter';minimum=TMP/'flutter-minimum'
installed=pathlib.Path((TMP/'flutter-installed-path.txt').read_text());installed_min=pathlib.Path((TMP/'minimum-flutter-installed-path.txt').read_text())
expected=json.loads((OUT/'flutter-installed-source-hashes.json').read_text())
assert all(hash((installed_min/name).read_bytes())==sha for name,sha in expected.items())
for consumer in [flutter,minimum]:
    lock=(consumer/'pubspec.lock').read_text()
    assert 'resolved-ref: "51cf4d55ea147fd71267787b774585278ed1f55a"' in lock
    assert 'url: "https://github.com/c0x65o/handrail-sdk-chat-flutter.git"' in lock
    assert 'version: "0.1.31"' in lock
jslock=json.loads((js/'package-lock.json').read_text())
assert jslock['packages']['node_modules/@handrail/chat']['resolved']=='git+https://github.com/c0x65o/handrail-sdk-chat-js.git#5cc37c0aad6bf4f74c4e849f62ae51badb124dca'
assert jslock['packages']['node_modules/@handrail/chat']['version']=='1.0.53'
baseline=(ROOT/'handrail-sdk-chat-flutter/docs/validation/command-retry-after-20261006/analyze.txt').read_text()
issues=lambda text:sorted(re.findall(r'info • (.+)',text))
assert len(issues(baseline))==13
assert issues((OUT/'flutter-full-source-analysis.txt').read_text())==issues(baseline)
assert issues((OUT/'minimum-flutter-full-source-analyze.txt').read_text())==issues(baseline)
preservation={}
for name,sha in [('handrail-sdk-chat-js','5cc37c0aad6bf4f74c4e849f62ae51badb124dca'),('handrail-sdk-chat-flutter','51cf4d55ea147fd71267787b774585278ed1f55a'),('handrail-chat-preview-flutter','b48bf8418702f3acf3b12b8e401749e7ff3a63fb')]:
    root=ROOT/name
    head=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip();assert head==sha
    tracked=subprocess.check_output(['git','-C',str(root),'status','--porcelain','--untracked-files=no'],text=True);assert not tracked
    assert run(name+'-diff-check',['git','diff','--check'],root)==0
    preservation[name]={'head':head,'tracked_status':tracked,'status':subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True)}
(OUT/'workspace-preservation.json').write_text(json.dumps(preservation,indent=2)+'\n')
current=json.loads((OUT/'js-installed-candidate.json').read_text())
browser=json.loads((OUT/'browser-results.json').read_text())
report={
 'work_request':'5a0b62f4-eb0a-42b0-8a37-0c50129304ea','source_work_request':'6c0a069f-a0a0-4f74-a8fd-83d08f030e39','run':'d1e102be-9b54-4288-84d1-671b0379486a','recorded_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'verdict':'Exact published consumer checks passed; existing full Flutter analysis remains failed with 13 baseline informational lints. No new release defect found. This is not whole-product acceptance.',
 'pins':{'js':{'version':'1.0.53','sha':'5cc37c0aad6bf4f74c4e849f62ae51badb124dca','url':'git+https://github.com/c0x65o/handrail-sdk-chat-js.git'},'flutter':{'version':'0.1.31','sha':'51cf4d55ea147fd71267787b774585278ed1f55a','url':'https://github.com/c0x65o/handrail-sdk-chat-flutter.git'},'preview_unchanged':'b48bf8418702f3acf3b12b8e401749e7ff3a63fb'},
 'guidance':{'handrail_current_context':'Read and matched active request/project/authentication snapshot; no queue/database mutations.','kb':'Read current KB catalog and both attached KB entries; no Chat-specific catalog entry. No persistence implementation changed; only HTTP boundary fixtures and existing storage tests. No native app scaffold was generated.','agents':'No AGENTS.md found in mounted project repositories or applicable ancestor paths; mounted .agents/.codex empty.','project_docs':['JS docs/releasing.md','Flutter docs/releasing.md','both docs/validation/command-retry-after-20261006/qualification.md','both docs/validation/command-retry-after-20261006/provenance.json'],'historical_statements':'Archived unpublished statements describe the source-time run; no archived evidence was edited.','ci':'No full CI invoked or configuration changed; existing five-minute full-CI autoskip preserved. Heavy checks sequential; Flutter concurrency 2, Node concurrency 1; runner bounds each check at 300 seconds.'},
 'source_verification':{'artifact':'source-verification.json','remote':'Public HTTPS ls-remote advertised both exact pins. Immutable raw GitHub URLs supplied all qualified changed files and version mirrors. Git package managers then fetched exact revisions.','normalization':'All qualified hashes match exactly except JS package.json/package-lock.json and Flutter pubspec.yaml, which match after only native version substitutions. JS complete candidate source fingerprint matches archived source after additionally normalizing its generated version constant. Flutter generated mirror checked before any lifecycle/generation.','js_installed_candidate_source_sha256':current['source']['sha256'],'js_installed_candidate_package_sha256':current['package']['sha256'],'js_artifacts':'All installed dist files match their candidate hashes. Archived command dispatcher declaration/JS, rate-limit JS and snapshot-reader JS hashes are unchanged.','flutter_integrity':'Every tracked file in both installed Git packages matches the pinned commit, and both installations have identical source hashes. Supplemental analyzer snapshots retain identical lib/test bytes; no SDK dependency uses a source snapshot/path override.'},
 'checks':[
  {'check':'JS pre-install generated version guard','result':'passed','artifact':'js-preinstall-version-guard.txt'},
  {'check':'JS clean public HTTPS Git lock + npm ci normal lifecycle/prepare','result':'passed','artifacts':['js-lock.txt','js-ci.txt','js-package.json','js-package-lock.json','js-package-graph.txt']},
  {'check':'npm run test:git-consumer with HANDRAIL_CHAT_JS_REVISION=5cc37c0aad6bf4f74c4e849f62ae51badb124dca','result':'passed','artifact':'js-git-consumer.txt'},
  {'check':'JS installed public command/header, durable-send and durable-read regressions','result':'passed','tests':66,'artifact':'js-installed-regressions.txt'},
  {'check':'JS installed strict public declaration typecheck, all exports, browser graphs and server browser rejection','result':'passed','artifacts':['js-installed-types.txt','js-installed-exports-browser.txt','js-exports-browser-graph.json']},
  {'check':'Flutter 3.41.7 / Dart 3.11.5 clean public Git consumer','result':'passed','tests':187,'core_guard_tests':3,'consumer_analysis':'passed','artifacts':['flutter-pubspec.lock','flutter-package-graph.txt','flutter-installed-regressions-complete-fixtures.txt','flutter-installed-public-core-guard-direct.txt','flutter-consumer-analyze.txt']},
  {'check':'Flutter 3.19.0 / Dart 3.3.0 clean public Git consumer','result':'passed','tests':187,'core_guard_tests':3,'consumer_analysis':'passed','artifacts':['minimum-flutter-pubspec.lock','minimum-flutter-graph.txt','minimum-flutter-regressions.txt','minimum-flutter-public-core-guard.txt','minimum-flutter-consumer-analyze.txt']},
  {'check':'Scoped Flutter qualified source analysis','result':'passed','artifact':'flutter-qualified-source-analysis.txt'},
  {'check':'Full Flutter lib/test analysis, byte-identical supplementary source snapshot with installed consumer graph','result':'failed_baseline','exit_code':1,'issues':issues(baseline),'toolchains':['3.41.7 / 3.11.5','3.19.0 / 3.3.0'],'artifacts':['flutter-full-source-analysis.txt','minimum-flutter-full-source-analyze.txt']},
  {'check':'Actual Chromium runtime through installed JS public client and installed Flutter shipped BrowserChatTransport','result':'passed','browser':browser['browser'],'cases':sum(len(x['results']) for x in browser['results']),'post_requests':sum(r['method']=='POST' for r in browser['requests']),'preflights':sum(r['method']=='OPTIONS' for r in browser['requests']),'request_interception':False,'artifacts':['browser-runtime-unintercepted.txt','browser-results.json','flutter-browser-compile.txt','js-browser-bundle.txt']}
 ],
 'coverage':[
  'Installed public dispatcher and Flutter public core sendMessage; seconds/date/invalid/missing Retry-After, cancellation/close, overlapping deadlines, bounded attempts, stable idempotency and body, lost acknowledgements, durable send/read, reducer, realtime package version.',
  'Actual native loopback HTTP through installed shipped ERP transport proves response header forwarding; public browser transport also forwards visible response headers.',
  'Browser: 26 cases over same origin and distinct loopback port origins, exposed versus hidden Retry-After; hidden cross-origin headers fall back to 60 seconds. Four real one-second timer cases; long waits use explicitly advancing injected clocks.',
  'Minimum and supported Flutter tools/caches are private writable copies/downloads. Minimum official archive SHA-256 verified against official manifest.'
 ],
 'harness_attempts':[
  {'artifact':'flutter-installed-regressions.txt','result':'failed_harness','reason':'Initial copied tests omitted two shipped relative fixture files. Added unchanged installed test/fixtures; 187 tests passed. No SDK source repair.'},
  {'artifact':'flutter-installed-public-core-guard.txt','result':'unavailable_launch_path','reason':'dart test refuses packages inside pub cache. Launched installed test runner directly with exact consumer package graph; 3 guards passed.'},
  {'artifacts':['flutter-full-analyze-baseline.txt.gz','flutter-qualified-files-analyze.txt.gz'],'result':'failed_analyzer_context','reason':'Analysis inside the pub cache did not resolve package imports even with copied package config. Byte-identical supplementary source analysis reproduced the baseline; these context errors are not SDK findings.'},
  {'artifact':'initial-js-browser-bundle.txt','result':'failed_harness','reason':'IIFE bundle initially contained top-level await; wrapped test entry in async main, then compiled successfully.'},
  {'artifact':'initial-browser-runtime.txt','result':'failed_browser_launch','reason':'Chromium Unix socket path exceeded length limit in deep worker tmp directory. Used a short private writable TMPDIR; no browser security/CORS bypass flags.'},
  {'artifacts':['browser-results-routed.json','browser-runtime-routed.txt'],'result':'superseded_pass','reason':'Initial request routing suppressed preflights. Final runtime repeated without interception and required real OPTIONS requests (16).'},
  {'result':'failed_download_url','reason':'Initial manifest URL had an extra /flutter component and returned HTTP 404. Correct official URL from existing compatibility evidence succeeded; archive hash verified.'}
 ],
 'scope_limits':['Loopback fixture CORS is not production CORS/host integration acceptance.','Parent owns actual Preview two-client PostgreSQL fixed-window checks, shared total request budget and production host/CORS integration. None claimed here.','No real messages, credentials, relay tokens, providers, deployment, Preview edits, database/queue changes, commit, push or source/version edits.','No native-device acceptance; Flutter tests execute on Linux host tooling.','No new PostgreSQL durability claim: boundary fixtures use synthetic data; existing SDK storage fixtures establish only their tested local behavior.','Full CI not executed; full Flutter analysis stays failed on known baseline lints.'],
 'browser_built_sha256':{name:hash((js/name).read_bytes()) for name in ['bundle-js.js','bundle-flutter.js']},
 'tools':{'node':subprocess.check_output(['node','--version'],text=True).strip(),'npm':subprocess.check_output(['npm','--version'],text=True).strip()},
 'reproduction_order':['verify_source.py','consumer_setup.py','js_qualify.py','flutter_setup.py','flutter_qualify.py','flutter_analysis_snapshot.py','browser_qualify.py','minimum_toolchain.py'],
 'artifacts':'artifact-sha256.json records all bounded evidence files; package locks and resolved graphs retained. Generated packages/toolchains/bundles remain disposable outside source.'
}
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(report['verdict'])
