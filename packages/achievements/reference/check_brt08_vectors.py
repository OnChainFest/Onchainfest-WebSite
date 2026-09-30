#!/usr/bin/env python3
"""
Independent BRT-08 achievement-vector checker (Python standard library only; no shared code with the
TypeScript implementation).

For every vector it re-derives JCS (RFC 8785) of the parsed canonical text — which must reproduce the
committed text byte for byte — and the domain-separated hash
  SHA-256("BR" || 0x01 || domainTag || 0x00 || schemaId "@" version || 0x00 || "br-json/1" || 0x00 || JCS)
It checks equal / distinct groups, that no vector carries a float, null or score-like member, and the
bindings of every derivation outcome: its snapshotHash equals the referenced snapshot vector, every
embedded candidate equals (byte for byte) and hashes to its candidate vector, and every identityHash
equals the referenced identity vector, and every candidate's evidenceCommitment equals the independently
recomputed hash of its basis → Evidence Bundle document. It also checks the BRT-01 AC-5 shape: a TEAM candidate carries
member credits only as immutable content, and no candidate exists when the outcome is BLOCKED.

LIMITATION: it does not re-run derivation rules (the TypeScript engine does); it proves the hashes
and the bindings between the committed documents.
"""
import hashlib
import json
import sys

PROFILE = "br-json/1"
FORBIDDEN = {"confidence", "trustScore", "score", "probability", "weight", "certaintyPercent"}


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
        if v["kind"] == "candidate" and parsed["holder"]["holderType"] == "ATHLETE" and "memberCredits" in parsed:
            failures.append(f"{v['name']}: an ATHLETE holder carries member credits")
        if v["kind"] != "outcome":
            continue
        if parsed["state"] != v["expectState"]:
            failures.append(f"{v['name']}: state {parsed['state']} != {v['expectState']}")
        if parsed["snapshotHash"] != by_name[v["snapshotVector"]][0]["hash"]:
            failures.append(f"{v['name']}: snapshotHash does not bind its snapshot vector")
        cands = parsed.get("candidates", [])
        if parsed["state"] == "BLOCKED" and cands:
            failures.append(f"{v['name']}: a BLOCKED outcome carries candidates")
        if len(cands) != len(v["candidateVectors"]):
            failures.append(f"{v['name']}: candidate count differs")
        for entry in cands:
            cand_hashes = {by_name[n][0]["hash"]: n for n in v["candidateVectors"]}
            ident_hashes = {by_name[n][0]["hash"] for n in v["identityVectors"]}
            name = cand_hashes.get(entry["candidateHash"])
            if name is None:
                failures.append(f"{v['name']}: candidateHash does not bind a candidate vector")
            elif jcs(entry["candidate"]) != by_name[name][0]["canonicalText"]:
                failures.append(f"{v['name']}: embedded candidate differs from {name}")
            if entry["identityHash"] not in ident_hashes:
                failures.append(f"{v['name']}: identityHash does not bind an identity vector")
        # evidenceCommitment (BRT-01 §8.1): recomputed independently from its own vector document,
        # which must list exactly the candidate's basis → Evidence Bundle references.
        for i, entry in enumerate(cands):
            cand = entry["candidate"]
            commit_names = v.get("commitmentVectors", [])
            if i >= len(commit_names):
                failures.append(f"{v['name']}: missing evidence-commitment vector")
                continue
            cv, cparsed = by_name[commit_names[i]]
            expected = sorted(
                ({k: b[k] for k in ("resultVersionId", "contentHash", "verificationRunId", "evidenceBundleHash", "evidenceBundleAsOf")}
                 for b in cand["basis"]), key=lambda x: (x["resultVersionId"], x["verificationRunId"]))
            if cparsed["basis"] != expected:
                failures.append(f"{v['name']}: evidence-commitment document is not the candidate basis")
            if cand["evidenceCommitment"] != cv["hash"]:
                failures.append(f"{v['name']}: candidate evidenceCommitment != recomputed commitment")
    if failures:
        for f in failures:
            print("FAIL", f)
        sys.exit(1)
    print(f"OK: {len(doc['vectors'])} BRT-08 vectors — JCS, hashes, equal/distinct groups and outcome → snapshot / candidate / identity bindings verified independently.")


if __name__ == "__main__":
    main(sys.argv[1])
