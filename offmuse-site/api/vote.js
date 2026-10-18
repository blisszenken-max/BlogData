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
async function getSongs(){if(cached.songs&&Date.now()<cached.until)return cached.songs;
 const url="https://docs.google.com/spreadsheets/d/"+SHEET+"/gviz/tq?gid="+GID+"&headers=1&range=A2:H1000&tqx=out:json";
 const response=await fetch(url,{headers:{"Accept":"text/plain"},signal:AbortSignal.timeout(9000)});
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
 try{const u=new URL(url);if(u.protocol!=="https:"||!u.hostname)return {ok:false,reason:"invalid_url"};}
 catch{return {ok:false,reason:"invalid_url"};}
 return{ok:true,url:url.replace(/\/$/,""),token};
}
function redisEnv(){const data=storageConfiguration();return data.ok?{url:data.url,token:data.token}:null;}
async function redis(command){const c=redisEnv();if(!c)throw Object.assign(Error("storage not configured"),{code:"STORAGE_OFFLINE"});
 const response=await fetch(c.url,{method:"POST",headers:{"Authorization":"Bearer "+c.token,"Content-Type":"application/json"},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error("storage request failed");
 const data=await response.json();if(data.error)throw Error("storage command failed");return data.result;}
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
   const storage=storageConfiguration();if(!storage.ok)return reply(res,200,{ok:true,enabled:false,reason:storage.reason});
   try{const p=await redis(["PING"]);return reply(res,200,{ok:true,enabled:p==="PONG"});}
   catch{return reply(res,200,{ok:true,enabled:false,reason:"storage_unavailable"});}
  }
  if(req.method!=="POST"){res.setHeader("Allow","GET, POST");return reply(res,405,{ok:false,code:"METHOD_NOT_ALLOWED"});}
  if(!redisEnv())return reply(res,503,{ok:false,code:"VOTING_NOT_READY"});
  const input=typeof req.body==="string"?JSON.parse(req.body):req.body;
  const songId=txt(input?.songId,80),version=txt(input?.version,24);
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(songId)||!/^[A-Za-z0-9_-]{1,24}$/.test(version))
   return reply(res,400,{ok:false,code:"INVALID_SELECTION"});
  let songs;
  try{songs=await getSongs();}catch{return reply(res,503,{ok:false,code:"MUSIC_LIST_UNAVAILABLE"});}
  if(!songs.has(songId)||!songs.get(songId).versions.has(version))
   return reply(res,400,{ok:false,code:"INVALID_SELECTION"});
  try{await redis(["HINCRBY",PREFIX+songId,version,"1"]);}
  catch{return reply(res,503,{ok:false,code:"VOTE_STORE_UNAVAILABLE"});}
  return reply(res,200,{ok:true,stored:true,songId,version});
 }catch(e){return reply(res,400,{ok:false,code:"BAD_REQUEST"});}
};
