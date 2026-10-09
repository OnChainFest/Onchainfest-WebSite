#!/usr/bin/env python3
"""
Independent BRT-10 Step 11 API vector checker (Python standard library only; no shared code with the
TypeScript implementation).

For every vector it:
  1. parses the vector;
  2. RECONSTRUCTS the expected DTO from the vector's input, from the published contract (schema tags,
     computed PLATFORM label, OFFICIAL owner publication NOT_AVAILABLE, read-time staleness reduced to
     {state, reasons} with sorted unique reasons, Mark display "<value> <unit>", a private athlete never
     identified, staff run reasons sorted, error envelopes as pinned);
  3. canonicalizes it with its own JCS (RFC 8785) implementation;
  4. computes SHA-256 over the JCS text (no domain tag: a DTO is a response document);
  5. compares both with the committed canonicalText and digest;
  6. scans every PUBLIC DTO for forbidden members (basis topology, pins, staleness lists, staleDigest,
     run / verification / evidence / owner / account identifiers, stored flags);
  7. fails if any input topology value (staleness `affected` / `notCurrent` / `added` / `removed` ids,
     the staleDigest, a private athlete's holder id) appears anywhere in a PUBLIC DTO.

It also requires the minimum coverage the Step 11 contract names (published PLATFORM system, snapshot,
leaderboard, as-published and as-corrected history, CURRENT and STALE snapshot, classification, STALE
classification, correction lineage, error envelopes for malformed / unknown identifiers, empty history).
"""
import hashlib
import json
import sys

PLATFORM_LABEL = "Bragging Rights platform ranking"
FORBIDDEN = {
    "basis", "resultVersionIds", "derivedFrom", "pinnedInputIds", "notCurrent", "added", "removed",
    "affected", "staleDigest", "document", "verificationRunId", "evidenceCommitment",
    "evidenceBundleHash", "hold", "runId", "runInputHash", "runOutcomeHash", "owner",
    "ownerPrincipalId", "anchorId", "accountId", "requestedByAccountId", "publishedByAccountId",
    "candidates", "isStale", "isCurrent", "stale", "isQualified",
}
REQUIRED = [
    "system/platform-published", "system/official-owner-publication-unavailable",
    "history/as-published-keeps-every-snapshot", "history/as-corrected-replaces-corrected",
    "history/empty", "snapshot/current", "snapshot/stale-topology-omitted",
    "snapshot/correction-lineage", "leaderboard/shared-ties-private-and-team",
    "classification/current", "classification/stale-topology-omitted",
    "classificationEntries/shared-rank", "staffRun/blocked-with-blockers",
    "error/snapshot-not-found", "error/malformed-snapshot-id", "error/invalid-cursor",
    "error/projection-mismatch",
]


def jcs(value):
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None or isinstance(value, float):
        raise ValueError("null / floating point are not representable")
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


def opt(d, key, value):
    if value is not None:
        d[key] = value
    return d


# ─────────────── independent DTO reconstruction ───────────────

def system(c):
    d = {
        "schema": "br:public-ranking-system@1",
        "systemId": c["systemId"], "code": c["code"], "name": c["name"],
        "displayName": c["displayName"], "kind": c["kind"], "method": c["method"],
        "version": opt({"latest": c["latestVersion"], "lifecycle": c["latestLifecycle"],
                        "specHash": c["latestSpecHash"]}, "published", c.get("publishedVersion")),
        "universe": {"disciplineVersionId": c["disciplineVersionId"],
                     "metric": {"key": c["metricKey"], "markMetricId": c["markMetricId"]},
                     "holderType": c["holderType"]},
        "requirements": {"recognitionLevel": c["recognitionLevel"],
                         "minimumVerificationLevel": c["minimumVerificationLevel"]},
        "effectiveFrom": c["effectiveFrom"],
    }
    if c["kind"] == "PLATFORM":
        d["label"] = PLATFORM_LABEL
    else:
        d["ownerPublication"] = {"status": "NOT_AVAILABLE", "reason": "OWNER_PUBLICATION_UNAVAILABLE"}
    return d


def summary(c):
    lineage = {"kind": c["lineageKind"], "reasons": sorted(set(c["lineageReasons"])),
               "chainPosition": c["chainPosition"]}
    opt(lineage, "priorSnapshotId", c.get("priorSnapshotId"))
    opt(lineage, "priorSnapshotHash", c.get("priorSnapshotHash"))
    opt(lineage, "correctedBy", c.get("correctedBySnapshotId"))
    d = {
        "snapshotId": c["snapshotId"], "snapshotHash": c["snapshotHash"],
        "system": {"systemId": c["systemId"], "code": c["systemCode"],
                   "systemVersionId": c["systemVersionId"], "version": c["systemVersion"],
                   "specHash": c["specHash"]},
        "kind": c["kind"], "method": c["method"], "engineVersion": c["engineVersion"],
        "asOf": c["asOf"], "publishedAt": c["publishedAt"], "lineage": lineage,
        "entryCount": c["entryCount"],
    }
    if c["kind"] == "PLATFORM":
        d["label"] = PLATFORM_LABEL
    opt(d, "corrects", c.get("corrects"))
    return d


def staleness(s, reasons_of):
    if s["state"] == "CURRENT":
        return {"state": "CURRENT", "reasons": []}
    return {"state": "STALE", "reasons": sorted(set(reasons_of(s)))}


def leaderboard_entry(e):
    holder = ({"holderType": "TEAM", "teamId": e["holderId"], "display": e["display"]}
              if e["holderType"] == "TEAM" else {"holderType": "ATHLETE", "display": e["display"]})
    v = e["value"]
    return {"rank": e["rank"], "tied": e["tied"], "holder": holder,
            "value": {**v, "display": f"{v['value']} {v['unit']}"},
            "comparatorTrace": [{"key": t["key"], "order": t["order"], "value": t["value"]}
                                for t in e["comparatorTrace"]],
            "basisCount": e["basisCount"]}


def classification(c, s):
    return {
        "schema": "br:public-classification@1",
        "classification": {
            "resultVersionId": c["resultVersionId"], "resultId": c["resultId"],
            "scopeType": c["scopeType"], "scopeTargetId": c["scopeTargetId"],
            "versionNumber": c["versionNumber"], "status": c["status"],
            "statusSince": c["statusSince"], "submittedAt": c["submittedAt"],
            "contentHash": c["contentHash"], "entryCount": c["entryCount"],
            "provenance": {
                "available": True,
                "policy": {"policyId": c["policyId"], "policyVersionId": c["policyVersionId"],
                           "specHash": c["policySpecHash"]},
                "disciplineVersionId": c["disciplineVersionId"], "engineVersion": c["engineVersion"],
                "inputsDigest": c["inputsDigest"], "inputCount": c["inputCount"],
            },
        },
        "readTime": {"staleness": staleness(s, lambda x: x["document"]["reasons"])},
    }


def rebuild(v):
    k, i = v["kind"], v["input"]
    if k == "system":
        return system(i)
    if k == "systemList":
        return opt({"schema": "br:public-ranking-system-list@1", "items": [system(c) for c in i["cards"]]},
                   "nextCursor", i.get("nextCursor"))
    if k == "history":
        return opt({"schema": "br:public-ranking-snapshot-history@1", "systemId": i["systemId"],
                    "view": i["view"], "items": [summary(c) for c in i["cards"]]},
                   "nextCursor", i.get("nextCursor"))
    if k == "snapshot":
        return {"schema": "br:public-ranking-snapshot@1", "snapshot": summary(i["card"]),
                "readTime": {"staleness": staleness(i["staleness"], lambda x: x["reasons"])}}
    if k == "leaderboard":
        return opt({"schema": "br:public-ranking-leaderboard@1", "snapshotId": i["snapshotId"],
                    "snapshotHash": i["snapshotHash"],
                    "entries": [leaderboard_entry(e) for e in i["entries"]]},
                   "nextCursor", i.get("nextCursor"))
    if k == "classification":
        return classification(i["card"], i["staleness"])
    if k == "classificationEntries":
        return opt({"schema": "br:public-classification-entries@1",
                    "resultVersionId": i["resultVersionId"], "contentHash": i["contentHash"],
                    "entries": [{"participantId": e["participantId"], "display": e["display"],
                                 "rank": e["rank"], "tied": e["tied"],
                                 "tieBreakKeys": [{"key": t["key"], "order": t["order"], "value": t["value"]}
                                                  for t in e["tieBreakKeys"]]}
                                for e in i["entries"]]},
                   "nextCursor", i.get("nextCursor"))
    if k == "staffRun":
        run = {**i["card"], "publicationReasons": sorted(set(i["card"]["publicationReasons"]))}
        return {"schema": "br:staff-ranking-run@1", "run": run,
                "candidates": [{**c, "reasons": sorted(set(c["reasons"]))} for c in i["candidates"]]}
    if k == "error":
        e = i["body"]["error"]
        if not isinstance(i["status"], int) or not (400 <= i["status"] <= 599):
            raise ValueError("error status out of range")
        if set(e) - {"code", "message", "reason"}:
            raise ValueError("error envelope carries an unexpected member")
        return {"error": dict(e)}
    raise ValueError(f"unknown kind {k}")


# ─────────────── leak scans ───────────────

def forbidden_members(node, path=""):
    out = []
    if isinstance(node, list):
        for n, x in enumerate(node):
            out += forbidden_members(x, f"{path}/{n}")
    elif isinstance(node, dict):
        for key, x in node.items():
            if key in FORBIDDEN:
                out.append(f"{path}/{key}")
            out += forbidden_members(x, f"{path}/{key}")
    return out


def topology_values(v):
    """Input values that must never reach a public DTO."""
    i, out = v["input"], set()
    s = i.get("staleness") if isinstance(i, dict) else None
    if isinstance(s, dict):
        for a in s.get("affected", []):
            out |= {a["resultVersionId"], a.get("verificationRunId", "")}
        doc = s.get("document", {})
        for key in ("notCurrent", "added", "removed"):
            out |= {p["resultVersionId"] for p in doc.get(key, [])}
        if "staleDigest" in s:
            out.add(s["staleDigest"])
    if v["kind"] == "leaderboard":
        out |= {e["holderId"] for e in i["entries"] if e["holderType"] == "ATHLETE"}
    out.discard("")
    return out


def main(path):
    doc = json.load(open(path, encoding="utf-8"))
    if doc.get("schema") != "br:brt-10-api-vectors@1":
        raise SystemExit("unexpected corpus schema")
    names, failures = set(), []
    for v in doc["vectors"]:
        name = v["name"]
        if name in names:
            failures.append(f"{name}: duplicate name")
        names.add(name)
        try:
            text = jcs(rebuild(v))
        except (KeyError, ValueError) as e:
            failures.append(f"{name}: cannot rebuild ({e})")
            continue
        if text != v["canonicalText"]:
            failures.append(f"{name}: canonical DTO differs from the independent reconstruction")
        if jcs(json.loads(v["canonicalText"])) != v["canonicalText"]:
            failures.append(f"{name}: committed text is not JCS")
        digest = "sha256:" + hashlib.sha256(v["canonicalText"].encode("utf-8")).hexdigest()
        if digest != v["digest"]:
            failures.append(f"{name}: digest mismatch")
        dto = json.loads(v["canonicalText"])
        if v["visibility"] == "PUBLIC":
            bad = forbidden_members(dto)
            if bad:
                failures.append(f"{name}: forbidden members {bad}")
            leaked = [t for t in topology_values(v) if t in v["canonicalText"]]
            if leaked:
                failures.append(f"{name}: input topology leaked into the public DTO {leaked}")
            if not str(dto.get("schema", "")).startswith("br:public-"):
                failures.append(f"{name}: public DTO without a br:public-* schema tag")
        elif v["visibility"] == "STAFF":
            if dto.get("schema") != "br:staff-ranking-run@1" or "staleDigest" in v["canonicalText"]:
                failures.append(f"{name}: staff DTO tag / content")
    for r in REQUIRED:
        if r not in names:
            failures.append(f"missing required vector {r}")
    if failures:
        for f in failures:
            print("FAIL:", f)
        raise SystemExit(1)
    print(f"OK: {len(doc['vectors'])} BRT-10 API vectors rebuilt independently; JCS, digests and leak scans hold.")


if __name__ == "__main__":
    main(sys.argv[1])
