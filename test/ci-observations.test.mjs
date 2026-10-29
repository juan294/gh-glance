import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as app from '../index.mjs';

const identity={feature:'ci',dataClass:'log',host:'github.com',repo:'acme/widget',accessPartition:'synthetic-access',runId:12,attempt:2,headSha:'a'.repeat(40),jobId:91,generation:'synthetic-generation'};
function manifest(text='setup done\nAssertionError: expected true, actual false\nfinished',options){
  assert.equal(typeof app.prepareCiSpans,'function');
  return app.buildCiQuestions(app.prepareCiSpans(text,options),identity);
}
function resultFor(built,probabilities={}){
  const answers={};
  for(const category of app.CI_OBSERVATION_CATEGORIES){
    const ids=built.questionIds[category],probability=probabilities[category]??.1;
    answers[ids.observation]={type:'noul',probability,decision:app.classifyJevProbability(probability)};
    answers[ids.evidence]={type:'choice',choice:built.spans[1]?.id??built.spans[0].id,confidence:1,
      probabilities:Object.fromEntries(built.spans.map(span=>[span.id,span.id===(built.spans[1]?.id??built.spans[0].id)?1:0]))};
  }
  return {status:'complete',answers,bindingDigest:built.bindingDigest,usage:{input_tokens:null,output_tokens:null}};
}

test('CI spans retain original lines after ANSI/CRLF cleanup and select marker context before bounded tail/head',()=>{
  assert.equal(typeof app.prepareCiSpans,'function');
  const simple=app.prepareCiSpans('first\r\n\u001b[31merror: mismatch\u001b[0m\nlast\u0000');
  assert.deepEqual(simple.spans.map(({id,lineStart,lineEnd,text})=>({id,lineStart,lineEnd,text})),[
    {id:'s1',lineStart:1,lineEnd:1,text:'first'},
    {id:'s2',lineStart:2,lineEnd:2,text:'error: mismatch'},
    {id:'s3',lineStart:3,lineEnd:3,text:'last'},
  ]);
  const lines=Array.from({length:200},(_,i)=>i===49?'AssertionError: expected 1, actual 2':`ordinary output ${i+1}`);
  const prepared=app.prepareCiSpans(lines.join('\n'));
  assert.equal(prepared.status,'ready');assert.equal(prepared.spans.length,40);
  assert.ok(prepared.spans.some(span=>span.lineStart===48));assert.ok(prepared.spans.some(span=>span.lineStart===52));
  assert.ok(prepared.spans.some(span=>span.lineStart===200));assert.ok(!prepared.spans.some(span=>span.lineStart===1));
  assert.deepEqual(prepared.spans.map(span=>span.lineStart),prepared.spans.map(span=>span.lineStart).sort((a,b)=>a-b));
  assert.ok(prepared.omittedRanges.length>0);
});

test('CI text and span byte limits preserve valid UTF-8 and disclose exact truncated/omitted ranges',()=>{
  const prepared=app.prepareCiSpans(Array.from({length:80},(_,i)=>`line${i+1} `+'界'.repeat(300)).join('\n'));
  assert.ok(prepared.spans.length<=40);assert.ok(prepared.spans.every(span=>Buffer.byteLength(span.text)<=512));
  assert.ok(prepared.spans.reduce((bytes,span)=>bytes+Buffer.byteLength(span.text),0)<=8192);
  assert.ok(prepared.truncatedRanges.length>0);assert.ok(prepared.omittedRanges.length>0);
  assert.ok(prepared.spans.every(span=>!span.text.includes('\ufffd')));
});

test('CI known-secret excerpts never build cloud input; a clean selected line range recovers',()=>{
  const samples=['Authorization: Bearer credential-secret','Cookie: session=credential-secret',
    '{"Cookie":"session=credential-secret"}','{"Authorization":"Bearer credential-secret"}',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890','https://storage.example/job?X-Amz-Signature=credential-secret',
    'TYPESAFE_API_KEY=credential-secret'];
  for(const secret of samples){
    const text=`safe setup\n${secret}\nAssertionError: expected true, actual false`;
    const blocked=app.prepareCiSpans(text);
    assert.equal(blocked.status,'suspected-secret');assert.equal(blocked.suspectedSecret,true);
    assert.ok(!JSON.stringify(blocked.spans).includes(secret));
    assert.throws(()=>app.buildCiQuestions(blocked,identity),error=>error.code==='suspected-secret'&&!error.message.includes(secret));
    const clean=app.prepareCiSpans(text,{range:{startLine:3,endLine:3}});
    assert.equal(clean.status,'ready');assert.equal(clean.spans[0].id,'s1');assert.equal(clean.spans[0].lineStart,3);
    assert.equal(Object.keys(app.buildCiQuestions(clean,identity).request.questions).length,12);
  }
  const privateKey='-----BEGIN PRIVATE KEY-----\nnot-a-real-key-body\n-----END PRIVATE KEY-----\nsafe output';
  assert.equal(app.prepareCiSpans(privateKey,{range:{startLine:2,endLine:2}}).status,'suspected-secret');
  assert.equal(app.prepareCiSpans(privateKey,{range:{startLine:4,endLine:4}}).status,'ready');
});

test('CI PGP private-key body remains blocked without selecting its marker and clean range recovers',()=>{
  const pgp='-----BEGIN PGP PRIVATE KEY BLOCK-----\nsynthetic-private-body\n-----END PGP PRIVATE KEY BLOCK-----\nsafe output';
  assert.equal(app.prepareCiSpans(pgp,{range:{startLine:2,endLine:2}}).status,'suspected-secret');
  assert.equal(app.prepareCiSpans(pgp,{range:{startLine:4,endLine:4}}).status,'ready');
});

test('CI questions use six independent Nouls and six companion Choices, exact preview state and no identity fields',()=>{
  const built=manifest();assert.equal(app.CI_QUESTION_VERSION,'ci-evidence-v1');
  assert.equal(Object.keys(built.request.questions).length,12);
  assert.equal(built.previewText,JSON.stringify(built.request.state,null,2));
  assert.ok(Buffer.byteLength(JSON.stringify(built.request))<=24576);
  assert.doesNotMatch(JSON.stringify(built.request),/acme|widget|synthetic-access|synthetic-generation|"runId"|"headSha"/);
  for(const category of app.CI_OBSERVATION_CATEGORIES){
    const ids=built.questionIds[category];
    assert.equal(ids.observation,`${category}_observed`);assert.equal(ids.evidence,`${category}_span`);
    assert.equal(built.request.questions[ids.observation].type,'noul');
    assert.equal(built.request.questions[ids.evidence].type,'choice');
    assert.deepEqual(Object.keys(built.request.questions[ids.evidence].criteria),built.spans.map(span=>span.id));
  }
});

test('CI Nouls independently gate observations; negative Choices never force a category and middle remains uncertain',()=>{
  const built=manifest();
  const mixed=app.validateCiObservations(resultFor(built,{assertion_mismatch:.9,execution_timeout:.8,dependency_download:.5}),built,identity);
  assert.equal(mixed.status,'observations');assert.equal(mixed.uncertain,1);
  assert.deepEqual(mixed.observations.map(item=>item.category),['assertion_mismatch','execution_timeout']);
  assert.ok(mixed.observations.every(item=>item.spanId==='s2'&&item.lineStart===2&&item.lineEnd===2));
  assert.equal(app.validateCiObservations(resultFor(built),built,identity).status,'none');
  const middle=Object.fromEntries(app.CI_OBSERVATION_CATEGORIES.map(category=>[category,.5]));
  assert.equal(app.validateCiObservations(resultFor(built,middle),built,identity).status,'uncertain');
});

test('CI fabricated/missing spans, partial evidence and different-attempt identity cannot surface observations',()=>{
  const built=manifest(),good=resultFor(built,{assertion_mismatch:.9}),id=built.questionIds.assertion_mismatch.evidence;
  assert.throws(()=>app.validateCiObservations({...good,bindingDigest:'foreign'},built,identity),{code:'stale'});
  assert.throws(()=>app.validateCiObservations(good,built,{...identity,attempt:3}),{code:'stale'});
  const foreign=structuredClone(good);foreign.answers[id].choice='fabricated';
  assert.throws(()=>app.validateCiObservations(foreign,built,identity),{code:'invalid-observations'});
  const missing=structuredClone(good);delete missing.answers[id];
  assert.throws(()=>app.validateCiObservations(missing,built,identity),{code:'invalid-observations'});
  assert.throws(()=>app.validateCiObservations({...good,status:'partial'},built,identity),{code:'invalid-observations'});
});

test('CI range bounds and empty evidence have usable explicit refusal rather than a cloud request',()=>{
  assert.equal(app.prepareCiSpans('\n\n').status,'insufficient');
  assert.throws(()=>app.buildCiQuestions(app.prepareCiSpans(''),identity),{code:'insufficient'});
  for(const range of [{startLine:0,endLine:1},{startLine:2,endLine:1},{startLine:1,endLine:4}])
    assert.throws(()=>app.prepareCiSpans('one\ntwo\nthree',{range}),{code:'invalid-range'});
});

test('CI request is a frozen projection of approved text; tampering and secrets in permitted failed-step fields refuse',()=>{
  const prepared=app.prepareCiSpans('AssertionError: expected true, actual false');
  const built=app.buildCiQuestions(prepared,identity);
  prepared.spans[0].text='changed after preview';assert.notEqual(built.request.state.excerpt.s1.text,prepared.spans[0].text);
  assert.throws(()=>app.buildCiQuestions(prepared,identity),{code:'invalid-excerpt'});
  assert.throws(()=>app.buildCiQuestions(app.prepareCiSpans('safe'),identity,{failedSteps:['Authorization: Bearer sensitive']}),{code:'suspected-secret'});
  assert.throws(()=>app.buildCiQuestions(app.prepareCiSpans('safe'),identity,{failedSteps:['-----BEGIN PRIVATE KEY-----','synthetic-body','-----END PRIVATE KEY-----']}),{code:'suspected-secret'});
});

test('CI standard OAuth error identifiers are evidence, while named credential assignments remain blocked',()=>{
  for(const prefix of ['invalid_token','INVALID_TOKEN'])assert.equal(app.prepareCiSpans(`${prefix}: the supplied access credential was rejected; authentication is required`).status,'ready');
  for(const value of ['TOKEN=synthetic-value','GITHUB_TOKEN=synthetic-value','api_key: synthetic-value','"client_secret": "synthetic-value"'])assert.equal(app.prepareCiSpans(value).status,'suspected-secret');
});

test('CI literal error markers retain embedded TypeError context outside head and tail windows',()=>{
  const lines=Array.from({length:200},(_,i)=>i===49?'TypeError: cannot read property of undefined':`ordinary output ${i+1}`);
  const prepared=app.prepareCiSpans(lines.join('\n'));
  assert.ok(prepared.spans.some(span=>span.lineStart===50));
});

test('CI bounded selection skips unusable whitespace truncation and can recover with a later clean range',()=>{
  const text=' '.repeat(600)+'AssertionError: expected 1, actual 2';
  assert.equal(app.prepareCiSpans(text).status,'insufficient');
  const recovered=app.prepareCiSpans(text+'\nactual clean evidence',{range:{startLine:2,endLine:2}});
  assert.equal(recovered.status,'ready');assert.equal(recovered.spans[0].lineStart,2);
});

test('CI priority retention preserves byte-sliver semantics and source order on a maximum-size marker-heavy log',()=>{
  const lines=Array.from({length:90},()=> '');
  for(let marker=1;marker<=16;marker++)lines[marker*5-1]='error '+'x'.repeat((marker===1?511:512)-6);
  lines[88]='a';lines[89]='界';
  const prepared=app.prepareCiSpans(lines.join('\n'));
  assert.equal(prepared.spans.reduce((n,span)=>n+Buffer.byteLength(span.text),0),8192);
  assert.ok(prepared.spans.some(span=>span.lineStart===89));assert.ok(!prepared.spans.some(span=>span.lineStart===90));
  const large=app.prepareCiSpans('error\n'.repeat(170000));
  assert.equal(large.spans.length,40);assert.equal(large.spans[0].lineStart,169961);assert.equal(large.spans.at(-1).lineStart,170000);
});

test('CI first render projection fences source/access/run/job/log/range changes and expired cached results synchronously',()=>{
  assert.equal(typeof app.projectCiView,'function');
  const source={databaseId:12,updatedAt:'2026-10-28T10:00:00Z',status:'completed',conclusion:'failure'};
  const text='AssertionError: expected 1, actual 2',prepared=app.prepareCiSpans(text);
  const view={mode:'ci',tab:'actions',identity:{...identity,sourceDigest:app.ciSourceDigest(source)},run:{id:12,attempt:2,headSha:identity.headSha},
    jobs:[{id:91,status:'completed',conclusion:'failure'},{id:92,status:'completed',conclusion:'failure'}],jobIndex:0,log:{text,digest:prepared.logDigest,lines:[text]},prepared,range:null};
  const bound=app.ciJevIdentity(view,prepared,identity.accessPartition);
  view.semantic={identity:bound,result:{observations:[{category:'assertion_mismatch'}]},evaluatedAt:1000};
  const context={host:identity.host,repo:identity.repo,accessPartition:identity.accessPartition,sourceRows:[source],nowMs:2000};
  assert.equal(app.projectCiView(view,context),view);
  for(const changed of [{accessPartition:null},{accessPartition:'other'},{repo:'acme/other'},{sourceRows:[{...source,updatedAt:'2026-10-28T10:01:00Z'}]}]){
    const projected=app.projectCiView(view,{...context,...changed});
    assert.equal(projected.semantic,null);assert.equal(projected.prepared,null);assert.equal(projected.log,null);
  }
  for(const changed of [{run:{...view.run,attempt:3}},{run:{...view.run,headSha:'b'.repeat(40)}},{jobIndex:1},
    {log:{...view.log,digest:'b'.repeat(64)}},{range:{startLine:1,endLine:2}}]){
    const projected=app.projectCiView({...view,...changed},context);
    assert.equal(projected.semantic,null);assert.equal(projected.prepared,null);
  }
  const expired=app.projectCiView(view,{...context,nowMs:601000});
  assert.equal(expired.semantic.result,undefined);assert.match(expired.semantic.message,/expired/);
});
