import crypto from 'node:crypto';
import fs from 'node:fs';

const MANIFEST = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const PASSABLE = new Set(['PASS','NOT_APPLICABLE']);
const VALID_RESULTS = new Set(['PASS','NOT_APPLICABLE','FAIL','REPAIR_REQUIRED','PENDING','MISSING']);

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64u(s) { return Buffer.from(s, 'base64url'); }
function sha256(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
}
function signObject(obj, secret) {
  const payload = b64u(Buffer.from(JSON.stringify(obj)));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(token, secret, typ) {
  if (!token || typeof token !== 'string' || !token.includes('.')) throw new Error('BAD_TOKEN');
  const [p,s] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  const a = Buffer.from(s); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) throw new Error('BAD_SIGNATURE');
  const obj = JSON.parse(unb64u(p).toString('utf8'));
  if (obj.typ !== typ) throw new Error('BAD_TOKEN_TYPE');
  if (obj.exp && Date.now() > obj.exp) throw new Error('TOKEN_EXPIRED');
  return obj;
}
function compare(actual, spec) {
  if (spec === true) return actual === true;
  if (Array.isArray(spec)) {
    const [op,a,b] = spec;
    if (op === '==') return actual === a;
    if (op === '>=') return typeof actual === 'number' && actual >= a;
    if (op === '<=') return typeof actual === 'number' && actual <= a;
    if (op === 'range') return typeof actual === 'number' && actual >= a && actual <= b;
  }
  return actual === spec;
}
function stageContract(stage) {
  const c = MANIFEST.stages[stage];
  if (!c) throw new Error('UNKNOWN_STAGE');
  return c;
}
function compactState(s) {
  return {
    typ:'state', v:1, run_id:s.run_id, policy_sha256:s.policy_sha256,
    stage:s.stage, closed:s.closed, committed:!!s.committed, terminal:s.terminal || 'NOT_READY',
    chain_digest:s.chain_digest || sha256('GENESIS:'+s.run_id), context_generation:s.context_generation || 0,
    iat:Date.now(), exp:Date.now()+24*60*60*1000
  };
}
function verifyOutcomes(stage, rows) {
  const c = stageContract(stage);
  if (!Array.isArray(rows) || rows.length !== c.required_rule_unit_count) throw new Error('RULE_OUTCOME_COVERAGE_INCOMPLETE');
  const seenUnits = new Set();
  let clauseCount = 0;
  const projection = [];
  for (const r of rows) {
    if (!r?.unit_id || !r?.source_sha256 || seenUnits.has(r.unit_id)) throw new Error('FOREIGN_OR_DUPLICATE_RULE_UNIT');
    seenUnits.add(r.unit_id);
    if (!Array.isArray(r.clauses)) throw new Error('CLAUSE_OUTCOME_COVERAGE_INCOMPLETE');
    const seenClauses = new Set();
    const clauseIds = [];
    for (const cl of r.clauses) {
      if (!cl?.clause_id || seenClauses.has(cl.clause_id)) throw new Error('DUPLICATE_OR_MISSING_CLAUSE_ID');
      seenClauses.add(cl.clause_id); clauseIds.push(cl.clause_id); clauseCount += 1;
      if (!VALID_RESULTS.has(cl.result)) throw new Error('INVALID_CLAUSE_RESULT');
      if (!Array.isArray(cl.evidence_refs) || cl.evidence_refs.length === 0) throw new Error('CLAUSE_EVIDENCE_MISSING');
      if (cl.result === 'NOT_APPLICABLE' && (!cl.original_condition || !cl.reason)) throw new Error('UNJUSTIFIED_CLAUSE_NOT_APPLICABLE');
      if (!PASSABLE.has(cl.result)) throw new Error('RULE_OUTCOME_NOT_PASSABLE:'+r.unit_id+':'+cl.clause_id+':'+cl.result);
    }
    projection.push({unit_id:r.unit_id,source_sha256:r.source_sha256,clause_ids:clauseIds.sort()});
  }
  if (clauseCount !== c.required_clause_count) throw new Error('CLAUSE_OUTCOME_COVERAGE_INCOMPLETE');
  projection.sort((a,b)=>a.unit_id.localeCompare(b.unit_id));
  if (sha256(projection) !== c.contract_digest) throw new Error('STAGE_CONTRACT_DIGEST_MISMATCH');
  return true;
}
function verifyMetrics(stage, metrics) {
  const gates = stageContract(stage).hard_gates;
  for (const [k,spec] of Object.entries(gates)) {
    if (!(k in (metrics||{}))) throw new Error('HARD_GATE_METRIC_MISSING:'+k);
    if (!compare(metrics[k],spec)) throw new Error('HARD_GATE_FAIL:'+k);
  }
  return true;
}

export function handleGateway(body, secret) {
  if (!secret || secret.length < 24) throw new Error('GATEWAY_SECRET_NOT_CONFIGURED');
  const op = body?.op;
  if (op === 'boot') {
    if (body.policy_sha256 !== MANIFEST.policy_sha256) throw new Error('POLICY_HASH_MISMATCH');
    const run_id = crypto.randomUUID();
    const state = compactState({run_id,policy_sha256:body.policy_sha256,stage:'F00',closed:[],committed:false,terminal:'NOT_READY',context_generation:0});
    return {ok:true, manifest:{policy_version:MANIFEST.policy_version,policy_sha256:MANIFEST.policy_sha256,catalog_sha256:MANIFEST.catalog_sha256,stage_count:MANIFEST.stage_count}, state_token:signObject(state,secret)};
  }
  if (op === 'inspect') {
    const s = verifyToken(body.state_token, secret, 'state');
    const c = stageContract(s.stage);
    return {ok:true,state:{run_id:s.run_id,stage:s.stage,closed:s.closed,committed:s.committed,terminal:s.terminal,context_generation:s.context_generation},contract:{name:c.name,next:c.next,allowed_tools:c.allowed_tools,required_rule_unit_count:c.required_rule_unit_count,required_clause_count:c.required_clause_count,contract_digest:c.contract_digest,hard_gates:c.hard_gates}};
  }
  if (op === 'bump_context') {
    const s = verifyToken(body.state_token, secret, 'state');
    s.context_generation += 1; s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,state_token:signObject(s,secret)};
  }
  if (op === 'grant') {
    const s = verifyToken(body.state_token, secret, 'state');
    if (s.terminal === 'DONE') throw new Error('RUN_ALREADY_DONE');
    const c = stageContract(s.stage);
    if (!c.allowed_tools.includes(body.tool_class)) throw new Error('TOOL_CLASS_NOT_ALLOWED_IN_STAGE');
    const payload_hash = sha256(body.payload ?? null);
    const grant = {typ:'grant',v:1,run_id:s.run_id,stage:s.stage,context_generation:s.context_generation,tool_class:body.tool_class,operation:String(body.operation||''),payload_hash,nonce:crypto.randomUUID(),iat:Date.now(),exp:Date.now()+5*60*1000};
    return {ok:true,grant_token:signObject(grant,secret),grant:{run_id:grant.run_id,stage:grant.stage,tool_class:grant.tool_class,operation:grant.operation,payload_hash:grant.payload_hash,expires_at:grant.exp}};
  }
  if (op === 'authorize') {
    const g = verifyToken(body.grant_token, secret, 'grant');
    const s = verifyToken(body.state_token, secret, 'state');
    if (g.run_id!==s.run_id || g.stage!==s.stage || g.context_generation!==s.context_generation) throw new Error('GRANT_STATE_MISMATCH');
    if (g.payload_hash !== sha256(body.payload ?? null)) throw new Error('REQUEST_HASH_MISMATCH');
    return {ok:true,authorized:true,route:{tool_class:g.tool_class,operation:g.operation},payload_hash:g.payload_hash};
  }
  if (op === 'commit') {
    const s = verifyToken(body.state_token, secret, 'state');
    if (s.stage !== 'F15') throw new Error('COMMIT_ONLY_AT_F15');
    if (!s.closed.includes('F14')) throw new Error('F14_NOT_CLOSED');
    if (!body.receipt?.exact_saved_byte_readback) throw new Error('COMMIT_READBACK_REQUIRED');
    s.committed=true; s.chain_digest=sha256(s.chain_digest+'|COMMIT|'+sha256(body.receipt)); s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,state_token:signObject(s,secret),commit_receipt:{run_id:s.run_id,stage:s.stage,accepted:true,receipt_digest:sha256(body.receipt)}};
  }
  if (op === 'close_stage') {
    const s = verifyToken(body.state_token, secret, 'state');
    const current = s.stage;
    if (current==='F15' && !s.committed) throw new Error('F15_COMMIT_REQUIRED');
    verifyOutcomes(current, body.rule_outcomes);
    verifyMetrics(current, body.metrics);
    const stage_digest = sha256({stage:current,rule_outcomes:body.rule_outcomes,metrics:body.metrics});
    s.closed=[...s.closed,current];
    s.chain_digest=sha256(s.chain_digest+'|'+current+'|'+stage_digest);
    if (current==='F18') { s.terminal='DONE'; }
    else { s.stage=stageContract(current).next; }
    s.iat=Date.now(); s.exp=Date.now()+24*60*60*1000;
    return {ok:true,closed_stage:current,next_stage:s.stage,terminal:s.terminal,stage_digest,chain_digest:s.chain_digest,state_token:signObject(s,secret)};
  }
  if (op === 'ready') {
    const s = verifyToken(body.state_token, secret, 'state');
    return {ok:true,ready:s.terminal==='DONE',terminal:s.terminal,reason:s.terminal==='DONE'?'CONTROLLER_TERMINAL_DONE':'MODEL_TEXT_HAS_NO_TERMINAL_AUTHORITY'};
  }
  throw new Error('UNKNOWN_OPERATION');
}

export function publicManifestSummary() {
  return {schema:MANIFEST.schema,policy_version:MANIFEST.policy_version,policy_sha256:MANIFEST.policy_sha256,catalog_sha256:MANIFEST.catalog_sha256,stage_count:MANIFEST.stage_count};
}