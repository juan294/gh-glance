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
const replayErrors=new Set(['missing-record','invalid-record','disabled','missing-key','identity','consent','input-too-large','canceled','stale','cooldown','cap','busy','model-unavailable','provider','invalid-observations','insufficient','suspected-secret','input-policy']);
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
const CI_VERSION='ci-evidence-v1';
const CI_CATEGORIES=['assertion_mismatch','dependency_download','permission_denied','execution_timeout','memory_exhaustion','static_check_failure'];
const exactKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
const projectedSpans=spans=>spans.map(s=>({id:s.id,lineStart:s.lineStart,lineEnd:s.lineEnd,text:s.text,...(s.truncated===true?{truncated:true}:{})}));
function ciHelpers(){
 if(app.CI_QUESTION_VERSION!==CI_VERSION || JSON.stringify(app.CI_OBSERVATION_CATEGORIES)!==JSON.stringify(CI_CATEGORIES) ||
  !['prepareCiSpans','buildCiQuestions','validateCiObservations'].every(name=>typeof app[name]==='function'))throw new EvaluationError('CI question helpers differ from the frozen evaluation contract.');
}
function inspectCiCase(c){
 ciHelpers();
 if(!Array.isArray(c.originalLines)||c.originalLines.some(line=>typeof line!=='string'||/[\r\n]/.test(line))||Buffer.byteLength(c.originalLines.join('\n'))>1024*1024)throw new EvaluationError('CI original lines are invalid or exceed the capture bound.');
 if(!exactKeys(c.identity,['runId','attempt','headSha','jobId']) || !['runId','attempt','jobId'].every(k=>Number.isSafeInteger(c.identity[k])&&c.identity[k]>0) || !/^[a-f0-9]{40}$/.test(c.identity.headSha))throw new EvaluationError('CI source identity is invalid.');
 if(!exactKeys(c.labels,CI_CATEGORIES)||Object.values(c.labels).some(value=>![true,false,null].includes(value)) || !exactKeys(c.acceptableSpanIds,CI_CATEGORIES))throw new EvaluationError('CI category labels/support are incomplete.');
 if(!['ready','suspected-secret','insufficient'].includes(c.expectedPolicy)||!Array.isArray(c.approvedSpans))throw new EvaluationError('CI input policy or approved spans are missing.');
 let prepared;
 try{prepared=app.prepareCiSpans(c.originalLines.join('\n'),c.selectedRange?{range:c.selectedRange}:{});}catch{throw new EvaluationError('CI selected range cannot be prepared.');}
 if(prepared.status!==c.expectedPolicy)throw new EvaluationError('CI input policy differs from its frozen source projection.');
 const spans=projectedSpans(prepared.spans);
 if(c.expectedPolicy==='ready'){
  if(JSON.stringify(projectedSpans(c.approvedSpans))!==JSON.stringify(spans))throw new EvaluationError('CI approved spans differ from the frozen original lines.');
 }else if(c.approvedSpans.length || Object.values(c.labels).some(value=>value!==null))throw new EvaluationError('Blocked/empty CI input cannot carry approved spans or semantic truth.');
 const ids=new Set(c.approvedSpans.map(s=>s.id));
 for(const category of CI_CATEGORIES){
  const support=c.acceptableSpanIds[category];
  if(!Array.isArray(support)||new Set(support).size!==support.length||support.some(id=>!ids.has(id)) || (c.labels[category]===true?support.length===0:support.length!==0))throw new EvaluationError('CI gold support must select existing same-excerpt spans for positive labels.');
 }
 if((Object.values(c.labels).some(value=>value===null)||['insufficient','ambiguous'].includes(c.classification)) && (typeof c.insufficientReason!=='string'||!c.insufficientReason.trim()))throw new EvaluationError('Ambiguous CI truth needs an insufficient-evidence rationale.');
 return prepared;
}
function inspectCiCorpus(corpus){
 if(corpus?.schemaVersion!==1||corpus.feature!=='ci'||corpus.questionVersion!==CI_VERSION||!Array.isArray(corpus.cases)||!corpus.cases.length)throw new EvaluationError('Expected a labeled CI corpus.');
 if(corpus.splitPolicy?.frozen!==true)throw new EvaluationError('CI held-out scoring requires a frozen split.');
 const ids=new Set(),groups=new Map();
 for(const c of corpus.cases){
  if(typeof c.id!=='string'||!c.id||ids.has(c.id))throw new EvaluationError('CI case IDs must be unique.');ids.add(c.id);
  if(!['development','held-out'].includes(c.split)||typeof c.groupId!=='string'||!c.groupId)throw new EvaluationError('CI split/group is missing.');
  if(groups.has(c.groupId)&&groups.get(c.groupId)!==c.split)throw new EvaluationError('Related CI group crosses the frozen split.');groups.set(c.groupId,c.split);
  if(!Array.isArray(c.slices)||c.slices.some(value=>typeof value!=='string'))throw new EvaluationError('CI slice labels are invalid.');
  inspectCiCase(c);
 }
 return corpus;
}
function ciLocalIdentity(c,prepared,corpusHash){
 return {feature:'ci',host:'synthetic.invalid',repo:'evaluation/ci',accessPartition:corpusHash,dataClass:'ci-log',
  runId:c.identity.runId,attempt:c.identity.attempt,headSha:c.identity.headSha,jobId:c.identity.jobId,
  contentDigest:prepared.excerptDigest,questionVersion:CI_VERSION};
}
export function buildCiEvaluationEntry(c,{corpusHash}={}){
 if(!/^[a-f0-9]{64}$/.test(corpusHash??''))throw new EvaluationError('CI projection needs its frozen corpus hash.');
 const prepared=inspectCiCase(c);
 if(prepared.status!=='ready')throw new EvaluationError('CI contract projection requires clean usable spans.');
 const identity=ciLocalIdentity(c,prepared,corpusHash),failedSteps=c.failedSteps??[];
 let built;try{built=app.buildCiQuestions(prepared,identity,{failedSteps});}catch{throw new EvaluationError('CI prepared input cannot fit its fixed question contract.');}
 const request=built.request,wire=JSON.stringify(request);
 if(Buffer.byteLength(wire)>24576||Object.keys(request.questions).length!==12)throw new EvaluationError('CI serialized question bound exceeded.');
 return {caseId:c.id,request,requestHash:hash(wire),bytes:Buffer.byteLength(wire),identity:built.identity,bindingDigest:built.bindingDigest,
  prepared,failedSteps,questionIds:built.questionIds};
}
const ciInsufficient=c=>['insufficient','ambiguous'].includes(c.classification)||Object.values(c.labels).every(value=>value===null);
function ciCoverage(corpus){
 const held=corpus.cases.filter(c=>c.split==='held-out'),ready=held.filter(c=>c.expectedPolicy==='ready'),insufficient=ready.filter(ciInsufficient);
 return {cases:corpus.cases.length,heldOut:held.length,development:corpus.cases.length-held.length,semanticEligible:ready.length,
  insufficientCases:insufficient.length,adversarialInsufficientCases:insufficient.filter(c=>c.slices.includes('adversarial')).length,
  policies:Object.fromEntries(['ready','suspected-secret','insufficient'].map(policy=>[policy,held.filter(c=>c.expectedPolicy===policy).length])),
  categories:Object.fromEntries(CI_CATEGORIES.map(category=>[category,{positive:ready.filter(c=>c.labels[category]===true).length,
   negative:ready.filter(c=>c.labels[category]===false).length,ambiguous:ready.filter(c=>c.labels[category]===null).length}]))};
}
function normalizedCiRecord(c,record,entry){
 const absent=error=>({status:'unavailable',error,outcomes:{},identityError:false,invalidSpans:0,policyViolation:false});
 if(!record)return absent('missing-record');
 if(c.expectedPolicy!=='ready')return record.status==='unavailable'?absent(safeReplayError(record.error)):{...absent('input-policy'),policyViolation:true};
 const identityMatches=exactKeys(record.identity,Object.keys(entry.identity))&&Object.entries(entry.identity).every(([key,value])=>record.identity[key]===value);
 if(record.bindingDigest!==entry.bindingDigest || !identityMatches)return {...absent('stale'),identityError:true};
 if(record.status==='unavailable')return absent(safeReplayError(record.error));
 if(record.status!=='completed'||!exactKeys(record.outcomes,CI_CATEGORIES))return absent('invalid-record');
 const spanIds=new Set(entry.prepared.spans.map(s=>s.id));let invalidSpans=0;
 for(const value of Object.values(record.outcomes)){
  if(!value||!['positive','negative','uncertain'].includes(value.decision))return absent('invalid-record');
  if(value.probability!==undefined && (!Number.isFinite(value.probability)||value.probability<0||value.probability>1 || app.classifyJevProbability(value.probability)!==value.decision))return absent('invalid-record');
  if(value.decision==='positive'&&!spanIds.has(value.spanId))invalidSpans++;
 }
 if(invalidSpans)return {...absent('invalid-record'),invalidSpans};
 return {status:'completed',error:safeReplayError(record.error),outcomes:record.outcomes,identityError:false,invalidSpans:0,policyViolation:false};
}
export function scoreCi(corpus,records=[],{corpusHash=hash(corpus)}={}){
 inspectCiCorpus(corpus);const byId=new Map();
 for(const record of records){if(byId.has(record.caseId))throw new EvaluationError('Duplicate CI replay case ID.');byId.set(record.caseId,record);}
 if([...byId.keys()].some(id=>!corpus.cases.some(c=>c.id===id)))throw new EvaluationError('CI replay contains an unknown case ID.');
 const categories=Object.fromEntries(CI_CATEGORIES.map(key=>[key,{tp:0,fp:0,fn:0,tn:0,abstentions:0,positiveExamples:0,negativeExamples:0,ambiguousExamples:0}]));
 const attempts=[];let spanSelections=0,supportedSpanSelections=0,invalidSpanSelections=0,identityErrors=0,policyViolations=0,insufficientCases=0,insufficientConcreteCases=0;
 for(const c of corpus.cases.filter(c=>c.split==='held-out')){
  const entry=c.expectedPolicy==='ready'?buildCiEvaluationEntry(c,{corpusHash}):null;
  const record=normalizedCiRecord(c,byId.get(c.id),entry),outcomes={};let concrete=0;
  identityErrors+=Number(record.identityError);policyViolations+=Number(record.policyViolation);invalidSpanSelections+=record.invalidSpans;spanSelections+=record.invalidSpans;
  const semantic=c.expectedPolicy==='ready',insufficient=semantic&&ciInsufficient(c);
  if(insufficient)insufficientCases++;
  for(const category of CI_CATEGORIES){
   const value=record.outcomes[category],decision=value?.decision??'unavailable',gold=c.labels[category],stats=categories[category];
   if(semantic){
    if(gold===true){stats.positiveExamples++;if(decision==='positive')stats.tp++;else stats.fn++;}
    else if(gold===false){stats.negativeExamples++;if(decision==='positive')stats.fp++;else if(decision==='negative')stats.tn++;}
    else stats.ambiguousExamples++;
    if(['uncertain','unavailable'].includes(decision))stats.abstentions++;
   }
   if(decision==='positive'){
    concrete++;spanSelections++;const supported=c.acceptableSpanIds[category].includes(value.spanId);supportedSpanSelections+=Number(supported);
    outcomes[category]={decision,spanId:value.spanId,supported};
   }else outcomes[category]={decision};
  }
  if(insufficient&&concrete)insufficientConcreteCases++;
  attempts.push({id:c.id,slices:c.slices,policy:c.expectedPolicy,status:record.status,error:record.error??null,identityError:record.identityError,policyViolation:record.policyViolation,
   invalidSpanSelections:record.invalidSpans,insufficient,concreteCategories:concrete,outcomes});
 }
 for(const stats of Object.values(categories)){stats.precision=stats.tp+stats.fp?stats.tp/(stats.tp+stats.fp):null;stats.recall=stats.positiveExamples?stats.tp/stats.positiveExamples:null;}
 const slices=Object.fromEntries([...new Set(attempts.flatMap(x=>x.slices))].map(slice=>{
  const values=attempts.filter(x=>x.slices.includes(slice)),gold=corpus.cases.filter(c=>c.split==='held-out'&&c.expectedPolicy==='ready'&&c.slices.includes(slice));
  return [slice,{attempted:values.length,semanticEligible:values.filter(x=>x.policy==='ready').length,
   unavailable:values.filter(x=>x.status==='unavailable').length,insufficient:values.filter(x=>x.insufficient).length,concreteCases:values.filter(x=>x.concreteCategories>0).length,
   categories:Object.fromEntries(CI_CATEGORIES.map(category=>[category,{positiveExamples:gold.filter(c=>c.labels[category]===true).length,
    negativeExamples:gold.filter(c=>c.labels[category]===false).length,ambiguousExamples:gold.filter(c=>c.labels[category]===null).length}]))}];
 }));
 return {coverage:ciCoverage(corpus),categories,spanSelections,supportedSpanSelections,spanSelectionAccuracy:spanSelections?supportedSpanSelections/spanSelections:null,
  invalidSpanSelections,identityErrors,policyViolations,insufficientCases,insufficientConcreteCases,insufficientConcreteRate:insufficientCases?insufficientConcreteCases/insufficientCases:null,
  slices,attempts,qualified:false,qualification:'UNVERIFIED: offline/replay arithmetic does not establish the live model contract or held-out semantic accuracy.'};
}
export function prepareCiManifest(corpus,{corpusHash=hash(corpus)}={}){
 inspectCiCorpus(corpus);
 if(corpus.splitPolicy?.frozen!==true||!['synthetic','public'].includes(corpus.provenance?.dataClass))throw new EvaluationError('CI manifest requires frozen synthetic/public labels.');
 const entries=[];
 for(const c of corpus.cases.filter(c=>c.split==='development'&&c.expectedPolicy==='ready')){
  const entry=buildCiEvaluationEntry(c,{corpusHash});
  if(entries.length>=12||entries.reduce((sum,item)=>sum+item.bytes,0)+entry.bytes>192*1024)break;
  entries.push(entry);
 }
 const manifest={schemaVersion:1,feature:'ci',purpose:'contract',dataClass:corpus.provenance.dataClass,model:app.JEV_MODEL,
  questionVersion:CI_VERSION,corpusHash,pricing:MODEL_RESERVATION,entries};
 validateEvaluationManifest(manifest);return manifest;
}
function validateCiManifest(manifest,{corpusHash=null,corpus=null}={}){
 ciHelpers();
 if(manifest?.schemaVersion!==1||manifest.feature!=='ci'||manifest.purpose!=='contract'||manifest.model!==app.JEV_MODEL||manifest.questionVersion!==CI_VERSION||!/^[a-f0-9]{64}$/.test(manifest.corpusHash??''))throw new EvaluationError('CI manifest model/question/corpus identity mismatch.');
 if(!['synthetic','public'].includes(manifest.dataClass)||JSON.stringify(manifest.pricing)!==JSON.stringify(MODEL_RESERVATION))throw new EvaluationError('CI manifest data class or pricing requires review.');
 if(corpus){inspectCiCorpus(corpus);if(corpus.splitPolicy?.frozen!==true||corpus.provenance?.dataClass!==manifest.dataClass)throw new EvaluationError('CI corpus must be frozen and match its synthetic/public class.');}
 if(corpusHash&&manifest.corpusHash!==corpusHash)throw new EvaluationError('CI corpus hash differs from the reviewed manifest.');
 if(!Array.isArray(manifest.entries)||!manifest.entries.length||manifest.entries.length>12)throw new EvaluationError('CI contract probe permits 1-12 calls.');
 const ids=new Set();let bytes=0;
 for(const entry of manifest.entries){
  if(typeof entry.caseId!=='string'||ids.has(entry.caseId))throw new EvaluationError('Duplicate/missing CI manifest case ID.');ids.add(entry.caseId);
  let rebuilt;
  try{rebuilt=app.buildCiQuestions(entry.prepared,entry.identity,{failedSteps:entry.failedSteps});}catch{throw new EvaluationError('CI manifest has an invalid bounded projection.');}
  const wire=JSON.stringify(entry.request);
  if(hash(wire)!==entry.requestHash||Buffer.byteLength(wire)!==entry.bytes||entry.bytes>24576 || hash(rebuilt.request)!==entry.requestHash ||
   rebuilt.bindingDigest!==entry.bindingDigest||JSON.stringify(rebuilt.questionIds)!==JSON.stringify(entry.questionIds))throw new EvaluationError('CI reviewed payload/hash/binding differs from its fixed projection.');
  if(corpus){
   const c=corpus.cases.find(c=>c.id===entry.caseId);
   if(!c||c.split!=='development'||c.expectedPolicy!=='ready')throw new EvaluationError('CI contract manifest must use clean reviewed development cases.');
   const expected=buildCiEvaluationEntry(c,{corpusHash:manifest.corpusHash});
   if(expected.requestHash!==entry.requestHash||expected.bindingDigest!==entry.bindingDigest||JSON.stringify(expected.identity)!==JSON.stringify(entry.identity)||JSON.stringify(expected.prepared)!==JSON.stringify(entry.prepared))throw new EvaluationError('CI manifest payload differs from the frozen corpus projection.');
  }
  bytes+=entry.bytes;
 }
 if(bytes>192*1024)throw new EvaluationError('CI contract probe exceeds 192 KiB of serialized input.');
 return {calls:manifest.entries.length,bytes,reservationDollars:manifest.entries.length*CALL_NANODOLLARS/1e9};
}
const ATTENTION_VERSION='attention-v1';
const ATTENTION_BADGES=['reported_regression','user_visible_impact'];
function attentionHelpers(){
 if(app.ATTENTION_QUESTION_VERSION!==ATTENTION_VERSION||JSON.stringify(app.ATTENTION_BADGES)!==JSON.stringify(ATTENTION_BADGES)||typeof app.buildAttentionJevRequest!=='function')throw new EvaluationError('Attention badge helpers differ from the frozen evaluation contract.');
}
function validAttentionMetadata(metadata){
 return exactKeys(metadata,['title','labels','branch'])&&typeof metadata.title==='string'&&Array.isArray(metadata.labels)&&metadata.labels.every(value=>typeof value==='string')&&(metadata.branch===null||typeof metadata.branch==='string');
}
function inspectAttentionCorpus(corpus){
 attentionHelpers();
 if(corpus?.schemaVersion!==1||corpus.feature!=='attention'||corpus.questionVersion!==ATTENTION_VERSION||!Array.isArray(corpus.cases)||!corpus.cases.length)throw new EvaluationError('Expected a labeled attention corpus.');
 if(corpus.splitPolicy?.frozen!==true)throw new EvaluationError('Attention held-out scoring requires a frozen split.');
 const ids=new Set(),groups=new Map();
 for(const c of corpus.cases){
  if(typeof c.id!=='string'||!c.id||ids.has(c.id))throw new EvaluationError('Attention case IDs must be unique.');ids.add(c.id);
  if(!['development','held-out'].includes(c.split)||typeof c.groupId!=='string'||!c.groupId)throw new EvaluationError('Attention split/group is missing.');
  if(groups.has(c.groupId)&&groups.get(c.groupId)!==c.split)throw new EvaluationError('Related attention group crosses the frozen split.');groups.set(c.groupId,c.split);
  if(!Array.isArray(c.slices)||c.slices.some(value=>typeof value!=='string'))throw new EvaluationError('Attention slice labels are invalid.');
  if(!validAttentionMetadata(c.metadata))throw new EvaluationError('Attention metadata must contain only title, labels and branch.');
  if(!exactKeys(c.labels,ATTENTION_BADGES)||Object.values(c.labels).some(value=>![true,false,null].includes(value)))throw new EvaluationError('Attention badge labels are incomplete.');
 }
 return corpus;
}
export function buildAttentionEvaluationEntry(c,{corpusHash}={}){
 attentionHelpers();
 if(!/^[a-f0-9]{64}$/.test(corpusHash??''))throw new EvaluationError('Attention projection needs its frozen corpus hash.');
 if(!validAttentionMetadata(c.metadata))throw new EvaluationError('Attention metadata projection is invalid.');
 const row={kind:'issue',number:1,title:c.metadata.title,labels:c.metadata.labels,branch:c.metadata.branch??''};
 const built=app.buildAttentionJevRequest([row]),wire=JSON.stringify(built.request);
 if(Buffer.byteLength(wire)>24576||Object.keys(built.request.questions).length!==2||!exactKeys(built.questionIds?.[0],ATTENTION_BADGES))throw new EvaluationError('Attention serialized question bound or mapping is invalid.');
 const contentDigest=hash(c.metadata),identity={feature:'attention',host:'synthetic.invalid',repo:'evaluation/attention',accessPartition:corpusHash,
  contentDigest,questionVersion:ATTENTION_VERSION,viewerId:1,manifestDigest:hash([c.id,contentDigest])};
 const bindingDigest=hash([identity,built.request]);
 return {caseId:c.id,metadata:c.metadata,request:built.request,requestHash:hash(wire),bytes:Buffer.byteLength(wire),identity,bindingDigest,questionIds:built.questionIds[0],truncated:built.truncated};
}
const attentionAmbiguous=c=>c.classification==='ambiguous'||Object.values(c.labels).some(value=>value===null);
function attentionCoverage(corpus){
 const held=corpus.cases.filter(c=>c.split==='held-out');
 return {cases:corpus.cases.length,heldOut:held.length,development:corpus.cases.length-held.length,ambiguousCases:held.filter(attentionAmbiguous).length,
  nonEnglishOrAdversarialCases:held.filter(c=>c.slices.some(s=>['non-English','non-english','adversarial'].includes(s))).length,
  badges:Object.fromEntries(ATTENTION_BADGES.map(key=>[key,{positive:held.filter(c=>c.labels[key]===true).length,negative:held.filter(c=>c.labels[key]===false).length,ambiguous:held.filter(c=>c.labels[key]===null).length}]))};
}
function normalizedAttentionRecord(record,entry){
 const absent=(error,identityError=false)=>({status:'unavailable',error,identityError,outcomes:{}});
 if(!record)return absent('missing-record');
 const matches=exactKeys(record.identity,Object.keys(entry.identity))&&Object.entries(entry.identity).every(([key,value])=>record.identity[key]===value);
 if(!matches||record.bindingDigest!==entry.bindingDigest)return absent('stale',true);
 if(record.status==='unavailable')return absent(safeReplayError(record.error));
 if(record.status!=='completed'||!exactKeys(record.outcomes,ATTENTION_BADGES))return absent('invalid-record');
 for(const value of Object.values(record.outcomes))if(!value||!['positive','negative','uncertain'].includes(value.decision)||
  value.probability!==undefined&&(!Number.isFinite(value.probability)||value.probability<0||value.probability>1||app.classifyJevProbability(value.probability)!==value.decision))return absent('invalid-record');
 return {status:'completed',error:safeReplayError(record.error),identityError:false,outcomes:record.outcomes};
}
export function scoreAttention(corpus,records=[],{corpusHash=hash(corpus)}={}){
 inspectAttentionCorpus(corpus);const byId=new Map();
 for(const record of records){if(byId.has(record.caseId))throw new EvaluationError('Duplicate attention replay case ID.');byId.set(record.caseId,record);}
 if([...byId.keys()].some(id=>!corpus.cases.some(c=>c.id===id)))throw new EvaluationError('Attention replay contains an unknown case ID.');
 const badges=Object.fromEntries(ATTENTION_BADGES.map(key=>[key,{tp:0,fp:0,fn:0,tn:0,abstentions:0,positiveExamples:0,negativeExamples:0,ambiguousExamples:0}]));
 const attempts=[];let identityErrors=0,ambiguousCases=0,ambiguousAssertionCases=0;
 for(const c of corpus.cases.filter(c=>c.split==='held-out')){
  const entry=buildAttentionEvaluationEntry(c,{corpusHash}),record=normalizedAttentionRecord(byId.get(c.id),entry),outcomes={};let positives=0,unsupported=0;
  const ambiguous=attentionAmbiguous(c);ambiguousCases+=Number(ambiguous);identityErrors+=Number(record.identityError);
  for(const key of ATTENTION_BADGES){
   const decision=record.outcomes[key]?.decision??'unavailable',gold=c.labels[key],stats=badges[key];outcomes[key]={decision};
   if(gold===true){stats.positiveExamples++;if(decision==='positive')stats.tp++;else stats.fn++;}
   else if(gold===false){stats.negativeExamples++;if(decision==='positive')stats.fp++;else if(decision==='negative')stats.tn++;}
   else stats.ambiguousExamples++;
   if(['uncertain','unavailable'].includes(decision))stats.abstentions++;
   positives+=Number(decision==='positive');unsupported+=Number(decision==='positive'&&gold!==true);
  }
  ambiguousAssertionCases+=Number(ambiguous&&unsupported>0);
  attempts.push({id:c.id,slices:c.slices,status:record.status,error:record.error??null,identityError:record.identityError,ambiguous,positiveBadges:positives,outcomes});
 }
 for(const stats of Object.values(badges)){stats.precision=stats.tp+stats.fp?stats.tp/(stats.tp+stats.fp):null;stats.recall=stats.positiveExamples?stats.tp/stats.positiveExamples:null;}
 const slices=Object.fromEntries([...new Set(attempts.flatMap(c=>c.slices))].map(slice=>{
  const values=attempts.filter(c=>c.slices.includes(slice)),gold=corpus.cases.filter(c=>c.split==='held-out'&&c.slices.includes(slice));
  return [slice,{attempted:values.length,unavailable:values.filter(c=>c.status==='unavailable').length,ambiguous:values.filter(c=>c.ambiguous).length,
   badges:Object.fromEntries(ATTENTION_BADGES.map(key=>[key,{positiveExamples:gold.filter(c=>c.labels[key]===true).length,negativeExamples:gold.filter(c=>c.labels[key]===false).length,ambiguousExamples:gold.filter(c=>c.labels[key]===null).length}]))}];
 }));
 return {coverage:attentionCoverage(corpus),badges,identityErrors,ambiguousCases,ambiguousAssertionCases,ambiguousAssertionRate:ambiguousCases?ambiguousAssertionCases/ambiguousCases:null,
  deterministicMembershipOrderPreservation:null,deterministicQualification:'Exercised separately by exact queue tests; badge replay does not measure queue behavior.',
  slices,attempts,qualified:false,qualification:'UNVERIFIED: offline/replay arithmetic does not establish the live model contract or held-out badge accuracy.'};
}
export function prepareAttentionManifest(corpus,{corpusHash=hash(corpus)}={}){
 inspectAttentionCorpus(corpus);
 if(!['synthetic','public'].includes(corpus.provenance?.dataClass))throw new EvaluationError('Attention manifest requires frozen synthetic/public labels.');
 const entries=[];
 for(const c of corpus.cases.filter(c=>c.split==='development')){
  const entry=buildAttentionEvaluationEntry(c,{corpusHash});
  if(entries.length>=12||entries.reduce((sum,item)=>sum+item.bytes,0)+entry.bytes>192*1024)break;
  entries.push(entry);
 }
 const manifest={schemaVersion:1,feature:'attention',purpose:'contract',dataClass:corpus.provenance.dataClass,model:app.JEV_MODEL,
  questionVersion:ATTENTION_VERSION,corpusHash,pricing:MODEL_RESERVATION,entries};
 validateEvaluationManifest(manifest);return manifest;
}
function validateAttentionManifest(manifest,{corpusHash=null,corpus=null}={}){
 attentionHelpers();
 if(manifest?.schemaVersion!==1||manifest.feature!=='attention'||manifest.purpose!=='contract'||manifest.model!==app.JEV_MODEL||manifest.questionVersion!==ATTENTION_VERSION||!/^[a-f0-9]{64}$/.test(manifest.corpusHash??''))throw new EvaluationError('Attention manifest model/question/corpus identity mismatch.');
 if(!['synthetic','public'].includes(manifest.dataClass)||JSON.stringify(manifest.pricing)!==JSON.stringify(MODEL_RESERVATION))throw new EvaluationError('Attention manifest data class or pricing requires review.');
 if(corpus){inspectAttentionCorpus(corpus);if(corpus.provenance?.dataClass!==manifest.dataClass)throw new EvaluationError('Attention corpus must match its synthetic/public class.');}
 if(corpusHash&&manifest.corpusHash!==corpusHash)throw new EvaluationError('Attention corpus hash differs from the reviewed manifest.');
 if(!Array.isArray(manifest.entries)||!manifest.entries.length||manifest.entries.length>12)throw new EvaluationError('Attention contract probe permits 1-12 calls.');
 const ids=new Set();let bytes=0;
 for(const entry of manifest.entries){
  if(typeof entry.caseId!=='string'||ids.has(entry.caseId))throw new EvaluationError('Duplicate/missing attention manifest case ID.');ids.add(entry.caseId);
  const expected=buildAttentionEvaluationEntry({id:entry.caseId,metadata:entry.metadata},{corpusHash:manifest.corpusHash});
  if(expected.requestHash!==entry.requestHash||expected.bytes!==entry.bytes||hash(entry.request)!==entry.requestHash||JSON.stringify(expected.identity)!==JSON.stringify(entry.identity)||expected.bindingDigest!==entry.bindingDigest||JSON.stringify(expected.questionIds)!==JSON.stringify(entry.questionIds))throw new EvaluationError('Attention reviewed payload/hash/binding differs from its fixed projection.');
  if(corpus){
   const c=corpus.cases.find(c=>c.id===entry.caseId);
   if(!c||c.split!=='development')throw new EvaluationError('Attention contract manifest must use reviewed development cases.');
   const frozen=buildAttentionEvaluationEntry(c,{corpusHash:manifest.corpusHash});
   if(frozen.requestHash!==entry.requestHash||frozen.bindingDigest!==entry.bindingDigest)throw new EvaluationError('Attention manifest payload differs from the frozen corpus projection.');
  }
  bytes+=entry.bytes;
 }
 if(bytes>192*1024)throw new EvaluationError('Attention contract probe exceeds 192 KiB of serialized input.');
 return {calls:manifest.entries.length,bytes,reservationDollars:manifest.entries.length*CALL_NANODOLLARS/1e9};
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
 if(manifest?.feature==='ci')return validateCiManifest(manifest,{corpusHash,corpus});
 if(manifest?.feature==='attention')return validateAttentionManifest(manifest,{corpusHash,corpus});
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
 const names=new Set(['feature','corpus','replay','prepare-manifest','manifest','manifest-sha256','max-calls','max-bytes','max-dollars','output']);
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];if(arg==='--live'){opts.live=true;continue;}
  if(!arg.startsWith('--'))throw new EvaluationError('Use named evaluation options.');
  const [name,inline]=arg.slice(2).split('=',2);if(!names.has(name))throw new EvaluationError(`Unknown option --${name}`);
  const value=inline??argv[++i];if(!value||value.startsWith('--'))throw new EvaluationError(`--${name} needs a value.`);opts[name]=value;
 }
 return opts;
}
export async function runEvaluationCLI(argv,{env=process.env,makeSession=app.createJevSession,fetchImpl=(...args)=>globalThis.fetch(...args)}={}){
 const opts=parseCLI(argv),feature=opts.feature??'focus';
 if(!['focus','ci','attention'].includes(feature))throw new EvaluationError('Choose the Focus, CI or attention evaluation feature.');
 const corpusBytes=readFileSync(opts.corpus??new URL(`../test/fixtures/jev/${feature}.json`,import.meta.url));
 const corpus=JSON.parse(corpusBytes),corpusHash=hash(corpusBytes);
 if(corpus.feature!==feature)throw new EvaluationError('Corpus feature differs from the selected evaluation.');
 if(feature==='ci')inspectCiCorpus(corpus);else if(feature==='attention')inspectAttentionCorpus(corpus);else inspectCorpus(corpus);
 const questionVersion=feature==='ci'?CI_VERSION:feature==='attention'?ATTENTION_VERSION:app.JEV_QUESTION_VERSION;
 const identity={feature,corpusHash,model:app.JEV_MODEL,questionVersion,runtime:process.version,
  candidateHashes:Object.fromEntries(['index.mjs','package.json','package-lock.json'].map(name=>[name,hash(readFileSync(new URL('../'+name,import.meta.url)))]))};
 if(opts['prepare-manifest']){
  if(opts.live)throw new EvaluationError('Prepare and review the exact manifest before a separate live invocation.');
  const manifest=feature==='ci'?prepareCiManifest(corpus,{corpusHash}):feature==='attention'?prepareAttentionManifest(corpus,{corpusHash}):prepareFocusManifest(corpus,{corpusHash});
  writeFileSync(opts['prepare-manifest'],JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  return {...identity,mode:'prepare',liveContract:'UNVERIFIED',dispatchedCalls:0,manifestPath:opts['prepare-manifest'],
   manifestHash:hash(readFileSync(opts['prepare-manifest'])),...validateEvaluationManifest(manifest)};
 }
 if(!opts.live){
  const replay=opts.replay?JSON.parse(readFileSync(opts.replay,'utf8')):null;
  if(replay && (replay.corpusHash!==corpusHash||replay.model!==app.JEV_MODEL||replay.questionVersion!==questionVersion || replay.feature && replay.feature!==feature || feature!=='focus'&&replay.feature!==feature))throw new EvaluationError('Replay identity differs from feature/corpus/model/questions.');
  return {...identity,mode:'offline',liveContract:'UNVERIFIED',dispatchedCalls:0,
   baseline:feature==='focus'?scoreFocus(corpus,localRecords(corpus)):null,
   ...(feature==='ci'?{corpusCoverage:ciCoverage(corpus)}:feature==='attention'?{corpusCoverage:attentionCoverage(corpus)}:{}),
   semantic:replay?(feature==='ci'?scoreCi(corpus,replay.records,{corpusHash}):feature==='attention'?scoreAttention(corpus,replay.records,{corpusHash}):scoreFocus(corpus,replay.records)):null,
   qualification:'Offline arithmetic and replay outcomes do not verify live model behavior.'};
 }
 if(!opts.manifest||!opts['manifest-sha256']||!opts['max-calls']||!opts['max-bytes']||!opts['max-dollars'])throw new EvaluationError('Live evaluation requires a reviewed manifest hash and explicit call/byte/dollar budgets.');
 const manifestBytes=readFileSync(opts.manifest),manifestHash=hash(manifestBytes);
 if(manifestHash!==opts['manifest-sha256'])throw new EvaluationError('Reviewed manifest hash differs.');
 const manifest=JSON.parse(manifestBytes);
 if(manifest.feature!==feature)throw new EvaluationError('Reviewed manifest feature differs from the selected evaluation.');
 const limits=validateEvaluationManifest(manifest,{corpusHash,corpus});
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
   const sourceIdentity=feature!=='focus'?entry.identity:{feature:'focus',host:'synthetic.invalid',repo:'evaluation/focus',accessPartition:manifestHash,
    contentDigest:entry.requestHash,query:entry.request.state.query,questionVersion:app.JEV_QUESTION_VERSION};
   session.grant(sourceIdentity);const start=performance.now(),before=dispatchedCalls;
   const result=await session.evaluateJev(entry.request,sourceIdentity,{isCurrent:()=>true});
   const latencyMs=performance.now()-start,calls=dispatchedCalls-before;
   let normalized;
   if(feature==='ci'){
    normalized={status:'unavailable',identity:entry.identity,bindingDigest:entry.bindingDigest,outcomes:{},error:safeReplayError(result.error)};
    if(result.status==='complete')try{
     const built=app.buildCiQuestions(entry.prepared,entry.identity,{failedSteps:entry.failedSteps});
     const validated=app.validateCiObservations({...result,bindingDigest:entry.bindingDigest},built,entry.identity);
     normalized={...normalized,status:'completed',outcomes:validated.outcomes,error:null};
    }catch{normalized.error='invalid-observations';}
   }else if(feature==='attention'){
    normalized={status:result.status==='complete'?'completed':'unavailable',identity:entry.identity,bindingDigest:entry.bindingDigest,
     outcomes:result.status==='complete'?Object.fromEntries(ATTENTION_BADGES.map(key=>[key,result.answers?.[entry.questionIds[key]]??{decision:'unavailable'}])):{},error:safeReplayError(result.error)};
    if(result.status==='complete'&&Object.values(normalized.outcomes).some(value=>!['positive','negative','uncertain'].includes(value.decision)))normalized={...normalized,status:'unavailable',outcomes:{},error:'invalid-record'};
   }else{
    const decisions=Object.fromEntries(entry.rowIds.map((id,index)=>[id,result.answers?.[`i${index}`]??{decision:'unavailable'}]));
    const ranking=Object.entries(decisions).filter(([,a])=>a.decision==='positive').sort((a,b)=>(b[1].probability??0)-(a[1].probability??0)).map(([id])=>id);
    normalized={status:result.status==='complete'?'completed':result.status==='partial'?'partial':'unavailable',decisions,ranking,error:safeReplayError(result.error)};
   }
   records.push({caseId:entry.caseId,...normalized,calls,latencyMs,usage:result.usage??null});
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
