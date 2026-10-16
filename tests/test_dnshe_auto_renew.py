#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
TARGET = HERE.with_name("dnshe_auto_renew.py")
if not TARGET.exists():
    TARGET = HERE.parent / "daily" / "dnshe_auto_renew.py"
spec = importlib.util.spec_from_file_location("dnshe", TARGET)
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
passed=failed=0
def check(name, fn):
 global passed,failed
 try: fn(); passed+=1; print("PASS",name)
 except Exception as e: failed+=1; print("FAIL",name,type(e).__name__,e)

def fake_items():
 return [{"full_domain":"vif.cc.cd","id":1,"created_at":"2026-07-01 00:00:00"},{"full_domain":"dqf.cc.cd","id":2,"created_at":"2026-07-01 00:00:00"},{"full_domain":"dfo.cc.cd","id":3,"created_at":"2026-07-01 00:00:00"}]

def t_build():
 state={"domains":{}}
 m,ch=d.build_managed_domains(["vif.cc.cd","dqf.cc.cd","dfo.cc.cd"],d.find_subdomain_map(fake_items()),state)
 assert len(m)==3 and ch and all(x.renew_before_days==175 for x in m)
def t_missing():
 try:d.build_managed_domains(["x.cc.cd"],{}, {"domains":{}});raise AssertionError
 except RuntimeError as e:assert "not found" in str(e)
def t_stale():
 state={"domains":{"old.cc.cd":{},"vif.cc.cd":{"expires_at":"2027-01-01 00:00","renew_before_days":10}}}
 d.build_managed_domains(["vif.cc.cd"],d.find_subdomain_map(fake_items()),state);assert "old.cc.cd" not in state["domains"]
def t_atomic():
 with tempfile.TemporaryDirectory() as x:
  p=pathlib.Path(x)/"s.json";d.save_state(p,{"domains":{"vif.cc.cd":{}}});assert json.loads(p.read_text())["domains"].get("vif.cc.cd")=={}
def t_secret_file():
 with tempfile.TemporaryDirectory() as x:
  p=pathlib.Path(x)/"a";p.write_text(" secret\n");assert d.read_secret(pathlib.Path(x),"NO_SUCH_ENV","a")=="secret"
def t_domains():
 with tempfile.TemporaryDirectory() as x:
  p=pathlib.Path(x)/"domains.txt";p.write_text("vif.cc.cd\n#x\ndqf.cc.cd\n");assert d.parse_domains(pathlib.Path(x))==["vif.cc.cd","dqf.cc.cd"]
def t_duplicate():
 with tempfile.TemporaryDirectory() as x:
  pathlib.Path(x,"domains.txt").write_text("vif.cc.cd\nvif.cc.cd\n")
  try:d.parse_domains(pathlib.Path(x));raise AssertionError
  except RuntimeError as e:assert "duplicates" in str(e)
def t_invalid_days():
 try:d.build_managed_domains(["vif.cc.cd"],d.find_subdomain_map(fake_items()),{"domains":{"vif.cc.cd":{"expires_at":"2027-01-01 00:00","renew_before_days":0}}});raise AssertionError
 except RuntimeError:pass
for n,f in list(globals().items()):
 if n.startswith("t_"):check(n,f)
print(f"RESULT PASS={passed} FAIL={failed}")
raise SystemExit(1 if failed else 0)
