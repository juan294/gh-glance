// Offline local-search baseline. Semantic qualification requires actual provider
// results; these numbers measure vocabulary overlap, never model accuracy.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseFocusQuery,rankLocalFocus} from '../index.mjs';
const bytes=readFileSync(new URL('../test/fixtures/jev/focus.json',import.meta.url));
const corpus=JSON.parse(bytes),results=[],excluded=[];
for(const c of corpus.cases.filter(c=>c.split==='held-out')){
 if(['ambiguous','query-error','filter-only'].includes(c.classification)) {
  const ranked=c.classification==='query-error'?[]:rankLocalFocus(parseFocusQuery(c.query),c.rows,c.rows.every(r=>r.kind==='pr')?'prs':'issues').map(r=>`${r.kind}:${r.number}`);
  excluded.push({id:c.id,classification:c.classification,slices:c.slices,
   unsupportedAssertions:c.classification==='ambiguous'?ranked.filter(id=>c.ambiguousIds.includes(id)).length:null});continue;
 }
 const parsed=parseFocusQuery(c.query), kind=c.rows.every(r=>r.kind==='pr')?'prs':'issues';
 const ranked=rankLocalFocus(parsed,c.rows,kind).map(r=>`${r.kind}:${r.number}`);
 const relevant=new Set(c.relevantIds),k=Math.min(3,relevant.size);
 results.push({id:c.id,slices:c.slices,matching:relevant.size>0,
  precision:k?ranked.slice(0,k).filter(id=>relevant.has(id)).length/k:null,
  recall:relevant.size?ranked.slice(0,5).filter(id=>relevant.has(id)).length/relevant.size:null,
  specific:relevant.size===0?ranked.length===0:null});
}
const avg=(rows,key)=>rows.length?rows.reduce((n,r)=>n+Number(r[key]),0)/rows.length:null;
const matching=results.filter(r=>r.matching),negative=results.filter(r=>!r.matching);
const samples=[],rows=Array.from({length:150},(_,i)=>({number:i+1,title:`Authentication cache item ${i}`,author:'ana'}));
for(let i=0;i<100;i++){const start=performance.now();rankLocalFocus(parseFocusQuery('auth cache'),rows);samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);
console.log(JSON.stringify({mode:'offline-local-baseline',corpusHash:createHash('sha256').update(bytes).digest('hex'),
 baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 candidateHashes:Object.fromEntries(['index.mjs','package.json','package-lock.json'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../'+name,import.meta.url))).digest('hex')])),
 runtime:process.version,modelCalls:0,matchingQueries:matching.length,noMatchQueries:negative.length,
 macroPrecisionAtK:avg(matching,'precision'),macroRecallAt5:avg(matching,'recall'),
 synonymRecallAt5:avg(matching.filter(r=>r.slices.includes('synonym')),'recall'),
 noMatchSpecificity:avg(negative,'specific'),localRankingMs:{samples:samples.length,p50:samples[49],p95:samples[94]},
 excludedCounts:Object.fromEntries(['ambiguous','query-error','filter-only'].map(kind=>[kind,excluded.filter(x=>x.classification===kind).length])),
 perSliceDenominators:Object.fromEntries([...new Set(corpus.cases.flatMap(c=>c.slices))].map(slice=>[slice,corpus.cases.filter(c=>c.split==='held-out' && c.slices.includes(slice)).length])),
 ambiguousUnsupportedAssertions:excluded.filter(x=>x.classification==='ambiguous').reduce((n,x)=>n+x.unsupportedAssertions,0),
 firstPaint:'Measured by PTY harness separately',excluded,results},null,2));
