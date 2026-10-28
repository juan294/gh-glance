// Test-only preload. Production has no endpoint override or fake-response option.
import {appendFileSync,readFileSync} from 'node:fs';
const original=globalThis.fetch;
globalThis.fetch=async (url,init)=>{
 if(String(url)!=='https://api.typesafe.ai/v1/systemone')return original(url,init);
 const request=JSON.parse(init.body);
 const config=process.env.GH_GLANCE_TEST_JEV_CONFIG?JSON.parse(readFileSync(process.env.GH_GLANCE_TEST_JEV_CONFIG,'utf8')):{};
 appendFileSync(process.env.GH_GLANCE_TEST_JEV_CALLS,JSON.stringify({method:init.method,request,keyPresent:Boolean(init.headers?.Authorization??init.headers?.authorization)})+'\n');
 if(config.delay)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,config.delay);init.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});});
 if(config.status)return new Response('do not expose provider content',{status:config.status,headers:{'retry-after':String(config.retryAfter??1)}});
 return Response.json({model:config.model??'jev-1.14.0',answers:Object.fromEntries(Object.keys(request.questions).map((id,i)=>[id,{type:'noul',noul:config.probabilities?.[i]??.5}])),usage:{input_tokens:42,output_tokens:1}});
};
