import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ATTENTION_BADGES,ATTENTION_QUESTION_VERSION,GRAPHQL_QUERIES,attentionManifest,attentionBatchVariables,normalizeAttentionBatch,buildAttention,buildAttentionJevRequest,fetchAttentionBatch,createJevSession,createIdentityCoordinator,createGovernorScope,registerLease,claimProbe,publishProbe,runAdmittedOperation,inspectGovernor,operationPausedUntil,acquisitionPublicationDeadline,pollPolicyInterval,createAcquisitionEngine,attentionEligibleRows,projectAttentionView,attentionPanel,attentionSemanticIdentity} from '../index.mjs';
import {graphqlShape} from './fixtures/request-oracle.mjs';
const viewer={id:7,login:'viewer',kind:'user',human:true,host:'github.com',accessKey:'access'};
const row=(kind,number,updatedAt='2026-10-28T10:00:00Z')=>({kind,number,title:`${kind} ${number}`,updatedAt,url:`https://github.com/acme/widget/${kind==='prs'?'pull':'issues'}/${number}`});
const connection=(nodes=[],hasNextPage=false,totalCount=nodes.length)=>({nodes,pageInfo:{hasNextPage},totalCount});
const detail=(candidate,extra={})=>({__typename:candidate.kind==='prs'?'PullRequest':'Issue',id:`${candidate.kind}_${candidate.number}`,number:candidate.number,closed:false,updatedAt:candidate.updatedAt,viewerDidAuthor:false,assignees:connection(),...(candidate.kind==='prs'?{isDraft:false,reviewDecision:null,reviewRequests:connection()}:{}),...extra});
const envelope=(manifest,nodes)=>({viewer:{id:'U_7',databaseId:7,login:'viewer'},repository:{id:'R_acme_widget',nameWithOwner:'acme/widget',url:'https://github.com/acme/widget',...Object.fromEntries(nodes.map((n,i)=>[`c${i}`,n]))}});
const manifestFor=rows=>attentionManifest({issues:rows.filter(r=>r.kind==='issues'),prs:rows.filter(r=>r.kind==='prs')},{host:'github.com',repo:'acme/widget',accessPartition:'access',viewer});

test('attention manifest deduplicates composite identities, bounds and stable latest-first order',()=>{
 const manifest=manifestFor([row('issues',1),row('prs',1),row('issues',1),row('issues',2,'2026-10-29T10:00:00Z')]);
 assert.deepEqual(manifest.rows.map(r=>r.key),['issues:2','issues:1','prs:1']);assert.equal(manifest.rows.length,3);
 const variables=attentionBatchVariables(manifest,0);assert.equal(Object.keys(variables).length,52);assert.equal(variables.use3,false);assert.equal(variables.n3,2);
 const shape=graphqlShape(GRAPHQL_QUERIES.attention.query,variables);assert.equal(shape.operation,'attention.details');assert.equal(shape.candidates.length,3);
 assert.throws(()=>graphqlShape(GRAPHQL_QUERIES.attention.query.replace('c0:','evil:'),variables));
 assert.throws(()=>graphqlShape(GRAPHQL_QUERIES.attention.query.replace('first:50','first:51'),variables));
});
test('attention validates viewer, slot kind/number/node ID and accepts changed metadata facts',()=>{
 const m=manifestFor([row('issues',1),row('prs',1)]),d=envelope(m,m.rows.map(r=>detail(r)));
 assert.throws(()=>normalizeAttentionBatch(m,{...d,viewer:{...d.viewer,databaseId:8}},0,{}),/identity/);
 assert.throws(()=>normalizeAttentionBatch(m,{...d,repository:{...d.repository,c0:d.repository.c1,c1:d.repository.c0}},0,{}),/identity/);
 const first=normalizeAttentionBatch(m,d,0,{},1000);assert.equal(first['issues:1'].assigned,false);
 const changed=structuredClone(d);changed.repository.c0.updatedAt='2026-10-29T11:00:00Z';changed.repository.c0.assignees=connection([{id:'U_7',login:'viewer'}]);
 const next=normalizeAttentionBatch(m,changed,0,first,1100);assert.equal(next['issues:1'].assigned,true);assert.equal(next['issues:1'].metadataChanged,true);
 changed.repository.c0.id='different';assert.throws(()=>normalizeAttentionBatch(m,changed,0,first),/identity/);
 const unavailable=structuredClone(d);unavailable.repository.c0=null;const gap={...first,...normalizeAttentionBatch(m,unavailable,0,first)};assert.throws(()=>normalizeAttentionBatch(m,changed,0,gap),/identity/);
});
test('attention tri-state relations preserve positive node50; incomplete and malformed absence stays unknown',()=>{
 const m=manifestFor([row('prs',1)]);const check=extra=>normalizeAttentionBatch(m,envelope(m,[detail(m.rows[0],extra)]),0,{},1000)['prs:1'];
 const users=Array.from({length:50},(_,i)=>({id:i===49?'U_7':`U_${i+20}`,login:`u${i}`}));
 assert.equal(check({assignees:connection(users,true,100)}).assigned,true);
 assert.equal(check({assignees:connection([],true,50)}).assigned,null);
 assert.equal(check({assignees:connection([null],false,1)}).assigned,null);
 assert.equal(check({reviewRequests:connection([{requestedReviewer:{__typename:'Team'}}])}).reviewRequested,false);
 assert.equal(check({reviewRequests:connection([{requestedReviewer:{__typename:'Bot'}}])}).reviewRequested,false);
 assert.equal(check({reviewRequests:connection([{requestedReviewer:null}])}).reviewRequested,null);
 assert.equal(check({reviewRequests:connection([{requestedReviewer:{__typename:'Mystery'}}])}).reviewRequested,null);
});
test('attention deterministic reasons/tier/order exclude closed and retain draft direct request',()=>{
 const m=manifestFor([row('prs',1),row('issues',2),row('prs',3),row('prs',4)]);
 const nodes=m.rows.map(r=>detail(r,{assignees:connection([{id:'U_7',login:'viewer'}]),...(r.number===1?{isDraft:true,reviewRequests:connection([{requestedReviewer:{__typename:'User',id:'U_7',login:'viewer'}}])}:{}),...(r.number===4?{closed:true}:{})}));
 const records=normalizeAttentionBatch(m,envelope(m,nodes),0,{},1000);const q=buildAttention(m,records,{nowMs:1100});
 assert.deepEqual(q.queue.map(r=>r.key),['prs:1','issues:2','prs:3']);assert.equal(q.queue[0].tier,1);assert.equal(q.queue[0].isDraft,true);assert.equal(q.queue[0].reasons.length,2);
 assert.equal(buildAttention(m,records,{nowMs:301000}).expired,4);assert.equal(buildAttention(m,records,{nowMs:301000}).queue.length,0);
 const snapshots=JSON.stringify(records);const badges={answers:{i0_reported_regression:{decision:'positive',probability:1}}};assert.deepEqual(buildAttention(m,records,{nowMs:1100,badges}).queue,q.queue);assert.equal(JSON.stringify(records),snapshots);
});
test('attention metadata builder has two fixed independent badges and bounded inert fields only',()=>{
 const built=buildAttentionJevRequest([{...row('prs',1),title:'Regression: previously worked',labels:['bug'],branch:'fix/regression',body:'never send',author:'private'}]);
 assert.equal(ATTENTION_QUESTION_VERSION,'attention-v1');assert.deepEqual(ATTENTION_BADGES,['reported_regression','user_visible_impact']);assert.equal(Object.keys(built.request.questions).length,2);
 assert.deepEqual(Object.keys(built.questionIds[0]),ATTENTION_BADGES);assert.doesNotMatch(JSON.stringify(built.request),/private|never send|acme\/widget/);
 const huge=buildAttentionJevRequest([{...row('issues',1),title:'x'.repeat(10000)}]);assert.equal(huge.truncated,1);assert.ok(Buffer.byteLength(JSON.stringify(huge.request.questions.i0_reported_regression.instructions.item))<=1024);
});
test('attention response bound precedes parsing, error+data retains meter and explicit next call recovers',async()=>{
 const m=manifestFor([row('issues',1)]);let calls=0;
 const run=async(_args,options)=>{calls++;assert.equal(options.timeoutMs,30000);assert.ok(options.maxBuffer<=2*1024*1024+16384);return 'HTTP/2 200 OK\r\n\r\n'+JSON.stringify({data:{...envelope(m,[detail(m.rows[0])]),rateLimit:{cost:2,limit:5000,used:2,remaining:4998,resetAt:new Date(Date.now()+3600000).toISOString()}},...(calls===1?{errors:[{message:'permission'}]}:{})});};
 const first=await fetchAttentionBatch(m,0,{run});assert.equal(first.ok,false);assert.equal(first.requestMetrics.graphqlUnits,2);const second=await fetchAttentionBatch(m,0,{run});assert.equal(second.ok,true);assert.equal(calls,2);
 const large=await fetchAttentionBatch(m,0,{run:async()=> 'HTTP/2 200 OK\r\n\r\n'+ ' '.repeat(2*1024*1024+1)});assert.equal(large.ok,false);assert.equal(large.reason,'response-too-large');
});
test('attention actual SDK batches pairs <=15 items/HTTP and60 items/action with next explicit batch',async()=>{
 const calls=[],session=createJevSession({enabled:true,key:'synthetic',fetchImpl:async(_url,options)=>{const request=JSON.parse(options.body);calls.push(request);return Response.json({model:request.model,answers:Object.fromEntries(Object.keys(request.questions).map(id=>[id,{type:'noul',noul:.5}])),usage:{input_tokens:1,output_tokens:1}});}});
 const built=buildAttentionJevRequest(Array.from({length:65},(_,i)=>row('issues',i+1))),identity={feature:'attention',host:'github.com',repo:'acme/widget',accessPartition:'access',contentDigest:'test',questionVersion:ATTENTION_QUESTION_VERSION};session.grant(identity);
 const first=await session.evaluateJev(built.request,identity);assert.equal(first.status,'partial');assert.equal(Object.keys(first.answers).length,120);assert.equal(calls.length,4);assert.ok(calls.every(c=>Object.keys(c.questions).length===30));
 const second=await session.evaluateJev(built.request,identity);assert.equal(second.status,'complete');assert.equal(calls.length,5);assert.equal(Object.keys(calls[4].questions).length,10);
});

test('attention human proof is ephemeral, exact-scope, and explicit cached-user recovery does not alter identity schema',async t=>{
 const root=mkdtempSync(join(tmpdir(),'glance-human-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let at=Date.now();
 const options={host:'github.com',pathOptions:{env:{XDG_CONFIG_HOME:root}},env:{GH_TOKEN:'synthetic-human'},now:()=>at,requestIdentity:async()=>({status:200,body:{id:7,login:'viewer',type:'User'},rateLimit:{resource:'core',limit:5000,used:1,remaining:4999,resetMs:at+3600000}})};
 const first=createIdentityCoordinator(options);t.after(()=>first.close());await first.refresh();assert.equal(first.humanIdentity().id,7);
 const cached=createIdentityCoordinator(options);t.after(()=>cached.close());await cached.refresh();assert.equal(cached.humanIdentity(),null);
 const identity=cached.current();assert.equal(cached.observeUserProof({...identity,id:8},{id:8,login:'other',type:'User'}),false);assert.equal(cached.humanIdentity(),null);
 assert.equal(cached.observeUserProof(identity,{id:7,login:'viewer',type:'Bot'}),true);assert.equal(cached.humanIdentity(),null);
 cached.observeUserProof(identity,{id:7,login:'viewer',type:'User'});assert.equal(cached.humanIdentity().id,7);assert.equal(Object.hasOwn(cached.current(),'human'),false);
});

test('attention strict oracle rejects aliased leaves, wrapper arguments/directives and literal/swapped variables',()=>{
 const m=manifestFor([row('issues',1),row('prs',1)]),v=attentionBatchVariables(m),q=GRAPHQL_QUERIES.attention.query;
 for(const changed of [q.replace('viewer{id','viewer{id:login'),q.replace('viewer{','viewer(extra:1){'),q.replace('pageInfo{','pageInfo @include(if:$use0){'),q.replace('nodes{id login}','nodes(first:50){id login}'),q.replace('requestedReviewer{','requestedReviewer(extra:1){'),q.replace('number:$n0','number:1'),q.replace('number:$n0','number:$n1')])assert.throws(()=>graphqlShape(changed,v),changed);
});
test('attention regression criteria accept explicit internal-tool regressions independently of user-impact badge',()=>{
 const built=buildAttentionJevRequest([{title:'The internal generator worked yesterday and now crashes',labels:[],branch:null}]);
 const regression=built.request.questions[built.questionIds[0].reported_regression],impact=built.request.questions[built.questionIds[0].user_visible_impact];
 assert.match(regression.criteria.false,/internal detail without an explicit report/);assert.match(impact.criteria.false,/purely internal detail/);assert.notEqual(regression.criteria.false,impact.criteria.false);
});
test('attention byte packing sends complete badge pairs for long bounded metadata and reaches next action',async()=>{
 const calls=[],session=createJevSession({enabled:true,key:'synthetic',fetchImpl:async(_url,options)=>{const r=JSON.parse(options.body);calls.push(r);return Response.json({model:r.model,answers:Object.fromEntries(Object.keys(r.questions).map(id=>[id,{type:'noul',noul:.9}])),usage:{input_tokens:1,output_tokens:1}});}});
 const built=buildAttentionJevRequest(Array.from({length:16},(_,i)=>({...row('issues',i+1),title:'x'.repeat(1000)}))),identity={feature:'attention',host:'github.com',repo:'acme/widget',accessPartition:'access',contentDigest:'long'};session.grant(identity);
 const result=await session.evaluateJev(built.request,identity);assert.equal(result.status,'complete');assert.ok(calls.length>1);for(const r of calls){assert.ok(Buffer.byteLength(JSON.stringify(r))<=24576);assert.equal(Object.keys(r.questions).length%2,0);assert.ok(Object.keys(r.questions).length<=30);}
});

test('attention malformed identity is unknown without losing other valid slots, closed rows leave unknown too',()=>{
 const m=manifestFor([row('issues',1),row('prs',2)]),d=envelope(m,m.rows.map(r=>detail(r)));d.repository.c0.id=null;
 const result=normalizeAttentionBatch(m,d);assert.equal(result['issues:1'].unknown,true);assert.equal(result['prs:2'].assigned,false);
 const closed=detail(m.rows[0],{closed:true,assignees:connection([],true,50)});const facts=normalizeAttentionBatch(m,envelope(m,[closed,detail(m.rows[1])]));assert.equal(buildAttention(m,facts).unknown.length,0);
});
test('attention connection bounds are literal50 rather than resolved variable values',()=>{
 const m=manifestFor([row('issues',50)]),v=attentionBatchVariables(m),q=GRAPHQL_QUERIES.attention.query;
 assert.throws(()=>graphqlShape(q.replace('assignees(first:50)','assignees(first:$n0)'),v));
});

test('attention actual admission settles normal meters and cost-overrun conservatively then blocks redispatch',async t=>{
 const root=mkdtempSync(join(tmpdir(),'glance-attention-meter-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let at=Date.now()+1000;const resetAt=at+3600000;t.mock.method(Date,'now',()=>at);
 const scope=createGovernorScope({effectiveHost:'github.com',authIdentity:'attention-meter',env:{XDG_CONFIG_HOME:root},now:()=>at}).value,leaseId=randomUUID();
 registerLease(scope,{id:leaseId,expiresAt:at+60000,floorMs:5000,activeTab:'issues',phaseSeed:{seed:leaseId,registeredAt:at},demand:{core:0,graphql:2}},at);
 const probe=claimProbe(scope,leaseId,at,'graphql');publishProbe(scope,leaseId,probe.value.nonce,{graphql:{limit:5000,used:0,remaining:5000,resetMs:at+3600000}},at,'graphql');
 const manifest=manifestFor([row('issues',1)]);let calls=0,cost=2;
 const run=async()=>{calls++;return 'HTTP/2 200 OK\r\n\r\n'+JSON.stringify({data:{...envelope(manifest,[detail(manifest.rows[0])]),rateLimit:{cost,limit:5000,used:cost===2?2:5,remaining:cost===2?4998:4995,resetAt:new Date(resetAt).toISOString()}}});};
 const act=()=>runAdmittedOperation({scope,leaseId,operation:'attention:details',now:()=>at,waitMs:5000,wait:async ms=>{at+=ms+1;return true;},run:signal=>fetchAttentionBatch(manifest,0,{signal,run})});
 const normal=await act();assert.equal(normal.ok,true,JSON.stringify(normal));assert.equal(inspectGovernor(scope,at).value.budgets.graphql.remaining,4998);
 at+=10000;cost=3;const overrun=await act();assert.equal(overrun.ok,false);assert.equal(inspectGovernor(scope,at).value.budgets.graphql.remaining,4995);assert.equal(inspectGovernor(scope,at).value.reservations[overrun.reservationId].status,'completed');assert.ok(operationPausedUntil('attention:details',at)>at);
 const blocked=await act();assert.equal(blocked.ok,false);assert.equal(calls,2);operationPausedUntil('attention:details',at+7200000);
});
test('attention source age advances locally and detail expiry suppresses completed badges before Unknown render',()=>{
 const m=manifestFor([row('issues',1)]),facts=normalizeAttentionBatch(m,envelope(m,[detail(m.rows[0],{assignees:connection([{id:'U_7',login:'viewer'}])})]),0,{},1000);
 const view={mode:'attention',manifest:m,records:facts,generation:1,coverage:[{kind:'issues',count:1,sourceAt:1000,missing:false,partial:true}],batches:[]};
 const built=buildAttentionJevRequest(buildAttention(m,facts,{nowMs:1001}).queue),identity=attentionSemanticIdentity(view,built.rows);
 view.semantic={identity,manifest:built,evaluatedAt:1001,result:{answers:Object.fromEntries(Object.values(built.questionIds[0]).map(id=>[id,{decision:'positive',probability:1}]))}};
 const actualSources={issues:[row('issues',1)],prs:[]};
 const context={host:'github.com',repo:'acme/widget',accessPartition:'access',viewerId:7,human:true,nowMs:301001};
 const projected=projectAttentionView(view,context,actualSources);assert.equal(projected.semantic,null);assert.doesNotMatch(attentionPanel({...projected,unknownView:true},{nowMs:301001}).lines.join(' '),/Reports regression|Describes user impact/);
 const initial=attentionPanel({...view,semantic:null},{nowMs:2000,rows:60}).lines.join(' '),later=attentionPanel({...view,semantic:null},{nowMs:62000,rows:60}).lines.join(' ');assert.match(initial,/1s old/);assert.match(later,/1m1s old/);
});
test('attention header-only quota evidence does not turn a point estimate into measured GraphQL units',async()=>{
 const m=manifestFor([row('issues',1)]),reset=Math.floor((Date.now()+3600000)/1000);
 const result=await fetchAttentionBatch(m,0,{run:async()=>`HTTP/2 200 OK\r\nx-ratelimit-resource: graphql\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-used: 2\r\nx-ratelimit-remaining: 4998\r\nx-ratelimit-reset: ${reset}\r\n\r\n`+JSON.stringify({data:envelope(m,[detail(m.rows[0])])})});
 assert.equal(result.ok,true);assert.equal(Object.hasOwn(result.requestMetrics,'graphqlUnits'),false);assert.equal(result.observedCost,null);assert.equal(result.budgetObservations[0].cost,null);
});
test('attention aggregate retention stays <=300 normalized records/2MiB and stores no full connections',()=>{
 const m=manifestFor(Array.from({length:50},(_,i)=>row('issues',i+1))),nodes=m.rows.slice(0,25).map(r=>detail(r,{id:'x'.repeat(70000)+r.number}));
 const first=normalizeAttentionBatch(m,envelope(m,nodes),0);assert.ok(Buffer.byteLength(JSON.stringify(first))<2*1024*1024);assert.ok(Object.values(first).every(r=>!Object.hasOwn(r,'assignees')&&!Object.hasOwn(r,'reviewRequests')));
 assert.throws(()=>normalizeAttentionBatch(m,envelope(m,m.rows.slice(25).map(r=>detail(r,{id:'y'.repeat(70000)+r.number}))),25,first),/aggregate-limit/);
});
test('attention deadline aborts exactly one external batch and next explicit batch succeeds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const m=manifestFor([row('issues',1)]);
 const pending=fetchAttentionBatch(m,0,{run:async(_args,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('synthetic timeout'),{name:'AbortError'})),{once:true}));}});
 t.mock.timers.tick(30000);const result=await pending;assert.equal(result.ok,false);assert.equal(calls,1);
 const next=await fetchAttentionBatch(m,0,{run:async()=>{calls++;return 'HTTP/2 200 OK\r\n\r\n'+JSON.stringify({data:envelope(m,[detail(m.rows[0])])});}});assert.equal(next.ok,true);assert.equal(calls,2);
});
test('attention canonical repository URL accepts case while refusing foreign host/repository and credentials',()=>{
 const m=manifestFor([row('issues',1)]),d=envelope(m,[detail(m.rows[0])]);d.repository.nameWithOwner='Acme/Widget';d.repository.url='https://github.com/Acme/Widget';assert.equal(normalizeAttentionBatch(m,d)['issues:1'].assigned,false);
 for(const url of ['https://evil.example/acme/widget','https://github.com/acme/other','https://user:pass@github.com/acme/widget']){d.repository.url=url;assert.throws(()=>normalizeAttentionBatch(m,d),/identity/);}
});

test('attention changed details retain facts, then refreshed matching metadata becomes badge-eligible without a stale loop',()=>{
 const old=manifestFor([row('issues',1)]),changed=detail(old.rows[0],{updatedAt:'2026-10-29T11:00:00Z',assignees:connection([{id:'U_7',login:'viewer'}])});
 const records=normalizeAttentionBatch(old,envelope(old,[changed]),0,{},1000),view={mode:'attention',manifest:old,records};assert.equal(buildAttention(old,records,{nowMs:1100}).queue.length,1);assert.equal(attentionEligibleRows(view,1100).length,0);
 const refreshed=manifestFor([{...row('issues',1),updatedAt:changed.updatedAt}]),fresh=normalizeAttentionBatch(refreshed,envelope(refreshed,[changed]),0,{},1200);assert.equal(attentionEligibleRows({...view,manifest:refreshed,records:fresh},1300).length,1);
});
test('attention tab retirement hides scoped facts and badges synchronously before effect cleanup',()=>{
 const m=manifestFor([row('issues',1)]),view={mode:'attention',tab:'issues',manifest:m,records:{},semantic:{result:{answers:{}}}};
 const projected=projectAttentionView(view,{host:'github.com',repo:'acme/widget',accessPartition:'access',viewerId:7,human:true,activeTab:'prs',nowMs:1000},{issues:[row('issues',1)],prs:[]});assert.equal(projected.manifest,null);assert.equal(projected.semantic,null);assert.deepEqual(projected.records,{});
 for(const change of [{accessPartition:'other'},{viewerId:8},{human:false},{repo:'acme/other'},{host:'other.example'}]){const next=projectAttentionView(view,{host:'github.com',repo:'acme/widget',accessPartition:'access',viewerId:7,human:true,activeTab:'issues',nowMs:1000,...change},{issues:[row('issues',1)],prs:[]});assert.equal(next.manifest,null);assert.equal(next.semantic,null);assert.deepEqual(next.records,{});}
});
test('attention panel distinguishes unknown batch cost from the conservative reservation',()=>{
 const m=manifestFor([row('issues',1)]),view={mode:'attention',manifest:m,records:{},batches:[{start:0,count:1,fetchedAt:1000,observedCost:null}]};const text=attentionPanel(view,{rows:80,nowMs:1100}).lines.join(' ');assert.match(text,/0 observed GraphQL points; 1 unknown-cost batches/);assert.match(text,/conservative 2 retained/);assert.doesNotMatch(text,/actual cost metered/);
});
test('attention one expired cached badge still packs whole item pairs within distinct item limits',async()=>{
 let at=1000,advancing=true;const calls=[],now=()=>advancing?at++:at,session=createJevSession({enabled:true,key:'synthetic',now,fetchImpl:async(_url,options)=>{const r=JSON.parse(options.body);calls.push(r);return Response.json({model:r.model,answers:Object.fromEntries(Object.keys(r.questions).map(id=>[id,{type:'noul',noul:.9}])),usage:{input_tokens:1,output_tokens:1}});}}),built=buildAttentionJevRequest(Array.from({length:30},(_,i)=>row('issues',i+1))),identity={feature:'attention',host:'github.com',repo:'acme/widget',accessPartition:'access',contentDigest:'boundary'};session.grant(identity);assert.equal((await session.evaluateJev(built.request,identity)).status,'complete');const initial=calls.length;
 advancing=false;at=601001;while(at<602000&&session.stats().cacheItems%2===0)at++;assert.equal(session.stats().cacheItems%2,1);const result=await session.evaluateJev(built.request,identity);assert.equal(result.status,'complete');assert.ok(calls.length>initial);for(const r of calls.slice(initial)){const ids=Object.keys(r.questions),items=new Set(ids.map(id=>id.split('_')[0]));assert.ok(items.size<=15);assert.equal(ids.length,items.size*2);}
});

test('inactive manual source publication has a finite conservative hint, normalizes and adopts while local off policy stays idle',async t=>{
 const at=Date.now(),policy={tab:'prs',floorMs:5000,demand:'inactive',unchangedCount:0,background:'off'};assert.equal(pollPolicyInterval(policy),Infinity);const deadline=acquisitionPublicationDeadline(at,policy);assert.equal(deadline,at+pollPolicyInterval({...policy,demand:'active',background:'all'}));assert.equal(pollPolicyInterval(policy),Infinity);
 const root=mkdtempSync(join(tmpdir(),'glance-publication-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const engine=createAcquisitionEngine({pathOptions:{env:{XDG_CONFIG_HOME:root}},now:()=>at});t.after(()=>engine.close());
 const query={host:'github.com',repositoryId:'R_widget',repository:'acme/widget',accessKey:'a'.repeat(64),targetKey:'github.com\0R_widget',resource:'prs',queryVersion:2,filters:{},pageSize:50,cursorGeneration:'first'},subscription=engine.subscribe(query,{active:false,floorMs:5000});let calls=0;
 const produced=await engine.refresh(subscription.value.id,{force:true,acquire:async()=>{calls++;return {rows:[],entities:[],raw:'[]',pageInfo:{loadedPages:1,hasNextPage:false},lastSuccessAt:at,lastChangedAt:at,nextDueAt:deadline,hold:null,capabilities:{},meta:{at,truncated:false},securityNotes:[],securityBlind:false};}});assert.equal(produced.ok,true,JSON.stringify(produced));assert.equal(produced.value.snapshot.lastSuccessAt,at);const adopted=engine.subscribe(query,{active:true,floorMs:5000});assert.equal(adopted.value.snapshot.lastSuccessAt,at);assert.equal(adopted.value.snapshot.nextDueAt,deadline);assert.equal(calls,1);
});
test('attention metadata coverage discloses truncation, uncertain answers and unqueried rows independently of the queue',()=>{
 const m=manifestFor([{...row('issues',1),title:'x'.repeat(2000)}]),records=normalizeAttentionBatch(m,envelope(m,[detail(m.rows[0],{assignees:connection([{id:'U_7',login:'viewer'}])})]),0,{},1000),queue=buildAttention(m,records,{nowMs:1100}).queue,built=buildAttentionJevRequest(queue);
 const answers=Object.fromEntries(Object.values(built.questionIds[0]).map(id=>[id,{decision:'uncertain',probability:.5}])),view={mode:'attention',manifest:m,records,semantic:{manifest:built,result:{answers}}};const text=attentionPanel(view,{rows:80,nowMs:1100}).lines.join(' ');assert.match(text,/1 row truncated/);assert.match(text,/2 uncertain badge answers/);assert.match(text,/0 unqueried metadata rows/);assert.doesNotMatch(text,/Reports regression|Describes user impact/);assert.equal(buildAttention(m,records,{nowMs:1100}).queue.length,1);
});

test('attention staged detail source binding retires on a later source change before effects',()=>{
 const initial={issues:[row('issues',1)],prs:[]},m=manifestFor(initial.issues),fresh={issues:[{...initial.issues[0],title:'T1'}],prs:[]},freshManifest=manifestFor(fresh.issues),view={mode:'attention',tab:'issues',manifest:m,records:{},busy:true,refreshingLists:true,pendingSourceDigest:freshManifest.sourceDigest,semantic:null},context={host:'github.com',repo:'acme/widget',accessPartition:'access',viewerId:7,human:true,activeTab:'issues',nowMs:1000};
 assert.equal(projectAttentionView(view,context,fresh),view);
 const later={issues:[{...fresh.issues[0],title:'T2'}],prs:[]},retired=projectAttentionView(view,context,later);assert.equal(retired.stale,true);assert.equal(retired.busy,false);assert.equal(retired.refreshingLists,false);assert.equal(retired.pendingSourceDigest,null);assert.equal(retired.semantic,null);
 for(const change of [{activeTab:'prs'},{accessPartition:'other'},{viewerId:8},{human:false},{repo:'acme/other'}]){const invalid=projectAttentionView(view,{...context,...change},fresh);assert.equal(invalid.manifest,null);assert.equal(invalid.busy,false);assert.equal(invalid.pendingSourceDigest,null);assert.equal(invalid.refreshingLists,false);}
});

test('attention source binding survives the actual acquisition snapshot codec but retires real metadata changes',async t=>{
 const root=mkdtempSync(join(tmpdir(),'glance-attention-codec-'));
 const at=Date.parse('2026-10-29T12:00:00Z'),engine=createAcquisitionEngine({pathOptions:{env:{XDG_CONFIG_HOME:root}},now:()=>at});t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true});});
 const live={number:1,title:'Review the session fix',author:'viewer',headRefName:'fix/session',isDraft:false,reviewDecision:null,updatedAt:'2026-10-28T10:00:00Z',url:'https://github.com/acme/widget/pull/1'};
 const query={host:'github.com',repositoryId:'R_widget',repository:'acme/widget',accessKey:'a'.repeat(64),targetKey:'github.com\0R_widget',resource:'prs',queryVersion:2,filters:{},pageSize:50,cursorGeneration:'first'},subscription=engine.subscribe(query,{active:false,floorMs:5000});
 const produced=await engine.refresh(subscription.value.id,{force:true,acquire:async()=>({rows:[live],entities:[],raw:JSON.stringify([live]),pageInfo:{loadedPages:1,hasNextPage:false},lastSuccessAt:at,lastChangedAt:at,nextDueAt:at+5000,hold:null,capabilities:{},meta:{at,truncated:false},securityNotes:[],securityBlind:false})});
 assert.equal(produced.ok,true,JSON.stringify(produced));const cached=produced.value.snapshot.rows[0];
 assert.equal(cached.reviewDecision,'');assert.deepEqual({...cached,reviewDecision:null},live);
 const identity={host:'github.com',repo:'acme/widget',accessPartition:'access',viewer},sources={issues:[],prs:[live]},m=attentionManifest(sources,identity),roundTrip={issues:[],prs:[cached]};
 assert.equal(attentionManifest(roundTrip,identity).sourceDigest,m.sourceDigest);
 const view={mode:'attention',tab:'prs',manifest:m,records:{},busy:true,refreshingLists:false,pendingSourceDigest:m.sourceDigest,semantic:null},context={host:'github.com',repo:'acme/widget',accessPartition:'access',viewerId:7,human:true,activeTab:'prs',nowMs:at};
 assert.equal(projectAttentionView(view,context,roundTrip),view);
 assert.equal(live.reviewDecision,null);assert.equal(cached.reviewDecision,'');
 for(const patch of [{number:2},{title:'Changed title'},{author:'other'},{headRefName:'fix/other'},{isDraft:true},{reviewDecision:'APPROVED'},{updatedAt:'2026-10-29T10:00:00Z'},{url:'https://github.com/acme/widget/pull/2'}]){
  const retired=projectAttentionView(view,context,{issues:[],prs:[{...cached,...patch}]});assert.equal(retired.stale,true,JSON.stringify(patch));assert.equal(retired.busy,false);assert.equal(retired.pendingSourceDigest,null);
 }
 assert.equal(projectAttentionView(view,context,{issues:[{number:2,title:'Assigned issue',author:'viewer',label:'bug',updatedAt:live.updatedAt,url:'https://github.com/acme/widget/issues/2'}],prs:[cached]}).stale,true);
});
