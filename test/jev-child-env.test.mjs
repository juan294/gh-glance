import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {withoutJevCredential,runGh,githubAppChildEnvironment,collectorSshEnvironment,parseArgs,validateArgs,TAB_KEYS} from '../index.mjs';
test('Jev CLI is explicit, bounded and standalone only',()=>{
 const parse=args=>validateArgs(parseArgs(args),TAB_KEYS);
 assert.equal(parse([]).jev,false);assert.equal(parse(['--jev']).jevMaxRequests,100);
 assert.equal(parse(['--jev','--jev-max-requests=12']).jevMaxRequests,12);
 for(const args of [['--jev-max-requests','1'],['--jev','--jev-max-requests','0'],['--jev','--jev-max-requests','10001'],['--jev','--jev-max-requests','1.2'],['--jev','--connect','local'],['--jev','--doctor'],['--jev','--collector-stdio']]) assert.throws(()=>parse(args),/jev/);
 assert.throws(()=>execFileSync(process.execPath,['index.mjs','--jev'],{encoding:'utf8',env:{...process.env,TYPESAFE_API_KEY:'dummy'},stdio:['ignore','pipe','pipe']}),error=>error.status===2 && /interactive standalone/.test(error.stderr));
});
test('Jev credential filter is immutable and applies to injected runGh and copied envs',async()=>{
 const env={TYPESAFE_API_KEY:'dummy',GH_TOKEN:'github',PATH:process.env.PATH};const before={...env};
 assert.deepEqual(withoutJevCredential(env),{GH_TOKEN:'github',PATH:process.env.PATH});assert.deepEqual(env,before);
 assert.equal(githubAppChildEnvironment('github.com','token',env).TYPESAFE_API_KEY,undefined);
 assert.equal(collectorSshEnvironment(env).TYPESAFE_API_KEY,undefined);
 const old=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='dummy';
 try {await runGh(['--version'],{operation:'version',execute:(_cmd,_args,options)=>{assert.equal(options.env.TYPESAFE_API_KEY,undefined);const child=new EventEmitter();child.pid=process.pid;const pending=Promise.resolve({stdout:'gh version 2.100.0'});pending.child=child;queueMicrotask(()=>child.emit('close',0));return pending;}});}finally{if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;}
});

test('Jev actual help/version/module import with key alone never load SDK or change the key',t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-import-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const imports=join(root,'imports');writeFileSync(imports,'');
 const guard=new URL('./pty/fixtures/jev-child-guard.mjs',import.meta.url).pathname;
 const env={...process.env,TYPESAFE_API_KEY:'dummy',GH_GLANCE_TEST_JEV_IMPORTS:imports};
 for(const args of [['index.mjs','--help'],['index.mjs','--version'],['index.mjs','--jev','--help'],['--input-type=module','-e',`await import(${JSON.stringify(new URL('../index.mjs',import.meta.url).href)});if(process.env.TYPESAFE_API_KEY!=='dummy')throw Error('key mutated');`]])execFileSync(process.execPath,['--import',guard,...args],{env,stdio:['ignore','pipe','pipe']});
 assert.equal(readFileSync(imports,'utf8'),'');
});

test('Jev key-only collector startup remains provider-free and shuts down cleanly',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jev-collector-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const imports=join(root,'imports'),calls=join(root,'calls'),config=join(root,'config.json');writeFileSync(imports,'');writeFileSync(calls,'');
 writeFileSync(config,JSON.stringify({version:1,providers:{personal:{type:'gh',host:'github.com'}},targets:[{host:'github.com',repo:'acme/widget',provider:'personal'}]}),{mode:0o600});
 const child=spawn(process.execPath,['--import',new URL('./pty/fixtures/jev-child-guard.mjs',import.meta.url).pathname,'--import',new URL('./pty/fixtures/jev-fetch.mjs',import.meta.url).pathname,'index.mjs','--serve','--config',config],{env:{...process.env,TYPESAFE_API_KEY:'dummy',XDG_CONFIG_HOME:root,HOME:root,GH_CONFIG_DIR:root,GH_GLANCE_TEST_JEV_IMPORTS:imports,GH_GLANCE_TEST_JEV_CALLS:calls},stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let stderr='';child.stderr.on('data',part=>{stderr+=part;});const deadline=Date.now()+5000;while(!stderr.includes('collector listening') && Date.now()<deadline && child.exitCode===null)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(stderr,/collector listening/);child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));assert.equal(child.exitCode,0);
 assert.equal(readFileSync(imports,'utf8'),'');assert.equal(readFileSync(calls,'utf8'),'');
});
