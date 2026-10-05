import json, os, urllib.request, urllib.error

BASE=os.environ.get("BASE","https://blog-data-omega.vercel.app")
POLICY="c12d7cc5a87981d6cc6af52b92fa19c6f5e276a73a37ecf2026984a74fcb0226"
ITEM={"leaf":{"index":0,"clause_id":"UNIT:U00212","unit_id":"U00212","unit_source_sha256":"cb64fa8433ab61f8aa6d5c5cddeea4719d3e8f6b87a0a7246f9c97fa1eb47958","clause_sha256":"cb64fa8433ab61f8aa6d5c5cddeea4719d3e8f6b87a0a7246f9c97fa1eb47958","kind":"UNIT_FALLBACK","text":"## P65.1 F00 — executable policy compile scan, once per RUN\n\n"},"proof":[{"side":"R","hash":"b96a1552bde624b8dbf16c8cb3f12e99bdc5da962909b309784f79b0faa554c0"},{"side":"R","hash":"b3f30443604baad1d84f86f2e0ca558c297a15de6d6528f342287207046770a5"},{"side":"R","hash":"d1197a00e771a4f1b0d939844c2954e59a7078c66153b6db20e0971873ca7673"},{"side":"R","hash":"433bcb6bb71a8d694aee9db4ad6c51337d142dc52a24c47d5341fe406b88eb49"},{"side":"R","hash":"2d629654e907e9cc9f4882e77840a301f7981d5ff1c6864b83e1a196869419df"},{"side":"R","hash":"47c98026f90a55f76c29d45cb17e43196c66e64d413fc7982330885210d91275"},{"side":"R","hash":"e6a2860b2f9ef8b2128eb169c4cf4075cfeaa9364dd3f2d44002c84ced2ca51e"},{"side":"R","hash":"0c8230200531d05465fb6953c329af6e21d0880fc5500d6babfb693ef73436a3"},{"side":"R","hash":"795b4271594ff7bf04fd463704ce6549af6711bdbe339d72be729d4ef64ea177"},{"side":"R","hash":"bd3585e3ea77da39e76a7dc24c5bfc55b9e4c39de69fc279c4deb0715f6aa8d2"},{"side":"R","hash":"ed625d6e1873ef39bf9421fb5aa9961cded4642c91899734f1c80a4a2e4ef6c6"}]}

def call(path, obj=None):
    if obj is None:
        req=urllib.request.Request(BASE+path)
    else:
        data=json.dumps(obj,ensure_ascii=False,separators=(",",":")).encode()
        req=urllib.request.Request(BASE+path,data=data,headers={"content-type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=20) as r:
            body=r.read().decode()
            return r.status,json.loads(body)
    except urllib.error.HTTPError as e:
        body=e.read().decode()
        return e.code,json.loads(body)

def expect_error(obj, err):
    code,d=call("/api/overseas-gateway",obj)
    assert code==400,(code,d)
    assert d.get("ok") is False and d.get("error")==err,(err,d)
    print(err+"=BLOCK")
    return d

code,h=call("/api/overseas-health")
assert code==200 and h["ok"] is True
assert h["mode"]=="vercel-hobby-merkle-r2" and h["policy_version"]=="v9.76" and h["stage_count"]==19
assert h["secret_configured"] is True
print("HEALTH=PASS")

expect_error({"op":"boot","policy_sha256":"0"*64},"POLICY_HASH_MISMATCH")
code,b=call("/api/overseas-gateway",{"op":"boot","policy_sha256":POLICY})
assert code==200 and b["ok"] and b.get("state_token")
state0=b["state_token"]
print("BOOT=PASS")

code,i=call("/api/overseas-gateway",{"op":"inspect","state_token":state0})
assert code==200 and i["state"]["stage"]=="F00"
assert i["contract"]["allowed_tools"]==["DRIVE_READ"] and i["contract"]["required_clause_count"]==1126
print("F00_INSPECT=PASS")

code,r=call("/api/overseas-gateway",{"op":"ready","state_token":state0})
assert code==200 and r["ready"] is False
print("READY_BEFORE_F18=BLOCK")

bad_state=state0[:-1]+("A" if state0[-1]!="A" else "B")
code,d=call("/api/overseas-gateway",{"op":"inspect","state_token":bad_state})
assert code==400 and d["error"]=="BAD_SIGNATURE"
print("STATE_SIGNATURE_TAMPER=BLOCK")

expect_error({"op":"grant","state_token":state0,"tool_class":"WEB_SEARCH","operation":"bad","payload":{}},"TOOL_CLASS_NOT_ALLOWED_IN_STAGE")
payload={"id":"policy"}
code,g=call("/api/overseas-gateway",{"op":"grant","state_token":state0,"tool_class":"DRIVE_READ","operation":"policy-read","payload":payload})
assert code==200 and g["ok"] and g.get("grant_token") and g.get("state_token")
state_g,grant=g["state_token"],g["grant_token"]
print("F00_DRIVE_READ_GRANT=PASS")

expect_error({"op":"grant","state_token":state_g,"tool_class":"DRIVE_READ","operation":"again","payload":payload},"PENDING_TOOL_GRANT_EXISTS")
expect_error({"op":"authorize","state_token":state_g,"grant_token":grant,"payload":{"id":"tampered"}},"REQUEST_HASH_MISMATCH")
code,a=call("/api/overseas-gateway",{"op":"authorize","state_token":state_g,"grant_token":grant,"payload":payload})
assert code==200 and a["authorized"] is True
print("PAYLOAD_MATCH_AUTHORIZE=PASS")

expect_error({"op":"complete_tool","state_token":state_g,"grant_token":grant,"receipt":{"result":"PASS"}},"TOOL_RECEIPT_NOT_PASSABLE")
code,c=call("/api/overseas-gateway",{"op":"complete_tool","state_token":state_g,"grant_token":grant,"receipt":{"event_ref":"prod-e2e","result":"PASS"}})
assert code==200 and c.get("state_token")
state1=c["state_token"]
print("TOOL_RECEIPT=PASS")

fake=json.loads(json.dumps(ITEM))
fake["proof"][0]["hash"]="0"*64
code,d=call("/api/overseas-gateway",{"op":"submit_clause_batch","state_token":state1,"items":[dict(fake,result="PASS",evidence_refs=["prod-e2e"]) ]})
assert code==400 and d["error"].startswith("CLAUSE_MERKLE_PROOF_INVALID:")
print("MERKLE_FAKE_PROOF=BLOCK")

valid=dict(ITEM,result="PASS",evidence_refs=["prod-e2e"])
code,v=call("/api/overseas-gateway",{"op":"submit_clause_batch","state_token":state1,"items":[valid]})
assert code==200 and v["accepted_clause_count"]==1 and v["required_clause_count"]==1126
state2=v["state_token"]
print("MERKLE_VALID_PROOF=PASS")

code,d=call("/api/overseas-gateway",{"op":"submit_clause_batch","state_token":state2,"items":[valid]})
assert code==400 and d["error"]=="CLAUSE_ALREADY_ACCEPTED:0"
print("CLAUSE_DUPLICATE=BLOCK")

metrics={"policy_identity_pass":True,"version_coherence_pass":True,"catalog_exact":True}
code,d=call("/api/overseas-gateway",{"op":"close_stage","state_token":state2,"metrics":metrics})
assert code==400 and d["error"]=="CLAUSE_COVERAGE_INCOMPLETE:1/1126"
print("F00_EARLY_CLOSE=BLOCK")

expect_error({"op":"commit_grant","state_token":state2,"plan":{}},"COMMIT_ONLY_AT_F15")
code,r=call("/api/overseas-gateway",{"op":"ready","state_token":state2})
assert code==200 and r["ready"] is False
print("READY_AFTER_PARTIAL_F00=BLOCK")

# Deliberately probe known stateless limitation: a stale pre-grant state can fork.
code,fork=call("/api/overseas-gateway",{"op":"grant","state_token":state0,"tool_class":"DRIVE_READ","operation":"fork-probe","payload":{"x":1}})
assert code==200 and fork["ok"] is True
print("STATELESS_STALE_STATE_FORK=ACCEPTED_KNOWN_LIMIT")

print("PRODUCTION_F00_SECURITY_E2E=PASS")

# trigger
