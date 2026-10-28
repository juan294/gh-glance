// Presence-only guard around external process APIs; never records argument/env values.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports,registerHooks} from 'node:module';
import {appendFileSync} from 'node:fs';
import {promisify} from 'node:util';
if(process.env.GH_GLANCE_TEST_JEV_IMPORTS)registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='@typesafe-ai/sdk')appendFileSync(process.env.GH_GLANCE_TEST_JEV_IMPORTS,'import\n');
 return nextResolve(specifier,context);
}});
for(const method of ['execFile','execFileSync','spawn']){
 const original=childProcess[method];
 const inspect=options=>{
  const present=Object.hasOwn(options?.env??process.env,'TYPESAFE_API_KEY');
  if(process.env.GH_GLANCE_TEST_JEV_CHILDREN)appendFileSync(process.env.GH_GLANCE_TEST_JEV_CHILDREN,JSON.stringify({method,present})+'\n');
  if(present)throw new Error('Test Jev credential reached child boundary');
 };
 childProcess[method]=function(command,args,options,...rest){inspect(options);return original.call(this,command,args,options,...rest);};
 if(original[promisify.custom])childProcess[method][promisify.custom]=function(command,args,options,...rest){inspect(options);return original[promisify.custom].call(this,command,args,options,...rest);};
}
syncBuiltinESMExports();
