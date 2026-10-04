import crypto from 'node:crypto';
import fs from 'node:fs';

const MANIFEST = JSON.parse(fs.readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
const PASSABLE = new Set(['PASS','NOT_APPLICABLE']);

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
function verifyToken(token, secret, typ) {
  if (!token || typeof token !== 'string' || !token.includes('.')) throw new Error('BAD_TOKEN');
  const [p,s]=token.split('.');
  const expected=crypto.createHmac('sha256',secret).update(p).digest('base64url');
  const a=Buffer.from(s), b=Buffer.from(expected);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('BAD_SIGNATURE');
  const obj=JSON.parse(unb64u(p).toString('utf8'));
  if (obj.typ!==typ) throw new Error('BAD_TOKEN_TYPE');
  if (obj.exp && Date.now()>obj.exp) throw new Error('TOKEN_EXPIRED');
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
function compactState(s) {
  const c=stageContract(s.stage);
  return {
    typ:'state',v:2,run_id:s.run_id,policy_sha256:s.policy_sha256,stage:s.stage,closed:s.closed||[],
    committed:!!s.committed,terminal:s.terminal||'NOT_READY',chain_digest:s.chain_digest||sha('GENESIS:'+s.run_id),
    context_generation:s.context_generation||0,eval_bitmap:s.eval_bitmap||zeroBitmap(c.required_clause_count),
    evidence_chain:s.evidence_chain||sha('EVIDENCE:'+s.run_id+':'+s.stage),
    pending_grant:s.pending_grant||null,pending_commit:s.pending_commit||null,
    iat:Date.now(),exp:Date.now()+24*60*60*1000
  };
}
function nextStateForStage(s,next) {
  const c=stageContract(next);
  s.stage=next; s.eval_bitmap=zeroBitmap(c.required_clause_count); s.evidence_chain=sha('EVIDENCE:'+s.run_id+':'+next);
  s.pending_grant=null; s.pending_commit=null; return s;
}
function verifyMetrics(stage,metrics) {
  const gates=stageContract(stage).hard_gates;
  for (const [k,spec] of Object.entries(gates)) {
    if (!(k in (metrics||{}))) throw new Error('HARD_GATE_METRIC_MISSING:'+k);
    if (!compare(metrics[k],spec)) throw new Error('HARD_GATE_FAIL:'+k);
  }
}
function grantHash(g) { return sha({run_id:g.run_id,stage:g.stage,context_generation:g.context_generation,tool_class:g.tool_class,operation:g.operation,payload_hash:g.payload_hash,nonce:g.nonce}); }
function commitHash(g) { return sha({run_id:g.run_id,stage:g.stage,plan_hash:g.plan_hash,nonce:g.nonce}); }

export function handleGateway(body,secret) {
  if (!secret || secret.length<24) throw new Error('GATEWAY_SECRET_NOT_CONFIGURED');
  const op=body?.op;
  if (op==='boot') {
    if (body.policy_sha256!==MANIFEST.policy_sha256) throw new Error('POLICY_HASH_MISMATCH');
    const run_id=crypto.randomUUID();
    const s=compactState({run_id,policy_sha256:body.policy_sha256,stage:'F00',closed:[],committed:false,terminal:'NOT_READY',context_generation:0});
    return {ok:true,manifest:publicManifestSummary(),state_token:signObject(s,secret)};
  }
  if (op==='inspect') {
    const s=verifyToken(body.state_token,secret,'state'); const c=stageContract(s.stage); const b=bitmapBuffer(s,c.required_clause_count);
    return {ok:true,state:{run_id:s.run_id,stage:s.stage,closed:s.closed,committed:s.committed,terminal:s.terminal,context_generation:s.context_generation,accepted_clause_count:bitCount(b,c.required_clause_count),required_clause_count:c.required_clause_count,pending_grant:!!s.pending_grant,pending_commit:!!s.pending_commit},contract:{name:c.name,next:c.next,allowed_tools:c.allowed_tools,required_rule_unit_count:c.required_rule_unit_count,required_clause_count:c.required_clause_count,merkle_root:c.merkle_root,batch_max:c.batch_max,hard_gates:c.hard_gates}};
  }
  if (op==='bump_context') {
    const s=verifyToken(body.state_token,secret,'state');
    if (s.pending_grant || s.pending_commit) throw new Error('PENDING_AUTHORIZATION_EXISTS');
    s.context_generation+=1; s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,state_token:signObject(s,secret)};
  }
  if (op==='submit_clause_batch') {
    const s=verifyToken(body.state_token,secret,'state'); const c=stageContract(s.stage);
    const items=body.items; if (!Array.isArray(items)||items.length<1||items.length>c.batch_max) throw new Error('BAD_BATCH_SIZE');
    const bits=bitmapBuffer(s,c.required_clause_count);
    for (const item of items) {
      const leaf=item?.leaf; const idx=leaf?.index;
      if (!Number.isInteger(idx)||idx<0||idx>=c.required_clause_count) throw new Error('CLAUSE_INDEX_OUT_OF_RANGE');
      if (bitIsSet(bits,idx)) throw new Error('CLAUSE_ALREADY_ACCEPTED:'+idx);
      if (!verifyMerkle(leaf,item.proof,c.merkle_root)) throw new Error('CLAUSE_MERKLE_PROOF_INVALID:'+idx);
      if (!PASSABLE.has(item.result)) throw new Error('CLAUSE_NOT_PASSABLE:'+idx+':'+String(item.result));
      if (!Array.isArray(item.evidence_refs)||item.evidence_refs.length===0) throw new Error('CLAUSE_EVIDENCE_MISSING:'+idx);
      if (item.result==='NOT_APPLICABLE' && (!item.original_condition || !item.reason)) throw new Error('UNJUSTIFIED_CLAUSE_NOT_APPLICABLE:'+idx);
      setBit(bits,idx);
      s.evidence_chain=sha(s.evidence_chain+'|'+canonical({index:idx,leaf_hash:leafHash(leaf),result:item.result,evidence_refs:item.evidence_refs,original_condition:item.original_condition||null,reason:item.reason||null}));
    }
    s.eval_bitmap=b64u(bits); s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,accepted:items.length,accepted_clause_count:bitCount(bits,c.required_clause_count),required_clause_count:c.required_clause_count,state_token:signObject(s,secret)};
  }
  if (op==='grant') {
    const s=verifyToken(body.state_token,secret,'state'); if (s.terminal==='DONE') throw new Error('RUN_ALREADY_DONE');
    if (s.pending_grant) throw new Error('PENDING_TOOL_GRANT_EXISTS');
    const c=stageContract(s.stage); if (!c.allowed_tools.includes(body.tool_class)) throw new Error('TOOL_CLASS_NOT_ALLOWED_IN_STAGE');
    const g={typ:'grant',v:2,run_id:s.run_id,stage:s.stage,context_generation:s.context_generation,tool_class:body.tool_class,operation:String(body.operation||''),payload_hash:sha(body.payload??null),nonce:crypto.randomUUID(),iat:Date.now(),exp:Date.now()+5*60*1000};
    g.grant_hash=grantHash(g); s.pending_grant=g.grant_hash; s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,state_token:signObject(s,secret),grant_token:signObject(g,secret),grant:{stage:g.stage,tool_class:g.tool_class,operation:g.operation,payload_hash:g.payload_hash,grant_hash:g.grant_hash,expires_at:g.exp}};
  }
  if (op==='authorize') {
    const s=verifyToken(body.state_token,secret,'state'), g=verifyToken(body.grant_token,secret,'grant');
    if (g.run_id!==s.run_id||g.stage!==s.stage||g.context_generation!==s.context_generation) throw new Error('GRANT_STATE_MISMATCH');
    if (g.grant_hash!==s.pending_grant||g.grant_hash!==grantHash(g)) throw new Error('GRANT_NOT_CURRENT');
    if (g.payload_hash!==sha(body.payload??null)) throw new Error('REQUEST_HASH_MISMATCH');
    return {ok:true,authorized:true,idempotency_key:g.grant_hash,route:{tool_class:g.tool_class,operation:g.operation},payload_hash:g.payload_hash};
  }
  if (op==='complete_tool') {
    const s=verifyToken(body.state_token,secret,'state'), g=verifyToken(body.grant_token,secret,'grant');
    if (g.grant_hash!==s.pending_grant||g.grant_hash!==grantHash(g)) throw new Error('GRANT_NOT_CURRENT');
    const r=body.receipt||{};
    if (!r.event_ref || !['PASS','NOT_APPLICABLE'].includes(r.result)) throw new Error('TOOL_RECEIPT_NOT_PASSABLE');
    s.chain_digest=sha(s.chain_digest+'|TOOL|'+g.grant_hash+'|'+sha(r)); s.pending_grant=null; s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,tool_receipt_digest:sha(r),state_token:signObject(s,secret)};
  }
  if (op==='commit_grant') {
    const s=verifyToken(body.state_token,secret,'state'); if (s.stage!=='F15') throw new Error('COMMIT_ONLY_AT_F15');
    if (!s.closed.includes('F14')) throw new Error('F14_NOT_CLOSED'); if (s.pending_commit) throw new Error('PENDING_COMMIT_EXISTS');
    const g={typ:'commit',v:2,run_id:s.run_id,stage:s.stage,plan_hash:sha(body.plan??null),nonce:crypto.randomUUID(),iat:Date.now(),exp:Date.now()+10*60*1000};
    g.commit_hash=commitHash(g); s.pending_commit=g.commit_hash; s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,state_token:signObject(s,secret),commit_token:signObject(g,secret),commit:{plan_hash:g.plan_hash,commit_hash:g.commit_hash,expires_at:g.exp}};
  }
  if (op==='commit_complete') {
    const s=verifyToken(body.state_token,secret,'state'), g=verifyToken(body.commit_token,secret,'commit');
    if (s.stage!=='F15'||g.run_id!==s.run_id||g.stage!==s.stage||g.commit_hash!==s.pending_commit||g.commit_hash!==commitHash(g)) throw new Error('COMMIT_GRANT_NOT_CURRENT');
    if (g.plan_hash!==sha(body.plan??null)) throw new Error('COMMIT_PLAN_HASH_MISMATCH');
    const r=body.receipt||{}; if (!r.exact_saved_byte_readback) throw new Error('COMMIT_READBACK_REQUIRED');
    s.committed=true; s.pending_commit=null; s.chain_digest=sha(s.chain_digest+'|COMMIT|'+g.commit_hash+'|'+sha(r)); s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,commit_receipt_digest:sha(r),state_token:signObject(s,secret)};
  }
  if (op==='close_stage') {
    const s=verifyToken(body.state_token,secret,'state'); const c=stageContract(s.stage); const bits=bitmapBuffer(s,c.required_clause_count);
    if (s.pending_grant) throw new Error('PENDING_TOOL_GRANT_EXISTS'); if (s.pending_commit) throw new Error('PENDING_COMMIT_EXISTS');
    if (!allBitsSet(bits,c.required_clause_count)) throw new Error('CLAUSE_COVERAGE_INCOMPLETE:'+bitCount(bits,c.required_clause_count)+'/'+c.required_clause_count);
    if (s.stage==='F15'&&!s.committed) throw new Error('F15_COMMIT_REQUIRED');
    if (s.stage==='F18') {
      const expected=Array.from({length:18},(_,i)=>'F'+String(i).padStart(2,'0'));
      if (canonical(s.closed)!==canonical(expected)) throw new Error('ALL_PRIOR_STAGES_NOT_CLOSED');
    }
    verifyMetrics(s.stage,body.metrics||{});
    const current=s.stage; const stage_digest=sha({stage:current,merkle_root:c.merkle_root,evidence_chain:s.evidence_chain,metrics:body.metrics||{},chain_before:s.chain_digest});
    s.closed=[...s.closed,current]; s.chain_digest=sha(s.chain_digest+'|STAGE|'+current+'|'+stage_digest);
    if (current==='F18') { s.terminal='DONE'; s.eval_bitmap=''; }
    else nextStateForStage(s,c.next);
    s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,closed_stage:current,next_stage:s.stage,terminal:s.terminal,stage_digest,chain_digest:s.chain_digest,state_token:signObject(s,secret)};
  }
  if (op==='ready') {
    const s=verifyToken(body.state_token,secret,'state'); return {ok:true,ready:s.terminal==='DONE',terminal:s.terminal,reason:s.terminal==='DONE'?'CONTROLLER_TERMINAL_DONE':'MODEL_TEXT_HAS_NO_TERMINAL_AUTHORITY'};
  }
  throw new Error('UNKNOWN_OPERATION');
}

export function publicManifestSummary() {
  return {schema:MANIFEST.schema,policy_version:MANIFEST.policy_version,policy_sha256:MANIFEST.policy_sha256,catalog_sha256:MANIFEST.catalog_sha256,stage_count:MANIFEST.stage_count};
}
export const __test={canonical,sha,leafHash,verifyMerkle,parentHash,zeroBitmap,bitCount};
