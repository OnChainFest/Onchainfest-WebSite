#!/usr/bin/env python3
"""
Independent BRT-10 ranking / classification vector checker (Python standard library only; no shared
code with the TypeScript implementation).

For every vector it re-derives JCS (RFC 8785) of the parsed canonical text — which must reproduce the
committed text byte for byte — and the domain-separated hash
  SHA-256("BR" || 0x01 || domainTag || 0x00 || schemaId "@" version || 0x00 || "br-json/1" || 0x00 || JCS)
It checks equal / distinct groups and that no vector carries a float, null or score-like member. Then:

  ranking run outcomes   inputHash binds the input vector; NO_RANKED_ENTRIES is a publication reason
                         iff there are no entries (never a candidate reason) and BLOCKED iff any
                         publication reason; every input candidate is accounted for
                         exactly once; each entry value is byte-equal to the Mark of every basis
                         candidate, which is INCLUDED; the entry is the holder's best over its INCLUDED
                         and NOT_HOLDER_BEST candidates (NOT_HOLDER_BEST strictly worse); ranks are
                         recomputed competition-style (rank = 1 + strictly better; tied iff shared).
  classification         inputsDigest binds the input vector; every input `@1` content re-hashes to its
  derivations            pinned contentHash; only PROPOSED carries content, which equals (byte for byte)
                         and hashes to its content vector and pins the same inputsDigest; derivedFrom is
                         exactly the inputs; the comparator trace is RECOMPUTED from the input (outcome
                         points SUM, then SUM / MAX / MIN of the declared source per key) and the shared
                         ranks recomputed lexicographically.
  classification         (Step 7) each `br:classification-staleness@1` document is RECOMPUTED from its
  staleness              content vector's derivedFrom pins and the committed observation: notCurrent =
                         pins not observed current (unknown counts), added = admissible − pinned,
                         removed = pinned − admissible − notCurrent, the reasons that follow, and the
                         version / content / inputsDigest binding. It carries no input status. Every
                         fresh case recomputes to no reason at all (CURRENT: no document exists).

LIMITATION: it does not re-run gate admissibility or policy validation (the TypeScript engine does);
it proves the hashes, the bindings, the selection, the aggregation and the ranking of the committed
documents.
"""
import hashlib
import json
import sys
from decimal import Decimal

PROFILE = "br-json/1"
FORBIDDEN = {"confidence", "trustScore", "score", "probability", "weight", "certaintyPercent", "greatness", "popularity", "isStale", "stale"}


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


def better(order, a, b):
    """1 if a is strictly better than b under `order`, -1 if worse, 0 if equal (exact decimals)."""
    x, y = Decimal(a), Decimal(b)
    if x == y:
        return 0
    return (1 if x > y else -1) * (1 if order == "HIGHER_IS_BETTER" else -1)


def check_ranks(items, cmp, label, failures):
    """Competition-style shared ranks, recomputed: rank = 1 + strictly better; tied iff shared."""
    for a in items:
        expect_rank = 1 + sum(1 for b in items if cmp(b, a) > 0)
        expect_tied = sum(1 for b in items if cmp(b, a) == 0) > 1
        if a["rank"] != expect_rank or a["tied"] != expect_tied:
            failures.append(f"{label}: rank/tied {a['rank']}/{a['tied']} != recomputed {expect_rank}/{expect_tied}")


def check_run(name, outcome, inp, failures):
    key = lambda c: (c["resultVersionId"], c["participantId"], c.get("ordinal", c.get("performanceOrdinal")))
    cands = {key(c): c for c in inp["candidates"]}
    states = {key(c): c for c in outcome["candidates"]}
    if sorted(cands) != sorted(states) or len(states) != len(outcome["candidates"]):
        failures.append(f"{name}: not every candidate is accounted for exactly once")
        return
    # Run-level publication rule: a snapshot always ranks someone (NO_RANKED_ENTRIES iff no entries),
    # and the run-level blocker is never a candidate reason.
    pub = outcome["publication"]
    if ("NO_RANKED_ENTRIES" in pub["reasons"]) != (len(outcome["entries"]) == 0):
        failures.append(f"{name}: NO_RANKED_ENTRIES must be present iff the run ranked nobody")
    if (pub["state"] == "BLOCKED") != bool(pub["reasons"]):
        failures.append(f"{name}: publication state and reasons disagree")
    if any("NO_RANKED_ENTRIES" in c["reasons"] for c in outcome["candidates"]):
        failures.append(f"{name}: NO_RANKED_ENTRIES appears as a candidate reason")
    order = inp["system"]["spec"]["comparator"]["keys"][0]["order"]
    holder = lambda c: (c["holder"]["holderType"], c["holder"]["holderId"]) if "holder" in c else None
    entries = {(e["holder"]["holderType"], e["holder"]["holderId"]): e for e in outcome["entries"]}
    for e in outcome["entries"]:
        trace = e["comparatorTrace"]
        if len(trace) != 1 or trace[0]["order"] != order or Decimal(trace[0]["value"]) != Decimal(e["value"]["value"]):
            failures.append(f"{name}: comparator trace differs from the ranked mark")
        for b in e["basis"]:
            c = cands.get((b["resultVersionId"], b["participantId"], b["performanceOrdinal"]))
            if c is None or c["mark"] != e["value"] or states[key(c)]["state"] != "INCLUDED":
                failures.append(f"{name}: basis is not an INCLUDED candidate with the byte-equal Mark")
    for k, s in states.items():
        c = cands[k]
        if s["state"] in ("INCLUDED", "NOT_HOLDER_BEST"):
            e = entries.get(holder(c))
            if e is None:
                failures.append(f"{name}: admissible candidate without a holder entry")
                continue
            rel = better(order, c["mark"]["value"], e["value"]["value"])
            if (s["state"] == "INCLUDED" and rel != 0) or (s["state"] == "NOT_HOLDER_BEST" and rel >= 0):
                failures.append(f"{name}: holder-best selection disagrees for {k}")
            if s["state"] == "INCLUDED" and not any(
                (b["resultVersionId"], b["participantId"], b["performanceOrdinal"]) == k for b in e["basis"]
            ):
                failures.append(f"{name}: an equal best mark was silently dropped from the basis")
        elif not s["reasons"]:
            failures.append(f"{name}: excluded candidate without a blocker")
    check_ranks(outcome["entries"], lambda a, b: better(order, a["value"]["value"], b["value"]["value"]), name, failures)


def aggregate(agg, values):
    if agg == "SUM":
        return sum((Decimal(v) for v in values), Decimal(0))
    ds = [Decimal(v) for v in values]
    return max(ds) if agg == "MAX" else min(ds)


def check_derivation(name, outcome, inp, content_vec, failures):
    for i in inp["inputs"]:
        if content_hash("result-version-content", "br:result-version-content", 1, jcs(i["content"])) != i["contentHash"]:
            if not any(x["resultVersionId"] == i["resultVersionId"] and "CONTENT_HASH_MISMATCH" in x["reasons"] for x in outcome["inputs"]):
                failures.append(f"{name}: input content does not re-hash and was not reported")
    if sorted(x["resultVersionId"] for x in outcome["inputs"]) != sorted(i["resultVersionId"] for i in inp["inputs"]):
        failures.append(f"{name}: not every input is accounted for")
    proposed = outcome["state"] == "PROPOSED"
    if proposed != ("proposal" in outcome) or proposed == bool(outcome["blockers"]):
        failures.append(f"{name}: state / proposal / blockers are inconsistent")
    if not proposed:
        return
    content = outcome["proposal"]["content"]
    cv, cparsed = content_vec
    if outcome["proposal"]["contentHash"] != cv["hash"] or jcs(content) != cv["canonicalText"]:
        failures.append(f"{name}: proposal does not bind its content vector")
    d = content["derivation"]
    if d["inputsDigest"] != outcome["inputsDigest"] or d["policy"]["specHash"] != inp["policy"]["specHash"]:
        failures.append(f"{name}: derivation pins do not bind the input")
    pins = sorted((x["resultVersionId"], x["contentHash"], x["status"]) for x in d["derivedFrom"])
    if pins != sorted((i["resultVersionId"], i["contentHash"], i["status"]) for i in inp["inputs"]):
        failures.append(f"{name}: derivedFrom is not exactly the inputs")
    # Recompute every participant's trace from the inputs.
    spec = inp["policy"]["spec"]
    participants = sorted({e["participantId"] for i in inp["inputs"] for e in i["content"]["entries"]})
    traces = {p: [] for p in participants}
    if spec["primary"] == "HEAD_TO_HEAD_WINNER":
        pts = {o["outcome"]: o["points"] for o in spec["outcomePoints"]}
        for p in participants:
            total = sum(pts[e["outcome"]] for i in inp["inputs"] for e in i["content"]["entries"] if e["participantId"] == p)
            traces[p].append(("HIGHER_IS_BETTER", Decimal(total)))
    for k in spec["keys"]:
        for p in participants:
            values = []
            for i in inp["inputs"]:
                c = i["content"]
                if not any(e["participantId"] == p for e in c["entries"]):
                    continue
                if k["source"] == "ENTRY_PRIMARY_MARK":
                    values += [e["primaryMark"]["value"] for e in c["entries"] if e["participantId"] == p]
                else:
                    values += [x["mark"]["value"] for x in c.get("performances", [])
                               if x["participantId"] == p and x["mark"]["metricId"] == k["markMetricId"] and x.get("valid", True)]
            traces[p].append((k["order"], aggregate(k["aggregation"], values)))
    entries = {e["participantId"]: e for e in content["entries"]}
    if sorted(entries) != participants:
        failures.append(f"{name}: classification entries are not exactly the participants")
        return
    for p, t in traces.items():
        got = [(x["order"], Decimal(x["value"])) for x in entries[p]["tieBreakKeys"]]
        if got != t:
            failures.append(f"{name}: recomputed trace for {p} {t} != committed {got}")

    def cmp(a, b):
        for x, y in zip(a["tieBreakKeys"], b["tieBreakKeys"]):
            r = better(x["order"], x["value"], y["value"])
            if r != 0:
                return r
        return 0

    check_ranks(content["entries"], cmp, name, failures)


def staleness_of(content, case):
    """Recomputes (reasons, notCurrent, added, removed) from the pins and the observation."""
    pins = {p["resultVersionId"]: p["contentHash"] for p in content["derivation"]["derivedFrom"]}
    current = case["current"]
    not_current = sorted(i for i in pins if current.get(i) is not True)
    reasons, added, removed = set(), [], []
    if case["admissible"] is None:
        reasons.add("ADMISSIBLE_INPUT_SET_UNKNOWN")
    else:
        adm = {p["resultVersionId"]: p["contentHash"] for p in case["admissible"]}
        added = [{"resultVersionId": i, "contentHash": adm[i]} for i in sorted(adm) if i not in pins]
        removed = [{"resultVersionId": i, "contentHash": pins[i]} for i in sorted(pins)
                   if i not in adm and i not in not_current]
        if added or removed:
            reasons.add("ADMISSIBLE_INPUT_SET_CHANGED")
    if not_current:
        reasons.add("PINNED_INPUT_NOT_CURRENT")
    return sorted(reasons), [{"resultVersionId": i, "contentHash": pins[i]} for i in not_current], added, removed


def check_staleness(name, doc, case, content_vec, failures):
    if content_vec is None:
        failures.append(f"{name}: staleness without its content vector")
        return
    cv, content = content_vec
    if (doc["classificationVersionId"] != case["classificationVersionId"] or doc["contentHash"] != cv["hash"]
            or doc["inputsDigest"] != content["derivation"]["inputsDigest"]):
        failures.append(f"{name}: staleness does not bind its classification version / content / inputsDigest")
    reasons, not_current, added, removed = staleness_of(content, case)
    if sorted(doc["reasons"]) != reasons:
        failures.append(f"{name}: recomputed reasons {reasons} != committed {sorted(doc['reasons'])}")
    for key, want in (("notCurrent", not_current), ("added", added), ("removed", removed)):
        if sorted(doc[key], key=lambda p: p["resultVersionId"]) != want:
            failures.append(f"{name}: recomputed {key} differs")
    if "status" in members(doc, set()):
        failures.append(f"{name}: a staleness document must not carry input statuses")


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
            failures.append(f"{v['name']}: score-like / stored-staleness members {sorted(bad)}")
        by_name[v["name"]] = (v, parsed)
    for group in doc["equal"]:
        if len({by_name[n][0]["hash"] for n in group}) != 1:
            failures.append(f"equal group differs: {group}")
    for group in doc["distinct"]:
        if len({by_name[n][0]["hash"] for n in group}) != len(group):
            failures.append(f"distinct group collides: {group}")
    for v, parsed in by_name.values():
        if v["kind"] == "runOutcome":
            iv, inp = by_name[v["inputVector"]]
            if parsed["inputHash"] != iv["hash"]:
                failures.append(f"{v['name']}: inputHash does not bind its input vector")
            if parsed["publication"]["state"] != v["expectState"]:
                failures.append(f"{v['name']}: publication state differs from expectState")
            check_run(v["name"], parsed, inp, failures)
        elif v["kind"] == "derivationOutcome":
            iv, inp = by_name[v["inputVector"]]
            if parsed["inputsDigest"] != iv["hash"]:
                failures.append(f"{v['name']}: inputsDigest does not bind its input vector")
            if parsed["state"] != v["expectState"]:
                failures.append(f"{v['name']}: state differs from expectState")
            cv = by_name.get(v.get("contentVector", ""))
            check_derivation(v["name"], parsed, inp, cv, failures)
        elif v["kind"] == "staleness":
            case = v["stalenessCase"]
            check_staleness(v["name"], parsed, case, by_name.get(case["contentVector"]), failures)
    for case in doc.get("freshCases", []):
        cv = by_name.get(case["contentVector"])
        if cv is None or staleness_of(cv[1], case)[0]:
            failures.append(f"fresh case over {case['contentVector']} does not recompute as CURRENT")
    if failures:
        for f in failures:
            print("FAIL", f)
        sys.exit(1)
    print(f"OK: {len(doc['vectors'])} BRT-10 vectors — JCS, hashes, equal/distinct groups, input/outcome/content bindings, holder-best selection, aggregation, shared ranks and classification staleness independently verified.")


if __name__ == "__main__":
    main(sys.argv[1])
