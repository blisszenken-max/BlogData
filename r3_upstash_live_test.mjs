import assert from 'node:assert/strict';
import {handleGateway} from './offmuse-site/gateway-r3/core.mjs';

const env={
  ...process.env,
  GATEWAY_SECRET:process.env.TEST_GATEWAY_SECRET,
  EXECUTOR_SHARED_SECRET:process.env.TEST_EXECUTOR_SECRET
};
const policy='c12d7cc5a87981d6cc6af52b92fa19c6f5e276a73a37ecf2026984a74fcb0226';
const boot=await handleGateway({op:'boot',policy_sha256:policy},env);
assert.equal(boot.ok,true);
const s0=boot.state_token;
const calls=[
  handleGateway({op:'grant',state_token:s0,tool_class:'DRIVE_READ',operation:'race-a',payload:{n:1}},env),
  handleGateway({op:'grant',state_token:s0,tool_class:'DRIVE_READ',operation:'race-b',payload:{n:2}},env)
];
const rr=await Promise.allSettled(calls);
const ok=rr.filter(x=>x.status==='fulfilled');
const bad=rr.filter(x=>x.status==='rejected');
assert.equal(ok.length,1);
assert.equal(bad.length,1);
assert.ok(['STATE_CONFLICT','STALE_STATE_TOKEN'].includes(bad[0].reason.message),bad[0].reason.message);
let staleErr=null;
try{await handleGateway({op:'inspect',state_token:s0},env);}catch(e){staleErr=e.message;}
assert.equal(staleErr,'STALE_STATE_TOKEN');
const ins=await handleGateway({op:'inspect',state_token:ok[0].value.state_token},env);
assert.equal(ins.state.rev,1);
assert.equal(ins.state.pending_grant,true);
console.log('UPSTASH_BOOT=PASS');
console.log('ATOMIC_RACE_ONE_WINNER=PASS');
console.log('STALE_STATE_TOKEN=BLOCK');
console.log('R3_REAL_REDIS_CAS=PASS');
