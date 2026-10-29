import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {capture} from './capture.mjs';
const reader=new URL('./capture.mjs',import.meta.url).href,product=new URL('../../index.mjs',import.meta.url).href;
function scenario(t,{cols=100,config={},fixture={},program,args='',userType='User',warm=false,jev=true,initialTab='issues'}={}){
 const root=mkdtempSync(join(tmpdir(),'glance-attention-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const name of ['calls','imports','events'])writeFileSync(join(root,name),'');writeFileSync(join(root,'config.json'),JSON.stringify(config));writeFileSync(join(root,'attention.json'),JSON.stringify(fixture));
 const budget={limit:5000,remaining:5000,used:0,resetMs:Date.now()+3600000};writeFileSync(join(root,'state.json'),JSON.stringify({createdAt:Date.now(),core:budget,graphql:budget,events:[]}));
 const driver=join(root,'driver.mjs');writeFileSync(driver,String.raw`import assert from 'node:assert/strict';import {readFileSync,writeFileSync,rmSync} from 'node:fs';import {parseCapture} from ${JSON.stringify(reader)};import {identityRegistryRoot,inspectIdentityRegistry,createQuotaScope,recordResourceBlock,dashboardCachePath,inspectGovernor} from ${JSON.stringify(product)};
const root=${JSON.stringify(root)},cols=${cols},pause=ms=>new Promise(r=>setTimeout(r,ms)),send=s=>process.stdout.write(s);
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols,rows:24}).finalFrame.lines.join('\n');
const jevCalls=()=>readFileSync(root+'/calls','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const ghCalls=()=>readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+'.calls','utf8').split('\n').filter(Boolean);
const detailEvents=()=>readFileSync(root+'/events','utf8').split('\n').filter(Boolean).map(JSON.parse);
const detailCalls=()=>ghCalls().filter(line=>line.includes('attention.details'));
const until=async(fn,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(fn())return;}catch{}await pause(40);}throw Error('UI barrier '+fn+'\n'+screen());};
const seek=async(text)=>{await pause(150);for(let i=0;i<16&&!screen().includes(text);i++){send('\u001b[6~');await pause(80);}if(!screen().includes(text))throw Error('seek '+text+'\\n'+screen());};
const detailReady=async(text,action='m')=>{await pause(200);for(let attempt=0;attempt<5;attempt++){for(let page=0;page<10&&!screen().includes(text)&&!screen().includes('Attention admission unavailable')&&!screen().includes('Source refresh unavailable');page++){send('\u001b[5~');await pause(70);}await until(()=>screen().includes(text)||screen().includes('Attention admission unavailable')||screen().includes('Source refresh unavailable'));if(screen().includes(text))return;const match=/Retry after ([0-9T:.-]+Z)/.exec(screen().replace(/[│\n]/g,' ').replace(/\s+/g,' '));const count=detailCalls().length;await pause(match?Math.max(100,Date.parse(match[1])-Date.now()+150):2400);assert.equal(detailCalls().length,count);send(screen().includes('Source refresh unavailable')?'r':action);await pause(200);}throw Error('explicit detail retries exhausted\\n'+screen());};
const save=name=>writeFileSync(root+'/'+name+'.txt',screen());
const loadLists=async()=>{await until(()=>screen().includes('SIGTERM'));send('3');await until(()=>screen().includes('release: v0.2.0'));send('2');await until(()=>screen().includes('SIGTERM'));};
try{${program}
writeFileSync(root+'/complete','yes');}catch(e){writeFileSync(root+'/failure',String(e));}finally{send('\u0003');}`);
 const preloads=['jev-fetch.mjs','jev-child-guard.mjs'].map(name=>`--import=${new URL('./fixtures/'+name,import.meta.url).pathname}`).join(' ');
 const options={cols,rows:24,signal:'none',settle:100,configHome:root,args:`--repo acme/widget --tab ${initialTab} --refresh 300 --background off ${jev?'--jev':''} ${args}`,env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',TYPESAFE_API_KEY:'synthetic-jev-key',GH_GLANCE_FIXTURE_STATE:join(root,'state.json'),GH_GLANCE_ATTENTION_FILE:join(root,'attention.json'),GH_GLANCE_ATTENTION_EVENTS:join(root,'events'),GH_GLANCE_FIXTURE_USER_TYPE:userType,GH_GLANCE_TEST_JEV_CALLS:join(root,'calls'),GH_GLANCE_TEST_JEV_CONFIG:join(root,'config.json'),GH_GLANCE_TEST_JEV_IMPORTS:join(root,'imports'),NODE_OPTIONS:preloads},stdin:`node '${driver}'`};
 if(warm)capture({...options,stdin:`sleep 3; printf '\\003'`});
 const result=capture(options);
 if(process.env.GH_GLANCE_ATTENTION_CAPTURES){
  mkdirSync(process.env.GH_GLANCE_ATTENTION_CAPTURES,{recursive:true});const name=t.name.replace(/[^a-zA-Z0-9-]+/g,'-');
  for(const [source,suffix]of [['events','.events.jsonl'],['source-proof.json','.source-proof.json']])if(existsSync(join(root,source)))writeFileSync(join(process.env.GH_GLANCE_ATTENTION_CAPTURES,name+suffix),readFileSync(join(root,source)));
 }

 if(existsSync(join(root,'failure'))&&process.env.GH_GLANCE_ATTENTION_CAPTURES){writeFileSync(join(process.env.GH_GLANCE_ATTENTION_CAPTURES,`failure-${cols}.calls`),result.fixtureCalls.join('\n'));}
 assert.equal(result.exitCode,0);assert.equal(existsSync(join(root,'failure')),false,existsSync(join(root,'failure'))?readFileSync(join(root,'failure'),'utf8'):'');assert.equal(readFileSync(join(root,'complete'),'utf8'),'yes');assert.equal(result.altEnter,result.altExit);assert.ok(result.finalFrame.widest<=cols-1);
 if(process.env.GH_GLANCE_ATTENTION_CAPTURES){mkdirSync(process.env.GH_GLANCE_ATTENTION_CAPTURES,{recursive:true});for(const name of ['queue','unknown','consent','badges','recovery'])if(existsSync(join(root,name+'.txt')))writeFileSync(join(process.env.GH_GLANCE_ATTENTION_CAPTURES,`phase5-${cols}-${name}.txt`),readFileSync(join(root,name+'.txt')));}
 return{root,result};
}
for(const cols of [100,40])test(`attention ${cols}: explicit details, deterministic queue, unknowns and metadata-only badges`,t=>scenario(t,{cols,config:{attentionProbabilities:{reported_regression:.9,user_visible_impact:.9}},program:String.raw`
await loadLists();assert.equal(detailCalls().length,0);assert.equal(jevCalls().length,0);send('a');await detailReady('One detail batch loaded');save('queue');assert.equal(detailCalls().length,1);assert.equal(jevCalls().length,0);
await seek('Your review requested');assert.ok(!screen().includes('overdue'));send('u');await seek('Unknown/unqueried');save('unknown');send('u');await pause(300);send('J');await pause(300);await seek('Enter Send');save('consent');assert.equal(jevCalls().length,0);send('\u001b');await pause(100);assert.equal(jevCalls().length,0);
send('J');await seek('Enter Send');send('\r');await until(()=>jevCalls().length>0);await seek('Reports regression');save('badges');assert.equal(detailCalls().length,1);assert.ok(!JSON.stringify(jevCalls()[0].request).includes('acme/widget'));
send('x');await seek('permission revoked');assert.equal(detailCalls().length,1);send('\u001b');await until(()=>screen().includes('SIGTERM'));
`}));

test('attention cached human identity explicitly verifies /user and recovers without hidden detail acquisition',t=>scenario(t,{warm:true,program:String.raw`
await loadLists();send('a');await until(()=>screen().includes('Human user proof unavailable'));assert.equal(detailCalls().length,0);const users=ghCalls().filter(s=>s.includes('api -i user')).length;send('r');await detailReady('One detail batch loaded');assert.equal(detailCalls().length,1);assert.equal(ghCalls().filter(s=>s.includes('api -i user')).length,users+1);assert.equal(jevCalls().length,0);save('recovery');
`}));
test('attention Bot identity remains unsupported after explicit proof and ordinary navigation stays usable',t=>scenario(t,{userType:'Bot',program:String.raw`
await loadLists();send('a');await until(()=>screen().includes('Human user proof unavailable'));send('r');await until(()=>screen().includes('account is not a User'));assert.equal(detailCalls().length,0);assert.equal(jevCalls().length,0);send('\u001b');await until(()=>screen().includes('SIGTERM'));
`}));
for(const target of ['local','ssh:fixture'])test(`attention connected ${target} is explicitly unsupported without local fallback`,t=>scenario(t,{jev:false,args:`--connect ${target}`,program:String.raw`
await pause(1600);send('a');await until(()=>screen().includes('Attention requires verified human'));assert.equal(detailCalls().length,0);assert.equal(jevCalls().length,0);send('\u001b');await pause(100);assert.ok(!screen().includes('Attention requires verified human'));
`}));
const manyIssues=Array.from({length:55},(_,i)=>({number:1000+i,title:'SIGTERM synthetic '+i,author:{login:'fixture'},labels:[{name:'bug'}],updatedAt:new Date(Date.parse('2026-10-28T12:00:00Z')-i*60000).toISOString()}));
test('attention 25/25/remainder, no automatic drain, first-page refresh, prior-as-of error and retry',t=>scenario(t,{fixture:{sources:{issues:manyIssues,prs:[]}},program:String.raw`
await until(()=>screen().includes('SIGTERM'));for(let i=0;i<4;i++){send('\u001b[6~');await pause(140);}await until(()=>ghCalls().filter(s=>s.includes('graphql issues.page')).length===2);await until(()=>screen().includes('Issues (55)'));send('a');await detailReady('Details 25/55');assert.equal(detailCalls().length,1);await pause(250);assert.equal(detailCalls().length,1);send('m');await detailReady('Details 50/55');assert.equal(detailCalls().length,2);send('m');await detailReady('Details 55/55');assert.equal(detailCalls().length,3);send('m');await until(()=>screen().includes('All frozen candidates'));assert.equal(detailCalls().length,3);
for(let i=0;i<25;i++){send('k');await pause(70);}send('\r');await until(()=>ghCalls().some(s=>s.includes('open https://github.com/acme/widget/issues/1049')));
const before=ghCalls().filter(s=>s.includes('graphql issues.page')).length;const f=JSON.parse(readFileSync(root+'/attention.json','utf8'));f.errors=true;writeFileSync(root+'/attention.json',JSON.stringify(f));send('r');await detailReady('permission/schema unavailable');assert.ok(screen().includes('Details 55/55'));assert.ok(ghCalls().filter(s=>s.includes('graphql issues.page')).length>=before+1);assert.ok(ghCalls().filter(s=>s.includes('graphql pulls.page')).length>=1);assert.ok(ghCalls().filter(s=>s.includes('graphql issues.page')).slice(before).every(s=>s.includes('after=-')));assert.equal(detailCalls().length,4);await seek('Assigned to you');save('recovery');
f.errors=false;writeFileSync(root+'/attention.json',JSON.stringify(f));send('r');await detailReady('Details 25/50');assert.equal(detailCalls().length,5);assert.equal(jevCalls().length,0);send('\r');await until(()=>ghCalls().some(s=>s.includes('open https://github.com/acme/widget/issues/1024')));send('m');await detailReady('Details 50/50');send('j');await pause(100);send('k');await until(()=>screen().includes('> [Tier 2] Issue #1024'));assert.equal(detailCalls().length,6);
`}));
test('attention pending badges keep selection and GitHub navigation responsive; explicit refresh clears old badges',t=>scenario(t,{config:{delay:1200,attentionProbabilities:{reported_regression:1,user_visible_impact:1}},program:String.raw`
await loadLists();send('a');await until(()=>screen().includes('One detail batch loaded'));send('J');await seek('Enter Send');send('\r');await until(()=>jevCalls().length===1);send('j');await until(()=>screen().includes('> [Tier 1] PR #40'));send('\r');await until(()=>ghCalls().some(s=>s.includes('open https://github.com/acme/widget/pull/40')));await seek('Reports regression');const count=detailCalls().length;send('r');await detailReady('One detail batch loaded');assert.equal(detailCalls().length,count+1);assert.ok(!screen().includes('Reports regression'));assert.equal(jevCalls().length,1);
`}));

test('attention canceled list refresh retires old provenance before late source publication and explicit restart recovers',t=>scenario(t,{program:String.raw`
await loadLists();send('a');await detailReady('One detail batch loaded');const before=detailCalls().length;
const issues=JSON.parse(readFileSync(new URL('./fixtures/issues.json',${JSON.stringify(reader)}),'utf8'));issues[0].title='Source changed during canceled attention refresh';
writeFileSync(root+'/attention.json',JSON.stringify({sources:{issues},sourceDelay:900}));send('r');await until(()=>screen().includes('Refreshing Issues'));send('\u001b');await until(()=>screen().includes('Source manifest changed'));send('J');await pause(250);assert.equal(jevCalls().length,0);assert.equal(detailCalls().length,before);
writeFileSync(root+'/attention.json',JSON.stringify({sources:{issues}}));send('r');await detailReady('One detail batch loaded');assert.equal(detailCalls().length,before+1);assert.equal(jevCalls().length,0);save('recovery');
`}));
test('attention detail completion preserves pending Unknown navigation and composite browser selection',t=>scenario(t,{fixture:{sources:{issues:manyIssues,prs:[]}},program:String.raw`
await until(()=>screen().includes('SIGTERM'));for(let i=0;i<4;i++){send('\u001b[6~');await pause(140);}await until(()=>screen().includes('Issues (55)'));send('a');await detailReady('Details 25/55');const f=JSON.parse(readFileSync(root+'/attention.json','utf8'));f.delay=1100;writeFileSync(root+'/attention.json',JSON.stringify(f));
for(let attempt=0;attempt<5;attempt++){send('m');await pause(250);await until(()=>detailEvents().filter(e=>e.kind==='start').length===2||screen().includes('Attention admission unavailable'));if(detailEvents().filter(e=>e.kind==='start').length===2)break;const match=/Retry after ([0-9T:.-]+Z)/.exec(screen().replace(/[│\n]/g,' ').replace(/\s+/g,' '));await pause(match?Math.max(100,Date.parse(match[1])-Date.now()+150):2400);}
await until(()=>detailEvents().filter(e=>e.kind==='start').length===2);send('u');await pause(150);send('j');await pause(150);send('\u001b[6~');await until(()=>detailEvents().filter(e=>e.kind==='end').length===2);await pause(250);send('\r');await until(()=>ghCalls().some(s=>s.includes('open https://github.com/acme/widget/issues/1050')));assert.equal(detailCalls().length,2);assert.equal(jevCalls().length,0);send('u');await pause(150);send('m');await detailReady('Details 55/55');assert.equal(detailCalls().length,3);
`}));
test('attention tab retirement cancels detail and badge flights before late render, cache or next model chunk',t=>scenario(t,{fixture:{sources:{issues:manyIssues,prs:[]}},config:{delay:1000,attentionProbabilities:{reported_regression:1}},program:String.raw`
await until(()=>screen().includes('SIGTERM'));send('a');await detailReady('One detail batch loaded');send('J');await seek('Enter Send');send('\r');await until(()=>jevCalls().length===1);send('3');await until(()=>screen().includes('[3:'));assert.ok(!screen().includes('Personal attention'));await pause(1200);assert.equal(jevCalls().length,1);assert.ok(!screen().includes('Reports regression'));
send('2');await until(()=>screen().includes('SIGTERM'));send('a');await detailReady('One detail batch loaded');const before=detailCalls().length;const f=JSON.parse(readFileSync(root+'/attention.json','utf8'));f.delay=1000;writeFileSync(root+'/attention.json',JSON.stringify(f));send('m');await pause(200);if(screen().includes('Attention admission unavailable')){await pause(2500);send('m');await pause(200);}send('3');await until(()=>screen().includes('[3:'));assert.ok(!screen().includes('Personal attention'));await pause(1200);assert.equal(jevCalls().length,1);assert.ok(detailCalls().length<=before+1);
`}));

test('attention unloaded sources make zero requests until explicit r loads first pages and one detail batch',t=>scenario(t,{initialTab:'actions',program:String.raw`
await until(()=>screen().includes('ci: pin actions')&&screen().includes('Watching'));const before=ghCalls().length;send('a');await until(()=>screen().includes('No loaded candidates'));assert.equal(detailCalls().length,0);assert.equal(jevCalls().length,0);assert.equal(ghCalls().length,before);send('r');await detailReady('One detail batch loaded');assert.equal(detailCalls().length,1);assert.equal(ghCalls().filter(s=>s.includes('graphql issues.page')).length,1);assert.equal(ghCalls().filter(s=>s.includes('graphql pulls.page')).length,1);assert.equal(jevCalls().length,0);
`}));
test('attention an intentional governor admission hold sends zero details and the displayed deadline permits one explicit retry',t=>scenario(t,{program:String.raw`
await loadLists();const registryRoot=identityRegistryRoot({env:{XDG_CONFIG_HOME:root}}),registry=inspectIdentityRegistry(registryRoot),[credentialKey,identity]=Object.entries(registry.value.identities)[0],scope=createQuotaScope({...identity,credentialKey},{root:registryRoot});const retryAt=Date.now()+2500;assert.equal(recordResourceBlock(scope,'graphql',retryAt,'rate-limit').ok,true);send('a');await until(()=>screen().includes('Attention admission unavailable'));assert.equal(detailCalls().length,0);assert.equal(jevCalls().length,0);assert.ok(screen().includes(new Date(retryAt).toISOString()));await pause(Math.max(0,retryAt-Date.now()+150));assert.equal(detailCalls().length,0);send('m');await detailReady('One detail batch loaded');assert.equal(detailCalls().length,1);assert.equal(jevCalls().length,0);
`}));

const stableReviewPrs=JSON.parse(readFileSync(new URL('./fixtures/prs.json',import.meta.url),'utf8')).map(row=>({...row,reviewDecision:row.reviewDecision??'REVIEW_REQUIRED'}));
test('attention source changes during refreshed detail flight retire pending state and explicit refresh recovers',t=>scenario(t,{fixture:{sources:{prs:stableReviewPrs}},program:String.raw`
await loadLists();send('a');await detailReady('One detail batch loaded');assert.equal(detailEvents().filter(e=>e.kind==='start').length,1);assert.equal(jevCalls().length,0);
const gate=root+'/held-attention-response',issues=JSON.parse(readFileSync(new URL('./fixtures/issues.json',${JSON.stringify(reader)}),'utf8')),f=JSON.parse(readFileSync(root+'/attention.json','utf8'));
issues[0].title='Held refresh source T1';f.sources.issues=issues;f.responseGateFile=gate;writeFileSync(gate,'hold');writeFileSync(root+'/attention.json',JSON.stringify(f));
try{
 send('r');await pause(200);
 for(let attempt=0;attempt<5;attempt++){
  await until(()=>detailEvents().some(e=>e.kind==='attention-response-gate-enter')||screen().includes('Attention admission unavailable'));
  if(detailEvents().some(e=>e.kind==='attention-response-gate-enter'))break;
  const match=/Retry after ([0-9T:.-]+Z)/.exec(screen().replace(/[│\n]/g,' ').replace(/\s+/g,' '));await pause(match?Math.max(100,Date.parse(match[1])-Date.now()+150):2400);send('m');await pause(200);
 }
 await until(()=>detailEvents().some(e=>e.kind==='attention-response-gate-enter'));assert.equal(detailEvents().filter(e=>e.kind==='start').length,2);assert.ok(screen().includes('Loading candidates'));
 const registryRoot=identityRegistryRoot({env:{XDG_CONFIG_HOME:root}}),[credentialKey,identity]=Object.entries(inspectIdentityRegistry(registryRoot).value.identities)[0],scope=createQuotaScope({...identity,credentialKey},{root:registryRoot}),heldReservation=Object.entries(inspectGovernor(scope).value.reservations).find(([,reservation])=>reservation.status==='started'&&reservation.receipt?.dispatches.some(dispatch=>dispatch.operation==='attention:details'))?.[0];assert.ok(heldReservation);
 issues[0].title='Published source T2';writeFileSync(root+'/attention.json',JSON.stringify(f));send('R');
 const cache=dashboardCachePath({env:{XDG_CONFIG_HOME:root}});
 await until(()=>Object.values(JSON.parse(readFileSync(cache,'utf8')).targets).some(target=>target.tabs?.issues?.data.some(row=>row.title==='Published source T2')),10000);
 const published=Object.values(JSON.parse(readFileSync(cache,'utf8')).targets).find(target=>target.tabs?.issues?.data.some(row=>row.title==='Published source T2'));
 writeFileSync(root+'/source-proof.json',JSON.stringify({observedAt:Date.now(),sourceLastOk:published.tabs.issues.lastOk,verifiedTitle:'Published source T2',detailStarts:detailEvents().filter(e=>e.kind==='start').length,gateEnteredAt:detailEvents().find(e=>e.kind==='attention-response-gate-enter').at}));
 await until(()=>screen().includes('Source manifest changed')&&!screen().includes('Loading candidates'),1000);
 send('J');await pause(150);assert.equal(jevCalls().length,0);assert.equal(detailEvents().filter(e=>e.kind==='start').length,2);save('recovery');
 rmSync(gate,{force:true});
 await until(()=>inspectGovernor(scope).value.reservations[heldReservation]?.status==='completed',5000);await pause(250);
 assert.ok(screen().includes('Source manifest changed'));assert.ok(!screen().includes('Loading candidates'));assert.equal(detailEvents().filter(e=>e.kind==='start').length,2);assert.equal(jevCalls().length,0);
 delete f.responseGateFile;writeFileSync(root+'/attention.json',JSON.stringify(f));send('r');await detailReady('One detail batch loaded');await seek('Published source T2');
 assert.equal(detailEvents().filter(e=>e.kind==='start').length,3);assert.equal(jevCalls().length,0);assert.ok(!detailEvents().some(e=>e.kind==='attention-response-gate-expired'));send('J');await seek('Enter Send');assert.equal(jevCalls().length,0);
}finally{rmSync(gate,{force:true});}
`}));
