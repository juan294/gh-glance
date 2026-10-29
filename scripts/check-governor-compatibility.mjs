#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {populatedGovernorV7} from '../test/fixtures/populated-governor-v7.mjs';
import {createGovernorScope,emptyGovernorState,writeGovernorState,withoutJevCredential} from '../index.mjs';
const baseline='0319c9c58d211867ec35776357259b02b235909f';
const checkout=fileURLToPath(new URL('..',import.meta.url));
const directory=mkdtempSync(join(tmpdir(),'glance-old-reader-'));
try{
  const env=withoutJevCredential({PATH:process.env.PATH,HOME:directory,GH_CONFIG_DIR:directory,GH_TOKEN:'synthetic-old-reader',XDG_CONFIG_HOME:directory,NODE_ENV:'production'});
  let source,manifest;
  try{source=execFileSync('git',['show',`${baseline}:index.mjs`],{cwd:checkout,env});manifest=execFileSync('git',['show',`${baseline}:package.json`],{cwd:checkout,env});}catch{throw Error('Required baseline git object is unavailable; compatibility check failed');}
  writeFileSync(join(directory,'index.mjs'),source);writeFileSync(join(directory,'package.json'),manifest);
  symlinkSync(join(checkout,'node_modules'),join(directory,'node_modules'),'dir');
  const results=[];
  for(const fixture of ['empty','populated']){
  let now=Date.now();
  const scope=createGovernorScope({effectiveHost:'github.com',authIdentity:'synthetic-old-reader-'+fixture,env,now:()=>now}).value;
  const populated=fixture==='populated'?populatedGovernorV7(scope,now,{includeLiveLease:true}):null;
  if(populated)now=populated.at;
  const v7=populated?.state ?? {...emptyGovernorState(),version:7};
  const v8={...v7,version:8};
  assert.equal(writeGovernorState(scope.path,v8).ok,true);
  const original=readFileSync(scope.path,'utf8');
  const input=`import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as old from ${JSON.stringify(pathToFileURL(join(directory,'index.mjs')).href)};
assert.equal(process.env.TYPESAFE_API_KEY,undefined);
assert.equal(old.GOVERNOR_STATE_VERSION,7);
const now=${now};
const scope=old.createGovernorScope({effectiveHost:'github.com',authIdentity:${JSON.stringify('synthetic-old-reader-'+fixture)},env:process.env,now:()=>now}).value;
assert.equal(scope.path,${JSON.stringify(scope.path)});
const v7=${JSON.stringify(v7)};
assert.ok(old.normalizeGovernorState(v7,now,{prune:false}),'actual baseline must accept historical v7 fixture');
const raw=readFileSync(scope.path,'utf8');
assert.equal(JSON.parse(raw).version,8);
assert.equal(old.normalizeGovernorState(JSON.parse(raw),now),null);
assert.equal(old.readGovernorState(scope.path,now,{persistMigration:false}).reason,'corrupt');
const id=${JSON.stringify(randomUUID())};
const mutation=old.registerLease(scope,{id,expiresAt:now+90000,floorMs:5000,activeTab:'actions',phaseSeed:{seed:id,registeredAt:now},demand:{core:1,graphql:0}},now);
assert.equal(mutation.reason,'corrupt');
assert.equal(readFileSync(scope.path,'utf8'),raw);
console.log(JSON.stringify({protocol:old.GOVERNOR_STATE_VERSION,refused:8,unchanged:true}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-'],{env,input,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(scope.path,'utf8'),original);
  results.push({fixture,...JSON.parse(result.stdout)});
  }
  process.stdout.write(JSON.stringify({runtime:process.version,baseline,baselineSourceSha256:createHash('sha256').update(source).digest('hex'),baselinePackageSha256:createHash('sha256').update(manifest).digest('hex'),candidateSourceSha256:createHash('sha256').update(readFileSync(new URL('../index.mjs',import.meta.url))).digest('hex'),oldReaders:results,offline:true})+'\n');
}catch(error){process.stderr.write(`Governor compatibility check failed: ${error.message}\n`);process.exitCode=1;}finally{rmSync(directory,{recursive:true,force:true});}
