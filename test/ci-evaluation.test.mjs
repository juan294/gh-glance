import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scoreCi,buildCiEvaluationEntry,prepareCiManifest,validateEvaluationManifest,runEvaluationCLI} from '../scripts/evaluate-jev.mjs';

const categories=['assertion_mismatch','dependency_download','permission_denied','execution_timeout','memory_exhaustion','static_check_failure'];
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function ciCase(id,text,positive=null,{split='held-out',ambiguous=false}={}){
 const labels=Object.fromEntries(categories.map(key=>[key,ambiguous?null:key===positive]));
 return {id,groupId:id,split,slices:ambiguous?['ambiguous','adversarial']:['literal'],classification:ambiguous?'insufficient':'ordinary',
  originalLines:[text],approvedSpans:[{id:'s1',lineStart:1,lineEnd:1,text}],labels,
  acceptableSpanIds:Object.fromEntries(categories.map(key=>[key,labels[key]===true?['s1']:[]])),
  insufficientReason:ambiguous?'A generic exit does not establish a concrete observation.':null,expectedPolicy:'ready',
  identity:{runId:100+id.length,attempt:1,headSha:'a'.repeat(40),jobId:200+id.length}};
}
function ciCorpus(){return {schemaVersion:1,feature:'ci',questionVersion:'ci-evidence-v1',provenance:{dataClass:'synthetic'},splitPolicy:{frozen:true},cases:[
 ciCase('assert','AssertionError: expected true but actual false','assertion_mismatch'),
 ciCase('permission','Permission denied: cannot upload artifact','permission_denied'),
 ciCase('negative','Timeout configured to 30 seconds; all tests passed.'),
 ciCase('insufficient','Command exited with code 1.',null,{ambiguous:true}),
 ciCase('development','AssertionError: expected 2 but actual 3','assertion_mismatch',{split:'development'}),
 ]};}
function ciRecord(c,corpus,overrides={}){
 const entry=buildCiEvaluationEntry(c,{corpusHash:hash(corpus)});
 const outcomes=Object.fromEntries(categories.map(category=>[category,{decision:'negative',probability:.1}]));
 for(const [category,decision] of Object.entries(overrides))outcomes[category]={decision,probability:decision==='positive'?.9:decision==='negative'?.1:.5,...(decision==='positive'?{spanId:'s1'}:{})};
 return {caseId:c.id,status:'completed',identity:entry.identity,bindingDigest:entry.bindingDigest,outcomes};
}
test('CI scoring keeps category, support and insufficient-evidence denominators independent',()=>{
 const corpus=ciCorpus(),[a,p,n,i]=corpus.cases;
 const report=scoreCi(corpus,[ciRecord(a,corpus,{assertion_mismatch:'uncertain'}),ciRecord(p,corpus,{permission_denied:'positive'}),
  ciRecord(n,corpus,{execution_timeout:'positive'}),ciRecord(i,corpus,{assertion_mismatch:'positive'})]);
 assert.equal(report.categories.assertion_mismatch.fn,1);assert.equal(report.categories.assertion_mismatch.abstentions,1);
 assert.equal(report.categories.assertion_mismatch.precision,null);assert.equal(report.categories.assertion_mismatch.recall,0);
 assert.equal(report.categories.permission_denied.tp,1);assert.equal(report.categories.permission_denied.precision,1);
 assert.equal(report.categories.execution_timeout.fp,1);
 assert.equal(report.spanSelections,3);assert.equal(report.supportedSpanSelections,1);assert.equal(report.spanSelectionAccuracy,1/3);
 assert.equal(report.insufficientCases,1);assert.equal(report.insufficientConcreteCases,1);assert.equal(report.insufficientConcreteRate,1);
 assert.equal(report.identityErrors,0);assert.equal(report.attempts.length,4);assert.equal(report.qualified,false);
 assert.equal(report.slices.adversarial.attempted,1);
});
test('CI insufficient-evidence rate includes safe known-negative excerpts and publishes per-slice truth denominators',()=>{
 const corpus=ciCorpus();corpus.cases[2].classification='insufficient';corpus.cases[2].insufficientReason='Configuration is not an observed timeout.';
 const negative=ciRecord(corpus.cases[2],corpus,{execution_timeout:'positive'}),ambiguous=ciRecord(corpus.cases[3],corpus);
 const report=scoreCi(corpus,[negative,ambiguous]);
 assert.equal(report.insufficientCases,2);assert.equal(report.insufficientConcreteCases,1);assert.equal(report.insufficientConcreteRate,.5);
 assert.equal(report.coverage.insufficientCases,2);assert.equal(report.coverage.adversarialInsufficientCases,1);
 assert.equal(report.slices.literal.categories.permission_denied.positiveExamples,1);
 assert.equal(report.slices.adversarial.categories.assertion_mismatch.ambiguousExamples,1);
});
test('CI policy-blocked outputs remain explicit policy violations outside semantic truth denominators',()=>{
 const corpus=ciCorpus(),blocked=ciCase('blocked','Authorization: Bearer synthetic-private-value',null,{ambiguous:true});
 blocked.expectedPolicy='suspected-secret';blocked.approvedSpans=[];blocked.slices=['policy-only'];corpus.cases.push(blocked);
 const report=scoreCi(corpus,[{caseId:'blocked',status:'completed',outcomes:{assertion_mismatch:{decision:'positive',spanId:'s1'}}}]);
 assert.equal(report.policyViolations,1);assert.equal(report.coverage.policies['suspected-secret'],1);
 assert.equal(report.categories.assertion_mismatch.positiveExamples,1);assert.equal(report.insufficientCases,1);
 assert.equal(report.attempts.find(c=>c.id==='blocked').error,'input-policy');
});
test('CI missing, contradictory unavailable and malformed completion records cannot earn credit',()=>{
 const corpus=ciCorpus(),positive=ciRecord(corpus.cases[0],corpus,{assertion_mismatch:'positive'});
 positive.status='unavailable';positive.error='Bearer evaluation-secret-sentinel signed-url-value';
 const incomplete=ciRecord(corpus.cases[1],corpus,{permission_denied:'positive'});delete incomplete.outcomes.memory_exhaustion;
 const report=scoreCi(corpus,[positive,incomplete]);
 assert.equal(report.categories.assertion_mismatch.tp,0);assert.equal(report.categories.assertion_mismatch.fn,1);
 assert.equal(report.categories.permission_denied.tp,0);assert.equal(report.categories.permission_denied.fn,1);
 assert.equal(report.categories.assertion_mismatch.precision,null);assert.equal(report.attempts.length,4);
 assert.doesNotMatch(JSON.stringify(report),/evaluation-secret-sentinel|signed-url-value/);
});
test('CI replay rejects other-attempt binding and fabricated same-excerpt span references',()=>{
 const corpus=ciCorpus(),a=ciRecord(corpus.cases[0],corpus,{assertion_mismatch:'positive'}),p=ciRecord(corpus.cases[1],corpus,{permission_denied:'positive'});
 a.identity.attempt=2;p.outcomes.permission_denied.spanId='fabricated-span';
 const report=scoreCi(corpus,[a,p]);
 assert.equal(report.identityErrors,1);assert.equal(report.invalidSpanSelections,1);
 assert.equal(report.categories.assertion_mismatch.tp,0);assert.equal(report.categories.permission_denied.tp,0);
 assert.equal(report.categories.assertion_mismatch.fn,1);assert.equal(report.categories.permission_denied.fn,1);
});
test('CI unavailable records still expose foreign identity errors without receiving positive credit',()=>{
 const corpus=ciCorpus(),record=ciRecord(corpus.cases[0],corpus,{assertion_mismatch:'positive'});
 record.status='unavailable';record.identity.attempt=2;
 const report=scoreCi(corpus,[record]);
 assert.equal(report.identityErrors,1);assert.equal(report.categories.assertion_mismatch.tp,0);assert.equal(report.categories.assertion_mismatch.fn,1);
});
test('CI replay identity compares field values independently of JSON property order',()=>{
 const corpus=ciCorpus(),record=ciRecord(corpus.cases[0],corpus,{assertion_mismatch:'positive'});
 record.identity=Object.fromEntries(Object.entries(record.identity).reverse());
 const report=scoreCi(corpus,[record]);
 assert.equal(report.identityErrors,0);assert.equal(report.categories.assertion_mismatch.tp,1);
});
test('CI frozen corpus refuses group leakage, unsupported gold and duplicate replay identities',()=>{
 const corpus=ciCorpus(),leak=structuredClone(corpus);leak.cases[4].groupId=leak.cases[0].groupId;
 assert.throws(()=>scoreCi(leak),/split/);
 const bad=structuredClone(corpus);bad.cases[0].acceptableSpanIds.assertion_mismatch=['missing'];
 assert.throws(()=>scoreCi(bad),/support|span/);
 const r=ciRecord(corpus.cases[0],corpus);assert.throws(()=>scoreCi(corpus,[r,r]),/duplicate/i);
});
test('CI held-out scoring refuses an unfrozen split even when no replay is supplied',()=>{
 const corpus=ciCorpus();corpus.splitPolicy.frozen=false;
 assert.throws(()=>scoreCi(corpus),/frozen/);
});
test('CI manifests bind exact clean development projections and reject a relabeled held-out entry',()=>{
 const corpus=ciCorpus(),manifest=prepareCiManifest(corpus);
 assert.equal(manifest.feature,'ci');assert.equal(manifest.entries.length,1);assert.equal(manifest.questionVersion,'ci-evidence-v1');
 assert.equal(validateEvaluationManifest(manifest,{corpusHash:hash(corpus),corpus}).calls,1);
 assert.equal(Object.keys(manifest.entries[0].request.questions).length,12);
 assert.doesNotMatch(JSON.stringify(manifest.entries[0].request),/synthetic\.invalid|evaluation\/ci|bindingDigest|accessPartition/);
 const bad=structuredClone(manifest);bad.entries[0].caseId=corpus.cases[0].id;
 assert.throws(()=>validateEvaluationManifest(bad,{corpusHash:hash(corpus),corpus}),/development|projection|payload/);
});
test('CI CLI defaults offline and exact reviewed fake HTTP retains shared budget and unknown usage',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-ci-evaluation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const corpusPath=join(root,'ci.json'),manifestPath=join(root,'manifest.json');writeFileSync(corpusPath,JSON.stringify(ciCorpus()));
 let creations=0;
 const offline=await runEvaluationCLI(['--feature','ci','--corpus',corpusPath],{env:{TYPESAFE_API_KEY:'must-not-start'},makeSession:()=>{creations++;throw Error('must stay offline');}});
 assert.equal(offline.dispatchedCalls,0);assert.equal(creations,0);assert.equal(offline.semantic,null);assert.equal(offline.baseline,null);
 const prepared=await runEvaluationCLI(['--feature','ci','--corpus',corpusPath,'--prepare-manifest',manifestPath]);
 assert.equal(prepared.dispatchedCalls,0);let calls=0;
 const report=await runEvaluationCLI(['--feature','ci','--corpus',corpusPath,'--live','--manifest',manifestPath,'--manifest-sha256',prepared.manifestHash,'--max-calls','1','--max-bytes','24576','--max-dollars','.003'],{
  env:{TYPESAFE_API_KEY:'synthetic-offline-ci-key'},fetchImpl:async(url,init)=>{
   calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');const request=JSON.parse(init.body);
   const answers=Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{
    if(q.type==='noul')return [id,{type:'noul',noul:.1}];
    const keys=Object.keys(q.criteria);return [id,{type:'choice',choice:keys[0],confidence:1/keys.length,probabilities:Object.fromEntries(keys.map(key=>[key,1/keys.length]))}];
   }));
   return new Response(JSON.stringify({model:'jev-1.14.0',answers,usage:{input_tokens:null,output_tokens:null}}),{headers:{'content-type':'application/json'}});
  }});
 assert.equal(calls,1);assert.equal(report.dispatchedCalls,1);assert.equal(report.liveContract,'PASSED');
 assert.equal(report.totalSpendDollars,null);assert.equal(report.unknownUsageCalls,1);assert.equal(report.reservedDollars,.002688);
 assert.equal(report.records[0].status,'completed');assert.equal(Object.keys(report.records[0].outcomes).length,6);
 assert.equal(JSON.parse(readFileSync(manifestPath)).entries[0].requestHash,hash(JSON.stringify(JSON.parse(readFileSync(manifestPath)).entries[0].request)));
});
