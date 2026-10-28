// Offline real-terminal input measurement during bounded fake Jev requests.
// Five fixed 20-key captures bound terminal-history replay cost. Every scheduled
// key is reported, including keys that miss the pending window or fail to paint.
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {capture} from '../test/pty/capture.mjs';
const files=['index.mjs','package-lock.json','scripts/measure-jev-interaction.mjs','test/pty/capture.mjs','test/pty/fixtures/jev-fetch.mjs','test/pty/fixtures/graphql-response.mjs','test/pty/fixtures/issues.json'];
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(new URL('../'+file,import.meta.url))).digest('hex')]));
const runs=[];
for(let run=0;run<5;run++){
 const root=mkdtempSync(join(tmpdir(),'glance-jev-perf-'));
 try {
  const calls=join(root,'calls'),config=join(root,'config'),driver=join(root,'driver.mjs'),output=join(root,'metrics');
  writeFileSync(calls,'');writeFileSync(config,JSON.stringify({delay:3000}));
  writeFileSync(driver,String.raw`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('../test/pty/capture.mjs',import.meta.url).href)};
const pause=ms=>new Promise(r=>setTimeout(r,ms)),send=s=>process.stdout.write(s),result={attempts:[],operations:0};
let observerDecodeMs=0,maxHistoryBytes=0;
const screen=()=>{const raw=readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),at=performance.now();const frame=parseCapture(raw,{cols:100,rows:24}).finalFrame.lines.join('\n');observerDecodeMs+=performance.now()-at;maxHistoryBytes=Math.max(maxHistoryBytes,Buffer.byteLength(raw));return frame;};
const selected=()=>screen().split('\n').find(line=>line.includes('>') && /#\d+/.test(line));
const until=async fn=>{const end=performance.now()+20000;while(performance.now()<end){try{if(fn())return;}catch{}await pause(2);}throw Error('paint deadline');};
try{
 await until(()=>screen().includes('of '));send('/');await until(()=>screen().includes('Focus >'));send('terminal');await pause(50);send('\r');await until(()=>screen().includes('Focus:'));send('j');await until(()=>selected());
 send('J');await until(()=>screen().includes('Jev pending') || screen().includes('TypeSafe'));
 if(screen().includes('TypeSafe')){send('\r');await until(()=>screen().includes('Jev pending'));}
 result.operations++;
 for(let index=0;index<20;index++){
  if(!screen().includes('Jev pending')){result.attempts.push({index,status:'not-pending',ms:null});continue;}
  const previous=selected(),at=performance.now(),decodeBefore=observerDecodeMs;send(index%2===0?'j':'k');
  try{
   await until(()=>selected()!==previous || !screen().includes('Jev pending'));
   const stillPending=screen().includes('Jev pending');
   result.attempts.push({index,status:stillPending?'painted-pending':'pending-ended',ms:performance.now()-at,observerDecodeMs:observerDecodeMs-decodeBefore,historyBytes:maxHistoryBytes});
  }catch(error){result.attempts.push({index,status:'paint-error',ms:performance.now()-at,error:String(error)});}
 }
}catch(error){result.error=String(error);}finally{
 while(result.attempts.length<20)result.attempts.push({index:result.attempts.length,status:'not-attempted',ms:null});
 result.maxHistoryBytes=maxHistoryBytes;writeFileSync(${JSON.stringify(output)},JSON.stringify(result));send('\u0003');
}
`);
  const terminal=capture({cols:100,rows:24,signal:'none',settle:35,configHome:root,args:'--repo acme/widget --tab issues --refresh 300 --background off --jev',
   env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',GH_GLANCE_FIXTURE_GRAPHQL_ROWS:'150',TYPESAFE_API_KEY:'dummy-test-only',NODE_OPTIONS:`--import=${new URL('../test/pty/fixtures/jev-fetch.mjs',import.meta.url).pathname}`,GH_GLANCE_TEST_JEV_CALLS:calls,GH_GLANCE_TEST_JEV_CONFIG:config},stdin:`node '${driver}'`});
  const metrics=JSON.parse(readFileSync(output,'utf8'));
  runs.push({run,...metrics,exitCode:terminal.exitCode,fakeHttpRequests:readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).length});
 } catch(error){runs.push({run,error:String(error),exitCode:null,fakeHttpRequests:null,attempts:Array.from({length:20},(_,index)=>({index,status:'capture-error',ms:null}))});}
 finally {rmSync(root,{recursive:true,force:true});}
}
const attempts=runs.flatMap(run=>run.attempts.map(attempt=>({run:run.run,...attempt}))),valid=attempts.filter(x=>x.status==='painted-pending'),samples=valid.map(x=>x.ms).sort((a,b)=>a-b);
const p95=samples.length?samples[Math.ceil(samples.length*.95)-1]:null;
const within100Ms=attempts.length===100 && valid.length===100 && runs.every(run=>run.exitCode===0 && !run.error) && p95<=100;
console.log(JSON.stringify({runtime:process.version,platform:process.platform,arch:process.arch,hashes,dimensions:{cols:100,rows:24},liveModelCalls:0,fakeHttpRequests:runs.reduce((sum,run)=>sum+(run.fakeHttpRequests??0),0),
 processTreeResources:'unmeasured',clockBoundary:'driver key write to parsed terminal selection change while Jev pending; includes bounded observer decoding',
 keypressToPaint:{scheduledCount:100,attemptCount:attempts.length,sampleCount:valid.length,invalidCount:attempts.length-valid.length,p95Ms:p95,within100Ms},
 measurementDesign:{captures:5,scheduledKeysPerCapture:20,automaticRetries:0},operations:runs.reduce((sum,run)=>sum+(run.operations??0),0),samplesMs:attempts.map(x=>x.ms),runs},null,2));
if(!within100Ms)process.exitCode=1;
