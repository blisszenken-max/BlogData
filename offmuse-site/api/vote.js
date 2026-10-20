/* OFFMUSE anonymous voting API.
   Runtime: Vercel Node.js serverless; storage: Upstash Redis REST (free tier).
   Every valid click atomically increments one version. Repeat voting is intentional.
   Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_*).
   Song/option membership is validated against the PUBLIC, read-only music sheet.
   No visitor account/IP/cookie/identity is stored. */
"use strict";
const SHEET="1uadQq-jlwisxFfoaNIzcl8-ERe0aAMj3mcPRM0l67VU";
const GID="684744840";
const PREFIX="offmuse:votes:v1:";
let cached={until:0,songs:null};
function txt(v,n=100){return String(v==null?"":v).trim().slice(0,n);}
function cell(row,i){const v=row?.c?.[i];return v&&v.v!=null?v.v:"";}
function validSuno(u){try{const x=new URL(txt(u,500));return x.protocol==="https:"&&["suno.com","www.suno.com"].includes(x.hostname)&&/^\/(?:s|song)\/[a-z0-9_-]+\/?$/i.test(x.pathname);}catch{return false;}}
function parseGviz(source){const marker="google.visualization.Query.setResponse(";
  const a=source.indexOf(marker);if(a<0)throw Error("invalid music feed");
  const b=source.indexOf(");",a+marker.length);if(b<0)throw Error("invalid music feed");
  const data=JSON.parse(source.slice(a+marker.length,b));if(data.status!=="ok"||!Array.isArray(data.table?.rows))throw Error("invalid music feed");return data.table.rows;}
async function getSongs(forceRefresh=false){
 if(!forceRefresh&&cached.songs&&Date.now()<cached.until)return cached.songs;
 const url="https://docs.google.com/spreadsheets/d/"+SHEET+"/gviz/tq?gid="+GID+"&headers=1&range=A2:H1000&tqx=out:json&_="+Date.now();
 const response=await fetch(url,{headers:{"Accept":"text/plain"},cache:"no-store",signal:AbortSignal.timeout(9000)});
 if(!response.ok)throw Error("public sheet unavailable");
 const rows=parseGviz(await response.text());const map=new Map();
 for(const row of rows){const id=txt(cell(row,0),80),title=txt(cell(row,1),100),version=txt(cell(row,2),24),
  suno=txt(cell(row,3),500),state=txt(cell(row,4),20);
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||!/^[A-Za-z0-9_-]{1,24}$/.test(version)||!title||state!=="표시"||!validSuno(suno))continue;
  if(!map.has(id))map.set(id,{title,versions:new Set()});map.get(id).versions.add(version);
 }
 for(const [id,entry] of map){if(entry.versions.size<2)map.delete(id);}
 cached={songs:map,until:Date.now()+30000};
 return map;
}
function normalizeEnv(value){
 let v=String(value??"").trim();
 if(v.length>1&&((v[0]==='"'&&v[v.length-1]==='"')||(v[0]==="'"&&v[v.length-1]==="'")))v=v.slice(1,-1).trim();
 return v;
}
function storageConfiguration(){
 const url=normalizeEnv(process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL);
 const token=normalizeEnv(process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN);
 if(!url&&!token)return {ok:false,reason:"missing_url_and_token"};
 if(!url)return {ok:false,reason:"missing_url"};
 if(!token)return {ok:false,reason:"missing_token"};
 try{
  const u=new URL(url);
  if(u.protocol!=="https:"||!u.hostname)return {ok:false,reason:"invalid_url"};
  // The Upstash REST URL is an HTTPS *.upstash.io origin, not the console or Redis TCP URL.
  if(!u.hostname.toLowerCase().endsWith(".upstash.io")||u.username||u.password||u.pathname!=="/"||u.search||u.hash)
   return {ok:false,reason:"wrong_rest_endpoint"};
 }catch{return {ok:false,reason:"invalid_url"};}
 return{ok:true,url:url.replace(/\/$/,""),token};
}
function redisEnv(){const data=storageConfiguration();return data.ok?{url:data.url,token:data.token}:null;}
function storageError(code){return Object.assign(Error(code),{code});}
async function redis(command){
 const c=redisEnv();if(!c)throw storageError("storage_not_configured");
 let response;
 try{
  response=await fetch(c.url,{method:"POST",headers:{"Authorization":"Bearer "+c.token,"Content-Type":"application/json"},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
 }catch(e){throw storageError(e?.name==="TimeoutError"||e?.name==="AbortError"?"connection_timeout":"network_error");}
 if(!response.ok){
  if(response.status===401||response.status===403)throw storageError("authentication_failed");
  if(response.status===404)throw storageError("endpoint_not_found");
  if(response.status===429)throw storageError("rate_limited");
  if(response.status>=500)throw storageError("redis_service_error");
  throw storageError("redis_request_rejected");
 }
 let data;
 try{data=await response.json();}catch{throw storageError("invalid_redis_response");}
 if(data?.error){
  if(/auth|token|unauthori[sz]|credential/i.test(String(data.error)))throw storageError("authentication_failed");
  throw storageError("redis_command_error");
 }
 if(!data||!Object.prototype.hasOwnProperty.call(data,"result"))throw storageError("invalid_redis_response");
 return data.result;
}
function reply(res,code,value){res.statusCode=code;res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.end(JSON.stringify(value));}
function csvEscape(x){const s=String(x??"");return /[,"\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function counts(flat){const obj=Object.create(null);if(Array.isArray(flat)){for(let i=0;i+1<flat.length;i+=2)obj[String(flat[i])]=Number(flat[i+1])||0;}else if(flat&&typeof flat==="object"){for(const [k,v]of Object.entries(flat))obj[k]=Number(v)||0;}return obj;}
async function outputResults(res){const songs=await getSongs(),rows=[["song_id","곡명","버전","투표수","곡 총투표수","득표율"]];
 for(const [id,entry]of songs){const data=counts(await redis(["HGETALL",PREFIX+id]));
 const total=[...entry.versions].reduce((a,v)=>a+(data[v]||0),0);
 for(const ver of entry.versions){const n=data[ver]||0;rows.push([id,entry.title,ver,n,total,total?Math.round(10000*n/total)/100:0]);}}
 res.statusCode=200;res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Cache-Control","no-store");
 res.setHeader("X-Content-Type-Options","nosniff");res.end("\uFEFF"+rows.map(r=>r.map(csvEscape).join(",")).join("\r\n"));}
module.exports=async function handler(req,res){
 try{
  if(req.method==="GET"){
   if(req.query?.results==="csv"){const secret=process.env.OFFMUSE_REPORT_SECRET;if(!secret||req.headers?.authorization!=="Bearer "+secret)return reply(res,403,{ok:false,code:"REPORT_FORBIDDEN"});if(!redisEnv())return reply(res,503,{ok:false,code:"VOTING_NOT_READY"});return await outputResults(res);}
   if(req.query?.check&&req.query?.version){
    const id=txt(req.query.check,80),version=txt(req.query.version,24);
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||!/^[A-Za-z0-9_-]{1,24}$/.test(version))return reply(res,400,{ok:false,code:"INVALID_SELECTION"});
    let songs;
    try{songs=await getSongs(true);}catch{return reply(res,503,{ok:false,code:"MUSIC_LIST_UNAVAILABLE"});}
    return reply(res,200,{ok:true,selectable:!!(songs.has(id)&&songs.get(id).versions.has(version)),songId:id,version});
   }
   const storage=storageConfiguration();if(!storage.ok)return reply(res,200,{ok:true,enabled:false,reason:storage.reason});
   try{
    const p=await redis(["PING"]);
    return p==="PONG"?reply(res,200,{ok:true,enabled:true}):reply(res,200,{ok:true,enabled:false,reason:"unexpected_ping_result"});
   }catch(e){
    const known=["authentication_failed","endpoint_not_found","rate_limited","redis_service_error","redis_request_rejected","invalid_redis_response","redis_command_error","connection_timeout","network_error"];
    return reply(res,200,{ok:true,enabled:false,reason:known.includes(e?.code)?e.code:"storage_unavailable"});
   }
  }
  if(req.method!=="POST"){res.setHeader("Allow","GET, POST");return reply(res,405,{ok:false,code:"METHOD_NOT_ALLOWED"});}
  if(!redisEnv())return reply(res,503,{ok:false,code:"VOTING_NOT_READY"});
  const input=typeof req.body==="string"?JSON.parse(req.body):req.body;
  const songId=txt(input?.songId,80),version=txt(input?.version,24);
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(songId)||!/^[A-Za-z0-9_-]{1,24}$/.test(version))
   return reply(res,400,{ok:false,code:"INVALID_SELECTION"});
  let songs;
  try{songs=await getSongs();}catch{
   if(!cached.songs)return reply(res,503,{ok:false,code:"MUSIC_LIST_UNAVAILABLE"});
   songs=cached.songs;
  }
  const isVisible=map=>map.has(songId)&&map.get(songId).versions.has(version);
  if(!isVisible(songs)){
   // A fresh lookup resolves stale option membership without granting hidden options.
   try{songs=await getSongs(true);}catch{
    return reply(res,503,{ok:false,code:"MUSIC_LIST_UNAVAILABLE"});
   }
   if(!isVisible(songs))return reply(res,400,{ok:false,code:"INVALID_SELECTION"});
  }
  try{await redis(["HINCRBY",PREFIX+songId,version,"1"]);}
  catch{return reply(res,503,{ok:false,code:"VOTE_STORE_UNAVAILABLE"});}
  return reply(res,200,{ok:true,stored:true,songId,version});
 }catch(e){return reply(res,400,{ok:false,code:"BAD_REQUEST"});}
};
