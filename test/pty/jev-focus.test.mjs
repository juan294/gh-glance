import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capture} from './capture.mjs';
for(const cols of [40,100])test(`Jev Focus ${cols}: explicit consent, uncertain coverage, revoke and local fallback`,t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-focus-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const calls=join(root,'jev-calls'),config=join(root,'config.json');writeFileSync(calls,'');writeFileSync(join(root,'imports'),'');writeFileSync(config,JSON.stringify({probabilities:[.9,.5,.1]}));
 const driver=join(root,'driver.mjs');
 writeFileSync(driver,`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('./capture.mjs',import.meta.url).href)};
const root=${JSON.stringify(root)},cols=${cols};const pause=ms=>new Promise(r=>setTimeout(r,ms));
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols,rows:24}).finalFrame.lines.join('\\n');
const send=s=>process.stdout.write(s);const jevCalls=()=>readFileSync(root+'/jev-calls','utf8').trim().split('\\n').filter(Boolean);
const until=async p=>{const end=Date.now()+18000;while(Date.now()<end){try{if(p())return;}catch{}await pause(40);}throw Error('UI timeout '+String(p)+'\\n'+screen());};
try{
 await until(()=>screen().includes('of '));const sourceCalls=()=>readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+'.calls','utf8').split('\\n').filter(line=>line.startsWith('graphql issues.page'));let initialSource=JSON.stringify(sourceCalls());if(readFileSync(root+'/imports','utf8'))throw Error('startup import');if(jevCalls().length)throw Error('startup call');
 send('/');await until(()=>screen().includes('Focus >'));send('#41');await pause(70);send('\\r');await until(()=>screen().includes('Focus: #41'));send('J');await until(()=>screen().includes('Exact filters only'));if(jevCalls().length || readFileSync(root+'/imports','utf8'))throw Error('filter-only import/call');send('\\u001b');await until(()=>!screen().includes('Focus:'));
 send('/');await until(()=>screen().includes('Focus >'));send('authentication');await until(()=>screen().includes('Focus >'));send('\\r');await until(()=>screen().includes('Focus:'));
 if(jevCalls().length || readFileSync(root+'/imports','utf8'))throw Error('typing import/call');const refreshCount=sourceCalls().length;send('r');await until(()=>sourceCalls().length>refreshCount);await pause(250);initialSource=JSON.stringify(sourceCalls());if(jevCalls().length || readFileSync(root+'/imports','utf8'))throw Error('refresh import/call');send('J');await until(()=>/TypeSafe/.test(screen()));
 writeFileSync(root+'/consent.txt',screen());if(readFileSync(root+'/imports','utf8'))throw Error('consent imported SDK');if(jevCalls().length)throw Error('consent dispatched');
 send('\\u001b');await until(()=>!screen().includes('TypeSafe'));if(jevCalls().length)throw Error('cancel dispatched');
 send('J');await until(()=>screen().includes('TypeSafe'));send('\\r');await until(()=>/3\\/3 eligible/.test(screen()));
 writeFileSync(root+'/result.txt',screen());if(jevCalls().length!==1)throw Error('expected one request');
 send('x');await until(()=>/permission revoked/.test(screen()));writeFileSync(root+'/revoked.txt',screen());
 send('J');await until(()=>screen().includes('TypeSafe'));send('\\u001b');await until(()=>!screen().includes('TypeSafe'));
 if(cols===100){
  writeFileSync(root+'/config.json',JSON.stringify({status:500}));
  send('/');await until(()=>screen().includes('Focus >'));send(' failures');await pause(100);send('\\r');await until(()=>screen().includes('Focus:'));
  send('J');await until(()=>screen().includes('TypeSafe'));send('\\r');await until(()=>screen().includes('Jev unavailable'));
  if(!screen().includes('3 unevaluated'))throw Error('Provider failure classified candidates');
  writeFileSync(root+'/config.json',JSON.stringify({probabilities:[.5,.5,.5]}));send('J');await until(()=>screen().includes('3/3 eligible') && screen().includes('3 uncertain'));
  writeFileSync(root+'/config.json',JSON.stringify({delay:6000}));send('/');await until(()=>screen().includes('Focus >'));send(' slow');await pause(100);send('\\r');await until(()=>screen().includes('Focus:'));
  send('J');await until(()=>screen().includes('Jev pending'));send('j');await pause(100);send('\\u001b');await until(()=>screen().includes('Jev canceled'));
  writeFileSync(root+'/config.json',JSON.stringify({probabilities:[.9,.5,.1]}));send('J');await until(()=>screen().includes('3/3 eligible'));
  writeFileSync(root+'/config.json',JSON.stringify({delay:6000}));send('/');await until(()=>screen().includes('Focus >'));send(' revoked');await pause(100);send('\\r');await until(()=>screen().includes('Focus:'));
  send('J');await until(()=>screen().includes('Jev pending'));send('x');await until(()=>screen().includes('permission revoked'));
  writeFileSync(root+'/config.json',JSON.stringify({probabilities:[.9,.5,.1]}));send('J');await until(()=>screen().includes('TypeSafe'));send('\\r');await until(()=>screen().includes('3/3 eligible'));
 }
 send('\\u001b');await until(()=>!screen().includes('Focus:'));if(JSON.stringify(sourceCalls())!==initialSource)throw Error('Semantic Focus acquired GitHub rows');writeFileSync(root+'/complete','yes');
}catch(error){writeFileSync(root+'/failure',String(error));}finally{send('\\u0003');}
`);
 const result=capture({cols,rows:24,signal:'none',settle:50,configHome:root,args:'--repo acme/widget --tab issues --refresh 300 --background off --jev',env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',TYPESAFE_API_KEY:'dummy-test-key',NODE_OPTIONS:`--import=${new URL('./fixtures/jev-fetch.mjs',import.meta.url).pathname} --import=${new URL('./fixtures/jev-child-guard.mjs',import.meta.url).pathname}`,GH_GLANCE_TEST_JEV_CHILDREN:join(root,'children'),GH_GLANCE_TEST_JEV_IMPORTS:join(root,'imports'),GH_GLANCE_TEST_JEV_CALLS:calls,GH_GLANCE_TEST_JEV_CONFIG:config},stdin:`node '${driver}'`});
 let failure='';try{failure=readFileSync(join(root,'failure'),'utf8');}catch{/* none */}assert.equal(failure,'',failure);
 assert.equal(readFileSync(join(root,'complete'),'utf8'),'yes');assert.equal(result.exitCode,0);assert.equal(result.altEnter,result.altExit);
 const children=readFileSync(join(root,'children'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(children.length>0);assert.ok(children.every(child=>child.present===false));
 const sent=JSON.parse(readFileSync(calls,'utf8').trim().split('\n')[0]);assert.equal(sent.method,'POST');assert.doesNotMatch(JSON.stringify(sent.request),/acme|widget|"author"|"url"/);
 for(const question of Object.values(sent.request.questions))assert.deepEqual(Object.keys(question.instructions.item).sort(),['kind','labels','title']);
 const consentFrame=readFileSync(join(root,'consent.txt'),'utf8');assert.match(consentFrame,/TypeSafe/);assert.match(consentFrame,/Enter[\s│]*Send/);assert.match(consentFrame,/Esc[\s│]*Cancel/);
 assert.match(readFileSync(join(root,'result.txt'),'utf8'),/uncertain/);assert.ok(result.finalFrame.widest<=cols-1);
});
test('Jev Focus freezes loaded manifest and explicitly continues 60/60/30 while preserving partial source coverage',t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-manifest-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const calls=join(root,'jev-calls');writeFileSync(calls,'');
 const driver=join(root,'driver.mjs');writeFileSync(driver,`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('./capture.mjs',import.meta.url).href)};
const root=${JSON.stringify(root)},pause=ms=>new Promise(r=>setTimeout(r,ms)),send=s=>process.stdout.write(s);
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols:100,rows:24}).finalFrame.lines.join('\\n');
const source=()=>Object.values(JSON.parse(readFileSync(root+'/gh-glance/dashboard-cache.json','utf8')).targets).map(x=>x.tabs.issues).find(Boolean);
const count=()=>readFileSync(root+'/jev-calls','utf8').trim().split('\\n').filter(Boolean).length;
const until=async p=>{const end=Date.now()+25000;while(Date.now()<end){try{if(p())return;}catch{}await pause(30);}throw Error('UI timeout '+String(p)+'\\n'+screen());};
try{
 await until(()=>source()?.data.length===50 && screen().includes('of '));
 send('/');await until(()=>screen().includes('Focus >'));send('authentication');await pause(80);send('\\r');await until(()=>screen().includes('Focus:'));
 send('J');await until(()=>screen().includes('TypeSafe'));send('\\r');await until(()=>screen().includes('50/50 eligible'));
 if(!/More source pages[\\s│]*not searched/.test(screen()))throw Error('Semantic results lost source incompleteness');
 if(!/Source[\\s│]+.*old/.test(screen()))throw Error('Semantic results lost source age');
 if(count()!==4)throw Error('50-row batching wrong');
 send('\\u001b');await until(()=>!screen().includes('Focus:'));
 for(let i=0;!screen().includes('of 150') && i<20;i++){send('\\u001b[6~');await pause(180);}
 await until(()=>screen().includes('of 150'));await pause(500);
 const before=JSON.stringify({data:source().data,lastOk:source().lastOk,at:source().meta.at});const beforeCalls=count();
 send('/');await until(()=>screen().includes('Focus >'));send('authentication');await pause(80);send('\\r');await until(()=>screen().includes('Focus:'));
 send('J');await until(()=>screen().includes('60/150 eligible'));if(count()-beforeCalls!==4)throw Error('first60 wrong');
 send('m');await until(()=>screen().includes('120/150 eligible'));if(count()-beforeCalls!==8)throw Error('second60 wrong');
 send('m');await until(()=>screen().includes('150/150 eligible'));if(count()-beforeCalls!==10)throw Error('last30 wrong');
 if(!screen().includes('150 uncertain'))throw Error('All-middle answers lost uncertainty');
 if(JSON.stringify({data:source().data,lastOk:source().lastOk,at:source().meta.at})!==before)throw Error('Semantic continuation changed source/freshness');
 writeFileSync(root+'/complete','yes');
}catch(error){writeFileSync(root+'/failure',String(error));}finally{send('\\u0003');}
`);
 const result=capture({cols:100,rows:24,signal:'none',settle:70,configHome:root,args:'--repo acme/widget --tab issues --refresh 300 --background off --jev',env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',GH_GLANCE_FIXTURE_GRAPHQL_ROWS:'200',TYPESAFE_API_KEY:'dummy',NODE_OPTIONS:`--import=${new URL('./fixtures/jev-fetch.mjs',import.meta.url).pathname}`,GH_GLANCE_TEST_JEV_CALLS:calls},stdin:`node '${driver}'`});
 let failure='';try{failure=readFileSync(join(root,'failure'),'utf8');}catch{/* none */}assert.equal(failure,'',failure);assert.equal(readFileSync(join(root,'complete'),'utf8'),'yes');assert.equal(result.exitCode,0);assert.equal(result.altEnter,result.altExit);
 const batches=readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(batches.length,14);assert.ok(batches.every(x=>Object.keys(x.request.questions).length<=15));
});
test('Jev key-only standalone startup, typing, disabled action and refresh import/send nothing',t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-key-only-'));t.after(()=>rmSync(root,{recursive:true,force:true}));for(const file of ['calls','imports'])writeFileSync(join(root,file),'');
 const driver=join(root,'driver.mjs');writeFileSync(driver,String.raw`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('./capture.mjs',import.meta.url).href)};
const root=${JSON.stringify(root)},pause=ms=>new Promise(r=>setTimeout(r,ms)),send=s=>process.stdout.write(s);
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols:100,rows:24}).finalFrame.lines.join('\n');
const until=async p=>{const end=Date.now()+15000;while(Date.now()<end){try{if(p())return;}catch{}await pause(30);}throw Error('UI timeout '+screen());};
try{await until(()=>screen().includes('of '));send('/');await until(()=>screen().includes('Focus >'));send('terminal');await pause(50);send('\r');await until(()=>screen().includes('Focus:'));send('J');await until(()=>screen().includes('Jev disabled'));
send('r');await pause(500);if(readFileSync(root+'/calls','utf8') || readFileSync(root+'/imports','utf8'))throw Error('key-only imported/sent');writeFileSync(root+'/complete','yes');}
catch(error){writeFileSync(root+'/failure',String(error));}finally{send('\u0003');}
`);
 const result=capture({cols:100,rows:24,signal:'none',settle:30,configHome:root,args:'--repo acme/widget --tab issues --refresh 300 --background off',env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',TYPESAFE_API_KEY:'dummy',NODE_OPTIONS:`--import=${new URL('./fixtures/jev-child-guard.mjs',import.meta.url).pathname} --import=${new URL('./fixtures/jev-fetch.mjs',import.meta.url).pathname}`,GH_GLANCE_TEST_JEV_IMPORTS:join(root,'imports'),GH_GLANCE_TEST_JEV_CALLS:join(root,'calls')},stdin:`node '${driver}'`});
 let failure='';try{failure=readFileSync(join(root,'failure'),'utf8');}catch{/* none */}assert.equal(failure,'',failure);assert.equal(readFileSync(join(root,'complete'),'utf8'),'yes');assert.equal(result.exitCode,0);
});
test('Jev retained rows refuse unknown identity; recovered account requires explicit scoped send',t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-unverified-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const name of ['calls','imports'])writeFileSync(join(root,name),'');
 const resource={limit:5000,remaining:5000,used:0,resetMs:Date.now()+3600000};
 writeFileSync(join(root,'state.json'),JSON.stringify({createdAt:Date.now(),core:resource,graphql:resource,events:[]}));
 writeFileSync(join(root,'account.json'),JSON.stringify({token:'fixture-account-a',user:{id:1,login:'octocat'}}));writeFileSync(join(root,'hosts.yml'),'fixture: verified\n');
 const driver=join(root,'driver.mjs');writeFileSync(driver,String.raw`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('./capture.mjs',import.meta.url).href)};
const root=${JSON.stringify(root)},pause=ms=>new Promise(r=>setTimeout(r,ms)),send=s=>process.stdout.write(s);
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols:100,rows:24}).finalFrame.lines.join('\n');
const until=async p=>{const end=Date.now()+20000;while(Date.now()<end){try{if(p())return;}catch{}await pause(30);}throw Error('UI timeout '+screen());};
try{
 await until(()=>screen().includes('of '));send('/');await until(()=>screen().includes('Focus >'));send('authentication');await pause(60);send('\r');await until(()=>screen().includes('Focus:'));
 writeFileSync(root+'/account.json',JSON.stringify({token:'',user:{id:1,login:'octocat'}}));writeFileSync(root+'/hosts.yml','fixture: unavailable\n');
 send('J');await until(()=>screen().includes('verified account'));send('\r');await pause(100);
 if(readFileSync(root+'/calls','utf8') || readFileSync(root+'/imports','utf8'))throw Error('unknown partition imported or dispatched');
 send('\u001b');await until(()=>!screen().includes('Focus:'));if(!screen().includes('SIGTERM erases'))throw Error('identity loss discarded retained rows');
 writeFileSync(root+'/account.json',JSON.stringify({token:'fixture-account-a',user:{id:1,login:'octocat'}}));writeFileSync(root+'/hosts.yml','fixture: verified\n');send('r');await pause(1500);
 send('/');await until(()=>screen().includes('Focus >'));send('authentication');await pause(60);send('\r');await until(()=>screen().includes('Focus:'));send('J');await until(()=>screen().includes('TypeSafe'));
 if(readFileSync(root+'/calls','utf8') || readFileSync(root+'/imports','utf8'))throw Error('verified recovery skipped explicit consent');send('\r');await until(()=>screen().includes('3/3 eligible'));
 if(readFileSync(root+'/calls','utf8').trim().split('\n').length!==1)throw Error('recovered send did not dispatch once');writeFileSync(root+'/complete','yes');
}catch(error){writeFileSync(root+'/failure',String(error));}finally{send('\u0003');}
`);
 const result=capture({cols:100,rows:24,signal:'none',settle:60,configHome:root,args:'--repo acme/widget --tab issues --refresh 300 --background off --jev',env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',TYPESAFE_API_KEY:'dummy',GH_GLANCE_FIXTURE_STATE:join(root,'state.json'),GH_GLANCE_FIXTURE_ACCOUNT_FILE:join(root,'account.json'),NODE_OPTIONS:`--import=${new URL('./fixtures/jev-child-guard.mjs',import.meta.url).pathname} --import=${new URL('./fixtures/jev-fetch.mjs',import.meta.url).pathname}`,GH_GLANCE_TEST_JEV_IMPORTS:join(root,'imports'),GH_GLANCE_TEST_JEV_CALLS:join(root,'calls')},stdin:`node '${driver}'`});
 let failure='';try{failure=readFileSync(join(root,'failure'),'utf8');}catch{/* none */}assert.equal(failure,'',failure);assert.equal(readFileSync(join(root,'complete'),'utf8'),'yes');assert.equal(result.exitCode,0);
});
