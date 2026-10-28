import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as app from '../index.mjs';
const sha='a'.repeat(40), host='github.com', repository='acme/widget';
const selected={databaseId:12,status:'completed',conclusion:'failure',updatedAt:'2026-10-28T10:00:00Z'};
const raw={id:12,repository:{full_name:repository},run_attempt:2,head_sha:sha,status:'completed',conclusion:'failure',updated_at:selected.updatedAt,html_url:'https://github.com/acme/widget/actions/runs/12'};
const job={id:91,run_id:12,head_sha:sha,name:'unit',status:'completed',conclusion:'failure',html_url:'https://github.com/acme/widget/actions/runs/12/job/91',steps:[{name:'test',number:1,status:'completed',conclusion:'failure'}]};
test('CI run facts pin exact selected identity and disclose a changed run',()=>{assert.equal(typeof app.parseCiRun,'function');const run=app.parseCiRun(JSON.stringify(raw),{host,repository,selected});assert.equal(run.attempt,2);assert.equal(run.headSha,sha);for(const changed of [{id:13},{repository:{full_name:'other/repo'}},{updated_at:'2026-10-28T10:01:00Z'},{head_sha:'invalid'}])assert.throws(()=>app.parseCiRun(JSON.stringify({...raw,...changed}),{host,repository,selected}));});
test('CI attempt jobs validate run/SHA, cap steps, disclose page coverage, failed jobs first',()=>{assert.equal(typeof app.parseCiJobs,'function');const run={id:12,headSha:sha,attempt:2};const parse=(jobs,total=jobs.length,headers={})=>app.parseCiJobs(JSON.stringify({total_count:total,jobs}),{host,repository,run,headers});const result=parse([{...job,id:92,html_url:job.html_url.replace('/91','/92'),conclusion:'cancelled'},job],3,{link:'<next>; rel="next"'});assert.equal(result.complete,false);assert.equal(result.total,3);assert.equal(result.jobs[0].id,91);assert.equal(result.jobs[0].url,job.html_url);assert.throws(()=>parse([{...job,run_id:13}]));assert.throws(()=>parse([{...job,html_url:job.html_url.replace('/91','/92')}]));assert.throws(()=>parse([{...job,head_sha:'b'.repeat(40)}]));assert.throws(()=>parse([{...job,steps:Array.from({length:101},()=>job.steps[0])}]));assert.throws(()=>parse(Array.from({length:101},(_,i)=>({...job,id:i+1}))));});
test('native log refuses applicable proxy before any dispatch and emits safe fixed error',async()=>{assert.equal(typeof app.requestGitHubJobLog,'function');let count=0;await assert.rejects(app.requestGitHubJobLog({host,repository,jobId:91,env:{GH_TOKEN:'fake',HTTPS_PROXY:'https://user:secret@proxy.invalid'},request:()=>{count++;throw Error('signed-secret');}}),e=>e.code==='unsupported-proxy'&&!JSON.stringify(e).includes('secret'));assert.equal(count,0);});
test('native proxy NO_PROXY matching preserves explicit bypass',()=>{assert.equal(app.ciProxyApplies('api.github.com',{HTTPS_PROXY:'http://proxy',NO_PROXY:'.github.com'}),false);assert.equal(app.ciProxyApplies('api.github.com',{HTTPS_PROXY:'http://proxy',NO_PROXY:'other.test'}),true);});
export {raw,job,selected};

import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
async function policyFixture(t){
  const directory=mkdtempSync(join(tmpdir(),'glance-ci-policy-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let at=1800000000000;
  const env={GH_TOKEN:'synthetic-ci-policy'};
  const coordinator=app.createIdentityCoordinator({host,pathOptions:{env:{XDG_CONFIG_HOME:directory}},env,now:()=>at,requestIdentity:async()=>({body:{id:42,login:'fixture'},rateLimit:{resource:'core',limit:5000,used:1,remaining:4999,resetMs:at+3600000}})});
  assert.equal((await coordinator.refresh()).ok,true);t.after(()=>coordinator.close());at+=250;
  const scope={...app.createQuotaScope(coordinator.current(),{root:coordinator.root,now:()=>at,identityProvider:coordinator.current}),identityCoordinator:coordinator,credentialEnvironment:env,httpWait:async(ms)=>{at+=ms;}};
  const leaseId=randomUUID();
  assert.equal(app.registerLease(scope,{id:leaseId,expiresAt:at+90000,floorMs:5000,activeTab:'actions',phaseSeed:{seed:leaseId,registeredAt:at},demand:{core:1,graphql:0}},at).ok,true);
  at+=5000;
  return {scope,coordinator,env,leaseId,now:()=>at,setNow(value){at=value;},wait:async(ms)=>{at+=ms+1;return true;},advance(ms){at+=ms;}};
}
function mockNative({lateSocket=false,hold=false,apiStatus=302}={}){
  const events=[],sockets=[],headers=[];
  const request=(url,options,callback)=>{
    const req=new EventEmitter();let reqClosed=false;
    req.destroy=()=>{if(!reqClosed){reqClosed=true;queueMicrotask(()=>req.emit('close'));}};
    req.end=()=>queueMicrotask(()=>{
      const api=url.hostname==='api.github.com';headers.push(options.headers);events.push({api,authorization:Boolean(options.headers.Authorization)});
      const socket=new EventEmitter();socket.destroy=()=>{if(!lateSocket)queueMicrotask(()=>socket.emit('close'));};sockets.push(socket);req.emit('socket',socket);
      const res=new EventEmitter();res.destroy=()=>queueMicrotask(()=>res.emit('close'));res.statusCode=api?apiStatus:200;
      res.headers=api?{'retry-after':'2',location:'https://storage.fixture.test/job?signature=SECRET','x-ratelimit-resource':'core','x-ratelimit-limit':'5000','x-ratelimit-remaining':'4998','x-ratelimit-used':'2','x-ratelimit-reset':String(Math.floor(1800000000000/1000)+3600)}:{'x-ratelimit-remaining':'7777'};
      callback(res);
      if(!hold){res.emit('data',Buffer.from(api?'redirect':'failure line\n'));res.emit('end');res.destroy();req.destroy();socket.destroy();}
    });
    return req;
  };
  return {request,events,headers,closeSockets(){for(const socket of sockets)socket.emit('close');}};
}
test('native transfer uses actual admission, nullable child proof and only original API quota',async t=>{
  const box=await policyFixture(t),transport=mockNative();
  const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request})});
  assert.equal(result.ok,true,result.error?.message);
  assert.deepEqual(transport.events,[{api:true,authorization:true},{api:false,authorization:false}]);assert.match(transport.headers[0]['User-Agent']??'',/^gh-glance\//);assert.equal(transport.headers[1]['User-Agent'],undefined);
  const state=app.inspectGovernor(box.scope,box.now()).value;
  const reservation=state.reservations[result.reservationId];
  assert.equal(reservation.actualCosts.core,1);assert.equal(reservation.receipt.dispatches.length,1);
  assert.equal(reservation.receipt.dispatches[0].childPid,null);assert.equal(reservation.receipt.dispatches[0].childBirth,null);
  assert.ok(reservation.receipt.dispatches[0].terminalAt!==null);assert.equal(state.budgets.core.remaining,4998);
  assert.equal(app.inspectIdentityRegistry(box.coordinator.root,{now:box.now()}).value.hosts[host].permits.length,0);
});
test('native Promise completion cannot release unclosed socket or generation; late actual close settles',async t=>{
  const box=await policyFixture(t),transport=mockNative({lateSocket:true});
  const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request,closeWaitMs:5})});
  assert.equal(result.ok,false);assert.equal(result.error.code,'closure');assert.ok(result.error.retryAt>box.now());
  let state=app.inspectGovernor(box.scope,box.now()).value;
  const reservation=state.reservations[result.reservationId];
  assert.equal(reservation.receipt.dispatches[0].terminalAt,null);assert.equal(reservation.status,'started');
  assert.equal(result.error.retryAt,reservation.receipt.deadline+app.IDENTITY_UNCERTAIN_MAX_MS);
  assert.equal(reservation.receipt.dispatches[0].childPid,null);
  assert.equal(app.inspectIdentityRegistry(box.coordinator.root,{now:box.now()}).value.hosts[host].permits.length,1);
  transport.closeSockets();await new Promise(resolve=>setTimeout(resolve,50));
  state=app.inspectGovernor(box.scope,box.now()).value;
  assert.ok(state.reservations[result.reservationId].receipt.dispatches[0].terminalAt!==null);
  assert.equal(app.inspectIdentityRegistry(box.coordinator.root,{now:box.now()}).value.hosts[host].permits.length,0);
  assert.equal(app.ciClosureRecoveryAt(box.scope,result.error.closureRecovery,box.now()),null);
});
test('native changed credential before dispatch consumes zero HTTP and settles never-started receipt',async t=>{
  const box=await policyFixture(t),transport=mockNative();
  const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>{box.env.GH_TOKEN='other-synthetic';return app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request});}});
  assert.equal(result.ok,false);assert.equal(transport.events.length,0);
  assert.equal(result.error.notStarted,true);assert.equal(result.error.code,'credential-changed');
});
test('metadata requests are separately admitted exact routes and preserve ordinary source facts',async t=>{
  const box=await policyFixture(t),calls=[];
  box.scope.executeGh=(_command,args,options)=>{
    calls.push({args,options});
    const child=new EventEmitter();child.pid=process.pid;
    const body=args.some(x=>x.includes('/attempts/'))?{total_count:1,jobs:[job]}:raw;
    const pending=new Promise(resolve=>queueMicrotask(()=>{resolve({stdout:'HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(body)});queueMicrotask(()=>child.emit('close'));}));pending.child=child;return pending;
  };
  const result=await app.loadCiEvidence({...box,host,repository,selected});
  assert.equal(result.run.attempt,2);assert.equal(calls.length,2);
  assert.ok(calls[0].args.includes('repos/acme/widget/actions/runs/12?exclude_pull_requests=true'));
  assert.ok(calls[1].args.includes('repos/acme/widget/actions/runs/12/attempts/2/jobs?per_page=100&page=1'));
  assert.ok(calls[1].options.maxBuffer<calls[0].options.maxBuffer);
  const state=app.inspectGovernor(box.scope,box.now()).value;
  assert.equal(Object.values(state.reservations).filter(r=>r.receipt?.dispatches.some(d=>d.operation.startsWith('detail:'))).length,2);
});

test('original API 403/429 Retry-After governs shared cooldown, independent of storage',async t=>{for(const status of [403,429]){const box=await policyFixture(t),transport=mockNative({apiStatus:status});const at=box.now();const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request})});assert.equal(result.ok,false);assert.equal(transport.events.length,1);const state=app.inspectIdentityRegistry(box.coordinator.root,{now:box.now()}).value.hosts[host];assert.equal(state.cooldownUntil,at+2000);assert.equal(state.throttle.attempts,1);}});
test('credential subprocess cancellation observes whole log deadline before any HTTPS dispatch',async t=>{const box=await policyFixture(t),transport=mockNative();let tokenCalls=0;box.scope.runLocalToken=(_args,{signal})=>new Promise((_resolve,reject)=>{tokenCalls++;signal.addEventListener('abort',()=>reject(Error('fake sensitive external failure')),{once:true});});const started=performance.now();const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,env:{GH_CONFIG_DIR:box.coordinator.root},request:transport.request,deadlineMs:30})});assert.equal(result.ok,false);assert.equal(result.error.code,'timeout');assert.equal(result.error.notStarted,true);assert.equal(tokenCalls,1);assert.equal(transport.events.length,0);assert.ok(performance.now()-started<1000);});
test('unknown native dispatch stays charged through deadline and computed debt window',async t=>{const box=await policyFixture(t),transport=mockNative({lateSocket:true});const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request,closeWaitMs:5})});assert.equal(result.error.code,'closure');const original=app.inspectGovernor(box.scope,box.now()).value.reservations[result.reservationId];box.setNow(original.receipt.deadline+1);const wake=()=>{const id=randomUUID();return app.registerLease(box.scope,{id,expiresAt:box.now()+90000,floorMs:5000,activeTab:'actions',phaseSeed:{seed:id,registeredAt:box.now()-5000},demand:{core:1,graphql:0}},box.now());};assert.equal(wake().ok,true);let state=app.inspectGovernor(box.scope,box.now()).value;const group=state.debtGroups[original.receipt.generation];assert.equal(group.unknownChild,true);assert.equal(group.quiescent,false);const recovery=app.ciClosureRecoveryAt(box.scope,result.error.closureRecovery,box.now());assert.equal(recovery,group.at+app.IDENTITY_UNCERTAIN_MAX_MS);assert.match(app.ciFailureMessage({...result.error,retryAt:recovery}),new RegExp(new Date(recovery).toISOString().replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));box.setNow(recovery-1);assert.equal(wake().ok,true);assert.equal(app.inspectGovernor(box.scope,box.now()).value.debtGroups[original.receipt.generation].quiescent,false);box.advance(2);assert.equal(wake().ok,true);state=app.inspectGovernor(box.scope,box.now()).value;assert.equal(state.debtGroups[original.receipt.generation].quiescent,true);assert.equal(state.debt.core.quiescentUnits,1);transport.closeSockets();});

test('NO_PROXY port does not bypass a proxy for another HTTPS storage port',()=>{assert.equal(app.ciProxyApplies('storage.fixture.test',{HTTPS_PROXY:'http://proxy.invalid',NO_PROXY:'storage.fixture.test:443'},'444'),true);});

function metadataTransport(box,{first=raw,second={total_count:1,jobs:[job]},status=200,onResponse=()=>{},delay=0}={}){
  const calls=[];
  box.scope.executeGh=(_command,args,options)=>{
    const index=calls.length;calls.push({args,maxBuffer:options.maxBuffer});const child=new EventEmitter();child.pid=process.pid;
    const stdout=`HTTP/2 ${status} ${status===200?'OK':'Forbidden'}\r\nContent-Type: application/json\r\n\r\n`+JSON.stringify(index===0?first:second);
    const pending=new Promise((resolve,reject)=>setTimeout(()=>{onResponse(index);if(Buffer.byteLength(stdout)>options.maxBuffer)reject(Object.assign(Error('external buffer overflow'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',stdout:stdout.slice(0,options.maxBuffer)}));else if(status!==200)reject(Object.assign(Error('external permission detail'),{stdout}));else resolve({stdout});queueMicrotask(()=>child.emit('close'));},delay));pending.child=child;return pending;
  };
  return calls;
}
test('each metadata endpoint can be denied independently and explicit recovery dispatches the missing operation',async t=>{
  for(const deniedAt of [0,1]){
    const box=await policyFixture(t);const calls=metadataTransport(box,{onResponse(index){if(deniedAt===1 && index===0)app.recordResourceBlock(box.scope,'core',box.now()+60000,'secondary-rate-limit');}});
    if(deniedAt===0)app.recordResourceBlock(box.scope,'core',box.now()+60000,'secondary-rate-limit');
    await assert.rejects(app.loadCiEvidence({...box,host,repository,selected}),error=>error.code==='admission'&&Number.isFinite(error.retryAt));
    assert.equal(calls.length,deniedAt);
    box.advance(60001);assert.equal(app.registerLease(box.scope,{id:box.leaseId,expiresAt:box.now()+90000,floorMs:5000,activeTab:'actions',phaseSeed:{seed:box.leaseId,registeredAt:box.now()-10000},demand:{core:1,graphql:0}},box.now()).ok,true);
    const probe=app.claimProbe(box.scope,box.leaseId,box.now(),'core');assert.equal(probe.value.status,'claimed');assert.equal(app.publishProbe(box.scope,box.leaseId,probe.value.nonce,{core:{source:'core-observer',budget:{limit:5000,remaining:4900,used:100,resetMs:box.now()+3600000}}},box.now(),'core').ok,true);box.advance(5000);
    const retryCalls=metadataTransport(box);const result=await app.loadCiEvidence({...box,host,repository,selected});assert.equal(result.run.id,12);assert.equal(retryCalls.length,2);
  }
});
test('metadata aggregate byte cap discards incomplete facts and selected mismatch never fetches jobs',async t=>{
  const box=await policyFixture(t);const calls=metadataTransport(box,{first:{...raw,padding:'x'.repeat(1100000)},second:{total_count:1,jobs:[job],padding:'y'.repeat(1100000)}});
  await assert.rejects(app.loadCiEvidence({...box,host,repository,selected}),{code:'metadata-oversize'});assert.equal(calls.length,2);assert.ok(calls[1].maxBuffer<1100000);
  const wrong=await policyFixture(t),wrongCalls=metadataTransport(wrong,{first:{...raw,updated_at:'2026-10-28T11:00:00Z'}});await assert.rejects(app.loadCiEvidence({...wrong,host,repository,selected}),{code:'changed'});assert.equal(wrongCalls.length,1);
});
test('metadata permission, total workflow deadline, and canceled late child preserve safe unavailable states',async t=>{
  const denied=await policyFixture(t);const deniedCalls=metadataTransport(denied,{status:403});await assert.rejects(app.loadCiEvidence({...denied,host,repository,selected}),{code:'permission'});assert.equal(deniedCalls.length,1);
  const timed=await policyFixture(t),timedCalls=metadataTransport(timed,{onResponse(){timed.advance(45001);}});await assert.rejects(app.loadCiEvidence({...timed,host,repository,selected}),{code:'timeout'});assert.equal(timedCalls.length,1);
  const canceled=await policyFixture(t),calls=metadataTransport(canceled,{delay:30});const controller=new AbortController();const pending=app.loadCiEvidence({...canceled,host,repository,selected,signal:controller.signal});setTimeout(()=>controller.abort(),5);await assert.rejects(pending,{code:'canceled'});assert.equal(calls.length,1);
});
test('credential change during HTTP-permit wait prevents native API dispatch',async t=>{
  const box=await policyFixture(t),transport=mockNative();const permit=await app.acquireIdentityHttpPermit(box.coordinator,{now:box.now});box.scope.httpWait=async ms=>{box.advance(ms+1);box.env.GH_TOKEN='changed-during-permit';};const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request})});assert.equal(result.ok,false);assert.equal(result.error.notStarted,true);assert.equal(result.error.code,'credential-changed');assert.equal(transport.events.length,0);app.releaseIdentityHttpPermit(box.coordinator,permit,null,box.now());
});

test('late native closure retries transient registry contention before releasing its permit',async t=>{
  const box=await policyFixture(t),transport=mockNative({lateSocket:true});
  // Freeze quota authority independently of the registry lock, as a completed
  // admitted dispatch does; the transport permit still uses its real registry.
  const scope={...box.scope,coordinationRoot:null,identityProvider:null};
  const result=await app.runAdmittedOperation({...box,scope,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request,closeWaitMs:5})});
  assert.equal(result.error.code,'closure');
  const lock=join(box.coordinator.root,'registry.json.lock');writeFileSync(lock,JSON.stringify({pid:process.pid,nonce:randomUUID()}),{flag:'wx',mode:0o600});
  transport.closeSockets();setTimeout(()=>unlinkSync(lock),350);
  const deadline=Date.now()+5000;while(Date.now()<deadline){const snapshot=app.inspectIdentityRegistry(box.coordinator.root,{now:box.now()});if(snapshot.ok && snapshot.value.hosts[host].permits.length===0)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(app.inspectIdentityRegistry(box.coordinator.root,{now:box.now()}).value.hosts[host].permits.length,0);
});

test('100-job and 100-step bounds retain exact partial coverage without pagination',()=>{const run={id:12,headSha:sha,attempt:2};const jobs=Array.from({length:100},(_,index)=>({...job,id:index+100,html_url:`https://github.com/acme/widget/actions/runs/12/job/${index+100}`}));jobs[0].steps=Array.from({length:100},(_,index)=>({...job.steps[0],number:index+1}));const result=app.parseCiJobs(JSON.stringify({total_count:101,jobs}),{host,repository,run,headers:{link:'<next>; rel="next"'}});assert.equal(result.jobs.length,100);assert.equal(result.jobs[0].steps.length,100);assert.equal(result.total,101);assert.equal(result.complete,false);assert.throws(()=>app.parseCiJobs(JSON.stringify({total_count:1,jobs:[{...job,name:'x'.repeat(513)}]}),{host,repository,run}));});
test('log admission denial sends zero HTTP and a fresh explicit action succeeds after recovery',async t=>{const box=await policyFixture(t),transport=mockNative();app.recordResourceBlock(box.scope,'core',box.now()+60000,'secondary-rate-limit');const attempt=()=>app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request})});const held=await attempt();assert.equal(held.skipped,true);assert.equal(transport.events.length,0);box.advance(60001);const id=box.leaseId;app.registerLease(box.scope,{id,expiresAt:box.now()+90000,floorMs:5000,activeTab:'actions',phaseSeed:{seed:id,registeredAt:box.now()-10000},demand:{core:1,graphql:0}},box.now());const claim=app.claimProbe(box.scope,id,box.now(),'core');assert.equal(claim.value.status,'claimed');app.publishProbe(box.scope,id,claim.value.nonce,{core:{source:'core-observer',budget:{limit:5000,remaining:4900,used:100,resetMs:box.now()+3600000}}},box.now(),'core');box.advance(5000);const result=await attempt();assert.equal(result.ok,true,result.error?.message);assert.equal(transport.events.length,2);});

test('late actual close completes its reservation after the immediate terminal-write budget is exhausted',async t=>{
  const box=await policyFixture(t),transport=mockNative({lateSocket:true});
  const result=await app.runAdmittedOperation({...box,operation:'detail:actions-job-log',waitMs:2000,run:signal=>app.requestGitHubJobLog({host,repository,jobId:91,signal,request:transport.request,closeWaitMs:5})});assert.equal(result.error.code,'closure');
  const lock=box.scope.path+'.lock';writeFileSync(lock,JSON.stringify({pid:process.pid,nonce:randomUUID()}),{flag:'wx',mode:0o600});
  const monotonic=performance.now.bind(performance);let ticks=0;t.mock.method(performance,'now',()=>monotonic()+(ticks++*16000));
  transport.closeSockets();await new Promise(resolve=>setTimeout(resolve,40));t.mock.restoreAll();
  assert.equal(JSON.parse(readFileSync(box.scope.path)).reservations[result.reservationId].receipt.dispatches[0].terminalAt,null,'the real quota lock must prevent durable terminal proof');
  unlinkSync(lock);assert.equal((await box.coordinator.flushCompletions()).ok,true);
  const deadline=Date.now()+1000;while(Date.now()<deadline && JSON.parse(readFileSync(box.scope.path)).reservations[result.reservationId]?.status!=='completed')await new Promise(resolve=>setTimeout(resolve,10));
  const reservation=JSON.parse(readFileSync(box.scope.path)).reservations[result.reservationId];assert.ok(reservation.receipt.dispatches[0].terminalAt!==null);assert.equal(reservation.status,'completed');
});
