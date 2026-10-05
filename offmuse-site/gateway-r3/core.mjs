import crypto from 'node:crypto';
import fs from 'node:fs';

const MANIFEST = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const PASSABLE = new Set(['PASS','NOT_APPLICABLE']);
const STATE_TTL_SECONDS = 48 * 60 * 60;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const GRANT_TTL_MS = 5 * 60 * 1000;
const COMMIT_TTL_MS = 10 * 60 * 1000;

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
}
function shaHexBytes(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value));
  return shaHexBytes(buf);
}
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64u(s) { return Buffer.from(s, 'base64url'); }
function signObject(obj, secret) {
  const payload=b64u(Buffer.from(JSON.stringify(obj)));
  const sig=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  return payload+'.'+sig;
}
function verifySignedObject(token, secret, typ, now=Date.now()) {
  if (!token || typeof token !== 'string' || !token.includes('.')) throw new Error('BAD_TOKEN');
  const [p,s]=token.split('.');
  const expected=crypto.createHmac('sha256',secret).update(p).digest('base64url');
  const a=Buffer.from(s), b=Buffer.from(expected);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('BAD_SIGNATURE');
  const obj=JSON.parse(unb64u(p).toString('utf8'));
  if (obj.typ!==typ) throw new Error('BAD_TOKEN_TYPE');
  if (obj.exp && now>obj.exp) throw new Error('TOKEN_EXPIRED');
  return obj;
}
function stageContract(stage) {
  const c=MANIFEST.stages[stage]; if (!c) throw new Error('UNKNOWN_STAGE'); return c;
}
function zeroBitmap(count) { return b64u(Buffer.alloc(Math.ceil(count/8))); }
function bitmapBuffer(state, count) {
  const expected=Math.ceil(count/8);
  const b=state.eval_bitmap ? unb64u(state.eval_bitmap) : Buffer.alloc(expected);
  if (b.length!==expected) throw new Error('BAD_EVAL_BITMAP');
  return Buffer.from(b);
}
function bitIsSet(buf,index) { return (buf[Math.floor(index/8)] & (1 << (index%8))) !== 0; }
function setBit(buf,index) { buf[Math.floor(index/8)] |= (1 << (index%8)); }
function bitCount(buf,count) { let n=0; for(let i=0;i<count;i++) if(bitIsSet(buf,i)) n++; return n; }
function allBitsSet(buf,count) { return bitCount(buf,count)===count; }
function parentHash(left,right) { return shaHexBytes(Buffer.concat([Buffer.from(left,'hex'),Buffer.from(right,'hex')])); }
function leafHash(leaf) { return sha(leaf); }
function verifyMerkle(leaf,proof,root) {
  let h=leafHash(leaf);
  if (!Array.isArray(proof)) return false;
  for (const p of proof) {
    if (!p || !/^[0-9a-f]{64}$/.test(String(p.hash||'')) || !['L','R'].includes(p.side)) return false;
    h=p.side==='L' ? parentHash(p.hash,h) : parentHash(h,p.hash);
  }
  return h===root;
}
function compare(actual,spec) {
  if (spec===true) return actual===true;
  if (Array.isArray(spec)) {
    const [op,a,b]=spec;
    if (op==='==') return actual===a;
    if (op==='>=') return typeof actual==='number' && actual>=a;
    if (op==='<=') return typeof actual==='number' && actual<=a;
    if (op==='range') return typeof actual==='number' && actual>=a && actual<=b;
  }
  return actual===spec;
}
function grantHash(g) { return sha({run_id:g.run_id,stage:g.stage,context_generation:g.context_generation,tool_class:g.tool_class,operation:g.operation,payload_hash:g.payload_hash,nonce:g.nonce}); }
function commitHash(g) { return sha({run_id:g.run_id,stage:g.stage,plan_hash:g.plan_hash,nonce:g.nonce}); }
function attestationHash(a) { return sha({run_id:a.run_id,stage:a.stage,grant_hash:a.grant_hash,payload_hash:a.payload_hash,receipt_hash:a.receipt_hash,evidence_ids:a.evidence_ids||[],metrics:a.metrics||{},nonce:a.nonce}); }
function commitAttestationHash(a) { return sha({run_id:a.run_id,stage:a.stage,commit_hash:a.commit_hash,plan_hash:a.plan_hash,receipt_hash:a.receipt_hash,nonce:a.nonce}); }

function stateKey(runId) { return 'ogw:r3:run:'+runId; }
function redisEnv(env) {
  return {
    url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '',
    token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || ''
  };
}
export function stateStoreConfigured(env=process.env) {
  const r=redisEnv(env); return !!(r.url && r.token);
}
export function executorAttestationConfigured(env=process.env) {
  return !!(env.EXECUTOR_SHARED_SECRET && env.EXECUTOR_SHARED_SECRET.length>=24);
}

class UpstashStateStore {
  constructor(env=process.env) {
    const r=redisEnv(env); this.url=r.url.replace(/\/$/,''); this.token=r.token;
    if (!this.url || !this.token) throw new Error('STATE_STORE_NOT_CONFIGURED');
  }
  async cmd(args) {
    const res=await fetch(this.url,{method:'POST',headers:{'authorization':'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify(args)});
    let body; try { body=await res.json(); } catch { throw new Error('STATE_STORE_BAD_RESPONSE'); }
    if (!res.ok || body?.error) throw new Error('STATE_STORE_ERROR:'+String(body?.error||res.status));
    return body?.result;
  }
  async create(key,obj,ttl=STATE_TTL_SECONDS) {
    const raw=JSON.stringify(obj);
    const result=await this.cmd(['SET',key,raw,'EX',String(ttl),'NX']);
    return result==='OK';
  }
  async get(key) {
    const raw=await this.cmd(['GET',key]);
    if (raw===null || raw===undefined) return null;
    return {raw:String(raw), value:JSON.parse(String(raw))};
  }
  async cas(key,expectedRaw,nextObj,ttl=STATE_TTL_SECONDS) {
    const nextRaw=JSON.stringify(nextObj);
    const script='local cur=redis.call("GET",KEYS[1]); if not cur then return 0 end; if cur~=ARGV[1] then return -1 end; redis.call("SET",KEYS[1],ARGV[2],"EX",ARGV[3]); return 1';
    const result=await this.cmd(['EVAL',script,'1',key,expectedRaw,nextRaw,String(ttl)]);
    return Number(result);
  }
}

export class MemoryStateStore {
  constructor() { this.map=new Map(); }
  async create(key,obj) { if (this.map.has(key)) return false; this.map.set(key,JSON.stringify(obj)); return true; }
  async get(key) { const raw=this.map.get(key); return raw===undefined?null:{raw,value:JSON.parse(raw)}; }
  async cas(key,expectedRaw,nextObj) { const raw=this.map.get(key); if(raw===undefined) return 0; if(raw!==expectedRaw) return -1; this.map.set(key,JSON.stringify(nextObj)); return 1; }
}

function newRunState(run_id,policy_sha256,now=Date.now()) {
  const stage='F00', c=stageContract(stage);
  return {
    schema:'overseas-run-state-v3',rev:0,run_id,policy_sha256,stage,closed:[],committed:false,terminal:'NOT_READY',
    chain_digest:sha('GENESIS:'+run_id),context_generation:0,eval_bitmap:zeroBitmap(c.required_clause_count),
    evidence_chain:sha('EVIDENCE:'+run_id+':'+stage),pending_grant:null,pending_commit:null,
    evidence_ledger:{},metric_ledger:{},created_at:now,updated_at:now
  };
}
function nextStateForStage(s,next) {
  const c=stageContract(next);
  s.stage=next; s.eval_bitmap=zeroBitmap(c.required_clause_count); s.evidence_chain=sha('EVIDENCE:'+s.run_id+':'+next);
  s.pending_grant=null; s.pending_commit=null; return s;
}
function tokenForState(s,secret,now=Date.now()) {
  return signObject({typ:'state',v:3,run_id:s.run_id,rev:s.rev,policy_sha256:s.policy_sha256,iat:now,exp:now+TOKEN_TTL_MS},secret);
}
async function loadAuthoritativeState(token,secret,store,now=Date.now()) {
  const t=verifySignedObject(token,secret,'state',now);
  const rec=await store.get(stateKey(t.run_id));
  if (!rec) throw new Error('RUN_STATE_NOT_FOUND');
  const s=rec.value;
  if (s.run_id!==t.run_id || s.policy_sha256!==t.policy_sha256) throw new Error('RUN_STATE_BINDING_MISMATCH');
  if (s.rev!==t.rev) throw new Error('STALE_STATE_TOKEN');
  return {token:t,raw:rec.raw,state:s};
}
async function persistMutation(ctx,store,now=Date.now()) {
  ctx.state.rev += 1; ctx.state.updated_at=now;
  const r=await store.cas(stateKey(ctx.state.run_id),ctx.raw,ctx.state);
  if (r===-1) throw new Error('STATE_CONFLICT');
  if (r===0) throw new Error('RUN_STATE_NOT_FOUND');
  return ctx.state;
}
function verifiedMetricsForStage(s,stage) {
  const gates=stageContract(stage).hard_gates; const out={};
  for (const [k,spec] of Object.entries(gates)) {
    const entry=s.metric_ledger?.[stage]?.[k];
    if (!entry) throw new Error('HARD_GATE_METRIC_MISSING:'+k);
    if (!entry.attestation_hash || !entry.evidence_id || !(entry.evidence_id in (s.evidence_ledger||{}))) throw new Error('HARD_GATE_METRIC_UNATTESTED:'+k);
    if (!compare(entry.value,spec)) throw new Error('HARD_GATE_FAIL:'+k);
    out[k]=entry.value;
  }
  return out;
}
function requireEvidenceRefs(s,refs,idx) {
  if (!Array.isArray(refs)||refs.length===0) throw new Error('CLAUSE_EVIDENCE_MISSING:'+idx);
  for (const ref of refs) if (!s.evidence_ledger || !(ref in s.evidence_ledger)) throw new Error('CLAUSE_EVIDENCE_UNATTESTED:'+idx+':'+String(ref));
}
function verifyToolAttestation(token,executorSecret,g,s,receipt,now=Date.now()) {
  if (!executorSecret || executorSecret.length<24) throw new Error('EXECUTOR_SHARED_SECRET_NOT_CONFIGURED');
  const a=verifySignedObject(token,executorSecret,'tool_attestation',now);
  if (a.run_id!==s.run_id||a.stage!==s.stage||a.grant_hash!==g.grant_hash||a.payload_hash!==g.payload_hash) throw new Error('TOOL_ATTESTATION_BINDING_MISMATCH');
  if (a.receipt_hash!==sha(receipt||{})) throw new Error('TOOL_ATTESTATION_RECEIPT_MISMATCH');
  if (a.attestation_hash!==attestationHash(a)) throw new Error('TOOL_ATTESTATION_HASH_MISMATCH');
  if (!Array.isArray(a.evidence_ids)||a.evidence_ids.length<1) throw new Error('TOOL_ATTESTATION_EVIDENCE_MISSING');
  if (!['PASS','NOT_APPLICABLE'].includes(receipt?.result)) throw new Error('TOOL_RECEIPT_NOT_PASSABLE');
  return a;
}
function verifyCommitAttestation(token,executorSecret,g,s,receipt,now=Date.now()) {
  if (!executorSecret || executorSecret.length<24) throw new Error('EXECUTOR_SHARED_SECRET_NOT_CONFIGURED');
  const a=verifySignedObject(token,executorSecret,'commit_attestation',now);
  if (a.run_id!==s.run_id||a.stage!==s.stage||a.commit_hash!==g.commit_hash||a.plan_hash!==g.plan_hash) throw new Error('COMMIT_ATTESTATION_BINDING_MISMATCH');
  if (a.receipt_hash!==sha(receipt||{})) throw new Error('COMMIT_ATTESTATION_RECEIPT_MISMATCH');
  if (a.attestation_hash!==commitAttestationHash(a)) throw new Error('COMMIT_ATTESTATION_HASH_MISMATCH');
  return a;
}

export async function handleGateway(body, env=process.env, deps={}) {
  const secret=env.GATEWAY_SECRET||'';
  if (!secret || secret.length<24) throw new Error('GATEWAY_SECRET_NOT_CONFIGURED');
  const executorSecret=env.EXECUTOR_SHARED_SECRET||'';
  const now=deps.now?deps.now():Date.now();
  const store=deps.store || new UpstashStateStore(env);
  const uuid=deps.uuid || (()=>crypto.randomUUID());
  const op=body?.op;

  if (op==='boot') {
    if (!stateStoreConfigured(env) && !deps.store) throw new Error('STATE_STORE_NOT_CONFIGURED');
    if (!executorAttestationConfigured(env)) throw new Error('EXECUTOR_SHARED_SECRET_NOT_CONFIGURED');
    if (body.policy_sha256!==MANIFEST.policy_sha256) throw new Error('POLICY_HASH_MISMATCH');
    let s,created=false;
    for(let i=0;i<3&&!created;i++) { s=newRunState(uuid(),body.policy_sha256,now); created=await store.create(stateKey(s.run_id),s); }
    if(!created) throw new Error('RUN_STATE_CREATE_FAILED');
    return {ok:true,manifest:publicManifestSummary(env),state_token:tokenForState(s,secret,now)};
  }

  if (op==='inspect' || op==='ready') {
    const ctx=await loadAuthoritativeState(body.state_token,secret,store,now), s=ctx.state;
    if (op==='ready') return {ok:true,ready:s.terminal==='DONE',terminal:s.terminal,reason:s.terminal==='DONE'?'CONTROLLER_TERMINAL_DONE':'MODEL_TEXT_HAS_NO_TERMINAL_AUTHORITY'};
    const c=stageContract(s.stage), b=bitmapBuffer(s,c.required_clause_count);
    return {ok:true,state:{run_id:s.run_id,rev:s.rev,stage:s.stage,closed:s.closed,committed:s.committed,terminal:s.terminal,context_generation:s.context_generation,accepted_clause_count:bitCount(b,c.required_clause_count),required_clause_count:c.required_clause_count,pending_grant:!!s.pending_grant,pending_commit:!!s.pending_commit,evidence_count:Object.keys(s.evidence_ledger||{}).length},contract:{name:c.name,next:c.next,allowed_tools:c.allowed_tools,required_rule_unit_count:c.required_rule_unit_count,required_clause_count:c.required_clause_count,merkle_root:c.merkle_root,batch_max:c.batch_max,hard_gates:c.hard_gates}};
  }

  const ctx=await loadAuthoritativeState(body.state_token,secret,store,now), s=ctx.state;
  if (s.terminal==='DONE') throw new Error('RUN_ALREADY_DONE');

  if (op==='bump_context') {
    if (s.pending_grant || s.pending_commit) throw new Error('PENDING_AUTHORIZATION_EXISTS');
    s.context_generation+=1; await persistMutation(ctx,store,now);
    return {ok:true,state_token:tokenForState(s,secret,now)};
  }

  if (op==='grant') {
    if (s.pending_grant) throw new Error('PENDING_TOOL_GRANT_EXISTS');
    const c=stageContract(s.stage); if (!c.allowed_tools.includes(body.tool_class)) throw new Error('TOOL_CLASS_NOT_ALLOWED_IN_STAGE');
    const g={typ:'grant',v:3,run_id:s.run_id,stage:s.stage,context_generation:s.context_generation,tool_class:body.tool_class,operation:String(body.operation||''),payload_hash:sha(body.payload??null),nonce:uuid(),iat:now,exp:now+GRANT_TTL_MS};
    g.grant_hash=grantHash(g); s.pending_grant={hash:g.grant_hash,status:'ISSUED'};
    await persistMutation(ctx,store,now);
    return {ok:true,state_token:tokenForState(s,secret,now),grant_token:signObject(g,secret),grant:{stage:g.stage,tool_class:g.tool_class,operation:g.operation,payload_hash:g.payload_hash,grant_hash:g.grant_hash,expires_at:g.exp}};
  }

  if (op==='authorize') {
    const g=verifySignedObject(body.grant_token,secret,'grant',now);
    if (g.run_id!==s.run_id||g.stage!==s.stage||g.context_generation!==s.context_generation) throw new Error('GRANT_STATE_MISMATCH');
    if (!s.pending_grant||s.pending_grant.hash!==g.grant_hash||s.pending_grant.status!=='ISSUED'||g.grant_hash!==grantHash(g)) throw new Error('GRANT_NOT_CURRENT');
    if (g.payload_hash!==sha(body.payload??null)) throw new Error('REQUEST_HASH_MISMATCH');
    s.pending_grant.status='AUTHORIZED'; await persistMutation(ctx,store,now);
    return {ok:true,authorized:true,idempotency_key:g.grant_hash,route:{tool_class:g.tool_class,operation:g.operation},payload_hash:g.payload_hash,state_token:tokenForState(s,secret,now)};
  }

  if (op==='complete_tool') {
    const g=verifySignedObject(body.grant_token,secret,'grant',now);
    if (!s.pending_grant||s.pending_grant.hash!==g.grant_hash||s.pending_grant.status!=='AUTHORIZED'||g.grant_hash!==grantHash(g)) throw new Error('GRANT_NOT_CURRENT');
    const receipt=body.receipt||{};
    if (!receipt.event_ref || !['PASS','NOT_APPLICABLE'].includes(receipt.result)) throw new Error('TOOL_RECEIPT_NOT_PASSABLE');
    const a=verifyToolAttestation(body.attestation_token,executorSecret,g,s,receipt,now);
    for (const eid of a.evidence_ids) {
      if (s.evidence_ledger[eid]) throw new Error('EVIDENCE_ID_ALREADY_EXISTS:'+eid);
      s.evidence_ledger[eid]={attestation_hash:a.attestation_hash,grant_hash:g.grant_hash,receipt_hash:a.receipt_hash,stage:s.stage,tool_class:g.tool_class,operation:g.operation};
    }
    if (!s.metric_ledger[s.stage]) s.metric_ledger[s.stage]={};
    for (const [k,v] of Object.entries(a.metrics||{})) {
      const evidenceId=a.evidence_ids[0];
      s.metric_ledger[s.stage][k]={value:v,evidence_id:evidenceId,attestation_hash:a.attestation_hash};
    }
    s.chain_digest=sha(s.chain_digest+'|TOOL|'+g.grant_hash+'|'+a.attestation_hash); s.pending_grant=null;
    await persistMutation(ctx,store,now);
    return {ok:true,tool_receipt_digest:a.receipt_hash,attestation_hash:a.attestation_hash,evidence_ids:a.evidence_ids,state_token:tokenForState(s,secret,now)};
  }

  if (op==='submit_clause_batch') {
    const c=stageContract(s.stage), items=body.items;
    if (!Array.isArray(items)||items.length<1||items.length>c.batch_max) throw new Error('BAD_BATCH_SIZE');
    const bits=bitmapBuffer(s,c.required_clause_count);
    for (const item of items) {
      const leaf=item?.leaf, idx=leaf?.index;
      if (!Number.isInteger(idx)||idx<0||idx>=c.required_clause_count) throw new Error('CLAUSE_INDEX_OUT_OF_RANGE');
      if (bitIsSet(bits,idx)) throw new Error('CLAUSE_ALREADY_ACCEPTED:'+idx);
      if (!verifyMerkle(leaf,item.proof,c.merkle_root)) throw new Error('CLAUSE_MERKLE_PROOF_INVALID:'+idx);
      if (!PASSABLE.has(item.result)) throw new Error('CLAUSE_NOT_PASSABLE:'+idx+':'+String(item.result));
      requireEvidenceRefs(s,item.evidence_refs,idx);
      if (item.result==='NOT_APPLICABLE' && (!item.original_condition || !item.reason)) throw new Error('UNJUSTIFIED_CLAUSE_NOT_APPLICABLE:'+idx);
      setBit(bits,idx);
      s.evidence_chain=sha(s.evidence_chain+'|'+canonical({index:idx,leaf_hash:leafHash(leaf),result:item.result,evidence_refs:item.evidence_refs,original_condition:item.original_condition||null,reason:item.reason||null}));
    }
    s.eval_bitmap=b64u(bits); await persistMutation(ctx,store,now);
    return {ok:true,accepted:items.length,accepted_clause_count:bitCount(bits,c.required_clause_count),required_clause_count:c.required_clause_count,state_token:tokenForState(s,secret,now)};
  }

  if (op==='commit_grant') {
    if (s.stage!=='F15') throw new Error('COMMIT_ONLY_AT_F15');
    if (!s.closed.includes('F14')) throw new Error('F14_NOT_CLOSED'); if (s.pending_commit) throw new Error('PENDING_COMMIT_EXISTS');
    const g={typ:'commit',v:3,run_id:s.run_id,stage:s.stage,plan_hash:sha(body.plan??null),nonce:uuid(),iat:now,exp:now+COMMIT_TTL_MS};
    g.commit_hash=commitHash(g); s.pending_commit={hash:g.commit_hash,status:'ISSUED'};
    await persistMutation(ctx,store,now);
    return {ok:true,state_token:tokenForState(s,secret,now),commit_token:signObject(g,secret),commit:{plan_hash:g.plan_hash,commit_hash:g.commit_hash,expires_at:g.exp}};
  }

  if (op==='commit_complete') {
    const g=verifySignedObject(body.commit_token,secret,'commit',now);
    if (s.stage!=='F15'||g.run_id!==s.run_id||g.stage!==s.stage||!s.pending_commit||g.commit_hash!==s.pending_commit.hash||g.commit_hash!==commitHash(g)) throw new Error('COMMIT_GRANT_NOT_CURRENT');
    if (g.plan_hash!==sha(body.plan??null)) throw new Error('COMMIT_PLAN_HASH_MISMATCH');
    const receipt=body.receipt||{}; if (!receipt.exact_saved_byte_readback) throw new Error('COMMIT_READBACK_REQUIRED');
    const a=verifyCommitAttestation(body.attestation_token,executorSecret,g,s,receipt,now);
    s.committed=true; s.pending_commit=null; s.chain_digest=sha(s.chain_digest+'|COMMIT|'+g.commit_hash+'|'+a.attestation_hash);
    await persistMutation(ctx,store,now);
    return {ok:true,commit_receipt_digest:a.receipt_hash,attestation_hash:a.attestation_hash,state_token:tokenForState(s,secret,now)};
  }

  if (op==='close_stage') {
    const c=stageContract(s.stage), bits=bitmapBuffer(s,c.required_clause_count);
    if (s.pending_grant) throw new Error('PENDING_TOOL_GRANT_EXISTS'); if (s.pending_commit) throw new Error('PENDING_COMMIT_EXISTS');
    if (!allBitsSet(bits,c.required_clause_count)) throw new Error('CLAUSE_COVERAGE_INCOMPLETE:'+bitCount(bits,c.required_clause_count)+'/'+c.required_clause_count);
    if (s.stage==='F15'&&!s.committed) throw new Error('F15_COMMIT_REQUIRED');
    if (s.stage==='F18') {
      const expected=Array.from({length:18},(_,i)=>'F'+String(i).padStart(2,'0'));
      if (canonical(s.closed)!==canonical(expected)) throw new Error('ALL_PRIOR_STAGES_NOT_CLOSED');
    }
    const metrics=verifiedMetricsForStage(s,s.stage);
    const current=s.stage, stage_digest=sha({stage:current,merkle_root:c.merkle_root,evidence_chain:s.evidence_chain,metrics,chain_before:s.chain_digest});
    s.closed=[...s.closed,current]; s.chain_digest=sha(s.chain_digest+'|STAGE|'+current+'|'+stage_digest);
    if (current==='F18') { s.terminal='DONE'; s.eval_bitmap=''; }
    else nextStateForStage(s,c.next);
    await persistMutation(ctx,store,now);
    return {ok:true,closed_stage:current,next_stage:s.stage,terminal:s.terminal,stage_digest,chain_digest:s.chain_digest,verified_metrics:metrics,state_token:tokenForState(s,secret,now)};
  }

  throw new Error('UNKNOWN_OPERATION');
}

export function makeToolAttestation(fields, executorSecret, now=Date.now()) {
  const a={typ:'tool_attestation',v:1,...fields,nonce:fields.nonce||crypto.randomUUID(),iat:fields.iat||now,exp:fields.exp||now+GRANT_TTL_MS};
  a.attestation_hash=attestationHash(a); return signObject(a,executorSecret);
}
export function makeCommitAttestation(fields, executorSecret, now=Date.now()) {
  const a={typ:'commit_attestation',v:1,...fields,nonce:fields.nonce||crypto.randomUUID(),iat:fields.iat||now,exp:fields.exp||now+COMMIT_TTL_MS};
  a.attestation_hash=commitAttestationHash(a); return signObject(a,executorSecret);
}
export function publicManifestSummary(env=process.env) {
  return {schema:'overseas-gateway-authoritative-r3',policy_version:MANIFEST.policy_version,policy_sha256:MANIFEST.policy_sha256,catalog_sha256:MANIFEST.catalog_sha256,stage_count:MANIFEST.stage_count,state_store_configured:stateStoreConfigured(env),executor_attestation_configured:executorAttestationConfigured(env),execution_authority:'CANDIDATE_FAIL_CLOSED'};
}
export const __test={canonical,sha,leafHash,verifyMerkle,parentHash,zeroBitmap,bitCount,signObject,verifySignedObject,attestationHash,commitAttestationHash,stateKey,newRunState,tokenForState};
