import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {withoutJevCredential} from '../index.mjs';
import {scoreFocus,validateEvaluationManifest,reserveEvaluationCall,prepareFocusManifest,runEvaluationCLI} from '../scripts/evaluate-jev.mjs';

const row=(number,title='cache')=>({kind:'issue',number,title,author:'ana',label:'',updatedAt:'2026-10-20T00:00:00Z',url:`https://github.com/synthetic/example/issues/${number}`});
function corpus(){return {schemaVersion:1,feature:'focus',questionVersion:'focus-v1',provenance:{dataClass:'synthetic'},splitPolicy:{frozen:true},cases:[
 {id:'three',split:'held-out',groupId:'three',slices:['synonym'],classification:'matching',query:'cache',rows:[row(1),row(2),row(3)],exactFilterExpectedIds:['issue:1','issue:2','issue:3'],relevantIds:['issue:1','issue:2','issue:3'],ambiguousIds:[]},
 {id:'two',split:'held-out',groupId:'two',slices:['lexical'],classification:'matching',query:'cache',rows:[row(4),row(5)],exactFilterExpectedIds:['issue:4','issue:5'],relevantIds:['issue:4','issue:5'],ambiguousIds:[]},
 {id:'unclear',split:'held-out',groupId:'unclear',slices:['no-match'],classification:'no-match',query:'auth',rows:[row(6)],exactFilterExpectedIds:['issue:6'],relevantIds:[],ambiguousIds:[]},
 {id:'negative',split:'held-out',groupId:'negative',slices:['no-match'],classification:'no-match',query:'auth',rows:[row(7)],exactFilterExpectedIds:['issue:7'],relevantIds:[],ambiguousIds:[]},
 {id:'ambiguous',split:'held-out',groupId:'ambiguous',slices:['ambiguous'],classification:'ambiguous',query:'cache',rows:[row(8)],exactFilterExpectedIds:['issue:8'],relevantIds:[],ambiguousIds:['issue:8']},
 {id:'filter',split:'held-out',groupId:'filter',slices:['exact-filter'],classification:'filter-only',query:'#9',rows:[row(9)],exactFilterExpectedIds:['issue:9'],relevantIds:['issue:9'],ambiguousIds:[]},
 ]};}
const record=(caseId,values,status='completed')=>({caseId,status,decisions:Object.fromEntries(Object.entries(values).map(([id,decision])=>[id,{decision}])),ranking:Object.entries(values).filter(([,d])=>d==='positive').map(([id])=>id)});
const records=()=>[
 record('three',{'issue:1':'positive','issue:2':'uncertain','issue:3':'unavailable'},'partial'),
 record('two',{'issue:4':'positive','issue:5':'positive'}),
 record('unclear',{'issue:6':'uncertain'}), record('negative',{'issue:7':'negative'}),
 record('ambiguous',{'issue:8':'positive'})];
test('Focus evaluation uses fixed k/matching denominators and keeps abstention out of specificity',()=>{
 const report=scoreFocus(corpus(),records());
 assert.equal(report.matchingQueries,2);assert.equal(report.noMatchQueries,2);
 assert.ok(Math.abs(report.macroPrecisionAtK-2/3)<1e-12);
 assert.ok(Math.abs(report.macroRecallAt5-2/3)<1e-12);
 assert.equal(report.synonymRecallAt5,1/3);assert.equal(report.noMatchSpecificity,.5);
 assert.equal(report.noMatchAbstentions,1);assert.equal(report.ambiguousCases,1);
 assert.equal(report.ambiguousUnsupportedAssertions,1);assert.equal(report.filterOnlyCases,1);
 assert.equal(report.attempts.length,6);assert.equal(report.qualified,false);
});
test('Missing and malformed provider records remain attempted failures instead of disappearing',()=>{
 const data=records().filter(x=>x.caseId!=='two');
 data[0]=record('three',{'issue:999':'positive'});
 const report=scoreFocus(corpus(),data);
 assert.equal(report.matchingQueries,2);assert.equal(report.macroPrecisionAtK,0);assert.equal(report.macroRecallAt5,0);
 assert.equal(report.attempts.find(x=>x.id==='three').status,'unavailable');
 assert.equal(report.attempts.find(x=>x.id==='two').status,'unavailable');
 assert.equal(report.attempts.length,6);
});
test('Frozen corpus refuses related-group leakage, invalid truth IDs and duplicate replay IDs',()=>{
 const bad=corpus();bad.cases[1].groupId='three';bad.cases[1].split='development';
 assert.throws(()=>scoreFocus(bad,records()),/split/);
 const wrong=corpus();wrong.cases[0].relevantIds=['issue:999'];assert.throws(()=>scoreFocus(wrong,records()),/relevant/);
 assert.throws(()=>scoreFocus(corpus(),[...records(),records()[0]]),/duplicate/i);
});
test('Prepared contract probe is exact, synthetic, development-only and bounded without dispatch',()=>{
 const data=JSON.parse(readFileSync(new URL('./fixtures/jev/focus.json',import.meta.url)));
 const manifest=prepareFocusManifest(data);
 assert.ok(manifest.entries.length>0 && manifest.entries.length<=12);
 assert.equal(manifest.dataClass,'synthetic');assert.equal(manifest.purpose,'contract');
 assert.ok(manifest.entries.every(x=>data.cases.find(c=>c.id===x.caseId).split==='development'));
 const inspected=validateEvaluationManifest(manifest);
 assert.ok(inspected.bytes<=192*1024);assert.equal(inspected.calls,manifest.entries.length);
 for(const entry of manifest.entries)assert.ok(Object.keys(entry.request.questions).length<=15);
 const altered=structuredClone(manifest);altered.entries[0].request.state.query+=' changed';
 assert.throws(()=>validateEvaluationManifest(altered),/hash|bytes/);
 assert.throws(()=>validateEvaluationManifest({...manifest,dataClass:'private'}),/synthetic|public/);
});
test('Live reservation uses full documented token ceiling and never refunds unknown usage',()=>{
 const first=reserveEvaluationCall({maxDollars:.003,reservedDollars:0,calls:0,maxCalls:12,bytes:0,maxBytes:192*1024},1024);
 assert.equal(first.reservedDollars,.002688);assert.equal(first.calls,1);assert.equal(first.bytes,1024);
 assert.throws(()=>reserveEvaluationCall(first,1024),/dollar|budget/);
 assert.throws(()=>reserveEvaluationCall({...first,maxDollars:1,calls:12},1),/call/i);
 assert.throws(()=>reserveEvaluationCall({...first,maxDollars:1,bytes:192*1024},1),/byte/i);
});
test('CLI defaults offline; live mode requires exact manifest hash, explicit budget and key before transport',async t=>{
 let sessionCreations=0;const makeSession=()=>{sessionCreations++;throw Error('network must not start');};
 const report=await runEvaluationCLI([], {makeSession,env:{TYPESAFE_API_KEY:'dummy-key-must-not-start'}});
 assert.equal(report.mode,'offline');assert.equal(report.liveContract,'UNVERIFIED');assert.equal(sessionCreations,0);
 await assert.rejects(runEvaluationCLI(['--live'],{makeSession,env:{}}),/manifest|budget/);
 const root=mkdtempSync(join(tmpdir(),'jev-evaluation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const manifestPath=join(root,'manifest.json');
 const prepared=await runEvaluationCLI(['--prepare-manifest',manifestPath],{makeSession,env:{}});
 assert.equal(prepared.dispatchedCalls,0);assert.ok(readFileSync(manifestPath).length>0);assert.equal(sessionCreations,0);
 await assert.rejects(runEvaluationCLI(['--live','--manifest',manifestPath,'--max-calls','12','--max-bytes','196608','--max-dollars','.04','--manifest-sha256','0'.repeat(64)],{makeSession,env:{TYPESAFE_API_KEY:'dummy'}}),/hash/);
 assert.equal(sessionCreations,0);
});

test('Unavailable records never earn positive credit even with contradictory replay answers',()=>{
 const report=scoreFocus(corpus(),[record('three',{'issue:1':'positive'},'unavailable'),...records().slice(1)]);
 assert.equal(report.attempts.find(x=>x.id==='three').precision,0);
 assert.equal(report.attempts.find(x=>x.id==='three').recall,0);
});

test('Live manifest binding rejects private or unfrozen corpora despite a synthetic manifest label',()=>{
 const data=JSON.parse(readFileSync(new URL('./fixtures/jev/focus.json',import.meta.url))),manifest=prepareFocusManifest(data);
 const privateData=structuredClone(data);privateData.provenance.dataClass='private';
 assert.throws(()=>validateEvaluationManifest(manifest,{corpus:privateData}),/synthetic|public|class/);
 const unfrozen=structuredClone(data);unfrozen.splitPolicy.frozen=false;
 assert.throws(()=>validateEvaluationManifest(manifest,{corpus:unfrozen}),/frozen/);
});
test('Replay errors cannot echo provider body, query or credentials into reports',()=>{
 const data=records();data[0].error='Bearer private-fixture-sentinel raw query';
 assert.doesNotMatch(JSON.stringify(scoreFocus(corpus(),data)),/private-fixture-sentinel|raw query/);
});
test('Completed replay with missing answers is unavailable while valid partial chunks retain credit',()=>{
 const data=records();data[0]=record('three',{'issue:1':'positive'});
 const report=scoreFocus(corpus(),data),attempt=report.attempts.find(x=>x.id==='three');
 assert.equal(attempt.status,'unavailable');assert.equal(attempt.precision,0);
 assert.equal(scoreFocus(corpus(),records()).attempts.find(x=>x.id==='three').precision,1/3);
});

test('Exact reviewed wire uses real adapter with fake external HTTP and preserves unknown spend',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-probe-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const manifestPath=join(root,'manifest.json');const prepared=await runEvaluationCLI(['--prepare-manifest',manifestPath]);
 const manifest=JSON.parse(readFileSync(manifestPath));let calls=0;
 const report=await runEvaluationCLI(['--live','--manifest',manifestPath,'--max-calls','12','--max-bytes','196608','--max-dollars','.04','--manifest-sha256',prepared.manifestHash],{
  env:{TYPESAFE_API_KEY:'dummy-offline-probe-key'},fetchImpl:async(url,init)=>{
   assert.equal(url,'https://api.typesafe.ai/v1/systemone');const request=JSON.parse(init.body);calls++;
   assert.ok(manifest.entries.some(x=>x.requestHash===createHash('sha256').update(init.body).digest('hex')));
   return new Response(JSON.stringify({model:'jev-1.14.0',answers:Object.fromEntries(Object.keys(request.questions).map(id=>[id,{type:'noul',noul:.8}])),usage:{input_tokens:null,output_tokens:null}}),{headers:{'content-type':'application/json'}});
  }});
 assert.equal(calls,manifest.entries.length);assert.equal(report.dispatchedCalls,calls);
 assert.equal(report.liveContract,'PASSED');assert.equal(report.totalSpendDollars,null);
 assert.equal(report.unknownUsageCalls,calls);assert.ok(Math.abs(report.reservedDollars-calls*.002688)<1e-12);
 assert.equal(report.providerLatency.stableTail,false);
});
test('Executable supports inline output and sanitizes malformed input without a key or network',t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-cli-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const output=join(root,'report.json');
 const result=spawnSync(process.execPath,[new URL('../scripts/evaluate-jev.mjs',import.meta.url).pathname,`--output=${output}`],{encoding:'utf8',env:withoutJevCredential(process.env)});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(readFileSync(output)).mode,'offline');
 const invalid=join(root,'invalid.json');writeFileSync(invalid,'private-provider-body-sentinel');
 const rejected=spawnSync(process.execPath,[new URL('../scripts/evaluate-jev.mjs',import.meta.url).pathname,'--corpus',invalid],{encoding:'utf8',env:withoutJevCredential(process.env)});
 assert.equal(rejected.status,1);assert.doesNotMatch(rejected.stderr,/private-provider-body-sentinel/);
 assert.match(rejected.stderr,/Input or transport unavailable/);
});
