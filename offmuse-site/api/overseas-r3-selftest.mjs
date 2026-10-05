import { handleGateway, makeToolAttestation, __test, publicManifestSummary } from '../gateway-r3/core.mjs';

const POLICY='c12d7cc5a87981d6cc6af52b92fa19c6f5e276a73a37ecf2026984a74fcb0226';
const PROOF0={
  leaf:{index:0,clause_id:'UNIT:U00212',unit_id:'U00212',unit_source_sha256:'cb64fa8433ab61f8aa6d5c5cddeea4719d3e8f6b87a0a7246f9c97fa1eb47958',clause_sha256:'cb64fa8433ab61f8aa6d5c5cddeea4719d3e8f6b87a0a7246f9c97fa1eb47958',kind:'UNIT_FALLBACK',text:'## P65.1 F00 — executable policy compile scan, once per RUN\n\n'},
  proof:[
    {side:'R',hash:'b96a1552bde624b8dbf16c8cb3f12e99bdc5da962909b309784f79b0faa554c0'},
    {side:'R',hash:'b3f30443604baad1d84f86f2e0ca558c297a15de6d6528f342287207046770a5'},
    {side:'R',hash:'d1197a00e771a4f1b0d939844c2954e59a7078c66153b6db20e0971873ca7673'},
    {side:'R',hash:'433bcb6bb71a8d694aee9db4ad6c51337d142dc52a24c47d5341fe406b88eb49'},
    {side:'R',hash:'2d629654e907e9cc9f4882e77840a301f7981d5ff1c6864b83e1a196869419df'},
    {side:'R',hash:'47c98026f90a55f76c29d45cb17e43196c66e64d413fc7982330885210d91275'},
    {side:'R',hash:'e6a2860b2f9ef8b2128eb169c4cf4075cfeaa9364dd3f2d44002c84ced2ca51e'},
    {side:'R',hash:'0c8230200531d05465fb6953c329af6e21d0880fc5500d6babfb693ef73436a3'},
    {side:'R',hash:'795b4271594ff7bf04fd463704ce6549af6711bdbe339d72be729d4ef64ea177'},
    {side:'R',hash:'bd3585e3ea77da39e76a7dc24c5bfc55b9e4c39de69fc279c4deb0715f6aa8d2'},
    {side:'R',hash:'ed625d6e1873ef39bf9421fb5aa9961cded4642c91899734f1c80a4a2e4ef6c6'}
  ]
};

function redisEnv(){
  return {
    url:(process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL||'').replace(/\/$/,''),
    token:process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN||''
  };
}
async function redisCmd(args){
  const r=redisEnv();
  const res=await fetch(r.url,{method:'POST',headers:{authorization:'Bearer '+r.token,'content-type':'application/json'},body:JSON.stringify(args)});
  const body=await res.json();
  if(!res.ok||body?.error) throw new Error('REDIS_SELFTEST_ERROR:'+String(body?.error||res.status));
  return body?.result;
}
async function expectError(fn, allowed){
  try { await fn(); return {blocked:false,error:'UNEXPECTED_SUCCESS'}; }
  catch(e){ const m=String(e?.message||e); return {blocked:allowed.some(x=>m===x||m.startsWith(x)),error:m}; }
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  let runId=null;
  const out={ok:false,mode:'r3-production-selftest',checks:{}};
  try{
    const manifest=publicManifestSummary(process.env);
    out.checks.health_configured=manifest.state_store_configured===true&&manifest.executor_attestation_configured===true;

    const boot=await handleGateway({op:'boot',policy_sha256:POLICY},process.env);
    const s0=boot.state_token;
    const ins0=await handleGateway({op:'inspect',state_token:s0},process.env);
    runId=ins0.state.run_id;
    out.checks.boot=ins0.state.stage==='F00'&&ins0.state.rev===0;

    const payload={id:'policy-selftest'};
    const race=await Promise.allSettled([
      handleGateway({op:'grant',state_token:s0,tool_class:'DRIVE_READ',operation:'race-a',payload},process.env),
      handleGateway({op:'grant',state_token:s0,tool_class:'DRIVE_READ',operation:'race-b',payload},process.env)
    ]);
    const wins=race.filter(x=>x.status==='fulfilled');
    const losses=race.filter(x=>x.status==='rejected');
    out.checks.atomic_race_one_winner=wins.length===1&&losses.length===1&&['STATE_CONFLICT','STALE_STATE_TOKEN'].includes(String(losses[0]?.reason?.message||losses[0]?.reason));

    const stale=await expectError(()=>handleGateway({op:'inspect',state_token:s0},process.env),['STALE_STATE_TOKEN']);
    out.checks.stale_token_block=stale.blocked;

    const win=wins[0].value;
    const gtoken=win.grant_token;
    const grant=win.grant;
    const auth=await handleGateway({op:'authorize',state_token:win.state_token,grant_token:gtoken,payload},process.env);
    out.checks.authorize=auth.authorized===true;

    const receipt={event_ref:'r3-prod-selftest',result:'PASS'};
    const missing=await expectError(()=>handleGateway({op:'complete_tool',state_token:auth.state_token,grant_token:gtoken,receipt},process.env),['BAD_TOKEN']);
    out.checks.missing_attestation_block=missing.blocked;

    const eid='evidence-r3-selftest-'+runId;
    const att=makeToolAttestation({
      run_id:runId,stage:'F00',grant_hash:grant.grant_hash,payload_hash:grant.payload_hash,
      receipt_hash:__test.sha(receipt),evidence_ids:[eid],
      metrics:{policy_identity_pass:true,version_coherence_pass:true,catalog_exact:true}
    },process.env.EXECUTOR_SHARED_SECRET);
    const comp=await handleGateway({op:'complete_tool',state_token:auth.state_token,grant_token:gtoken,receipt,attestation_token:att},process.env);
    out.checks.attested_receipt=comp.evidence_ids?.[0]===eid;

    const raw=await redisCmd(['GET',__test.stateKey(runId)]);
    const state=JSON.parse(String(raw));
    const metrics=state.metric_ledger?.F00||{};
    out.checks.evidence_ledger=!!state.evidence_ledger?.[eid];
    out.checks.metric_ledger=['policy_identity_pass','version_coherence_pass','catalog_exact'].every(k=>metrics[k]?.value===true&&metrics[k]?.evidence_id===eid&&!!metrics[k]?.attestation_hash);

    const fake=await expectError(()=>handleGateway({op:'submit_clause_batch',state_token:comp.state_token,items:[{...PROOF0,result:'PASS',evidence_refs:['fake-evidence']}]},process.env),['CLAUSE_EVIDENCE_UNATTESTED:']);
    out.checks.unattested_evidence_block=fake.blocked;

    const good=await handleGateway({op:'submit_clause_batch',state_token:comp.state_token,items:[{...PROOF0,result:'PASS',evidence_refs:[eid]}]},process.env);
    out.checks.merkle_clause_accept=good.accepted_clause_count===1&&good.required_clause_count===1126;

    const dup=await expectError(()=>handleGateway({op:'submit_clause_batch',state_token:good.state_token,items:[{...PROOF0,result:'PASS',evidence_refs:[eid]}]},process.env),['CLAUSE_ALREADY_ACCEPTED:0']);
    out.checks.duplicate_clause_block=dup.blocked;

    const early=await expectError(()=>handleGateway({op:'close_stage',state_token:good.state_token},process.env),['CLAUSE_COVERAGE_INCOMPLETE:1/1126']);
    out.checks.early_stage_close_block=early.blocked;

    const ready=await handleGateway({op:'ready',state_token:good.state_token},process.env);
    out.checks.ready_before_f18_block=ready.ready===false;

    out.ok=Object.values(out.checks).every(Boolean);
    return res.status(out.ok?200:500).json(out);
  }catch(e){
    out.error=String(e?.message||e);
    return res.status(500).json(out);
  }finally{
    if(runId){
      try{ await redisCmd(['DEL',__test.stateKey(runId)]); }catch{}
    }
  }
}
