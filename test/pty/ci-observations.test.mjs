import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {capture} from './capture.mjs';

const reader=new URL('./capture.mjs',import.meta.url).href;
function scenario(t,{cols=100,log='setup done\nAssertionError: expected true, actual false\ncompleted with exit 1',config={},program}={}){
  const root=mkdtempSync(join(tmpdir(),'glance-ci-jev-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const name of ['calls','imports','native'])writeFileSync(join(root,name),'');
  writeFileSync(join(root,'log.txt'),log);writeFileSync(join(root,'config.json'),JSON.stringify(config));
  const resource={limit:5000,remaining:5000,used:0,resetMs:Date.now()+3600000};
  writeFileSync(join(root,'state.json'),JSON.stringify({createdAt:Date.now(),core:resource,graphql:resource,events:[]}));
  const driver=join(root,'driver.mjs');
  writeFileSync(driver,String.raw`import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {parseCapture} from ${JSON.stringify(reader)};
const root=${JSON.stringify(root)},cols=${cols};const pause=ms=>new Promise(r=>setTimeout(r,ms)),send=s=>process.stdout.write(s);
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols,rows:24}).finalFrame.lines.join('\n');
const jevCalls=()=>readFileSync(root+'/calls','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const ghCalls=()=>readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+'.calls','utf8').split('\n').filter(Boolean);
const sourceCalls=()=>ghCalls().filter(s=>s.includes('/actions/runs?'));
const until=async(fn,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(fn())return;}catch{}await pause(40);}throw Error('UI barrier '+fn+'\n'+screen());};
const save=name=>writeFileSync(root+'/'+name+'.txt',screen());
const openLog=async()=>{await until(()=>screen().includes('ci: pin actions')&&screen().includes('Watching'));send('j');await pause(120);send('j');await until(()=>screen().split('\n').some(s=>s.includes('>')&&s.includes('restore')));send('d');await until(()=>screen().includes('2/2 jobs loaded'));send('l');await until(()=>screen().includes('Log complete'));};
try{${program}
writeFileSync(root+'/complete','yes');}catch(error){writeFileSync(root+'/failure',String(error));}finally{send('\u0003');}`);
  const preloads=['ci-https.mjs','jev-fetch.mjs','jev-child-guard.mjs'].map(name=>`--import=${new URL('./fixtures/'+name,import.meta.url).pathname}`).join(' ');
  const result=capture({cols,rows:24,signal:'none',settle:100,configHome:root,args:'--repo acme/widget --refresh 300 --background off --jev',
    env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',TYPESAFE_API_KEY:'synthetic-jev-key',GH_GLANCE_FIXTURE_STATE:join(root,'state.json'),
      GH_GLANCE_CI_LOG_FILE:join(root,'log.txt'),GH_GLANCE_CI_EVENTS:join(root,'native'),GH_GLANCE_TEST_JEV_CALLS:join(root,'calls'),
      GH_GLANCE_TEST_JEV_CONFIG:join(root,'config.json'),GH_GLANCE_TEST_JEV_IMPORTS:join(root,'imports'),NODE_OPTIONS:preloads},stdin:`node '${driver}'`});
  assert.equal(result.exitCode,0);assert.equal(existsSync(join(root,'failure')),false,existsSync(join(root,'failure'))?readFileSync(join(root,'failure'),'utf8'):'');
  assert.equal(readFileSync(join(root,'complete'),'utf8'),'yes');assert.equal(result.altEnter,result.altExit);assert.ok(result.finalFrame.widest<=cols-1);
  if(process.env.GH_GLANCE_CI_CAPTURES)for(const name of ['preview','preview-text','observations','secret','range'])if(existsSync(join(root,name+'.txt')))
    writeFileSync(join(process.env.GH_GLANCE_CI_CAPTURES,`phase4-${cols}-${name}.txt`),readFileSync(join(root,name+'.txt')));
  return {root,result};
}

for(const cols of [100,40])test(`CI observations ${cols}: every-send preview, exact wire, source facts, cancellation and revocation`,t=>{
  const {root,result}=scenario(t,{cols,config:{ciProbabilities:{assertion_mismatch:.9}},program:String.raw`
await openLog();const beforeSource=JSON.stringify(sourceCalls());const beforeNative=readFileSync(root+'/native','utf8');
assert.equal(jevCalls().length,0);assert.equal(readFileSync(root+'/imports','utf8'),'');send('J');await until(()=>screen().includes('TypeSafe preview'));save('preview');
assert.equal(jevCalls().length,0);assert.equal(readFileSync(root+'/imports','utf8'),'');assert.ok(/Enter[\s│]*Send/.test(screen()));
for(let page=0;page<20&&!screen().includes('AssertionError');page++){send('\u001b[6~');await pause(80);}await until(()=>screen().includes('AssertionError'));save('preview-text');assert.ok(screen().includes('failure'));assert.equal(jevCalls().length,0);assert.equal(readFileSync(root+'/imports','utf8'),'');
send('\u001b');await until(()=>!screen().includes('TypeSafe preview'));assert.equal(jevCalls().length,0);
send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('Assertion mismatch'));save('observations');
assert.equal(jevCalls().length,1);const wire=jevCalls()[0].request;
assert.equal(Object.keys(wire.questions).length,12);assert.equal(wire.state.excerpt.s2.text,'AssertionError: expected true, actual false');assert.equal(wire.state.excerpt.s2.lineStart,2);
assert.ok(!JSON.stringify(wire).includes('acme/widget'));assert.ok(screen().includes('failure'));assert.ok(/line[s]?[\s│]*2/.test(screen()));
send('J');await until(()=>screen().includes('TypeSafe preview'));send('\u001b');await until(()=>!screen().includes('TypeSafe preview'));assert.equal(jevCalls().length,1);
send('x');await until(()=>screen().includes('permission revoked'));assert.ok(!screen().includes('Assertion mismatch'));assert.ok(!screen().includes('AssertionError: expected true'));
assert.equal(JSON.stringify(sourceCalls()),beforeSource);assert.equal(readFileSync(root+'/native','utf8'),beforeNative);
`});
  assert.doesNotMatch(result.raw,/do not expose provider content/);
  assert.equal(readFileSync(join(root,'calls'),'utf8').trim().split('\n').length,1);
});

test('CI suspected secret blocks cloud input; range editor owns q and clean original lines can be explicitly sent',t=>scenario(t,{log:'Authorization: Bearer synthetic-private-value\nAssertionError: expected true, actual false\nclean finish',config:{ciProbabilities:{assertion_mismatch:.9}},program:String.raw`
await openLog();send('J');await until(()=>screen().includes('Suspected secret'));save('secret');assert.equal(jevCalls().length,0);assert.equal(readFileSync(root+'/imports','utf8'),'');
send('e');await until(()=>screen().includes('CI range >'));send('q');await pause(100);assert.ok(screen().includes('CI range > q'));send('\r');await until(()=>screen().includes('Invalid CI line range'));
send('\u007f');await pause(60);send('2-3');await pause(100);send('\r');await until(()=>screen().includes('Range 2-3 ready'));save('range');
send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('Assertion mismatch'));
assert.equal(jevCalls().length,1);assert.ok(!JSON.stringify(jevCalls()[0].request).includes('synthetic-private-value'));assert.equal(jevCalls()[0].request.state.excerpt.s1.lineStart,2);
`}));

test('CI provider error retains local conclusion and an explicit fresh preview recovers to uncertainty',t=>{
  const {result}=scenario(t,{config:{status:500},program:String.raw`
await openLog();send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('Jev unavailable'));assert.ok(screen().includes('failure'));assert.equal(jevCalls().length,1);
writeFileSync(root+'/config.json',JSON.stringify({ciProbabilities:Object.fromEntries(['assertion_mismatch','dependency_download','permission_denied','execution_timeout','memory_exhaustion','static_check_failure'].map(k=>[k,.5]))}));
send('J');await until(()=>screen().includes('TypeSafe preview'));assert.equal(jevCalls().length,1);send('\r');await until(()=>screen().includes('6 uncertain'));assert.ok(screen().includes('failure'));assert.ok(!screen().includes('No listed observation found'));
`});assert.doesNotMatch(result.raw,/do not expose provider content/);
});

test('CI empty evidence has no model call and explicit log reload reaches usable preview',t=>scenario(t,{log:'\n\n',program:String.raw`
await openLog();send('J');await until(()=>screen().includes('Insufficient CI evidence'));assert.equal(jevCalls().length,0);assert.equal(readFileSync(root+'/imports','utf8'),'');
writeFileSync(root+'/log.txt','AssertionError: expected 2, actual 3');send('l');await until(()=>screen().includes('AssertionError: expected 2'));send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('6 uncertain'));assert.equal(jevCalls().length,1);
`}));

test('CI pending inference keeps page input responsive and source refresh cancels publication without acquiring details',t=>scenario(t,{config:{delay:6000},program:String.raw`
await openLog();send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('Jev pending'));
send('\u001b[6~');await pause(100);assert.ok(screen().includes('Jev pending'));const beforeSource=sourceCalls().length;const beforeDetails=ghCalls().filter(s=>s.includes('/attempts/')).length;
send('r');await until(()=>sourceCalls().length===beforeSource+1);await until(()=>!screen().includes('CI evidence')&&screen().includes('Watching'));await pause(600);assert.ok(!screen().includes('Assertion mismatch'));assert.equal(ghCalls().filter(s=>s.includes('/attempts/')).length,beforeDetails);assert.equal(jevCalls().length,1);
`}));

test('CI unsupported Focus key leaves pending observations usable and J can review again',t=>scenario(t,{config:{delay:800,ciProbabilities:{assertion_mismatch:.9}},program:String.raw`
await openLog();send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('Jev pending'));send('/');await until(()=>screen().includes('Assertion mismatch'));assert.equal(jevCalls().length,1);
send('J');await until(()=>screen().includes('TypeSafe preview'));send('\u001b');await until(()=>!screen().includes('TypeSafe preview'));
`}));

test('CI context rejection exposes a smaller-range correction and requires a fresh preview',t=>scenario(t,{config:{status:413},program:String.raw`
await openLog();send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('CI excerpt too large'));assert.equal(jevCalls().length,1);
send('e');await until(()=>screen().includes('CI range >'));send('2');await pause(80);send('\r');await until(()=>screen().includes('Range 2-2 ready'));
writeFileSync(root+'/config.json',JSON.stringify({ciProbabilities:{assertion_mismatch:.9}}));send('J');await until(()=>screen().includes('TypeSafe preview'));assert.equal(jevCalls().length,1);send('\r');await until(()=>screen().includes('Assertion mismatch'));assert.equal(jevCalls().length,2);
`}));

test('CI changed Actions generation makes completed cached observations and excerpt unreachable',t=>scenario(t,{config:{ciProbabilities:{assertion_mismatch:.9}},program:String.raw`
await openLog();send('J');await until(()=>screen().includes('TypeSafe preview'));send('\r');await until(()=>screen().includes('Assertion mismatch'));assert.equal(jevCalls().length,1);
const state=JSON.parse(readFileSync(root+'/state.json','utf8'));const runs=JSON.parse(readFileSync(new URL('./fixtures/actions-runs.json',${JSON.stringify(reader)}),'utf8'));
runs[1].updatedAt=new Date(Date.now()+1000).toISOString();state.apiEntities={...(state.apiEntities??{}),['repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60']:{body:JSON.stringify(runs)}};writeFileSync(root+'/state.json',JSON.stringify(state));
send('R');await until(()=>screen().includes('Run changed;'));assert.ok(!screen().includes('Assertion mismatch'));assert.ok(!screen().includes('AssertionError: expected true'));
send('J');await pause(200);assert.equal(jevCalls().length,1);assert.ok(!screen().includes('Assertion mismatch'));
`}));
