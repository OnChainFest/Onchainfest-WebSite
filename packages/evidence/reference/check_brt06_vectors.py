#!/usr/bin/env python3
"""
Independent BRT-06 vector checker (Python standard library only; no shared code with TypeScript).

Canonical vectors: re-derives JCS (RFC 8785) of `normalized` and the domain-separated SHA-256
  SHA-256("BR" || 0x01 || domainTag || 0x00 || schemaId "@" version || 0x00 || "br-json/1" || 0x00 || JCS)
and checks equal-hash groups.

Signing vectors: independently decides accept/reject and compares with `expect`:
  * header rules (RFC 7515 + RFC 7797): protected header has EXACTLY {alg, b64, crit, kid},
    b64 == false, crit == ["b64"], kid == the registered key id, alg == the key's algorithm;
  * payload = "bragging-rights/sig/v1:" || hex(statementHash); input = protected || "." || payload;
  * signature = canonical base64url of EXACTLY 64 bytes (Ed25519 R||S, or ECDSA P-256 R||S —
    never DER);
  * cryptographic verification with its own Ed25519 (RFC 8032 §5.1.7) and ECDSA P-256/SHA-256
    (SEC 1 §4.1.4) implementations.

Key vectors: strict public JWK validation (required members, validated RFC 7517 metadata, no private
members, canonical 32-byte base64url coordinates, point on curve) and RFC 7638 thumbprints, plus
equal-thumbprint groups.

LIMITATION: it does not re-implement input normalization or schema validation (guarded by the
TypeScript generator and the committed file). The pure-Python curve arithmetic is not constant time;
it verifies public test data only.
"""
import base64
import hashlib
import json
import sys

PROFILE = "br-json/1"
PREFIX = "bragging-rights/sig/v1:"


# ───────────────────────────── JCS ─────────────────────────────
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
    pre = b"BR" + bytes([1]) + tag.encode("ascii") + b"\x00" + f"{schema_id}@{version}".encode("ascii") + b"\x00" + PROFILE.encode("ascii") + b"\x00" + text.encode("utf-8")
    return "sha256:" + hashlib.sha256(pre).hexdigest()


# ───────────────────────────── base64url ─────────────────────────────
B64URL = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def b64url_decode_canonical(s):
    """Decodes unpadded base64url and returns None unless the spelling is canonical."""
    if not isinstance(s, str) or not s or any(c not in B64URL for c in s) or len(s) % 4 == 1:
        return None
    raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    return raw if base64.urlsafe_b64encode(raw).decode().rstrip("=") == s else None


# ───────────────────────────── Ed25519 (RFC 8032) ─────────────────────────────
ED_P = 2**255 - 19
ED_L = 2**252 + 27742317777372353535851937790883648493
ED_D = (-121665 * pow(121666, ED_P - 2, ED_P)) % ED_P
ED_SQRT_M1 = pow(2, (ED_P - 1) // 4, ED_P)


def ed_add(P, Q):
    x1, y1, z1, t1 = P
    x2, y2, z2, t2 = Q
    a = (y1 - x1) * (y2 - x2) % ED_P
    b = (y1 + x1) * (y2 + x2) % ED_P
    c = 2 * t1 * t2 * ED_D % ED_P
    d = 2 * z1 * z2 % ED_P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % ED_P, g * h % ED_P, f * g % ED_P, e * h % ED_P)


def ed_mul(k, P):
    Q = (0, 1, 1, 0)
    while k:
        if k & 1:
            Q = ed_add(Q, P)
        P = ed_add(P, P)
        k >>= 1
    return Q


def ed_decompress(b):
    if len(b) != 32:
        return None
    y = int.from_bytes(b, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= ED_P:
        return None
    x2 = (y * y - 1) * pow(ED_D * y * y + 1, ED_P - 2, ED_P) % ED_P
    if x2 == 0:
        if sign:
            return None
        x = 0
    else:
        x = pow(x2, (ED_P + 3) // 8, ED_P)
        if (x * x - x2) % ED_P != 0:
            x = x * ED_SQRT_M1 % ED_P
        if (x * x - x2) % ED_P != 0:
            return None
        if (x & 1) != sign:
            x = ED_P - x
    return (x, y, 1, x * y % ED_P)


def ed_encode(P):
    x, y, z, _ = P
    zi = pow(z, ED_P - 2, ED_P)
    x, y = x * zi % ED_P, y * zi % ED_P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


ED_B = ed_decompress(int.to_bytes(4 * pow(5, ED_P - 2, ED_P) % ED_P, 32, "little"))


def ed25519_verify(public, message, sig):
    A = ed_decompress(public)
    if A is None or len(sig) != 64:
        return False
    R = ed_decompress(sig[:32])
    S = int.from_bytes(sig[32:], "little")
    if R is None or S >= ED_L:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + public + message).digest(), "little") % ED_L
    return ed_encode(ed_mul(S, ED_B)) == ed_encode(ed_add(R, ed_mul(h, A)))


# ───────────────────────────── ECDSA P-256 (SEC 1) ─────────────────────────────
P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
P256_A = P256_P - 3
P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
P256_G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
          0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def ec_on_curve(Pt):
    x, y = Pt
    return 0 <= x < P256_P and 0 <= y < P256_P and (y * y - (x * x * x + P256_A * x + P256_B)) % P256_P == 0


def ec_add(P, Q):
    if P is None:
        return Q
    if Q is None:
        return P
    (x1, y1), (x2, y2) = P, Q
    if x1 == x2 and (y1 + y2) % P256_P == 0:
        return None
    if P == Q:
        m = (3 * x1 * x1 + P256_A) * pow(2 * y1, P256_P - 2, P256_P) % P256_P
    else:
        m = (y2 - y1) * pow(x2 - x1, P256_P - 2, P256_P) % P256_P
    x3 = (m * m - x1 - x2) % P256_P
    return (x3, (m * (x1 - x3) - y1) % P256_P)


def ec_mul(k, P):
    R = None
    while k:
        if k & 1:
            R = ec_add(R, P)
        P = ec_add(P, P)
        k >>= 1
    return R


def es256_verify(x, y, message, sig):
    Q = (int.from_bytes(x, "big"), int.from_bytes(y, "big"))
    if len(sig) != 64 or not ec_on_curve(Q):
        return False
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < P256_N and 1 <= s < P256_N):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, P256_N - 2, P256_N)
    X = ec_add(ec_mul(e * w % P256_N, P256_G), ec_mul(r * w % P256_N, Q))
    return X is not None and X[0] % P256_N == r


# ───────────────────────────── JWK rules ─────────────────────────────
REQUIRED = {"EdDSA": ["crv", "kty", "x"], "ES256": ["crv", "kty", "x", "y"]}
METADATA = {"alg", "use", "key_ops", "kid", "ext"}


def parse_public_jwk(alg, jwk):
    """Returns the normalized public JWK, or None."""
    req = REQUIRED.get(alg)
    if req is None or not isinstance(jwk, dict):
        return None
    if any(m not in jwk for m in req) or any(m not in req and m not in METADATA for m in jwk):
        return None
    if "alg" in jwk and jwk["alg"] != alg:
        return None
    if "use" in jwk and jwk["use"] != "sig":
        return None
    if "ext" in jwk and not isinstance(jwk["ext"], bool):
        return None
    if "kid" in jwk and (not isinstance(jwk["kid"], str) or len(jwk["kid"]) > 200):
        return None
    if "key_ops" in jwk and not (isinstance(jwk["key_ops"], list) and all(o == "verify" for o in jwk["key_ops"])):
        return None
    coords = {}
    for c in req[2:]:
        raw = b64url_decode_canonical(jwk[c])
        if raw is None or len(raw) != 32:
            return None
        coords[c] = raw
    if alg == "EdDSA":
        if jwk["kty"] != "OKP" or jwk["crv"] != "Ed25519" or ed_decompress(coords["x"]) is None:
            return None
        return {"crv": "Ed25519", "kty": "OKP", "x": jwk["x"]}
    if jwk["kty"] != "EC" or jwk["crv"] != "P-256":
        return None
    if not ec_on_curve((int.from_bytes(coords["x"], "big"), int.from_bytes(coords["y"], "big"))):
        return None
    return {"crv": "P-256", "kty": "EC", "x": jwk["x"], "y": jwk["y"]}


def thumbprint(normalized):
    """RFC 7638: SHA-256 over the required members, lexicographic order, no whitespace."""
    text = "{" + ",".join(f'"{k}":"{normalized[k]}"' for k in sorted(normalized)) + "}"
    return base64.urlsafe_b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode().rstrip("=")


def decide_signing(v, keys):
    """Independent accept/reject decision for one signing vector."""
    key = keys[v["key"]]
    header_raw = b64url_decode_canonical(v["protected"])
    if header_raw is None:
        return "reject"
    try:
        pairs = json.loads(header_raw, object_pairs_hook=lambda p: p if len({k for k, _ in p}) == len(p) else None)
    except ValueError:
        return "reject"
    if pairs is None:
        return "reject"
    header = dict(pairs)
    if sorted(header) != ["alg", "b64", "crit", "kid"] or header["b64"] is not False or header["crit"] != ["b64"]:
        return "reject"
    if header["kid"] != v["keyId"] or header["alg"] != key["alg"] or v["alg"] != key["alg"]:
        return "reject"
    payload = PREFIX + v["statementHash"][len("sha256:"):]
    signing_input = v["protected"] + "." + payload
    if v["signingInput"] != signing_input:
        raise AssertionError(f"{v['id']}: recorded signing input is not the RFC 7797 input")
    sig = b64url_decode_canonical(v["signature"])
    if sig is None or len(sig) != 64:
        return "reject"
    message = signing_input.encode("ascii")
    jwk = key["publicJwk"]
    if key["alg"] == "EdDSA":
        ok = ed25519_verify(b64url_decode_canonical(jwk["x"]), message, sig)
    else:
        ok = es256_verify(b64url_decode_canonical(jwk["x"]), b64url_decode_canonical(jwk["y"]), message, sig)
    return "accept" if ok else "reject"


def main(path):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    failures = []
    by_id = {}
    for v in doc["canonical"]:
        by_id[v["id"]] = v
        if v["expect"] != "accept":
            if not str(v.get("error", "")).startswith("BRJ_"):
                failures.append(f"{v['id']}: reject vector without a rule code")
            continue
        text = jcs(v["normalized"])
        if text != v["canonical"]:
            failures.append(f"{v['id']}: JCS mismatch")
        if content_hash(v["domainTag"], v["schema"]["id"], v["schema"]["version"], text) != v["hash"]:
            failures.append(f"{v['id']}: hash mismatch")
    for group in doc["equalHashGroups"]:
        if len({by_id[i]["hash"] for i in group}) != 1:
            failures.append(f"equal-hash group {group} differs")

    keys = doc["vectorKeys"]
    for name, k in keys.items():
        norm = parse_public_jwk(k["alg"], k["publicJwk"])
        if norm is None or thumbprint(norm) != k["thumbprint"]:
            failures.append(f"vector key {name}: invalid or thumbprint mismatch")
    signature_checks = 0
    for v in doc["signing"]:
        try:
            got = decide_signing(v, keys)
        except AssertionError as e:
            failures.append(str(e))
            continue
        signature_checks += 1
        if got != v["expect"]:
            failures.append(f"{v['id']}: independent decision {got} != expected {v['expect']}")
    accepted_algs = sorted(v["alg"] for v in doc["signing"] if v["expect"] == "accept")
    if accepted_algs != ["ES256", "EdDSA"]:
        failures.append(f"expected one accepted EdDSA and one accepted ES256 vector, got {accepted_algs}")

    tps = {}
    for k in doc["keys"]:
        norm = parse_public_jwk(k["alg"], k["jwk"])
        got = "accept" if norm is not None else "reject"
        if got != k["expect"]:
            failures.append(f"{k['id']}: independent JWK decision {got} != expected {k['expect']}")
        elif norm is not None:
            tps[k["id"]] = thumbprint(norm)
            if tps[k["id"]] != k["thumbprint"]:
                failures.append(f"{k['id']}: RFC 7638 thumbprint mismatch")
    for group in doc["equalThumbprintGroups"]:
        if len({tps.get(i) for i in group}) != 1:
            failures.append(f"equal-thumbprint group {group} differs")

    total = len(doc["canonical"]) + len(doc["signing"]) + len(doc["keys"])
    if failures:
        print("\n".join(failures))
        print(f"FAILED: {len(failures)} problem(s) in {total} BRT-06 vectors")
        return 1
    print(f"OK: independent checker reproduced {total} BRT-06 vectors (JCS + domain-separated hashes; "
          f"{signature_checks} signatures verified/rejected with its own Ed25519 and P-256 ECDSA; "
          f"{len(doc['keys'])} JWK/RFC 7638 cases)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
