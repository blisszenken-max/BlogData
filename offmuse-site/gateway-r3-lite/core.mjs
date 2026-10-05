import crypto from 'node:crypto';
import fs from 'node:fs';

const MANIFEST = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const STATE_TTL_SECONDS = 24 * 60 * 60;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
}
function sha(v) { return crypto.createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex'); }
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64u(s) { return Buffer.from(s,'base64url'); }
function sign(obj, secret) {
  const p=b64u(Buffer.from(JSON.stringify(obj)));
  const sig=crypto.createHmac('sha256',secret).update(p).digest('base64url');
  return p+'.'+sig;
}
function verify(token,secret,typ,now=Date.now()) {
  if(!token||typeof token!=='string'||!token.includes('.')) throw new Error('BAD_TOKEN');
  const [p,s]=token.split('.');
  const e=crypto.createHmac('sha256',secret).update(p).digest('base64url');
  const a=Buffer.from(s),b=Buffer.from(e);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) throw new Error('BAD_SIGNATURE');
  const o=JSON.parse(unb64u(p).toString('utf8'));
  if(o.typ!==typ) throw new Error('BAD_TOKEN_TYPE');
  if(o.exp&&now>o.exp) throw new Error('TOKEN_EXPIRED');
  return o;
}
function compare(actual,spec){
  if(spec===true) return actual===true;
  if(Array.isArray(spec)){
    const [op,a,b]=spec;
    if(op==='==') return actual===a;
    if(op==='>=') return typeof actual==='number'&&actual>=a;
    if(op==='<=') return typeof actual==='number'&&actual<=a;
    if(op==='range') return typeof actual==='number'&&actual>=a&&actual<=b;
  }
  return actual===spec;
}
function pct(ok,total){ return total>0 && ok===total ? '100%' : `${total?Math.round(ok*100/total):0}%`; }
function stageContract(stage){ const c=MANIFEST.stages[stage]; if(!c) throw new Error('UNKNOWN_STAGE:'+stage); return c; }
function phaseStages(phase){ const v=MANIFEST.phases?.[phase]; if(!Array.isArray(v)||v.length<1) throw new Error('UNKNOWN_PHASE:'+phase); return v; }
function redisEnv(env){ return {url:(env.UPSTASH_REDIS_REST_URL||env.KV_REST_API_URL||'').replace(/\/$/,''),token:env.UPSTASH_REDIS_REST_TOKEN||env.KV_REST_API_TOKEN||''}; }
export function stateStoreConfigured(env=process.env){ const r=redisEnv(env); return !!(r.url&&r.token); }

class UpstashStateStore{
  constructor(env=process.env){ const r=redisEnv(env); this.url=r.url; this.token=r.token; if(!this.url||!this.token) throw new Error('STATE_STORE_NOT_CONFIGURED'); }
  async cmd(args){ const res=await fetch(this.url,{method:'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify(args)}); let body; try{body=await res.json();}catch{throw new Error('STATE_STORE_BAD_RESPONSE');} if(!res.ok||body?.error) throw new Error('STATE_STORE_ERROR:'+String(body?.error||res.status)); return body?.result; }
  async create(key,obj,ttl=STATE_TTL_SECONDS){ return (await this.cmd(['SET',key,JSON.stringify(obj),'EX',String(ttl),'NX']))==='OK'; }
  async get(key){ const raw=await this.cmd(['GET',key]); return raw==null?null:{raw:String(raw),value:JSON.parse(String(raw))}; }
  async cas(key,expectedRaw,nextObj,ttl=STATE_TTL_SECONDS){ const script='local cur=redis.call("GET",KEYS[1]); if not cur then return 0 end; if cur~=ARGV[1] then return -1 end; redis.call("SET",KEYS[1],ARGV[2],"EX",ARGV[3]); return 1'; return Number(await this.cmd(['EVAL',script,'1',key,expectedRaw,JSON.stringify(nextObj),String(ttl)])); }
}
export class MemoryStateStore{
  constructor(){this.map=new Map();}
  async create(k,o){if(this.map.has(k))return false;this.map.set(k,JSON.stringify(o));return true;}
  async get(k){const raw=this.map.get(k);return raw===undefined?null:{raw,value:JSON.parse(raw)};}
  async cas(k,e,n){const raw=this.map.get(k);if(raw===undefined)return 0;if(raw!==e)return -1;this.map.set(k,JSON.stringify(n));return 1;}
}
function stateKey(runId){return 'ogw:r3lite:run:'+runId;}
function newState(runId,policy,now){return {schema:'overseas-run-state-r3-lite-phase',rev:0,run_id:runId,policy_sha256:policy,phase:MANIFEST.phase_order[0],closed:[],terminal:'NOT_READY',chain_digest:sha('GENESIS:'+runId),created_at:now,updated_at:now};}
function tokenFor(s,secret,now){return sign({typ:'state',v:'r3-lite-phase',run_id:s.run_id,rev:s.rev,policy_sha256:s.policy_sha256,iat:now,exp:now+TOKEN_TTL_MS},secret);}
async function loadState(token,secret,store,now){const t=verify(token,secret,'state',now);const rec=await store.get(stateKey(t.run_id));if(!rec)throw new Error('RUN_STATE_NOT_FOUND');const s=rec.value;if(s.run_id!==t.run_id||s.policy_sha256!==t.policy_sha256)throw new Error('RUN_STATE_BINDING_MISMATCH');if(s.rev!==t.rev)throw new Error('STALE_STATE_TOKEN');return {raw:rec.raw,state:s};}
async function persist(ctx,store,now){ctx.state.rev+=1;ctx.state.updated_at=now;const r=await store.cas(stateKey(ctx.state.run_id),ctx.raw,ctx.state);if(r===-1)throw new Error('STATE_CONFLICT');if(r===0)throw new Error('RUN_STATE_NOT_FOUND');}
const arr=v=>Array.isArray(v)?v:[];
const truth=v=>v===true;
function deriveMetrics(stage,p,s){
  switch(stage){
    case 'F00': return {policy_identity_pass:p.policy_sha256===MANIFEST.policy_sha256,version_coherence_pass:p.policy_version===MANIFEST.policy_version,catalog_exact:p.catalog_sha256===MANIFEST.catalog_sha256,policy_revision_exact:p.policy_revision_id===MANIFEST.policy_drive_revision_id};
    case 'F01': return {execution_contract_locked:truth(p.execution_contract_locked)};
    case 'F02': return {topic_lock:truth(p.topic?.locked),trend_persistence:truth(p.topic?.trend_persistence),event_independent:truth(p.topic?.event_independent)};
    case 'F03': {const claims=arr(p.claims);return {verified_material_claim_count:claims.filter(x=>x?.supported===true).length,trend_evidence_source_count:arr(p.trend_sources).length,trend_anchor_source_count:arr(p.trend_anchors).length,unsupported_major_claim_count:claims.filter(x=>x?.major!==false&&x?.supported!==true).length,benchmark_eligible_count:arr(p.benchmarks).filter(x=>x?.eligible!==false).length};}
    case 'F04': {const rs=arr(p.reader_situations),qs=arr(p.question_sensors),mq=arr(p.material_questions);const qse=qs.filter(x=>arr(x?.evidence_refs).length>0).length;const bound=mq.filter(x=>x?.interest_id).length;return {reader_situation_lock_coverage:`${Math.min(rs.length,7)}/7`,question_sensor_evaluated_count:qs.length,question_sensor_evidence_coverage:`${qse}/6`,core_reader_interest_count:arr(p.interests).length,material_question_to_interest_binding_coverage:pct(bound,mq.length)};}
    case 'F05': {const t=arr(p.titles);return {title_hook_candidate_count:t.length,title_hook_distinct_frame_count:new Set(t.map(x=>x?.frame).filter(Boolean)).size,title_hook_selected_count:t.filter(x=>x?.selected===true).length,selected_title_score:Number(t.find(x=>x?.selected===true)?.score??-1),article_blueprint_locked:truth(p.blueprint?.locked)};}
    case 'F06': return {written_draft_set_exists:arr(p.drafts).length>0};
    case 'F07': return {architecture_candidate_count:arr(p.architectures).length,valid_full_draft_count:arr(p.valid_full_drafts).length,blind_reader_gap_challenge_pass:truth(p.blind_reader?.pass),material_post_article_search_query_count:arr(p.residual_search_queries).length,residual_material_question_count:arr(p.residual_material_questions).length,blind_known_interest_answer_gap_count:Number(p.blind_reader?.known_interest_gaps??999),blind_new_material_gap_count:Number(p.blind_reader?.new_material_gaps??999)};
    case 'F08': {const v=arr(p.visual_targets);return {visual_target_set_locked:truth(p.locked),visual_target_content_contract_coverage:pct(v.filter(x=>x?.contract_locked===true).length,v.length),missing_must_show_count:v.filter(x=>x?.must_show_missing===true).length};}
    case 'F09': {const v=arr(p.photo_targets);return {required_photo_source_stage_not_executed_count:v.filter(x=>x?.source_stage_executed!==true).length,real_photo_target_not_searched_count:v.filter(x=>x?.searched!==true).length};}
    case 'F10': {const v=arr(p.generated_assets);return {unauthorized_generation_count:v.filter(x=>x?.authorized!==true).length,paid_image_plugin_call_count:v.filter(x=>x?.paid_plugin===true).length};}
    case 'F11': {const v=arr(p.visuals);return {unresolved_visual_target_count:v.filter(x=>x?.resolved!==true).length,plain_background_infographic_count:v.filter(x=>x?.plain_background===true).length,card_only_infographic_count:v.filter(x=>x?.card_only===true).length,chart_only_infographic_count:v.filter(x=>x?.chart_only===true).length,background_unverified_or_decorative_pass_count:v.filter(x=>x?.background_verified!==true||x?.decorative_pass===true).length,visual_text_readability_fail_count:v.filter(x=>x?.text_readable!==true).length};}
    case 'F12': {const rows=arr(p.scorecard);const score=rows.reduce((a,x)=>a+Number(x?.score||0),0);return {qa_scorecard_row_count:rows.length,score_dimension_without_evidence:rows.filter(x=>arr(x?.evidence_refs).length<1).length,qa_scorecard_row_without_measured_counter_count:rows.filter(x=>x?.measured_counter===undefined||x?.measured_counter===null).length,quality_score_direct_model_assignment_count:rows.filter(x=>x?.model_assigned_score===true).length,final_qa_score:score,hard_fail_count:Number(p.hard_fail_count??999)};}
    case 'F13': {const d=arr(p.docs);return {final_docx_count:d.filter(x=>x?.docx===true).length,structural_readback_doc_count:d.filter(x=>x?.structural_readback===true).length};}
    case 'F14': {const d=arr(p.docs);const coverage=d.length&&d.every(x=>Number(x?.page_coverage)===1)?'100%':`${d.length?Math.round(d.reduce((a,x)=>a+Number(x?.page_coverage||0),0)*100/d.length):0}%`;return {final_bytes_measured_doc_count:d.filter(x=>x?.final_bytes_measured===true).length,render_doc_count:d.filter(x=>x?.rendered===true).length,full_render_page_coverage:coverage,f14_final_bytes_hard_fail_count:d.filter(x=>x?.hard_fail===true).length,pending_semantic_qa_count:d.filter(x=>x?.pending_semantic_qa===true).length,pending_render_qa_count:d.filter(x=>x?.pending_render_qa===true).length};}
    case 'F15': {const d=arr(p.saved_docs);return {saved_docx_count:d.filter(x=>x?.saved===true).length,saved_bytes_mismatch_count:d.filter(x=>x?.bytes_match!==true).length,commit_receipt_count:p.commit_receipt?1:0};}
    case 'F16': {
      const h=p.handoff||{}, docs=(h.final_docs&&typeof h.final_docs==='object'&&!Array.isArray(h.final_docs))?h.final_docs:{};
      const named=['naver','tistory','google_wp'];
      const naver=docs.naver||{};
      const allowedRoles=new Set(['ACTUAL_PHOTO','DIGITAL_REALISTIC','INFO_ACTUAL_PHOTO','INFO_DIGITAL_REALISTIC','INFO_EXPLAINER','INFO_HOOK']);
      const visuals=arr(h.visuals);
      return {
        handoff_schema:h.schema,
        handoff_status:h.status,
        handoff_final_docs_count:named.filter(k=>docs[k]&&typeof docs[k]==='object').length,
        handoff_named_final_docs_pass:named.every(k=>docs[k]&&typeof docs[k]==='object'&&String(docs[k].sha256||'').length===64),
        handoff_naver_identity_pass:Boolean((naver.file_id||naver.filename)&&String(naver.sha256||'').length===64),
        handoff_key_points_count:arr(h.key_points).length,
        handoff_source_refs_count:arr(h.source_refs).length,
        handoff_run_mode_allowed:['DISCOVERY','FIXED_TOPIC','RERUN','REWORK'].includes(h.run_mode),
        handoff_invalid_visual_role_count:visuals.filter(x=>!allowedRoles.has(x?.role)).length,
        handoff_readback_exact:truth(h.readback_exact)
      };
    }
    case 'F17': return {preview_attempted_doc_count:arr(p.previews).length,result_summary_emitted:truth(p.result_summary_emitted)};
    case 'F18': {const expected=Array.from({length:18},(_,i)=>'F'+String(i).padStart(2,'0'));return {all_prior_stages_closed:canonical(s.closed)===canonical(expected),pending_required_count:Number(p.pending_required_count??999),failed_required_count:Number(p.failed_required_count??999)};}
    default: throw new Error('UNKNOWN_STAGE');
  }
}
function validateEvidence(stage,p){
  const refs=arr(p.evidence_refs);
  if(stage==='F00'||stage==='F01'||stage==='F18') return true;
  if(refs.length<1) throw new Error('STAGE_EVIDENCE_MISSING');
  for(const r of refs){ if(typeof r!=='string'||r.trim().length<3) throw new Error('BAD_EVIDENCE_REF'); }
  return true;
}
function validateStage(stage,p,s){
  if(!p||typeof p!=='object'||Array.isArray(p)) throw new Error('BAD_STAGE_PACKET');
  validateEvidence(stage,p);
  const c=stageContract(stage), metrics=deriveMetrics(stage,p,s);
  for(const [k,spec] of Object.entries(c.hard_gates)){
    if(!(k in metrics)) throw new Error('HARD_GATE_METRIC_MISSING:'+k);
    if(!compare(metrics[k],spec)) throw new Error('HARD_GATE_FAIL:'+k+':'+JSON.stringify(metrics[k]));
  }
  return metrics;
}

function expectedPhaseIndex(phase){const i=MANIFEST.phase_order.indexOf(phase);if(i<0)throw new Error('UNKNOWN_PHASE:'+phase);return i;}
function validatePhasePacket(phase,packet,s){
  if(!packet||typeof packet!=='object'||Array.isArray(packet)) throw new Error('BAD_PHASE_PACKET');
  const expected=phaseStages(phase);
  const stagePackets=packet.stages;
  if(!stagePackets||typeof stagePackets!=='object'||Array.isArray(stagePackets)) throw new Error('BAD_PHASE_STAGE_SET');
  const got=Object.keys(stagePackets).sort();
  const need=[...expected].sort();
  if(canonical(got)!==canonical(need)) throw new Error('PHASE_STAGE_SET_MISMATCH:'+phase);
  const shadow={...s,closed:[...s.closed]};
  const metrics={};
  for(const stage of expected){
    metrics[stage]=validateStage(stage,stagePackets[stage],shadow);
    shadow.closed.push(stage);
  }
  return {metrics,closed:shadow.closed};
}

export async function handleGateway(body,env=process.env,deps={}){
  const secret=env.GATEWAY_SECRET||''; if(secret.length<24) throw new Error('GATEWAY_SECRET_NOT_CONFIGURED');
  const now=deps.now?deps.now():Date.now(); const store=deps.store||new UpstashStateStore(env); const uuid=deps.uuid||(()=>crypto.randomUUID()); const op=body?.op;
  if(op==='boot'){
    if(!stateStoreConfigured(env)&&!deps.store) throw new Error('STATE_STORE_NOT_CONFIGURED');
    if(body.policy_sha256!==MANIFEST.policy_sha256) throw new Error('POLICY_HASH_MISMATCH');
    let s,ok=false; for(let i=0;i<3&&!ok;i++){s=newState(uuid(),body.policy_sha256,now);ok=await store.create(stateKey(s.run_id),s);} if(!ok) throw new Error('RUN_STATE_CREATE_FAILED');
    return {ok:true,manifest:publicManifestSummary(env),state_token:tokenFor(s,secret,now)};
  }
  const ctx=await loadState(body.state_token,secret,store,now),s=ctx.state;
  if(op==='inspect') return {ok:true,state:{run_id:s.run_id,rev:s.rev,phase:s.phase,closed:s.closed,terminal:s.terminal},contract:{phase:s.phase,stages:phaseStages(s.phase)}};
  if(op==='ready') return {ok:true,ready:s.terminal==='DONE',terminal:s.terminal,reason:s.terminal==='DONE'?'CONTROLLER_TERMINAL_DONE':'MODEL_TEXT_HAS_NO_TERMINAL_AUTHORITY'};
  if(s.terminal==='DONE') throw new Error('RUN_ALREADY_DONE');
  if(op==='complete_phase'){
    const phase=s.phase;
    if(body.phase!==phase) throw new Error('PHASE_MISMATCH:expected='+phase+':got='+String(body.phase));
    const validated=validatePhasePacket(phase,body.packet||{},s);
    const phase_digest=sha({phase,stage_packet_digest:sha(body.packet?.stages||{}),stage_metrics:validated.metrics,policy_sha256:MANIFEST.policy_sha256,chain_before:s.chain_digest});
    s.closed=validated.closed; s.chain_digest=sha(s.chain_digest+'|PHASE|'+phase+'|'+phase_digest);
    const idx=expectedPhaseIndex(phase);
    if(idx===MANIFEST.phase_order.length-1){s.terminal='DONE';}
    else{s.phase=MANIFEST.phase_order[idx+1];}
    await persist(ctx,store,now);
    return {ok:true,closed_phase:phase,next_phase:s.terminal==='DONE'?'DONE':s.phase,closed_stages:phaseStages(phase),terminal:s.terminal,ready:s.terminal==='DONE',verified_metrics:validated.metrics,phase_digest,chain_digest:s.chain_digest,state_token:tokenFor(s,secret,now)};
  }
  throw new Error('UNKNOWN_OPERATION');
}
export function publicManifestSummary(env=process.env){return {schema:MANIFEST.schema,policy_version:MANIFEST.policy_version,policy_sha256:MANIFEST.policy_sha256,policy_drive_revision_id:MANIFEST.policy_drive_revision_id,catalog_sha256:MANIFEST.catalog_sha256,stage_count:MANIFEST.stage_count,phase_count:MANIFEST.phase_count,phase_order:MANIFEST.phase_order,state_ttl_seconds:STATE_TTL_SECONDS,state_store_configured:stateStoreConfigured(env),execution_authority:'PHASE_CONTROL_ONLY'};}
export const __test={canonical,sha,stateKey,deriveMetrics,validateStage,validatePhasePacket,newState,tokenFor,phaseStages};
