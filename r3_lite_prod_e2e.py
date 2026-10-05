import json, urllib.request, urllib.error, time, os

BASE=os.environ.get("BASE","https://blog-data-omega.vercel.app")
POLICY="c12d7cc5a87981d6cc6af52b92fa19c6f5e276a73a37ecf2026984a74fcb0226"
CATALOG="1f330d947587a07c95d0a563bd3417c0ee1fcb686a05de61e0534185f274a2ef"

def call(path,obj=None):
    if obj is None:
        req=urllib.request.Request(BASE+path)
    else:
        data=json.dumps(obj,separators=(",",":")).encode()
        req=urllib.request.Request(BASE+path,data=data,headers={"content-type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body=e.read().decode()
        try:return e.code,json.loads(body)
        except:return e.code,{"raw":body}

def wait_health():
    for _ in range(40):
        code,d=call("/api/overseas-health-r3-lite")
        if code==200 and d.get("ok") and d.get("schema")=="overseas-gateway-r3-lite":
            return d
        time.sleep(3)
    raise RuntimeError("R3 Lite health not ready")

def ev(stage): return [f"{stage}-evidence-1"]

def packet(stage):
    if stage=="F00": return {"policy_sha256":POLICY,"policy_version":"v9.76","catalog_sha256":CATALOG}
    if stage=="F01": return {"execution_contract_locked":True}
    if stage=="F02": return {"evidence_refs":ev(stage),"topic":{"locked":True,"trend_persistence":True,"event_independent":True}}
    if stage=="F03": return {"evidence_refs":ev(stage),"claims":[{"id":i,"supported":True,"major":True} for i in range(8)],"trend_sources":["s1","s2"],"trend_anchors":["a1"],"benchmarks":[{"eligible":True},{"eligible":True}]}
    if stage=="F04": return {"evidence_refs":ev(stage),"reader_situations":[{"id":i} for i in range(7)],"question_sensors":[{"id":i,"evidence_refs":["e"]} for i in range(6)],"interests":[{"id":"i1"}],"material_questions":[{"interest_id":"i1"},{"interest_id":"i1"}]}
    if stage=="F05": return {"evidence_refs":ev(stage),"titles":[{"frame":"f"+str(i%3),"score":90 if i==0 else 70,"selected":i==0} for i in range(5)],"blueprint":{"locked":True}}
    if stage=="F06": return {"evidence_refs":ev(stage),"drafts":[{"id":1}]}
    if stage=="F07": return {"evidence_refs":ev(stage),"architectures":[{"id":i} for i in range(5)],"valid_full_drafts":[1,2,3],"blind_reader":{"pass":True,"known_interest_gaps":0,"new_material_gaps":0},"residual_search_queries":[],"residual_material_questions":[]}
    if stage=="F08": return {"evidence_refs":ev(stage),"locked":True,"visual_targets":[{"contract_locked":True,"must_show_missing":False},{"contract_locked":True,"must_show_missing":False}]}
    if stage=="F09": return {"evidence_refs":ev(stage),"photo_targets":[{"source_stage_executed":True,"searched":True},{"source_stage_executed":True,"searched":True}]}
    if stage=="F10": return {"evidence_refs":ev(stage),"generated_assets":[{"authorized":True,"paid_plugin":False}]}
    if stage=="F11": return {"evidence_refs":ev(stage),"visuals":[{"resolved":True,"plain_background":False,"card_only":False,"chart_only":False,"background_verified":True,"decorative_pass":False,"text_readable":True}]}
    if stage=="F12": return {"evidence_refs":ev(stage),"scorecard":[{"score":10,"evidence_refs":["e"],"measured_counter":1,"model_assigned_score":False} for _ in range(9)],"hard_fail_count":0}
    if stage=="F13": return {"evidence_refs":ev(stage),"docs":[{"docx":True,"structural_readback":True} for _ in range(3)]}
    if stage=="F14": return {"evidence_refs":ev(stage),"docs":[{"final_bytes_measured":True,"rendered":True,"page_coverage":1,"hard_fail":False,"pending_semantic_qa":False,"pending_render_qa":False} for _ in range(3)]}
    if stage=="F15": return {"evidence_refs":ev(stage),"saved_docs":[{"saved":True,"bytes_match":True} for _ in range(3)],"commit_receipt":{"ok":True}}
    if stage=="F16": return {"evidence_refs":ev(stage),"handoff":{"schema":"OVERSEAS_SHORTS_HANDOFF_V3_LIGHT","status":"READY","final_docs":[1,2,3],"source_refs":["s1","s2"],"readback_exact":True}}
    if stage=="F17": return {"evidence_refs":ev(stage),"previews":[1,2,3],"result_summary_emitted":True}
    if stage=="F18": return {"pending_required_count":0,"failed_required_count":0}
    raise KeyError(stage)

h=wait_health()
assert h["state_store_configured"] is True
print("R3_LITE_HEALTH=PASS")

code,b=call("/api/overseas-gateway-r3-lite",{"op":"boot","policy_sha256":POLICY})
assert code==200 and b.get("ok") is True and b.get("state_token")
state=b["state_token"]
stale=state
print("R3_LITE_BOOT=PASS")

code,bad=call("/api/overseas-gateway-r3-lite",{"op":"complete_stage","state_token":state,"packet":{"policy_sha256":"bad","policy_version":"v9.76","catalog_sha256":"bad"}})
assert code==400 and str(bad.get("error","")).startswith("HARD_GATE_FAIL:policy_identity_pass")
print("R3_LITE_BAD_F00=BLOCK")

for i in range(19):
    stage="F"+str(i).zfill(2)
    code,r=call("/api/overseas-gateway-r3-lite",{"op":"complete_stage","state_token":state,"packet":packet(stage)})
    assert code==200 and r.get("ok") is True and r.get("closed_stage")==stage,(stage,code,r)
    state=r["state_token"]
    print(stage+"=PASS")

code,st=call("/api/overseas-gateway-r3-lite",{"op":"inspect","state_token":stale})
assert code==400 and st.get("error")=="STALE_STATE_TOKEN"
print("R3_LITE_STALE_TOKEN=BLOCK")

code,ready=call("/api/overseas-gateway-r3-lite",{"op":"ready","state_token":state})
assert code==200 and ready.get("ready") is True and ready.get("terminal")=="DONE"
print("R3_LITE_READY=PASS")
print("R3_LITE_PRODUCTION_E2E=PASS")
