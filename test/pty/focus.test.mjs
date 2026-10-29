import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capture, captureAsync} from './capture.mjs';
import {createCollectorService, normalizeCollectorConfig} from '../../index.mjs';

for(const cols of [40,100]) test(`Focus ${cols}: editor, selection, q, escape and no acquisition on search`,t=>{
 const root=mkdtempSync(join(tmpdir(),'glance-focus-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const driver=join(root,'driver.mjs');
 writeFileSync(driver,`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('./capture.mjs',import.meta.url).href)};
const root=${JSON.stringify(root)}, cols=${cols};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols,rows:24}).finalFrame.lines.join('\\n');
const send=s=>process.stdout.write(s);
const until=async fn=>{let end=Date.now()+15000;while(Date.now()<end){try{if(fn())return;}catch{}await pause(50);}throw Error('UI timeout: '+screen());};
try {
 await until(()=>screen().includes('Watching') || screen().includes('Cached'));
 send('2'); await until(()=>screen().includes('Issues') && screen().includes('of '));
 const before=readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+'.calls','utf8');
 send('/'); await until(()=>screen().includes('Focus >'));
 send('q'); await until(()=>screen().includes('Focus > q'));
 send('\\u007f'); await until(()=>/Focus >\\s*[│]/.test(screen())); send('#42'); await until(()=>screen().includes('Focus > #42')); send('\\r'); await until(()=>screen().includes('Focus: #42'));
 writeFileSync(root+'/search.txt',screen());
 send('/'); await until(()=>screen().includes('Focus > #42'));
 send('abc'); await until(()=>screen().includes('Focus > #42abc')); send('\\u001b'); await until(()=>screen().includes('Focus: #42'));
 send('\\u001b'); await until(()=>!screen().includes('Focus:'));
 writeFileSync(root+'/ordinary.txt',screen());
 const after=readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+'.calls','utf8');
 if(before!==after) throw Error('Search acquired extra data');
 writeFileSync(root+'/evidence.json',JSON.stringify({before,after}));
} catch(error) {writeFileSync(root+'/failure',String(error));}
finally {send('\\u0003');}
`);
 const result=capture({cols,rows:24,signal:'none',settle:35,args:'--repo acme/widget --refresh 300 --background off',configHome:root,env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1'},stdin:`node '${driver}'`});
 assert.equal(result.exitCode,0);
 assert.equal(result.altEnter, result.altExit);
 assert.equal(readFileSync(join(root,'evidence.json'),'utf8').length>0,true,
   (()=>{try{return readFileSync(join(root,'failure'),'utf8');}catch{return 'driver incomplete';}})());
 assert.match(readFileSync(join(root,'search.txt'),'utf8'),/Focus: #42/);
 assert.doesNotMatch(readFileSync(join(root,'ordinary.txt'),'utf8'),/Focus:/);
});


function focusBox(t) {
 const root=mkdtempSync(join(tmpdir(),'glance-focus-flow-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 return root;
}

function focusDriver(root, program, dimensions={cols:100,rows:24}) {
 const path=join(root,'flow.mjs');
 writeFileSync(path,`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('./capture.mjs',import.meta.url).href)};
const root=${JSON.stringify(root)}, dimensions=${JSON.stringify(dimensions)};
const started=Date.now();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const raw=()=>readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8');
const screen=()=>parseCapture(raw(),dimensions).finalFrame.lines.join('\\n');
const calls=()=>readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+'.calls','utf8').split('\\n').filter(Boolean);
const send=value=>process.stdout.write(value);
const until=async predicate=>{const deadline=Date.now()+18000;while(Date.now()<deadline){
 try{if(predicate())return;}catch{}await pause(40);}throw Error('UI timeout: '+String(predicate)+'\\n'+screen());};
const save=(name,value)=>writeFileSync(root+'/'+name,typeof value==='string'?value:JSON.stringify(value));
try {${program}; save('complete','yes');}
catch(error){save('failure',String(error));}
finally{send('\\u0003');}
`);
 return `node '${path}'`;
}

function assertFocusFlow(root, result) {
 let failure='';
 try{failure=readFileSync(join(root,'failure'),'utf8');}catch{/* no driver error */}
 assert.equal(failure,'',failure);
 assert.equal(readFileSync(join(root,'complete'),'utf8'),'yes');
 assert.equal(result.exitCode,0);
 assert.equal(result.altEnter,result.altExit);
}

test('Focus corrects an invalid date, opens original issue 41, and keeps source time on typing',t=>{
 const root=focusBox(t);
 const result=capture({cols:100,rows:24,signal:'none',settle:45,configHome:root,
  args:'--repo acme/widget --tab issues --refresh 300 --background off',
  env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1'},stdin:focusDriver(root,`
await until(()=>screen().includes('SIGTERM erases') && screen().includes('of '));
const source=()=>Object.values(JSON.parse(readFileSync(root+'/gh-glance/dashboard-cache.json','utf8')).targets)
 .map(entry=>entry.tabs.issues).filter(Boolean).map(tab=>({lastOk:tab.lastOk,metaAt:tab.meta.at,data:tab.data}));
await until(()=>source().length===1);
const before={calls:calls(),source:source()};
send('/'); await until(()=>screen().includes('Focus >'));
send('updated:>=2026-02-30'); await until(()=>screen().includes('Focus > updated:>=2026-02-30'));
send('\\r'); await until(()=>screen().includes('valid UTC calendar date'));
save('invalid.txt',screen());
send('\\u007f'); await until(()=>screen().includes('Focus > updated:>=2026-02-3') && !screen().includes('valid UTC calendar date'));
send('\\u007f'); await until(()=>/Focus > updated:>=2026-02-\\s*[│]/.test(screen()));
send('28'); await until(()=>screen().includes('Focus > updated:>=2026-02-28'));
send('\\r'); await until(()=>screen().includes('Focus: updated:>=2026-02-28') && screen().includes('3/3'));
save('corrected.txt',screen());
send('\\u001b'); await until(()=>!screen().includes('Focus:'));
send('/'); await until(()=>screen().includes('Focus >'));
send('#41'); await until(()=>screen().includes('Focus > #41'));
send('\\r'); await until(()=>screen().includes('Focus: #41') && screen().includes('1/3'));
send('j'); await until(()=>screen().split('\\n').some(line=>line.includes('#41 ') && line.includes('>')));
save('selected.txt',screen());
send('\\r'); await until(()=>calls().some(line=>line==='open https://github.com/acme/widget/issues/41'));
const after={calls:calls().filter(line=>!line.startsWith('open ')),source:source()};
save('source.json',{before,after});
`) });
 assertFocusFlow(root,result);
 assert.match(readFileSync(join(root,'invalid.txt'),'utf8'),/valid UTC calendar date/);
 assert.match(readFileSync(join(root,'corrected.txt'),'utf8'),/3\/3/);
 const evidence=JSON.parse(readFileSync(join(root,'source.json'),'utf8'));
 assert.deepEqual(evidence.after,evidence.before);
 assert.equal(result.fixtureCalls.filter(line=>line==='open https://github.com/acme/widget/issues/41').length,1);
});

test('Focus unsupported Actions notice recovers through Issues without acquiring on slash',t=>{
 const root=focusBox(t);
 const result=capture({cols:100,rows:24,signal:'none',settle:40,configHome:root,
  args:'--repo acme/widget --refresh 300 --background off',
  env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1'},stdin:focusDriver(root,`
await until(()=>screen().includes('ci: pin actions') && screen().includes('Watching'));
const before=calls();
send('/'); await until(()=>screen().includes('Focus applies to Issues or Pull requests'));
save('unsupported.txt',screen());
if(JSON.stringify(before)!==JSON.stringify(calls()))throw Error('Unsupported Focus dispatched a request');
send('2'); await until(()=>screen().includes('SIGTERM erases') && screen().includes('of '));
send('/'); await until(()=>screen().includes('Focus >'));
send('#41'); await until(()=>screen().includes('Focus > #41'));
send('\\r'); await until(()=>screen().includes('Focus: #41') && screen().includes('1/3'));
save('recovered.txt',screen());
`) });
 assertFocusFlow(root,result);
 assert.match(readFileSync(join(root,'unsupported.txt'),'utf8'),/press 2 or 3/);
 assert.match(readFileSync(join(root,'recovered.txt'),'utf8'),/1\/3/);
 assert.equal(result.fixtureCalls.filter(line=>line.startsWith('graphql issues.page')).length,1);
});

test('Focus keeps 256-byte query coverage visible through CSI, mouse input and live resize',t=>{
 const root=focusBox(t);
 const result=capture({cols:40,rows:24,resize:{cols:100,rows:24,afterSeconds:10},
  signal:'none',settle:40,configHome:root,
  args:'--repo acme/widget --tab issues --refresh 300 --background off',
  env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1'},stdin:focusDriver(root,`
await until(()=>screen().includes('of '));
const before=calls();
send('/'); await until(()=>screen().includes('Focus >'));
send('q'.repeat(256)); await until(()=>screen().includes('Focus > q'));
send('z'); await until(()=>screen().includes('256 UTF-8 bytes'));
save('limit-narrow.txt',screen());
for(const token of ['\\u001b[999~','\\u001b[A','\\u001b[<64;10;5M']){
 send(token); await pause(150);
 if(!screen().includes('Focus > q') || !screen().includes('256 UTF-8 bytes'))throw Error('Control input changed the editor');
}
send('\\r'); await until(()=>screen().includes('Focus:') && screen().includes('0/3'));
save('submitted-narrow.txt',screen());
await until(()=>Date.now()-started>11000);
dimensions.cols=100;
await until(()=>screen().includes('Focus:') && screen().includes('0/3'));
save('submitted-wide.txt',screen());
send('/'); await until(()=>screen().includes('Focus >'));
send('z'); await until(()=>screen().includes('256 UTF-8 bytes'));
send('\\u001b'); await until(()=>screen().includes('Focus:') && !screen().includes('256 UTF-8 bytes'));
if(JSON.stringify(before)!==JSON.stringify(calls()))throw Error('Editor/control/resize acquired data');
save('no-requests.json',{before,after:calls()});
`,{cols:40,rows:24}) });
 assertFocusFlow(root,result);
 assert.match(readFileSync(join(root,'limit-narrow.txt'),'utf8'),/256 UTF-8 bytes/);
 for(const size of ['narrow','wide']){
  const frame=readFileSync(join(root,`submitted-${size}.txt`),'utf8');
  assert.match(frame,/0\/3/);
  assert.match(frame,/No local match/);
 }
 assert.ok(result.finalFrame.widest<=99);
});

const FOCUS_COLLECTOR_CONFIG={version:1,providers:{personal:{type:'gh',host:'github.com'}},
 targets:[{host:'github.com',repo:'acme/widget',provider:'personal'}]};

for(const connection of ['local','ssh:studio']) test(`Focus connected source ${connection} recovers unloaded to empty to loaded and never opens a removed selection`,async t=>{
 const root=focusBox(t);
 const sourceAt=Date.now()-120000;
 const jevImports=join(root,'jev-imports'),jevCalls=join(root,'jev-calls');writeFileSync(jevImports,'');writeFileSync(jevCalls,'');
 const env={GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',TYPESAFE_API_KEY:'dummy-test-key',GH_GLANCE_TEST_JEV_IMPORTS:jevImports,GH_GLANCE_TEST_JEV_CALLS:jevCalls,NODE_OPTIONS:`--import=${new URL('./fixtures/jev-child-guard.mjs',import.meta.url).pathname} --import=${new URL('./fixtures/jev-fetch.mjs',import.meta.url).pathname}`};
 if(connection==='ssh:studio'){
  const bin=join(root,'bin');mkdirSync(bin);
  symlinkSync(new URL('../../index.mjs',import.meta.url).pathname,join(bin,'gh-glance'));
  symlinkSync(new URL('../fixtures/ssh',import.meta.url).pathname,join(bin,'ssh'));
  env.PATH=`${bin}:${new URL('./fixtures/',import.meta.url).pathname}:${process.env.PATH}`;
  env.HOME=root;
 }
 const rows=[41,37].map(number=>({number,title:`Focus source issue ${number}`,author:'ana',label:'bug',
  updatedAt:'2026-10-20T00:00:00Z',url:`https://github.com/acme/widget/issues/${number}`}));
 let refreshes=0;
 const observed=[];
 const runtime={subscribe({resource,onSnapshot}){
  const deliver=()=>{
   if(resource!=='issues')return;
   const sourceRows=refreshes===1?[]:refreshes===2?rows:[rows[1]];
   const snapshot={generation:refreshes,rows:sourceRows,pageInfo:{loadedPages:1,hasNextPage:refreshes>=2},
    lastSuccessAt:sourceAt+refreshes*1000,lastChangedAt:sourceAt+refreshes*1000,nextDueAt:Date.now()+300000,
    hold:null,meta:{at:sourceAt+refreshes*1000,truncated:refreshes>=2},securityNotes:[],securityBlind:false,capabilities:{}};
   observed.push({refresh:refreshes,sourceAt:snapshot.lastSuccessAt,numbers:sourceRows.map(row=>row.number)});
   onSnapshot(snapshot);
  };
  return {updateDemand(){},inspect(){},close(){},refresh(){if(resource==='issues' && existsSync(join(root,'permit-refresh'))){
   rmSync(join(root,'permit-refresh'));refreshes+=1;deliver();
  }}};
 },close(){}};
 const service=await createCollectorService({config:normalizeCollectorConfig(FOCUS_COLLECTOR_CONFIG),
  pathOptions:{env:{XDG_CONFIG_HOME:root},platform:process.platform},runtime});
 t.after(()=>service.close());
 const result=await captureAsync({cols:100,rows:24,signal:'none',settle:45,configHome:root,
  args:`--connect ${connection} --repo acme/widget --tab issues --background off`,
  env,stdin:focusDriver(root,`
await until(()=>screen().includes('Issues'));
send('/'); await until(()=>screen().includes('Focus >') && screen().includes('Source not loaded'));
save('unloaded.txt',screen());
send('\\r'); await until(()=>screen().includes('Focus: all loaded rows'));
save('permit-refresh','yes');
send('r'); await until(()=>screen().includes('0/0 matches'));
save('empty.txt',screen());
save('permit-refresh','yes');
send('r'); await until(()=>screen().includes('2/2 matches') && screen().includes('Focus source issue 41'));
send('/'); await until(()=>screen().includes('Focus >'));
send('#41'); await until(()=>screen().includes('Focus > #41'));
send('\\r'); await until(()=>screen().includes('Focus: #41') && screen().includes('1/2 matches'));
send('j'); await until(()=>screen().split('\\n').some(line=>line.includes('#41 ') && line.includes('>')));
send('\\r'); await until(()=>calls().some(line=>line==='open https://github.com/acme/widget/issues/41'));
const before=calls().filter(line=>line.startsWith('open ')).length;
save('permit-refresh','yes');
send('r'); await until(()=>screen().includes('Focus: #41') && screen().includes('0/1 matches') && /More source pages[\\s│]*not searched/.test(screen()));
save('removed.txt',screen());
send('\\r'); await pause(200);
if(calls().filter(line=>line.startsWith('open ')).length!==before)throw Error('Removed selection opened another row');
send('\\u001b'); await until(()=>!screen().includes('Focus:') && screen().includes('Focus source issue 37'));
save('ordinary-after-removal.txt',screen());
`) });
 assertFocusFlow(root,result);
 assert.equal(readFileSync(jevImports,'utf8'),'');assert.equal(readFileSync(jevCalls,'utf8'),'');
 assert.equal(refreshes,3);
 assert.deepEqual(observed.map(item=>item.numbers),[[],[41,37],[37]]);
 assert.deepEqual(observed.map(item=>item.sourceAt),[sourceAt+1000,sourceAt+2000,sourceAt+3000]);
 assert.match(readFileSync(join(root,'unloaded.txt'),'utf8'),/Source not loaded/);
 assert.match(readFileSync(join(root,'empty.txt'),'utf8'),/0\/0 matches/);
 assert.match(readFileSync(join(root,'removed.txt'),'utf8'),/0\/1 matches/);
 assert.doesNotMatch(readFileSync(join(root,'removed.txt'),'utf8'),/Last check found no open issues/);
 assert.match(readFileSync(join(root,'removed.txt'),'utf8'),/More source pages[\s│]*not searched/);
 assert.equal(result.fixtureCalls.filter(line=>line.startsWith('api ')||line.startsWith('graphql ')).length,0);
});


test('Focus PR branch filter opens pull 40 and preserves the two original source rows',t=>{
 const root=focusBox(t);
 const result=capture({cols:100,rows:24,signal:'none',settle:40,configHome:root,
  args:'--repo acme/widget --tab prs --refresh 300 --background off',
  env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1'},stdin:focusDriver(root,`
await until(()=>screen().includes('release: v0.2.0') && screen().includes('of '));
const source=()=>Object.values(JSON.parse(readFileSync(root+'/gh-glance/dashboard-cache.json','utf8')).targets)
 .map(entry=>entry.tabs.prs).filter(Boolean).map(tab=>({lastOk:tab.lastOk,metaAt:tab.meta.at,data:tab.data}));
await until(()=>source().length===1 && source()[0].data.length===2);
const before={calls:calls(),source:source()};
send('/'); await until(()=>screen().includes('Focus >'));
send('branch:develop #40'); await until(()=>screen().includes('Focus > branch:develop #40'));
send('\\r'); await until(()=>screen().includes('Focus: branch:develop #40') && screen().includes('1/2 matches'));
send('j'); await until(()=>screen().split('\\n').some(line=>line.includes('#40 ') && line.includes('>')));
send('\\r'); await until(()=>calls().some(line=>line==='open https://github.com/acme/widget/pull/40'));
save('pr-filter.txt',screen());
send('\\u001b'); await until(()=>!screen().includes('Focus:') && screen().includes('wip: scrolling'));
const after={calls:calls().filter(line=>!line.startsWith('open ')),source:source()};
save('pr-source.json',{before,after});
`) });
 assertFocusFlow(root,result);
 const evidence=JSON.parse(readFileSync(join(root,'pr-source.json'),'utf8'));
 assert.deepEqual(evidence.after,evidence.before);
 assert.equal(evidence.after.source[0].data.length,2);
 assert.match(readFileSync(join(root,'pr-filter.txt'),'utf8'),/1\/2 matches/);
 assert.equal(result.fixtureCalls.filter(line=>line==='open https://github.com/acme/widget/pull/40').length,1);
 assert.equal(result.fixtureCalls.filter(line=>line.includes('/issues/40')).length,0);
});
