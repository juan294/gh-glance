// Offline by default. This developer tool never creates children or captures a
// key on import. Only an explicit, budgeted, exact-manifest live run can send.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import * as app from '../index.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
class EvaluationError extends Error {}
const sourceURL='https://docs.typesafe.ai/models.md';
export const MODEL_RESERVATION={model:'jev-1.14.0',inputTokenCeiling:64000,dollarsPerBillionInputTokens:42,
 outputTokensFree:true,verifiedAt:'2026-10-28',source:sourceURL};
const CALL_NANODOLLARS=MODEL_RESERVATION.inputTokenCeiling*MODEL_RESERVATION.dollarsPerBillionInputTokens;
const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const itemId=row=>`${row.kind}:${row.number}`;
function inspectCorpus(corpus){
 if(!corpus || !Array.isArray(corpus.cases) || !corpus.cases.length)throw new EvaluationError('Corpus needs labeled cases.');
 const ids=new Set(),groups=new Map();
 for(const c of corpus.cases){
  if(typeof c.id!=='string' || ids.has(c.id))throw new EvaluationError('Corpus case IDs must be unique.');ids.add(c.id);
  if(!['development','held-out'].includes(c.split)||typeof c.groupId!=='string')throw new EvaluationError('Corpus split/group is missing.');
  if(groups.has(c.groupId) && groups.get(c.groupId)!==c.split)throw new EvaluationError('Related group crosses the frozen split.');groups.set(c.groupId,c.split);
  if(!Array.isArray(c.rows)||!Array.isArray(c.relevantIds)||!Array.isArray(c.ambiguousIds))throw new EvaluationError('Corpus labels are missing.');
  const rowIds=c.rows.map(itemId);if(new Set(rowIds).size!==rowIds.length)throw new EvaluationError('Duplicate source identity.');
  if(c.expectedQueryError){let failed=false;try{app.parseFocusQuery(c.query);}catch{failed=true;}if(!failed)throw new EvaluationError('Expected query error did not occur.');continue;}
  const parsed=app.parseFocusQuery(c.query),eligible=c.rows.filter(row=>app.focusEligible(parsed,row,row.kind==='pr'?'prs':'issues')).map(itemId);
  if(JSON.stringify(eligible)!==JSON.stringify(c.exactFilterExpectedIds))throw new EvaluationError('Exact filter oracle differs from the frozen labels.');
  if(c.relevantIds.some(id=>!eligible.includes(id)) || c.ambiguousIds.some(id=>!eligible.includes(id)))throw new EvaluationError('Invalid relevant/ambiguous identity in the frozen labels.');
 }
 return corpus;
}
const replayErrors=new Set(['missing-record','invalid-record','disabled','missing-key','consent','input-too-large','canceled','stale','cooldown','cap','busy','model-unavailable','provider']);
const safeReplayError=value=>value==null?null:replayErrors.has(value)?value:'unavailable';
function normalizedRecord(c,record,eligible){
 if(!record)return {status:'unavailable',decisions:{},ranking:[],error:'missing-record'};
 if(record.status==='unavailable')return {...record,error:safeReplayError(record.error),decisions:{},ranking:[]};
 const decisions=record.decisions;
 const valid=decisions && typeof decisions==='object' && !Array.isArray(decisions) &&
  ['completed','partial','unavailable'].includes(record.status) && Object.entries(decisions).every(([id,a])=>eligible.includes(id) &&
   a && ['positive','negative','uncertain','unavailable'].includes(a.decision));
 const ranking=record.ranking ?? Object.keys(decisions??{}).filter(id=>decisions[id]?.decision==='positive');
 if(!valid || record.status==='completed' && (Object.keys(decisions).length!==eligible.length || Object.values(decisions).some(a=>a.decision==='unavailable')) || !Array.isArray(ranking) || new Set(ranking).size!==ranking.length ||
  ranking.some(id=>!eligible.includes(id)||decisions[id]?.decision!=='positive') ||
  Object.keys(decisions).some(id=>decisions[id].decision==='positive'&&!ranking.includes(id))) {
  return {status:'unavailable',decisions:{},ranking:[],error:'invalid-record'};
 }
 return {...record,error:safeReplayError(record.error),decisions,ranking};
}
export function scoreFocus(corpus,records=[]){
 inspectCorpus(corpus);
 const byId=new Map();for(const record of records){if(byId.has(record.caseId))throw new EvaluationError('Duplicate replay case ID.');byId.set(record.caseId,record);}
 if([...byId.keys()].some(id=>!corpus.cases.some(c=>c.id===id)))throw new EvaluationError('Replay contains an unknown case ID.');
 const attempts=[];
 for(const c of corpus.cases.filter(c=>c.split==='held-out')){
  if(c.expectedQueryError || c.classification==='query-error'){attempts.push({id:c.id,slices:c.slices,status:'deterministic',kind:'query-error'});continue;}
  const parsed=app.parseFocusQuery(c.query),eligible=c.rows.filter(row=>app.focusEligible(parsed,row,row.kind==='pr'?'prs':'issues')).map(itemId);
  if(c.classification==='filter-only'){attempts.push({id:c.id,slices:c.slices,status:'deterministic',kind:'filter-only'});continue;}
  const record=normalizedRecord(c,byId.get(c.id),eligible);
  const positive=record.ranking,ambiguous=c.classification==='ambiguous';
  const unknown=eligible.filter(id=>!record.decisions[id] || ['uncertain','unavailable'].includes(record.decisions[id].decision)).length;
  const relevant=new Set(c.relevantIds),k=Math.min(3,relevant.size);
  attempts.push({id:c.id,slices:c.slices,kind:ambiguous?'ambiguous':relevant.size?'matching':'no-match',status:record.status,
   error:record.error??null,eligible:eligible.length,unknown,positiveIds:positive,
   precision:k?positive.slice(0,k).filter(id=>relevant.has(id)).length/k:null,
   recall:relevant.size?positive.slice(0,5).filter(id=>relevant.has(id)).length/relevant.size:null,
   specific:!ambiguous&&!relevant.size ? record.status==='completed' && positive.length===0 && eligible.every(id=>record.decisions[id]?.decision==='negative'):null,
   unsupportedAssertions:ambiguous?positive.filter(id=>c.ambiguousIds.includes(id)).length:0});
 }
 const matching=attempts.filter(x=>x.kind==='matching'),negative=attempts.filter(x=>x.kind==='no-match'),ambiguous=attempts.filter(x=>x.kind==='ambiguous');
 const p=average(matching.map(x=>x.precision)),r=average(matching.map(x=>x.recall));
 const synonym=matching.filter(x=>x.slices.includes('synonym'));
 const specificity=average(negative.map(x=>Number(x.specific)));
 const slices=Object.fromEntries([...new Set(attempts.flatMap(x=>x.slices??[]))].map(slice=>{
  const rows=attempts.filter(x=>x.slices?.includes(slice));return [slice,{attempted:rows.length,matching:rows.filter(x=>x.kind==='matching').length,
   noMatch:rows.filter(x=>x.kind==='no-match').length,ambiguous:rows.filter(x=>x.kind==='ambiguous').length,unavailable:rows.filter(x=>x.status==='unavailable').length}];
 }));
 return {matchingQueries:matching.length,noMatchQueries:negative.length,macroPrecisionAtK:p,macroRecallAt5:r,
  synonymQueries:synonym.length,synonymRecallAt5:average(synonym.map(x=>x.recall)),noMatchSpecificity:specificity,
  noMatchAbstentions:negative.filter(x=>x.unknown>0 || x.status!=='completed').length,ambiguousCases:ambiguous.length,
  ambiguousUnsupportedAssertions:ambiguous.reduce((n,x)=>n+x.unsupportedAssertions,0),filterOnlyCases:attempts.filter(x=>x.kind==='filter-only').length,
  queryErrorCases:attempts.filter(x=>x.kind==='query-error').length,slices,attempts,qualified:false,
  qualification:'UNVERIFIED: replay/local metrics do not establish a live model contract or held-out semantic gain.'};
}
export function reserveEvaluationCall(state,bytes){
 if(!Number.isSafeInteger(bytes)||bytes<1)throw new EvaluationError('Invalid serialized byte count.');
 if(!Number.isSafeInteger(state.maxCalls)||state.calls>=state.maxCalls)throw new EvaluationError('Call budget exhausted.');
 if(!Number.isSafeInteger(state.maxBytes)||state.bytes+bytes>state.maxBytes)throw new EvaluationError('Serialized byte budget exhausted.');
 const reservedNanoDollars=(state.reservedNanoDollars??Math.round(state.reservedDollars*1e9))+CALL_NANODOLLARS;
 if(!Number.isFinite(state.maxDollars)||state.maxDollars<=0 || reservedNanoDollars>Math.floor(state.maxDollars*1e9))throw new EvaluationError('Dollar budget cannot reserve the full documented token ceiling.');
 return {...state,calls:state.calls+1,bytes:state.bytes+bytes,reservedNanoDollars,reservedDollars:reservedNanoDollars/1e9};
}
export function prepareFocusManifest(corpus,{corpusHash=hash(corpus)}={}){
 inspectCorpus(corpus);
 if(corpus.splitPolicy?.frozen!==true || !['synthetic','public'].includes(corpus.provenance?.dataClass))throw new EvaluationError('Manifest requires frozen synthetic/public labels.');
 const entries=[];
 for(const c of corpus.cases.filter(c=>c.split==='development')){
  if(c.expectedQueryError || ['query-error','filter-only'].includes(c.classification))continue;
  const kind=c.rows.every(row=>row.kind==='pr')?'prs':'issues';
  const built=app.buildFocusJevRequest(c.query,c.rows,kind);
  const questions=Object.keys(built.request.questions);
  if(!questions.length)continue;
  if(questions.length>15)throw new EvaluationError('Review separate <=15-item payloads before preparing this probe.');
  const request=built.request,bytes=Buffer.byteLength(JSON.stringify(request));
  if(bytes>24576)throw new EvaluationError('Prepared request exceeds 24 KiB.');
  if(entries.reduce((n,e)=>n+e.bytes,0)+bytes>192*1024 || entries.length>=12)break;
  entries.push({caseId:c.id,request,requestHash:hash(request),bytes,rowIds:built.rows.map(itemId),truncated:built.truncated});
 }
 const manifest={schemaVersion:1,feature:'focus',purpose:'contract',dataClass:corpus.provenance.dataClass,
  model:app.JEV_MODEL,questionVersion:app.JEV_QUESTION_VERSION,corpusHash,pricing:MODEL_RESERVATION,entries};
 validateEvaluationManifest(manifest);return manifest;
}
export function validateEvaluationManifest(manifest,{corpusHash=null,corpus=null}={}){
 if(manifest?.schemaVersion!==1||manifest.feature!=='focus'||manifest.purpose!=='contract')throw new EvaluationError('Expected a Focus contract manifest.');
 if(!['synthetic','public'].includes(manifest.dataClass))throw new EvaluationError('Only synthetic/public payloads are permitted.');
 if(manifest.model!==app.JEV_MODEL || manifest.questionVersion!==app.JEV_QUESTION_VERSION || !/^[a-f0-9]{64}$/.test(manifest.corpusHash??''))throw new EvaluationError('Model/question/corpus identity mismatch.');
 if(corpus && (corpus.splitPolicy?.frozen!==true || !['synthetic','public'].includes(corpus.provenance?.dataClass) || corpus.provenance.dataClass!==manifest.dataClass))throw new EvaluationError('Live corpus must be frozen and match its synthetic/public data class.');
 if(corpusHash && manifest.corpusHash!==corpusHash)throw new EvaluationError('Corpus hash differs from the reviewed manifest.');
 if(JSON.stringify(manifest.pricing)!==JSON.stringify(MODEL_RESERVATION))throw new EvaluationError('Model ceiling/price snapshot requires fresh review.');
 if(!Array.isArray(manifest.entries)||!manifest.entries.length||manifest.entries.length>12)throw new EvaluationError('Contract probe permits 1-12 calls.');
 const ids=new Set();let bytes=0;
 for(const entry of manifest.entries){
  if(typeof entry.caseId!=='string'||ids.has(entry.caseId))throw new EvaluationError('Duplicate/missing manifest case ID.');ids.add(entry.caseId);
  const request=entry.request,wire=JSON.stringify(request),count=Object.keys(request?.questions??{}).length;
  if(!request || request.model!==app.JEV_MODEL || typeof request.state?.query!=='string' || Buffer.byteLength(request.state.query)>256 || count<1||count>15)throw new EvaluationError('Unbounded request in manifest.');
  if(hash(wire)!==entry.requestHash || Buffer.byteLength(wire)!==entry.bytes)throw new EvaluationError('Reviewed payload hash/bytes differ.');
  if(entry.bytes>24576 || !Array.isArray(entry.rowIds)||entry.rowIds.length!==count || new Set(entry.rowIds).size!==count)throw new EvaluationError('Manifest rows/request bytes are invalid.');
  if(Object.values(request.questions).some(q=>q.type!=='noul'))throw new EvaluationError('Focus manifest contains an unexpected question type.');
  if(corpus){
   const c=corpus.cases.find(c=>c.id===entry.caseId);
   if(!c || c.split!=='development' || c.expectedQueryError)throw new EvaluationError('Contract manifest must use reviewed development cases.');
   const rebuilt=app.buildFocusJevRequest(c.query,c.rows,c.rows.every(row=>row.kind==='pr')?'prs':'issues');
   if(hash(rebuilt.request)!==entry.requestHash || JSON.stringify(rebuilt.rows.map(itemId))!==JSON.stringify(entry.rowIds))throw new EvaluationError('Manifest payload differs from the frozen corpus projection.');
  }
  bytes+=entry.bytes;
 }
 if(bytes>192*1024)throw new EvaluationError('Contract probe exceeds 192 KiB of serialized input.');
 return {calls:manifest.entries.length,bytes,reservationDollars:manifest.entries.length*CALL_NANODOLLARS/1e9};
}
function localRecords(corpus){
 return corpus.cases.filter(c=>!c.expectedQueryError).map(c=>{
  const parsed=app.parseFocusQuery(c.query),kind=c.rows.every(r=>r.kind==='pr')?'prs':'issues';
  const eligible=c.rows.filter(row=>app.focusEligible(parsed,row,row.kind==='pr'?'prs':'issues'));
  const ranking=app.rankLocalFocus(parsed,eligible,kind).map(itemId),positive=new Set(ranking);
  return {caseId:c.id,status:'completed',ranking,decisions:Object.fromEntries(eligible.map(row=>[itemId(row),{decision:positive.has(itemId(row))?'positive':'negative'}]))};
 });
}
function parseCLI(argv){
 const opts={live:false};
 const names=new Set(['corpus','replay','prepare-manifest','manifest','manifest-sha256','max-calls','max-bytes','max-dollars','output']);
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];if(arg==='--live'){opts.live=true;continue;}
  if(!arg.startsWith('--'))throw new EvaluationError('Use named evaluation options.');
  const [name,inline]=arg.slice(2).split('=',2);if(!names.has(name))throw new EvaluationError(`Unknown option --${name}`);
  const value=inline??argv[++i];if(!value||value.startsWith('--'))throw new EvaluationError(`--${name} needs a value.`);opts[name]=value;
 }
 return opts;
}
export async function runEvaluationCLI(argv,{env=process.env,makeSession=app.createJevSession,fetchImpl=(...args)=>globalThis.fetch(...args)}={}){
 const opts=parseCLI(argv),corpusBytes=readFileSync(opts.corpus??new URL('../test/fixtures/jev/focus.json',import.meta.url));
 const corpus=JSON.parse(corpusBytes),corpusHash=hash(corpusBytes);inspectCorpus(corpus);
 const identity={corpusHash,model:app.JEV_MODEL,questionVersion:app.JEV_QUESTION_VERSION,runtime:process.version,
  candidateHashes:Object.fromEntries(['index.mjs','package.json','package-lock.json'].map(name=>[name,hash(readFileSync(new URL('../'+name,import.meta.url)))]))};
 if(opts['prepare-manifest']){
  if(opts.live)throw new EvaluationError('Prepare and review the exact manifest before a separate live invocation.');
  const manifest=prepareFocusManifest(corpus,{corpusHash});writeFileSync(opts['prepare-manifest'],JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  return {...identity,mode:'prepare',liveContract:'UNVERIFIED',dispatchedCalls:0,manifestPath:opts['prepare-manifest'],
   manifestHash:hash(readFileSync(opts['prepare-manifest'])),...validateEvaluationManifest(manifest)};
 }
 if(!opts.live){
  const replay=opts.replay?JSON.parse(readFileSync(opts.replay,'utf8')):null;
  if(replay && (replay.corpusHash!==corpusHash||replay.model!==app.JEV_MODEL||replay.questionVersion!==app.JEV_QUESTION_VERSION))throw new EvaluationError('Replay identity differs from corpus/model/questions.');
  return {...identity,mode:'offline',liveContract:'UNVERIFIED',dispatchedCalls:0,
   baseline:scoreFocus(corpus,localRecords(corpus)),semantic:replay?scoreFocus(corpus,replay.records):null,
   qualification:'Offline arithmetic and replay outcomes do not verify live model behavior.'};
 }
 if(!opts.manifest||!opts['manifest-sha256']||!opts['max-calls']||!opts['max-bytes']||!opts['max-dollars'])throw new EvaluationError('Live evaluation requires a reviewed manifest hash and explicit call/byte/dollar budgets.');
 const manifestBytes=readFileSync(opts.manifest),manifestHash=hash(manifestBytes);
 if(manifestHash!==opts['manifest-sha256'])throw new EvaluationError('Reviewed manifest hash differs.');
 const manifest=JSON.parse(manifestBytes),limits=validateEvaluationManifest(manifest,{corpusHash,corpus});
 const maxCalls=Number(opts['max-calls']),maxBytes=Number(opts['max-bytes']),maxDollars=Number(opts['max-dollars']);
 if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>12||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>192*1024||!Number.isFinite(maxDollars)||maxDollars<=0)throw new EvaluationError('Invalid concrete contract-probe budget.');
 if(limits.calls>maxCalls||limits.bytes>maxBytes||limits.reservationDollars>maxDollars)throw new EvaluationError('Budget cannot reserve every reviewed payload.');
 if(!env.TYPESAFE_API_KEY)throw new EvaluationError('Live evaluation requires TYPESAFE_API_KEY; no call was sent.');
 // Match the actual SDK wire body before delegating to external transport.
 let approved=null,dispatchedCalls=0,serializedBytes=0;
 const guardedFetch=async(url,init)=>{
  const body=String(init?.body??'');
  if(!approved || url!=='https://api.typesafe.ai/v1/systemone' || init?.method!=='POST' || hash(body)!==approved.requestHash || Buffer.byteLength(body)!==approved.bytes)throw new EvaluationError('SDK payload differs from the reviewed manifest.');
  if(approved.sent)throw new EvaluationError('A reviewed payload cannot retry.');approved.sent=true;
  dispatchedCalls++;serializedBytes+=Buffer.byteLength(body);return fetchImpl(url,init);
 };
 const session=makeSession({enabled:true,key:env.TYPESAFE_API_KEY,maxRequests:maxCalls,fetchImpl:guardedFetch});
 let budget={maxDollars,reservedDollars:0,calls:0,maxCalls,bytes:0,maxBytes};const records=[],timings=[];let knownInputTokens=0,unknownUsageCalls=0;
 try {
  for(const entry of manifest.entries){
   budget=reserveEvaluationCall(budget,entry.bytes);approved={...entry,sent:false};
   const sourceIdentity={feature:'focus',host:'synthetic.invalid',repo:'evaluation/focus',accessPartition:manifestHash,
    contentDigest:entry.requestHash,query:entry.request.state.query,questionVersion:app.JEV_QUESTION_VERSION};
   session.grant(sourceIdentity);const start=performance.now(),before=dispatchedCalls;
   const result=await session.evaluateJev(entry.request,sourceIdentity,{isCurrent:()=>true});
   const latencyMs=performance.now()-start,calls=dispatchedCalls-before;
   const decisions=Object.fromEntries(entry.rowIds.map((id,index)=>[id,result.answers?.[`i${index}`]??{decision:'unavailable'}]));
   const ranking=Object.entries(decisions).filter(([,a])=>a.decision==='positive').sort((a,b)=>(b[1].probability??0)-(a[1].probability??0)).map(([id])=>id);
   records.push({caseId:entry.caseId,status:result.status==='complete'?'completed':result.status==='partial'?'partial':'unavailable',decisions,ranking,
    error:result.error??null,calls,latencyMs,usage:result.usage??null});
   if(calls){timings.push(latencyMs);if(Number.isSafeInteger(result.usage?.input_tokens))knownInputTokens+=result.usage.input_tokens;else unknownUsageCalls++;}
  }
 }finally{session.clear();approved=null;}
 const sorted=[...timings].sort((a,b)=>a-b),knownUsageDollars=knownInputTokens*MODEL_RESERVATION.dollarsPerBillionInputTokens/1e9;
 return {...identity,mode:'live-contract',manifestHash,liveContract:records.length===manifest.entries.length&&records.every(x=>x.status==='completed')?'PASSED':'FAILED',
  qualification:'A development contract probe does not qualify held-out semantic accuracy.',dispatchedCalls,serializedBytes,reservedDollars:budget.reservedDollars,
  pricing:MODEL_RESERVATION,knownInputTokens,unknownUsageCalls,knownUsageDollars,
  totalSpendDollars:unknownUsageCalls?null:knownUsageDollars,providerLatency:{samples:timings.length,p50Ms:sorted.length?sorted[Math.floor(sorted.length/2)]:null,
   p95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,stableTail:timings.length>=100},records};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const report=await runEvaluationCLI(process.argv.slice(2));const output=parseCLI(process.argv.slice(2)).output;
  if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report,null,2));
 }catch(error){console.error(`Jev evaluation: ${error instanceof EvaluationError?error.message:'Input or transport unavailable; check the local files and explicit budgets.'}`);process.exitCode=1;}
}
