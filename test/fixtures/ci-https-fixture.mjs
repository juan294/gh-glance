import {createServer,request as httpsRequest} from 'node:https';
import {readFileSync} from 'node:fs';
const externalRequest=httpsRequest;
const key=readFileSync(new URL('./ci-tls/test-private-key.fixture',import.meta.url));
const cert=readFileSync(new URL('./ci-tls/test-ca.crt',import.meta.url));
export async function ciHttpsFixture({mode='ok',onRequest=()=>{},trust=true,servername='localhost'}={}) {
  const events=[],sockets=new Set();
  const serve=stage=>(req,res)=>{
    const event={stage,method:req.method,authorization:Boolean(req.headers.authorization),cookie:Boolean(req.headers.cookie),path:req.url.split('?')[0]};
    events.push(event);onRequest(event);
    if(mode==='reset'){req.socket.destroy();return;}
    if(mode==='hang')return;
    if(stage==='api'){
      if(['403','429','404'].includes(mode)){res.writeHead(Number(mode),{'retry-after':'2','x-ratelimit-resource':'core','x-ratelimit-limit':'5000','x-ratelimit-remaining':'4999','x-ratelimit-used':'1','x-ratelimit-reset':String(Math.floor(Date.now()/1000)+3600)});res.end('denied');return;}
      if(mode!=='missing-headers')res.setHeader('x-ratelimit-resource','core');
      if(mode!=='missing-headers')for(const [k,v]of Object.entries({'limit':'5000','remaining':'4999','used':'1','reset':String(Math.floor(Date.now()/1000)+3600)}))res.setHeader('x-ratelimit-'+k,v);
      res.writeHead(302,{location:mode==='port-proxy'?'https://storage.fixture.test:444/log?signature=SECRET':mode==='api-api'?'https://api.github.com/again?signature=SECRET':mode==='http'?'http://storage.fixture.test/log?signature=SECRET':mode==='userinfo'?'https://user:secret@storage.fixture.test/log': 'https://storage.fixture.test/log?signature=SECRET'});
      res.end(mode==='api-oversize'?'x'.repeat(1024*1024+1):mode==='aggregate'?'x'.repeat(512*1024):'redirect');return;
    }
    if(mode==='storage-api' || mode==='storage-storage' || mode==='loop'){
      res.writeHead(302,{location:mode==='storage-api'?'https://api.github.com/again?signature=SECRET':'https://elsewhere.fixture.test/log?signature=SECRET'});res.end();return;
    }
    if(mode==='expired'){res.writeHead(403);res.end('expired');return;}
    res.writeHead(200,{'content-type':'text/plain','x-ratelimit-remaining':'7777','x-ratelimit-resource':'core','x-ratelimit-limit':'7777','x-ratelimit-reset':String(Math.floor(Date.now()/1000)+3600)});
    if(mode==='storage-hang'){res.write('first');return;}
    res.end(mode==='oversize'?'x'.repeat(1024*1024+1):mode==='aggregate'?'x'.repeat(600*1024):'test failed\nassert expected true\n');
  };
  const api=createServer({key,cert},serve('api')),storage=createServer({key,cert},serve('storage'));
  for(const server of [api,storage])server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  await new Promise(resolve=>storage.listen(0,'127.0.0.1',resolve));
  return {events,unref(){api.unref();storage.unref();},
    request(url,options,callback){
      const stage=url.hostname==='api.github.com'?'api':'storage';
      const port=(stage==='api'?api:storage).address().port;
      return externalRequest(new URL(`https://127.0.0.1:${port}${url.pathname}${url.search}`),{...options,...(trust?{ca:cert}:{}),servername},callback);
    },
    async close(){for(const socket of sockets)socket.destroy();await Promise.all([api,storage].map(server=>new Promise(resolve=>server.close(resolve))));},
    get openSockets(){return sockets.size;},
  };
}
