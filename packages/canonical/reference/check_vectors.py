#!/usr/bin/env python3
"""
Independent BR-JSON v1 reference checker (BRT-03 §7, option A).

Structurally separate from packages/canonical: different language, standard library only,
no shared code. It re-derives, for every accepted golden vector:

  1. the RFC 8785 (JCS) serialization of the vector's `normalized` value, with its own
     key sort (UTF-16 code units) and its own string escaping;
  2. the domain-separated SHA-256 content hash (BRT-02 §3.2);
  3. independent BR-JSON invariant checks on `normalized` (NFC strings, no null, safe
     integers, canonical decimal / timestamp / UUID / hash spellings).

LIMITATIONS (documented in docs/implementation/BRT-03-FOUNDATION.md):
  - it does NOT re-implement input normalization (input -> normalized); that mapping is
    guarded by hand-authored expectations in br-json-v1.source.json;
  - it does not evaluate schema constraints or set ordering semantics from the schemas;
  - it trusts the vector file structure.

Exit status 0 only if every accepted vector's canonical text and hash agree.
"""
import hashlib
import json
import re
import sys
import unicodedata

PROFILE = "br-json/1"
MAX_SAFE = 2**53 - 1
DECIMAL = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$")
TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def jcs(value):
    if value is None:
        raise ValueError("null is not representable in BR-JSON")
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) > MAX_SAFE:
            raise ValueError("unsafe integer")
        return str(value)
    if isinstance(value, float):
        raise ValueError("floating point numbers are not representable in BR-JSON")
    if isinstance(value, str):
        return jcs_string(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(jcs_string(k) + ":" + jcs(value[k]) for k in keys) + "}"
    raise ValueError(f"unsupported type {type(value)}")


def jcs_string(s):
    out = ['"']
    for ch in s:
        cp = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif cp < 0x20:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def content_hash(domain_tag, schema_id, version, canonical_text):
    preimage = (
        b"BR"
        + bytes([0x01])
        + domain_tag.encode("ascii")
        + b"\x00"
        + f"{schema_id}@{version}".encode("ascii")
        + b"\x00"
        + PROFILE.encode("ascii")
        + b"\x00"
        + canonical_text.encode("utf-8")
    )
    return "sha256:" + hashlib.sha256(preimage).hexdigest()


def invariant_problems(value, path=""):
    problems = []
    if value is None:
        problems.append(f"{path}: null")
    elif isinstance(value, bool):
        pass
    elif isinstance(value, int):
        if abs(value) > MAX_SAFE:
            problems.append(f"{path}: unsafe integer")
    elif isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            problems.append(f"{path}: not NFC")
        if re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T", value) and not TIMESTAMP.match(value):
            problems.append(f"{path}: non-canonical timestamp")
        if re.match(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-", value) and not UUID.match(value):
            problems.append(f"{path}: non-canonical uuid")
        if value.startswith("sha256:") and not re.match(r"^sha256:[0-9a-f]{64}$", value):
            problems.append(f"{path}: non-canonical hash")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            problems += invariant_problems(v, f"{path}/{i}")
    elif isinstance(value, dict):
        for k, v in value.items():
            problems += invariant_problems(v, f"{path}/{k}")
    else:
        problems.append(f"{path}: unsupported type")
    return problems


def reject_duplicate_keys(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError(f"duplicate key in vector file: {keys}")
    return dict(pairs)


def main(path):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f, object_pairs_hook=reject_duplicate_keys)
    failures = 0
    checked = 0
    for v in doc["vectors"]:
        if v["expect"] != "accept":
            continue
        checked += 1
        normalized = v["normalized"]
        problems = invariant_problems(normalized)
        # decimal-typed members in the sample schema are named "ratio"
        if isinstance(normalized, dict) and "ratio" in normalized and not DECIMAL.match(normalized["ratio"]):
            problems.append("ratio: non-canonical decimal")
        text = jcs(normalized)
        if text != v["canonical"]:
            problems.append(f"canonical text mismatch\n    reference {text}\n    vector    {v['canonical']}")
        h = content_hash(v["domainTag"], v["schema"]["id"], v["schema"]["version"], text)
        if h != v["sha256"]:
            problems.append(f"hash mismatch\n    reference {h}\n    vector    {v['sha256']}")
        if problems:
            failures += 1
            print(f"FAIL {v['id']}:")
            for p in problems:
                print(f"  - {p}")
    print(f"reference checker: {checked - failures}/{checked} accepted vectors agree")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "packages/canonical/test-vectors/br-json-v1.vectors.json"))
