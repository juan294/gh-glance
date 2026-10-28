#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {requestGitHubJobLog} from '../index.mjs';
import {ciHttpsFixture} from '../test/fixtures/ci-https-fixture.mjs';
export async function qualifyCiLogTransport(){
  const cases=[];
  for(const [mode,expected] of [['ok',null],['api-api','unsupported-storage'],['storage-api','unsupported-storage'],['storage-storage','unsupported-storage'],['loop','unsupported-storage'],['http','unsupported-storage'],['userinfo','unsupported-storage'],['expired','unavailable'],['403','permission'],['429','unavailable'],['404','unavailable'],['missing-headers',null],['oversize','oversize'],['aggregate','oversize'],['untrusted','network'],['wrong-hostname','network'],['storage-proxy','unsupported-proxy'],['port-proxy','unsupported-proxy'],['api-oversize','oversize'],['hang','timeout'],['storage-hang','timeout'],['reset','network'],['abort','canceled']]){
    const fixture=await ciHttpsFixture({mode:mode==='abort'?'storage-hang':mode==='untrusted'||mode==='wrong-hostname'||mode==='storage-proxy'?'ok':mode,trust:mode!=='untrusted',servername:mode==='wrong-hostname'?'wrong.invalid':'localhost'});
    const controller=new AbortController();let timer;
    try{
      if(mode==='abort')timer=setTimeout(()=>controller.abort(),50);
      let result,error;
      try{result=await requestGitHubJobLog({host:'github.com',repository:'acme/widget',jobId:91,env:{GH_TOKEN:'synthetic-ci-token',...(mode==='storage-proxy'||mode==='port-proxy'?{HTTPS_PROXY:'http://proxy.invalid',NO_PROXY:mode==='port-proxy'?'api.github.com,storage.fixture.test:443':'api.github.com'}:{})},request:fixture.request,signal:controller.signal,deadlineMs:mode.includes('hang')?80:2000,closeWaitMs:2000});}catch(caught){error=caught;}
      assert.equal(error?.code??null,expected,mode);
      assert.ok(fixture.events.filter(e=>e.stage==='api').length<=1,mode+' API bound');
      assert.ok(fixture.events.filter(e=>e.stage==='storage').length<=1,mode+' storage bound');
      assert.ok(fixture.events.filter(e=>e.stage==='api').every(e=>e.authorization),mode+' API auth');
      assert.ok(fixture.events.filter(e=>e.stage==='storage').every(e=>!e.authorization && !e.cookie),mode+' storage privacy');
      const errorText=JSON.stringify(error??null)+String(error?.message??'')+String(error?.stack??'')+String(error?.cause??'');
      assert.ok(!errorText.includes('SECRET'),mode+' signed URL sanitation');
      assert.ok(!errorText.includes('signature='),mode+' signed query sanitation');
      assert.ok(!errorText.includes('synthetic-ci-token'),mode+' token sanitation');
      assert.ok(fixture.events.every(event=>event.method==='GET'),mode+' exact GET');
      assert.ok(fixture.events.filter(event=>event.stage==='api').every(event=>event.path==='/repos/acme/widget/actions/jobs/91/logs'),mode+' exact API path');
      assert.ok(fixture.events.filter(event=>event.stage==='storage').every(event=>event.path==='/log'),mode+' exact storage path');
      await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(fixture.openSockets,0,mode+' actual socket closure');
      if(error)assert.equal(Object.hasOwn(error,'text'),false,mode+' discards partial log');
      assert.ok(!JSON.stringify(error??null).includes('synthetic-ci-token'),mode+' token sanitation');
      if(result){assert.equal(result.complete,true);assert.equal(result.rateLimit?.remaining??null,mode==='missing-headers'?null:4999);assert.equal(result.requestMetrics.coreUnits,1);assert.match(result.text,/test failed/);}
      cases.push({mode,category:error?.code??'complete',api:fixture.events.filter(e=>e.stage==='api').length,storage:fixture.events.filter(e=>e.stage==='storage').length});
    }finally{clearTimeout(timer);await fixture.close();}
  }
  let dispatches=0;
  await assert.rejects(requestGitHubJobLog({host:'github.com',repository:'acme/widget',jobId:91,env:{HTTPS_PROXY:'https://user:secret@proxy.invalid'},request(){dispatches++;throw Error('unexpected');}}),{code:'unsupported-proxy'});
  assert.equal(dispatches,0);
  return {runtime:process.version,offline:true,sourceSha256:createHash('sha256').update(readFileSync(new URL('../index.mjs',import.meta.url))).digest('hex'),cases,proxyDispatches:dispatches};
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(JSON.stringify(await qualifyCiLogTransport(),null,2)+'\n');}catch(error){process.stderr.write(`CI transport qualification failed: ${error.code??error.name}\n`);process.exitCode=1;}
}
