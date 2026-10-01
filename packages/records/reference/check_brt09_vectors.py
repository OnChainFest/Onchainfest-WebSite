#!/usr/bin/env python3
"""
Independent BRT-09 record-vector checker (Python standard library only; no shared code with the
TypeScript implementation).

For every vector it re-derives JCS (RFC 8785) of the parsed canonical text — which must reproduce the
committed text byte for byte — and the domain-separated hash
  SHA-256("BR" || 0x01 || domainTag || 0x00 || schemaId "@" version || 0x00 || "br-json/1" || 0x00 || JCS)
It checks equal / distinct groups, that no vector carries a float, null or score-like member, and the
bindings of every evaluation outcome: its snapshotHash equals the referenced snapshot vector; only a
QUALIFYING outcome carries a candidate or a ratification; the embedded candidate equals (byte for byte)
and hashes to its candidate vector; the identityHash equals its identity vector; the candidate value is
byte-equal to the snapshot Performance mark (value integrity) and its effectiveFrom is the Performance
sporting time. For replay vectors it independently recomputes the current holder(s) (RC-1…RC-3).

LIMITATION: it does not re-run category validation or authority evaluation (the TypeScript engine
does); it proves the hashes, the bindings and the invariants of the committed documents.
"""
import hashlib
import json
import sys
from decimal import Decimal

PROFILE = "br-json/1"
FORBIDDEN = {"confidence", "trustScore", "score", "probability", "weight", "certaintyPercent", "greatness", "popularity"}


def jcs(value):
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None or isinstance(value, float):
        raise ValueError("null / floating point are not representable in BR-JSON")
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise ValueError("unsafe integer")
        return str(value)
    if isinstance(value, str):
        return jcs_string(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(jcs_string(k) + ":" + jcs(value[k]) for k in keys) + "}"
    raise ValueError(f"unsupported type {type(value)}")


def jcs_string(s):
    esc = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
    return '"' + "".join(esc.get(c, "\\u%04x" % ord(c) if ord(c) < 0x20 else c) for c in s) + '"'


def content_hash(tag, schema_id, version, text):
    pre = (b"BR" + bytes([1]) + tag.encode("ascii") + b"\x00" + f"{schema_id}@{version}".encode("ascii")
           + b"\x00" + PROFILE.encode("ascii") + b"\x00" + text.encode("utf-8"))
    return "sha256:" + hashlib.sha256(pre).hexdigest()


def members(value, out):
    if isinstance(value, dict):
        for k, v in value.items():
            out.add(k)
            members(v, out)
    elif isinstance(value, list):
        for v in value:
            members(v, out)
    return out


def replay_current(doc):
    lower = doc["comparator"] == "LOWER_IS_BETTER"
    marks = sorted((m for m in doc["marks"] if m["valid"]),
                   key=lambda m: (m["effectiveFrom"], m["ratifiedSeq"], m["recordMarkId"]))
    current = []
    for m in marks:
        if not current:
            current = [m]
            continue
        a, b = Decimal(m["value"]["value"]), Decimal(current[0]["value"]["value"])
        better = a < b if lower else a > b
        if better:
            current = [m]
        elif a == b and doc["tiePolicy"] == "SHARED":
            current.append(m)
    return sorted(m["recordMarkId"] for m in current)


def main(path):
    doc = json.load(open(path, encoding="utf-8"))
    by_name = {}
    failures = []
    for v in doc["vectors"]:
        parsed = json.loads(v["canonicalText"])
        if jcs(parsed) != v["canonicalText"]:
            failures.append(f"{v['name']}: canonical text is not JCS")
        if content_hash(v["domainTag"], v["schemaId"], v["schemaVersion"], v["canonicalText"]) != v["hash"]:
            failures.append(f"{v['name']}: hash mismatch")
        bad = members(parsed, set()) & FORBIDDEN
        if bad:
            failures.append(f"{v['name']}: score-like members {sorted(bad)}")
        by_name[v["name"]] = (v, parsed)
    for group in doc["equal"]:
        if len({by_name[n][0]["hash"] for n in group}) != 1:
            failures.append(f"equal group differs: {group}")
    for group in doc["distinct"]:
        if len({by_name[n][0]["hash"] for n in group}) != len(group):
            failures.append(f"distinct group collides: {group}")
    for v, parsed in by_name.values():
        if v["kind"] == "replay":
            if replay_current(parsed) != sorted(v["expectCurrent"]):
                failures.append(f"{v['name']}: independent replay disagrees with expectCurrent")
            continue
        if v["kind"] != "outcome":
            continue
        if parsed["state"] != v["expectState"]:
            failures.append(f"{v['name']}: state {parsed['state']} != {v['expectState']}")
        snap_v, snap = by_name[v["snapshotVector"]]
        if parsed["snapshotHash"] != snap_v["hash"]:
            failures.append(f"{v['name']}: snapshotHash does not bind its snapshot vector")
        qualifies = parsed["state"] == "QUALIFIES"
        if not qualifies and ("candidate" in parsed or "ratification" in parsed):
            failures.append(f"{v['name']}: a non-qualifying outcome carries a candidate / ratification")
        if "candidate" in parsed:
            entry = parsed["candidate"]
            cv, cand = by_name[v["candidateVector"]]
            if entry["candidateHash"] != cv["hash"] or jcs(entry["candidate"]) != cv["canonicalText"]:
                failures.append(f"{v['name']}: candidate does not bind its candidate vector")
            if entry["identityHash"] != by_name[v["identityVector"]][0]["hash"]:
                failures.append(f"{v['name']}: identityHash does not bind its identity vector")
            if cand["value"] != snap["performance"]["mark"]:
                failures.append(f"{v['name']}: mark value is not the exact Performance mark")
            if cand["effectiveFrom"] != snap["performance"]["occurredAt"]:
                failures.append(f"{v['name']}: effectiveFrom is not the sporting time")
        if "ratification" in parsed and parsed["ratification"]["subjectHash"] != snap["pendingMark"]["markHash"]:
            failures.append(f"{v['name']}: ratification does not bind the exact pending mark hash")
    if failures:
        for f in failures:
            print("FAIL", f)
        sys.exit(1)
    print(f"OK: {len(doc['vectors'])} BRT-09 vectors — JCS, hashes, equal/distinct groups, outcome bindings, value integrity and independent replay verified.")


if __name__ == "__main__":
    main(sys.argv[1])
