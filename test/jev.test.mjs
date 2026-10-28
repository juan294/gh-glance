import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as app from '../index.mjs';
const identity={feature:'focus',host:'github.com',repo:'acme/widget',accessPartition:'person',contentDigest:'abc',query:'sign in',questionVersion:'focus-v1'};
const rows=[{number:1,title:'Authentication session',author:'ana'},{number:2,title:'CSS color',author:'bob'}];
const request=()=>app.buildFocusJevRequest('sign in',rows,'issues').request;
const raw=(questions,p=.8)=>({model:'jev-1.14.0',answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:p}])),usage:{input_tokens:null,output_tokens:2}});
const fixture=(options={})=>{let calls=0;const session=app.createJevSession({enabled:true,key:'dummy',fetchImpl:async(_url,init)=>{calls++;return Response.json(raw(JSON.parse(init.body).questions));},...options});return {session,calls:()=>calls};};
test('Jev exact-filter manifest includes synonyms outside lexical matches; payload excludes identities',()=>{
 const result=app.buildFocusJevRequest('author:ana sign in',rows,'issues');
 assert.deepEqual(result.rows,[rows[0]]); assert.equal(Object.keys(result.request.questions).length,1);
 assert.equal(result.request.state.query,'sign in');
 assert.doesNotMatch(JSON.stringify(result.request),/ana|acme|widget|number|author/);
 assert.equal(Object.keys(app.buildFocusJevRequest('author:ana',rows,'issues').request.questions).length,0);
});
test('Jev boundaries and strict typed validator',()=>{
 assert.deepEqual([0,.3,.7,1].map(app.classifyJevProbability),['negative','uncertain','uncertain','positive']);
 const q={i0:{type:'noul'}}; assert.equal(app.validateJevResponse(raw(q),q).usage.input_tokens,null);
 for(const bad of [ {...raw(q),model:'jev-latest'}, {...raw(q),answers:{}}, {...raw(q),answers:{...raw(q).answers,extra:{type:'noul',noul:1}}},raw(q,NaN),raw(q,1.1),{...raw(q),usage:{input_tokens:-1,output_tokens:0}}]) assert.throws(()=>app.validateJevResponse(bad,q));
 const cq={c:{type:'choice',criteria:{yes:'yes',no:'no'}}};
 const cr={model:'jev-1.14.0',answers:{c:{type:'choice',choice:'yes',confidence:.8,probabilities:{yes:.8,no:.2}}},usage:{input_tokens:0,output_tokens:0}};
 assert.equal(app.validateJevResponse(cr,cq).answers.c.choice,'yes');
 for(const probabilities of [{yes:.2,no:.8},{yes:.8,no:.4},{yes:.8,other:.2}]) assert.throws(()=>app.validateJevResponse({...cr,answers:{c:{...cr.answers.c,probabilities}}},cq));
});
test('Jev disabled/no key/no consent imports and sends nothing; explicit grant succeeds and caches',async()=>{
 for(const options of [{enabled:false},{key:''},{}]){let imports=0;const f=fixture({...options,loadSdk:async()=>{imports++;return import('@typesafe-ai/sdk');}});
  if(options.enabled===false||options.key==='')f.session.grant(identity);
  assert.equal((await f.session.evaluateJev(request(),identity)).status,'unavailable');assert.equal(imports,0);assert.equal(f.calls(),0);}
 const f=fixture();f.session.grant(identity);let result=await f.session.evaluateJev(request(),identity);assert.equal(result.status,'complete');assert.equal(f.calls(),1);assert.equal(result.answers.i0.decision,'positive');
 result=await f.session.evaluateJev(request(),identity);assert.equal(f.calls(),1);assert.equal(result.cached,2);
 f.session.revoke(identity);assert.equal(f.session.stats().cacheItems,0);assert.equal((await f.session.evaluateJev(request(),identity)).status,'unavailable');
});
test('Jev caps dispatch, cooldown has no automatic retry and expiry allows explicit retry',async()=>{
 let now=1000,calls=0;const f=fixture({now:()=>now,maxRequests:2,fetchImpl:async(_u,init)=>{calls++;return calls===1?new Response('secret provider body',{status:429,headers:{'retry-after':'999'}}):Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
 assert.equal((await f.session.evaluateJev(request(),identity)).error,'cooldown');assert.equal(calls,1);
 assert.equal((await f.session.evaluateJev(request(),identity)).error,'cooldown');now+=60001;assert.equal(calls,1);
 assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');assert.equal(calls,2);
 f.session.clear();f.session.grant(identity);assert.equal((await f.session.evaluateJev(request(),identity)).error,'cap');assert.equal(calls,2);
});
test('Jev chunks 150 rows through 60/60/30 with exact partial coverage',async()=>{
 const f=fixture();f.session.grant(identity);const r=app.buildFocusJevRequest('topic',Array.from({length:150},(_,i)=>({number:i,title:'unrelated vocabulary'})),'issues').request;
 let a=await f.session.evaluateJev(r,identity);assert.equal(a.status,'partial');assert.equal(Object.keys(a.answers).length,60);assert.equal(f.calls(),4);
 a=await f.session.evaluateJev(r,identity);assert.equal(Object.keys(a.answers).length,120);assert.equal(f.calls(),8);
 a=await f.session.evaluateJev(r,identity);assert.equal(a.status,'complete');assert.equal(Object.keys(a.answers).length,150);assert.equal(f.calls(),10);
});
test('Jev equal requests join, changed identities cancel and stale completion never publishes',async()=>{
 let release;let calls=0;
 const f=fixture({fetchImpl:async(_u,init)=>{calls++;await new Promise(resolve=>{release=resolve;});return Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
 const first=f.session.evaluateJev(request(),identity);const equal=f.session.evaluateJev(request(),identity);assert.equal(first,equal);
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 const changed={...identity,query:'new topic'};f.session.grant(changed);
 const next=await f.session.evaluateJev(request(),changed);assert.equal(next.error,'busy');
 release();assert.equal((await first).error,'canceled');assert.equal(calls,1);
 let current=false;const good=fixture();good.session.grant(identity);assert.equal((await good.session.evaluateJev(request(),identity,{isCurrent:()=>current})).error,'canceled');
 current=true;assert.equal((await good.session.evaluateJev(request(),identity,{isCurrent:()=>current})).status,'complete');
});
test('Jev whole action deadline bounds import and body; explicit retry recovers',async()=>{
 const late=fixture({loadSdk:()=>new Promise(()=>{})});late.session.grant(identity);
 const start=Date.now();assert.equal((await late.session.evaluateJev(request(),identity,{deadlineAt:Date.now()+20})).error,'canceled');assert.ok(Date.now()-start<500);assert.equal(late.calls(),0);
 let attempts=0;
 const f=fixture({fetchImpl:async(_u,init)=>{attempts++;if(attempts===1)return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));return Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
 assert.equal((await f.session.evaluateJev(request(),identity,{deadlineAt:Date.now()+20})).error,'canceled');
 assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');assert.equal(attempts,2);
});
test('Jev streamed response bound rejects actual bytes with safe error and valid retry',async()=>{
 let attempts=0;
 const f=fixture({fetchImpl:async(_u,init)=>{attempts++;return attempts===1?new Response(new ReadableStream({start(c){for(let i=0;i<33;i++)c.enqueue(new Uint8Array(4096));c.close();}}),{headers:{'content-length':'1'}}):Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
 assert.equal((await f.session.evaluateJev(request(),identity)).error,'provider');assert.equal(attempts,1);
 assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');
});
test('Jev normalized cache is bounded, expires, partitions identity and ignores SDK env overrides',async()=>{
 let clock=1000,seen;const f=fixture({now:()=>clock,fetchImpl:async(url,init)=>{seen={url,init};return Response.json(raw(JSON.parse(init.body).questions,.5));}});f.session.grant(identity);
 const r=app.buildFocusJevRequest('topic',Array.from({length:150},(_,i)=>({number:i,title:'evidence'}))).request;
 for(let i=0;i<3;i++)await f.session.evaluateJev(r,identity);
 assert.equal(f.session.stats().cacheItems,128);assert.ok(f.session.stats().cacheBytes<=2097152);
 assert.equal(seen.url,'https://api.typesafe.ai/v1/systemone');assert.equal(seen.init.redirect,'error');assert.equal(seen.init.headers['Content-Encoding'],undefined);
 clock+=600001;assert.equal(f.session.stats().cacheItems,0);
 const other={...identity,accessPartition:'other'};assert.equal((await f.session.evaluateJev(request(),other)).error,'consent');
});
test('Jev projection/request bounds and branch case filters are enforced',()=>{
 const all=[{number:1,title:'x'.repeat(5000),headRefName:'Feature',author:'ana'},{number:2,title:'sign in',headRefName:'feature',author:'ana'}];
 const built=app.buildFocusJevRequest('branch:Feature sign in',all,'prs');assert.deepEqual(built.rows,[all[0]]);assert.equal(built.truncated,1);
 assert.ok(Buffer.byteLength(JSON.stringify(built.request.questions.i0.instructions.item))<=1024);
});
test('Jev semantic presentation keeps uncertain and unevaluated rows inspectable',()=>{
 const manifest=app.buildFocusJevRequest('sign in',rows);
 const result={answers:{i1:{type:'noul',probability:.5,decision:'uncertain'}}};
 assert.deepEqual(app.focusSemanticRows(manifest,result.answers),[rows[1],rows[0]]);
 assert.match(app.focusSemanticCoverage(manifest,result,98),/1\/2 eligible \(2 loaded\): 0 matches, 1 uncertain, 1 unevaluated/);
 assert.doesNotMatch(app.focusSemanticCoverage(manifest,result,98),/no match|nothing needs/i);
});
test('Jev import failure, invalid schema and removed model each recover through explicit retry',async()=>{
 let loads=0;const imported=fixture({loadSdk:()=>++loads===1?Promise.reject(new Error('private loader detail')):import('@typesafe-ai/sdk')});imported.session.grant(identity);
 assert.equal((await imported.session.evaluateJev(request(),identity)).error,'provider');assert.equal(imported.calls(),0);
 assert.equal((await imported.session.evaluateJev(request(),identity)).status,'complete');
 for(const failure of ['schema','model']){let attempts=0;const f=fixture({fetchImpl:async(_u,init)=>{attempts++;return attempts===1?(failure==='model'?new Response('unsupported model secret',{status:404}):Response.json({model:'wrong',answers:{}})):Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
  const failed=await f.session.evaluateJev(request(),identity);assert.equal(failed.error,failure==='model'?'model-unavailable':'provider');assert.deepEqual(failed.answers,{});assert.doesNotMatch(JSON.stringify(failed),/secret|wrong|detail/);
  assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');assert.equal(attempts,2);
 }
});
test('Jev sequential chunks share deadline and disclose only completed valid chunks',async()=>{
 let clock=1000,attempts=0;const f=fixture({now:()=>clock,fetchImpl:async(_u,init)=>{attempts++;clock+=2001;return Response.json(raw(JSON.parse(init.body).questions,.5));}});f.session.grant(identity);
 const r=app.buildFocusJevRequest('topic',Array.from({length:60},(_,i)=>({number:i,title:'evidence'}))).request;
 const result=await f.session.evaluateJev(r,identity);assert.equal(result.status,'partial');assert.equal(Object.keys(result.answers).length,15);assert.equal(attempts,2);assert.equal(result.error,'canceled');
});
test('Jev cancellation before dispatch, during headers, and revocation sends no obsolete result',async()=>{
 const before=fixture();before.session.grant(identity);const controller=new AbortController();controller.abort();assert.equal((await before.session.evaluateJev(request(),identity,{signal:controller.signal})).error,'canceled');assert.equal(before.calls(),0);
 let release;const f=fixture({fetchImpl:async(_u,init)=>{await new Promise(resolve=>{release=resolve;});return Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
 const promise=f.session.evaluateJev(request(),identity);while(!release)await new Promise(resolve=>setImmediate(resolve));f.session.revoke(identity);
 assert.equal((await promise).error,'canceled');assert.equal(f.session.stats().cacheItems,0);assert.equal(f.session.stats().requests,1);assert.equal(f.session.stats().remaining,99);release();
 await new Promise(resolve=>setImmediate(resolve));f.session.grant(identity);
 release=null;const recovered=f.session.evaluateJev(request(),identity);while(!release)await new Promise(resolve=>setImmediate(resolve));release();assert.equal((await recovered).status,'complete');
});
test('Jev fixed endpoint/model/logging ignore environment overrides and redirects never follow',async()=>{
 const names=['TYPESAFE_BASE_URL','TYPESAFE_DEFAULT_MODEL','TYPESAFE_LOG_LEVEL'];const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 for(const [i,name] of names.entries())process.env[name]=['https://unexpected.example','jev-latest','debug'][i];
 let attempts=0,redirectCanceled=0;const f=fixture({fetchImpl:async(url,init)=>{attempts++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(JSON.parse(init.body).model,'jev-1.14.0');assert.equal(init.redirect,'error');return attempts===1?new Response(new ReadableStream({cancel(){redirectCanceled++;}}),{status:302,headers:{location:'https://unexpected.example'}}):Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
 try{assert.equal((await f.session.evaluateJev(request(),identity)).error,'provider');assert.equal(attempts,1);assert.equal(redirectCanceled,1);assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');}finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
});
test('Jev active coverage has explicit manifest, byte and TTL bounds outside the LRU',async()=>{
 let clock=1000;const f=fixture({now:()=>clock});f.session.grant(identity);
 const oversized=app.buildFocusJevRequest('topic',Array.from({length:151},(_,i)=>({number:i,title:'title'}))).request;
 assert.equal((await f.session.evaluateJev(oversized,identity)).error,'input-too-large');assert.equal(f.calls(),0);
 const bounded=app.buildFocusJevRequest('topic',Array.from({length:150},(_,i)=>({number:i,title:'title'}))).request;
 for(let i=0;i<3;i++)await f.session.evaluateJev(bounded,identity);
 assert.equal(f.session.stats().activeItems,150);assert.ok(f.session.stats().activeBytes<=2097152);
 clock+=600001;assert.equal(f.session.stats().activeItems,0);assert.equal(f.session.stats().activeBytes,0);
});
test('Jev disclosure retains source age and incomplete-page disclosure alongside semantic results',()=>{
 const source='No local match; 0/150 matches among loaded title/metadata. Source 2m old. More source pages not searched.';
 const result='Jev 60/150 eligible (150 loaded): 0 matches, 60 uncertain, 90 unevaluated.';
 const lines=app.focusDisclosureLines(source,result);assert.ok(lines.includes(source));assert.ok(lines.includes(result));
});
test('Jev transport honors the SDK cancellation signal as well as the whole action',async()=>{
 let sdkAborted=false;
 const sdk={TypeSafeClient:class {constructor(config){this.config=config;}systemOne(batch){const controller=new AbortController();setImmediate(()=>controller.abort());return this.config.fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',body:JSON.stringify(batch),signal:controller.signal}).then(r=>r.json());}}};
 const f=fixture({loadSdk:async()=>sdk,fetchImpl:async(_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>{sdkAborted=true;reject(new Error('canceled'));},{once:true});})});f.session.grant(identity);
 const pending=f.session.evaluateJev(request(),identity,{deadlineAt:Date.now()+1000});
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(sdkAborted,true);assert.equal((await pending).error,'provider');
});
test('Jev source/account/query changed after dispatch rejects obsolete answer, then explicit retry recovers',async()=>{
 for(const field of ['contentDigest','accessPartition','query']){
  let release,current=identity;let attempts=0;
  const f=fixture({fetchImpl:async(_url,init)=>{attempts++;if(attempts===1)await new Promise(resolve=>{release=resolve;});return Response.json(raw(JSON.parse(init.body).questions));}});f.session.grant(identity);
  const pending=f.session.evaluateJev(request(),identity,{isCurrent:()=>current===identity});while(!release)await new Promise(resolve=>setImmediate(resolve));
  current={...identity,[field]:'changed'};release();const stale=await pending;assert.equal(stale.error,'stale');assert.deepEqual(stale.answers,{});assert.equal(f.session.stats().cacheItems,0);
  f.session.grant(current);assert.equal((await f.session.evaluateJev(request(),current)).status,'complete');assert.equal(attempts,2);
 }
});
test('Jev deferred import resolving after cancellation cannot dispatch; permitted retry succeeds',async()=>{
 let release,loads=0;const f=fixture({loadSdk:()=>++loads===1?new Promise(resolve=>{release=resolve;}):import('@typesafe-ai/sdk')});f.session.grant(identity);
 const controller=new AbortController();const pending=f.session.evaluateJev(request(),identity,{signal:controller.signal});while(!release)await new Promise(resolve=>setImmediate(resolve));
 controller.abort();assert.equal((await pending).error,'canceled');release(await import('@typesafe-ai/sdk'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls(),0);
 assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');assert.equal(f.calls(),1);
});
test('Jev oversized query and serialized request reject before dispatch; corrected input recovers',async()=>{
 const f=fixture();f.session.grant(identity);const r=request();
 for(const bad of [{...r,state:{query:'x'.repeat(257)}},{...r,questions:{i0:{type:'noul',instructions:'x'.repeat(25000)}}}])assert.equal((await f.session.evaluateJev(bad,identity)).error,'input-too-large');
 assert.equal(f.calls(),0);assert.equal((await f.session.evaluateJev(r,identity)).status,'complete');assert.equal(f.calls(),1);
});
test('Jev cache isolates every feature/source/question partition and reuses exact old identities',async()=>{
 for(const field of ['feature','host','repo','accessPartition','contentDigest','query','questionVersion']){
  const f=fixture();f.session.grant(identity);await f.session.evaluateJev(request(),identity);
  const other={...identity,[field]:'changed'};f.session.grant(other);assert.equal((await f.session.evaluateJev(request(),other)).status,'complete');assert.equal(f.calls(),2,field);
  assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');assert.equal(f.calls(),2,field+' exact cache');
 }
});
test('Jev cache byte eviction is exercised independently of the item-count limit',async()=>{
 let attempts=0;const criteria=Object.fromEntries(Array.from({length:1000},(_,i)=>['option_'+String(i).padStart(8,'0'),null]));
 const probabilities=Object.fromEntries(Object.keys(criteria).map(key=>[key,.001]));
 const r={model:'jev-1.14.0',state:{query:'topic'},questions:{c:{type:'choice',instructions:'Which?',criteria}}};
 assert.ok(Buffer.byteLength(JSON.stringify(r))<=24576);
 const f=fixture({maxRequests:200,fetchImpl:async()=>{attempts++;return Response.json({model:'jev-1.14.0',answers:{c:{type:'choice',choice:Object.keys(criteria)[0],confidence:.5,probabilities}},usage:{input_tokens:1,output_tokens:0}});}});f.session.grant(identity);
 for(let i=0;i<100;i++)assert.equal((await f.session.evaluateJev(r,{...identity,contentDigest:String(i)})).status,'complete');
 assert.equal(attempts,100);assert.ok(f.session.stats().cacheItems<100);assert.ok(f.session.stats().cacheItems<128);assert.ok(f.session.stats().cacheBytes<=2097152);
 await f.session.evaluateJev(r,{...identity,contentDigest:'99'});assert.equal(attempts,100);
 await f.session.evaluateJev(r,{...identity,contentDigest:'0'});assert.equal(attempts,101);
});
test('Jev retained rows cannot authorize an unverified partition; verified recovery needs fresh scoped permission',async()=>{
 let imports=0;const f=fixture({loadSdk:async()=>{imports++;return import('@typesafe-ai/sdk');}}),unknown={...identity,accessPartition:'unverified'};
 assert.equal(f.session.grant(unknown),false);assert.equal((await f.session.evaluateJev(request(),unknown)).error,'identity');assert.equal(imports,0);assert.equal(f.calls(),0);
 assert.equal((await f.session.evaluateJev(request(),identity)).error,'consent');assert.equal(imports,0);
 f.session.grant(identity);assert.equal((await f.session.evaluateJev(request(),identity)).status,'complete');assert.equal(imports,1);assert.equal(f.calls(),1);
 f.session.revokeAll();assert.equal(f.session.hasConsent(identity),false);assert.equal(f.session.stats().activeItems,0);
});
test('Jev active result byte cap rejects an overflowing chunk without publishing or retaining it',async()=>{
 const criteria=Object.fromEntries(Array.from({length:127},(_,i)=>['o'+String(i).padStart(3,'0'),null]));
 const probabilities=Object.fromEntries(Object.keys(criteria).map(k=>[k,1/127]));
 const questions=Object.fromEntries(Array.from({length:600},(_,i)=>['q'+i,{type:'choice',criteria}]));
 const r={model:'jev-1.14.0',state:{query:'topic'},questions},attention={...identity,feature:'attention'};
 const f=fixture({fetchImpl:async(_url,init)=>Response.json({model:'jev-1.14.0',answers:Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id=>[id,{type:'choice',choice:'o000',confidence:.5,probabilities}])),usage:{input_tokens:1,output_tokens:0}})});f.session.grant(attention);
 let result;for(let i=0;i<10;i++){result=await f.session.evaluateJev(r,attention);if(result.error)break;}
 assert.equal(result.error,'input-too-large');assert.equal(result.status,'partial');assert.ok(f.session.stats().activeItems<600);assert.ok(f.session.stats().activeBytes<=2097152);
 assert.equal(Object.keys(result.answers).length,f.session.stats().activeItems);
});
