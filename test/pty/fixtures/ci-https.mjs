// Test-only third-party HTTPS boundary. Production origin policy is unchanged.
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
import {ciHttpsFixture} from '../../fixtures/ci-https-fixture.mjs';
const fixture=await ciHttpsFixture({mode:process.env.GH_GLANCE_CI_MODE??'ok',onRequest:event=>{
  if(process.env.GH_GLANCE_CI_EVENTS)appendFileSync(process.env.GH_GLANCE_CI_EVENTS,JSON.stringify(event)+'\n');
}});
fixture.unref();
let delayed=false;
https.request=(url,options,callback)=>{
  if(!(url instanceof URL) || !['api.github.com','storage.fixture.test'].includes(url.hostname))throw Error('Unexpected offline CI origin');
  const req=fixture.request(url,options,callback);
  if(process.env.GH_GLANCE_CI_MODE==='late-close-once' && !delayed && url.hostname==='api.github.com'){
    delayed=true;
    const once=req.once.bind(req);
    req.once=(event,listener)=>event==='socket'?once(event,socket=>listener({
      once(name,handler){socket.once(name,(...args)=>setTimeout(()=>handler(...args),17000));return this;},
      destroy(){socket.destroy();},
    })):once(event,listener);
  }
  return req;
};
syncBuiltinESMExports();
