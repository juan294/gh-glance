// Offline real-terminal first-paint/input harness. An optional baseline entry
// uses the same runtime, arguments, dimensions and fixtures as the candidate.
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {capture} from '../test/pty/capture.mjs';
const baseline=process.argv[2] ? resolve(process.argv[2]) : null;
const candidate=new URL('../index.mjs',import.meta.url).pathname;
const root=mkdtempSync(join(tmpdir(),'glance-feature-perf-'));
const runs=[];
try {
 for(let pair=0;pair<5;pair++) for(const [name,entry] of [...(baseline?[['baseline',baseline]]:[]),['candidate',candidate]]) {
  const file=join(root,`${name}-${pair}.json`),driver=join(root,'driver.mjs');
  const marker=join(root,'entry-start.json'),ready=join(root,'driver-ready'),wrapper=join(root,'entry.mjs');
  rmSync(marker,{force:true});rmSync(ready,{force:true});
  writeFileSync(wrapper, `import {existsSync,writeFileSync} from 'node:fs';\nwhile(!existsSync(${JSON.stringify(ready)})) await new Promise(r=>setTimeout(r,2));\nwriteFileSync(${JSON.stringify(marker)},String(Date.now()));\nprocess.argv[1]=${JSON.stringify(entry)};\nawait import(${JSON.stringify(pathToFileURL(entry).href)});`);
  writeFileSync(driver,`import {readFileSync,writeFileSync} from 'node:fs';
import {parseCapture} from ${JSON.stringify(new URL('../test/pty/capture.mjs',import.meta.url).href)};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const screen=()=>parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,'utf8'),{cols:80,rows:24}).finalFrame.lines.join('\\n');
const send=s=>process.stdout.write(s);
const until=async fn=>{const end=performance.now()+20000;while(performance.now()<end){try{if(fn())return;}catch{}await pause(2);}throw Error('paint deadline');};
writeFileSync(${JSON.stringify(ready)},"ready");
const result={inputMs:[]};
try {await until(()=>screen().includes('1:Actions') && screen().includes('╭'));result.firstPaintMs=Date.now()-Number(readFileSync(${JSON.stringify(marker)},'utf8'));
await until(()=>screen().includes('Watching') || screen().includes('Cached'));
if(${name==='candidate'}) {send('2');await until(()=>screen().includes('Issues') && screen().includes('of '));send('/');await until(()=>screen().includes('Focus >'));
for(let i=1;i<=20;i++){const at=performance.now();send('z');await until(()=>screen().includes('Focus > '+'z'.repeat(i)));result.inputMs.push(performance.now()-at);}}
}catch(error){result.error=String(error);}finally{writeFileSync(${JSON.stringify(file)},JSON.stringify(result));send('\\u0003');}
`);
  mkdirSync(join(root,`${name}-${pair}`),{recursive:true});
  const terminal=capture({cols:80,rows:24,signal:'none',settle:35,configHome:join(root,`${name}-${pair}`),
   args:'--repo acme/widget --refresh 300 --background off',
   env:{GH_GLANCE_CAPTURE_LIVE_FLUSH:'1',GH_GLANCE_CAPTURE_ENTRY:wrapper},stdin:`node '${driver}'`});
  const metrics=JSON.parse(readFileSync(file));
  if(metrics.error || terminal.exitCode!==0) throw Error(metrics.error ?? `terminal exit ${terminal.exitCode}`);
  runs.push({name,pair,...metrics});
 }
 const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 const current=runs.filter(x=>x.name==='candidate'),old=runs.filter(x=>x.name==='baseline');
 const inputs=current.flatMap(x=>x.inputMs).sort((a,b)=>a-b);
 const currentMedian=median(current.map(x=>x.firstPaintMs)),oldMedian=old.length?median(old.map(x=>x.firstPaintMs)):null;
 console.log(JSON.stringify({runtime:process.version,candidateHash:createHash('sha256').update(readFileSync(candidate)).digest('hex'),
  baselineHash:baseline?createHash('sha256').update(readFileSync(baseline)).digest('hex'):null,
  processTreeResources:'unmeasured',modelCalls:0,clockBoundary:'entry import to first dashboard frame; excludes Node startup',firstPaint:{sampleCount:current.length,candidateMedianMs:currentMedian,
   baselineMedianMs:oldMedian,withinAllowance:oldMedian===null?null:currentMedian<=oldMedian*1.05+20},
  keypressToPaint:{sampleCount:inputs.length,p95Ms:inputs[Math.ceil(inputs.length*.95)-1]},runs},null,2));
} finally {rmSync(root,{recursive:true,force:true});}
