import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as app from '../index.mjs';
const row = (number, title, extra = {}) => ({ number, title, author:'ana', updatedAt:'2026-10-20T00:00:00Z', ...extra });
const ids = (query, rows, kind='issues') => app.rankLocalFocus(app.parseFocusQuery(query), rows, kind).map(x=>x.number);
test('Focus exact filters AND and branch case, strict dates and numeric IDs', () => {
 const rows=[row(42,'Authentication',{author:'bob',headRefName:'fix/Session'}),row(43,'Auth',{headRefName:'fix/session'})];
 assert.deepEqual(ids('#42 author:ana',rows),[]);
 assert.deepEqual(ids('branch:fix/Session',rows,'prs'),[42]);
 assert.deepEqual(ids('branch:fix/Session',rows),[]);
 assert.throws(()=>app.parseFocusQuery('updated:>=2026-02-30'),/valid UTC calendar date/);
 for(const query of ['#x','author:','updated:2026-01-01','branch:']) assert.throws(()=>app.parseFocusQuery(query),/filter/);
 assert.deepEqual(ids('#42',rows),[42]); assert.deepEqual(ids('author:ANA updated:>=2026-10-20',rows),[43]);
});
test('Focus stable phrase, exact, prefix, typo and Unicode ranking',()=>{
 const rows=[row(1,'Authentication cache'),row(2,'Auth cache'),row(3,'Authorization cache'),row(4,'Cache auth')];
 assert.deepEqual(ids('auth cache',rows),[2,4,1,3]);
 assert.deepEqual(ids('cache', [row(1,'cache'),row(2,'caches'),row(3,'cace'),row(4,'cache')]),[1,4,2,3]);
 assert.deepEqual(ids('cat',[row(1,'bat')]),[]);
 assert.deepEqual(ids('sesión',[row(1,'SESIO\u0301N')]),[1]);
 assert.deepEqual(ids('',rows),[1,2,3,4]);
});
test('Focus reducer captures printable q, refuses oversized input and restores edit/view',()=>{
 let state=app.reduceFeatureMode(null,{type:'focus',tab:'issues',selection:42});
 state=app.reduceFeatureMode(state,{type:'text',text:'query'}); assert.equal(state.draft,'query');
 state=app.reduceFeatureMode(state,{type:'submit'}); assert.equal(state.query,'query');
 state=app.reduceFeatureMode(state,{type:'edit'}); state=app.reduceFeatureMode(state,{type:'text',text:'x'});
 state=app.reduceFeatureMode(state,{type:'escape'}); assert.equal(state.query,'query'); assert.equal(state.editing,false);
 assert.equal(app.reduceFeatureMode(state,{type:'escape'}),null);
 state=app.reduceFeatureMode(null,{type:'focus',tab:'issues'});
 state=app.reduceFeatureMode(state,{type:'text',text:'é'.repeat(129)}); assert.equal(state.error,'Query limit: 256 UTF-8 bytes; shorten the query.');
 assert.ok(Buffer.byteLength(state.draft)<=256);
 assert.equal(app.reduceFeatureMode(state,{type:'text',text:'[A\u001b'})?.draft,state.draft);
});
test('Focus coverage distinguishes missing, empty, partial and stale without changing sources',()=>{
 assert.match(app.focusCoverage({rows:null,matches:[],nowMs:5000}),/not loaded.*r Refresh/);
 assert.match(app.focusCoverage({rows:[],matches:[],sourceAt:1000,nowMs:5000}),/0\/0.*4s/);
 assert.match(app.focusCoverage({rows:[row(1,'x')],matches:[],sourceAt:1000,nowMs:5000,hasNextPage:true}),/No local match.*More source pages/);
});

test('Escape restores submitted empty results, feature hints match input ownership',()=>{
 let state=app.reduceFeatureMode(null,{type:'focus',tab:'issues',selection:42});
 state=app.reduceFeatureMode(state,{type:'submit'});state=app.reduceFeatureMode(state,{type:'edit'});
 state=app.reduceFeatureMode(state,{type:'text',text:'x'});
 state=app.reduceFeatureMode(state,{type:'escape'});assert.equal(state.query,'');assert.equal(state.editing,false);
 const hints=app.activeKeyHints({interactive:true,feature:{mode:'focus',editing:true}});
 assert.equal(hints.find(x=>x.label==='Quit').keys,'^C');
 assert.ok(!hints.some(x=>['Refresh','Open'].includes(x.label)));
});

test('Frozen Focus corpus preserves all exact-filter oracles and held-out groups',async()=>{
 const {readFileSync}=await import('node:fs');
 const corpus=JSON.parse(readFileSync(new URL('./fixtures/jev/focus.json',import.meta.url)));
 const groups=new Map(), held=corpus.cases.filter(x=>x.split==='held-out');
 assert.ok(held.length>=80);
 for(const [slice,n] of [['synonym',30],['no-match',20],['ambiguous',10],['non-English',10]]) assert.ok(held.filter(x=>x.slices.includes(slice)).length>=n,slice);
 for(const c of corpus.cases){
  assert.ok(!groups.has(c.groupId) || groups.get(c.groupId)===c.split); groups.set(c.groupId,c.split);
  if(c.expectedQueryError){assert.throws(()=>app.parseFocusQuery(c.query));continue;}
  const parsed=app.parseFocusQuery(c.query);
  assert.deepEqual(c.rows.filter(r=>app.focusEligible(parsed,r,r.kind==='pr'?'prs':'issues')).map(r=>`${r.kind}:${r.number}`),c.exactFilterExpectedIds,c.id);
 }
});

test('literal bracket text remains searchable and source data stays immutable',()=>{
 let state=app.reduceFeatureMode(null,{type:'focus',tab:'issues'});
 state=app.reduceFeatureMode(state,{type:'text',text:'[bug]'});assert.equal(state.draft,'[bug]');
 const rows=Object.freeze([Object.freeze(row(1,'cache')),Object.freeze(row(2,'auth'))]);
 assert.deepEqual(ids('auth',rows),[2]);assert.deepEqual(rows.map(x=>x.number),[1,2]);
 assert.deepEqual(app.reconcileSelectionViewport({items:app.rankLocalFocus(app.parseFocusQuery('auth'),rows),key:1,rows:10}),{key:null,offset:0});
});
