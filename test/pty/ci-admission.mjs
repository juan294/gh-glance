import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {withFileLock,writeGovernorState} from '../../index.mjs';

// Setup may hit the real governor's manual wait bound. Retry only the
// displayed admission refusal, once, after its finite deadline.
export async function admittedCiStage({screen,until,pause,send,calls,nativeEvents},text,key){
 await until(()=>screen().includes(text)||screen().includes('GitHub admission is paused.'));
 if(screen().includes(text))return {retried:false,runBefore:0,jobsBefore:0};
 const count=route=>calls().filter(call=>call.includes(route)).length;
 const runBefore=count('/actions/runs/102?'),jobsBefore=count('/attempts/1/jobs?');
 if(key==='d'){assert.ok(runBefore===0||runBefore===1);assert.equal(jobsBefore,0);}
 const beforeNative=nativeEvents();
 const shown=screen().replaceAll('│',' ').split(/\s+/).filter(Boolean).join(' ');
 const marker='Wait until ',offset=shown.indexOf(marker);
 assert.ok(offset>=0,'admission refusal must show its retry deadline');
 const retryAt=Date.parse(shown.slice(offset+marker.length,offset+marker.length+24));
 assert.ok(Number.isFinite(retryAt),'retry deadline must be finite');
 const delay=Math.max(0,retryAt-Date.now()+150);
 assert.ok(delay<=10000,'unexpected long admission hold');
 await pause(delay);
 assert.equal(count('/actions/runs/102?'),runBefore,'run request dispatched while held');
 assert.equal(count('/attempts/1/jobs?'),jobsBefore,'jobs request dispatched while held');
 assert.equal(nativeEvents(),beforeNative,'native transport dispatched while held');
 send(key);
 await until(()=>screen().includes(text));
 return {retried:true,runBefore,jobsBefore};
}

// Put this capture's real governor in a future lane without changing clocks.
export function holdCiAdmission(root){
 const directory=join(root,'gh-glance','coordination-v2');
 const names=readdirSync(directory).filter(name=>/^quota-[a-f0-9]{64}\.json$/.test(name));
 assert.equal(names.length,1);
 const file=join(directory,names[0]);
 const held=withFileLock(file+'.lock',()=>{
  const state=JSON.parse(readFileSync(file,'utf8'));
  state.budgets.core.laneNextAt=Date.now()+4500;
  return writeGovernorState(file,state);
 });
 assert.equal(held.ok,true,JSON.stringify(held));
}
