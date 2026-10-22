#!/usr/bin/env python3
"""ONCHAINFEST-LEGAL-04/06 · Legal hub deployment artifact: package, verify, stage, check.

Standard library only. The build job (no secrets) packages legal/dist; the deploy job runs this
file from the TRUSTED commit (never from the artifact) and treats the artifact as untrusted data.

  package    --dist DIR --out DIR --repository R --sha S --run-id N --event E
  selfcheck  --dir DIR --repository R --sha S --run-id N
  verify     --zip FILE --digest sha256:HEX --repository R --sha S --run-id N
             --mode preview|production --out DIR
  workspace  --vercel-json FILE --out DIR
  check-ids  --project-id ID --website-project-id ID
  check-link --project-json FILE --project-id ID --website-project-id ID
  check-output --output DIR --public DIR --target preview|production
  check-project --project-api FILE --project-id ID
  check-deployment --deployment FILE --aliases FILE --probes FILE --project-id ID
             --mode preview|production

Every check fails closed: any doubt is an error, and nothing is written before everything passed.
"""

import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import zipfile

SCHEMA = "oncf-legal-hub-artifact/1"
MARKER = '<meta name="oncf-site" content="legal-hub" />'

# Exactly the files the hub builds (legal/src/build.mjs): pages per locale, 404, robots, assets.
SITE_PATH = re.compile(
    r"^((es/)?(terms|privacy)\.html|(es/)?products/[a-z0-9-]+\.html|index\.html|es\.html"
    r"|404\.html|robots\.txt|assets/(legal\.css|logo\.png|favicon\.ico))$"
)
REQUIRED = {
    "index.html", "terms.html", "privacy.html", "es.html", "es/terms.html", "es/privacy.html",
    "404.html", "robots.txt", "assets/legal.css", "assets/logo.png", "assets/favicon.ico",
}
ROBOTS_DRAFT = "User-agent: *\nDisallow: /\n"
ROBOTS_FINAL = "User-agent: *\nAllow: /\n"

MAX_FILES = 64
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024
MAX_ZIP_BYTES = 4 * 1024 * 1024

# Active content never allowed in a page (the hub ships none; CSP blocks it as well).
HTML_FORBIDDEN = re.compile(
    r"<script|<iframe|<object|<embed|<form|<base\b|<meta[^>]+http-equiv|\son[a-z]+\s*="
    r"|javascript:|vbscript:|data:",
    re.IGNORECASE,
)
CSS_FORBIDDEN = re.compile(
    r"@import|url\s*\(|expression\s*\(|javascript:|(?<![\w-])behavior\s*:", re.IGNORECASE
)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
ICO_MAGIC = b"\x00\x00\x01\x00"
DRAFT_SIGNS = ('class="review', 'class="draft-banner', 'content="noindex')

# Keys a trusted legal/vercel.json may carry; anything that adds code or routing is refused.
VERCEL_JSON_KEYS = {
    "$schema", "framework", "buildCommand", "outputDirectory", "cleanUrls", "trailingSlash",
    "git", "headers", "rewrites",
}
# The only routing allowed. With cleanUrls, `vercel build` serves index.html at /index, not at /
# (LEGAL-05); this internal rewrite serves the home page at /.
ROOT_REWRITES = [{"source": "/", "destination": "/index"}]
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
# A request without a Vercel session to a protected deployment is sent to Vercel's login.
SSO_LOGIN = "https://vercel.com/sso-api?"
# Pulled project settings that must be empty so `vercel build` only copies public/.
EMPTY_SETTINGS = ("framework", "buildCommand", "installCommand", "devCommand", "outputDirectory")


class ArtifactError(Exception):
    pass


def fail(message):
    raise ArtifactError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------------- content


def check_content(path, data, mode):
    """Type and content rules for one site file."""
    if not SITE_PATH.match(path):
        fail(f"unexpected file: {path}")
    if len(data) > MAX_FILE_BYTES:
        fail(f"file too large: {path}")
    if path.endswith(".html"):
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            fail(f"not UTF-8: {path}")
        if not text.startswith("<!doctype html>\n"):
            fail(f"not an HTML document: {path}")
        if MARKER not in text:
            fail(f"missing legal-hub marker: {path}")
        if HTML_FORBIDDEN.search(text):
            fail(f"active content in {path}")
        if mode == "production" and any(sign in text for sign in DRAFT_SIGNS):
            fail(f"draft, review marker or noindex in a production artifact: {path}")
    elif path.endswith(".css"):
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            fail(f"not UTF-8: {path}")
        if CSS_FORBIDDEN.search(text):
            fail(f"external or active content in {path}")
    elif path.endswith(".png"):
        if not data.startswith(PNG_MAGIC):
            fail(f"not a PNG: {path}")
    elif path.endswith(".ico"):
        if not data.startswith(ICO_MAGIC):
            fail(f"not an ICO: {path}")
    elif path == "robots.txt":
        allowed = (ROBOTS_FINAL,) if mode == "production" else (ROBOTS_DRAFT, ROBOTS_FINAL)
        if data.decode("utf-8", "replace") not in allowed:
            fail("unexpected robots.txt")
    else:
        fail(f"unsupported file type: {path}")


def check_site(files, mode):
    """files: {path: bytes}. Whole-site rules."""
    if len(files) > MAX_FILES:
        fail("too many files")
    if sum(len(d) for d in files.values()) > MAX_TOTAL_BYTES:
        fail("artifact too large")
    missing = REQUIRED - set(files)
    if missing:
        fail(f"missing required files: {', '.join(sorted(missing))}")
    for path, data in files.items():
        check_content(path, data, mode)


def build_manifest(files, repository, sha, run_id, event):
    return {
        "schema": SCHEMA,
        "repository": repository,
        "sha": sha,
        "run_id": str(run_id),
        "event": event,
        "files": {
            p: {"sha256": sha256(d), "size": len(d)} for p, d in sorted(files.items())
        },
    }


def check_manifest(raw, files, repository, sha, run_id):
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        fail("manifest is not JSON")
    if not isinstance(manifest, dict) or set(manifest) != {
        "schema", "repository", "sha", "run_id", "event", "files",
    }:
        fail("manifest has unexpected keys")
    if manifest["schema"] != SCHEMA:
        fail("unknown manifest schema")
    if manifest["repository"] != repository:
        fail("manifest repository mismatch")
    if manifest["sha"] != sha:
        fail("manifest commit does not match the workflow run")
    if manifest["run_id"] != str(run_id):
        fail("manifest run id does not match the workflow run")
    expected = {p: {"sha256": sha256(d), "size": len(d)} for p, d in files.items()}
    if manifest["files"] != expected:
        fail("manifest file list or hashes do not match the artifact")
    return manifest


# --------------------------------------------------------------------------------- package


def read_dist(dist):
    files = {}
    for root, dirs, names in os.walk(dist, followlinks=False):
        for name in dirs + names:
            full = os.path.join(root, name)
            if os.path.islink(full):
                fail(f"symlink in build output: {os.path.relpath(full, dist)}")
        for name in names:
            full = os.path.join(root, name)
            if not stat.S_ISREG(os.lstat(full).st_mode):
                fail(f"not a regular file: {os.path.relpath(full, dist)}")
            rel = os.path.relpath(full, dist).replace(os.sep, "/")
            with open(full, "rb") as handle:
                files[rel] = handle.read()
    return files


def package(dist, out, repository, sha, run_id, event):
    files = read_dist(dist)
    check_site(files, "preview")
    if os.path.exists(out) and os.listdir(out):
        fail(f"output directory is not empty: {out}")
    for path, data in files.items():
        target = os.path.join(out, "site", *path.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(data)
    manifest = build_manifest(files, repository, sha, run_id, event)
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
    return manifest


def zip_dir(directory):
    """A zip like the one actions/upload-artifact makes of `directory` (for selfcheck/tests)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, _, names in os.walk(directory):
            for name in sorted(names):
                full = os.path.join(root, name)
                archive.write(full, os.path.relpath(full, directory).replace(os.sep, "/"))
    return buffer.getvalue()


# ---------------------------------------------------------------------------------- verify


def safe_entry_name(name):
    if not name or "\\" in name or "\x00" in name or name.startswith("/") or ":" in name:
        return False
    parts = name.rstrip("/").split("/")
    return all(part not in ("", ".", "..") and not part.startswith(".") for part in parts)


def read_zip(blob):
    """Entries of the artifact zip as {name: bytes}; rejects anything that is not a plain file."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        fail("artifact is not a zip archive")
    entries = {}
    total = 0
    infos = archive.infolist()
    if len(infos) > MAX_FILES * 2:
        fail("too many zip entries")
    for info in infos:
        name = info.filename
        if not safe_entry_name(name):
            fail(f"unsafe path in artifact: {name!r}")
        if info.flag_bits & 0x1:
            fail(f"encrypted entry: {name}")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            fail(f"symlink in artifact: {name}")
        if info.is_dir():
            continue
        if mode and not stat.S_ISREG(mode):
            fail(f"not a regular file: {name}")
        if mode & 0o111:
            fail(f"executable file in artifact: {name}")
        if name in entries:
            fail(f"duplicate entry: {name}")
        if info.file_size > MAX_FILE_BYTES:
            fail(f"file too large: {name}")
        with archive.open(info) as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES or len(data) != info.file_size:
            fail(f"size mismatch: {name}")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            fail("artifact too large")
        entries[name] = data
    return entries


def verify(blob, digest, repository, sha, run_id, mode):
    """Validated site files {path: bytes}. `digest` is GitHub's artifact digest (sha256:HEX)."""
    if mode not in ("preview", "production"):
        fail(f"unknown mode: {mode}")
    if len(blob) > MAX_ZIP_BYTES:
        fail("artifact archive too large")
    match = re.fullmatch(r"sha256:([0-9a-f]{64})", digest or "")
    if not match:
        fail("missing or malformed artifact digest")
    if sha256(blob) != match.group(1):
        fail("artifact digest mismatch (tampered or incomplete download)")
    if not re.fullmatch(r"[0-9a-f]{40}", sha or ""):
        fail("malformed commit sha")
    entries = read_zip(blob)
    if "manifest.json" not in entries:
        fail("artifact has no manifest")
    files = {}
    for name, data in entries.items():
        if name == "manifest.json":
            continue
        if not name.startswith("site/"):
            fail(f"unexpected file outside site/: {name}")
        files[name[len("site/"):]] = data
    check_site(files, mode)
    check_manifest(entries["manifest.json"], files, repository, sha, run_id)
    return files


def write_site(files, out):
    if os.path.exists(out) and os.listdir(out):
        fail(f"output directory is not empty: {out}")
    for path, data in files.items():
        target = os.path.join(out, *path.split("/"))
        real_out = os.path.realpath(out)
        if not os.path.realpath(target).startswith(real_out + os.sep):
            fail(f"path escapes the output directory: {path}")
        os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)


# ------------------------------------------------------------------------------- workspace


def workspace(vercel_json_path, out):
    """A deploy workspace: the trusted vercel.json, minus the build command, serving public/."""
    with open(vercel_json_path, encoding="utf-8") as handle:
        config = json.load(handle)
    unknown = set(config) - VERCEL_JSON_KEYS
    if unknown:
        fail(f"trusted vercel.json has unsupported keys: {', '.join(sorted(unknown))}")
    if config.get("framework") is not None:
        fail("trusted vercel.json must not set a framework")
    if config.get("rewrites") != ROOT_REWRITES:
        fail(f"trusted vercel.json rewrites must be exactly {ROOT_REWRITES}")
    config.pop("buildCommand", None)
    config["outputDirectory"] = "public"
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "vercel.json"), "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
    return config


def check_ids(project_id, website_project_id):
    if not re.fullmatch(r"prj_[A-Za-z0-9]+", project_id or ""):
        fail("legal hub project id is missing or malformed")
    if not website_project_id:
        fail("website project id is missing; cannot prove the projects differ")
    if project_id == website_project_id:
        fail("legal hub project id is the website project; refusing")


def check_link(project_json, project_id, website_project_id):
    check_ids(project_id, website_project_id)
    with open(project_json, encoding="utf-8") as handle:
        link = json.load(handle)
    if link.get("projectId") != project_id:
        fail("pulled project link is not the legal hub project")
    settings = link.get("settings") or {}
    if settings.get("rootDirectory") not in (None, ".", ""):
        fail("the legal hub project must have an empty Root Directory")
    for key in EMPTY_SETTINGS:
        if settings.get(key) not in (None, ""):
            fail(f"the legal hub project setting {key} must be empty")


def check_output(output, public, target):
    """The prebuilt output is exactly the verified files, static only, for the right target."""
    if os.path.exists(os.path.join(output, "functions")):
        fail("serverless functions in the build output")
    with open(os.path.join(output, "builds.json"), encoding="utf-8") as handle:
        builds = json.load(handle)
    if builds.get("target") != target:
        fail(f"build output target is {builds.get('target')!r}, expected {target!r}")
    if builds.get("error") or any("error" in b for b in builds.get("builds", [])):
        fail("the build recorded an error")
    static = read_dist(os.path.join(output, "static"))
    expected = read_dist(public)
    if static != expected:
        fail("static output differs from the verified artifact")
    with open(os.path.join(output, "config.json"), encoding="utf-8") as handle:
        config = json.load(handle)
    check_routing(config, static)


def route(config, files, path):
    """Resolve a request path against a Build Output API v3 config, as Vercel routes it.

    Only what `vercel build` emits for this hub is understood (redirects and headers, the
    filesystem, rewrites with `check`, then the error phase); anything else fails closed.
    Returns ("file", name), ("redirect", location) or ("missing", None).
    """
    served = {}
    for name in files:
        served["/" + config.get("overrides", {}).get(name, {}).get("path", name)] = name
    phase = None
    for rule in config.get("routes", []):
        if "handle" in rule:
            if rule["handle"] not in ("filesystem", "error"):
                fail(f"unexpected routing phase {rule['handle']!r} in the build output")
            # The filesystem is checked once, when the first phase ends.
            if phase is None and path in served:
                return "file", served[path]
            phase = rule["handle"]
            if phase == "error":
                return "missing", None
            continue
        match = re.fullmatch(rule["src"], path)
        if not match:
            continue

        def expand(value):
            return re.sub(r"\$(\d+)", lambda m: match.group(int(m.group(1))) or "", value)

        if phase is None and rule.get("status") in REDIRECT_STATUSES:
            return "redirect", expand(rule["headers"]["Location"])
        if phase is None and set(rule) == {"src", "headers", "continue"}:
            continue
        if phase == "filesystem" and rule.get("check") and "dest" in rule:
            path = expand(rule["dest"])
            if path in served:
                return "file", served[path]
            continue
        fail(f"unexpected route in the build output: {rule}")
    return ("file", served[path]) if phase is None and path in served else ("missing", None)


def check_routing(config, files):
    """Every page is served at its clean URL, / is the home page, /index does not loop."""
    for name in files:
        if not name.endswith(".html") or name == "404.html":
            continue
        url = "/" if name == "index.html" else "/" + name[: -len(".html")]
        if route(config, files, url) != ("file", name):
            fail(f"{url} would not serve {name} (got {route(config, files, url)})")
    if route(config, files, "/index") != ("redirect", "/"):
        fail("/index must redirect to /")
    if route(config, files, "/__legal_hub_unknown__") != ("missing", None):
        fail("an unknown path must not be served")
    if not any(r.get("status") == 404 and r.get("dest") == "/404" for r in config["routes"]):
        fail("unknown paths must fall back to the 404 page")
    if route(config, files, "/404") != ("file", "404.html"):
        fail("the 404 page is not in the build output")


def check_project(project_api, project_id):
    """Before a preview deploy: Vercel assigns a project's FIRST deployment to production (and
    its public production domains) whatever the CLI asked for (LEGAL-05). Require an existing
    production deployment and Vercel Authentication."""
    with open(project_api, encoding="utf-8") as handle:
        project = json.load(handle)
    if project.get("id") != project_id:
        fail("Vercel API returned another project")
    if not isinstance(project.get("ssoProtection"), dict):
        fail("SECURITY: Vercel Authentication (Deployment Protection) is off for the legal hub")
    if not ((project.get("targets") or {}).get("production") or {}).get("id"):
        fail("SECURITY: the legal hub project has no production deployment, so Vercel would "
             "promote this preview to production; see the runbook (first deployment)")


def check_deployment(deployment_api, aliases_api, probes, project_id, mode):
    """After the deploy: the server-side target, and (preview) that no URL serves without login."""
    with open(deployment_api, encoding="utf-8") as handle:
        deployment = json.load(handle)
    with open(aliases_api, encoding="utf-8") as handle:
        aliases = [a["alias"] for a in json.load(handle).get("aliases", [])]
    if deployment.get("projectId") != project_id:
        fail("SECURITY: the deployment does not belong to the legal hub project")
    if deployment.get("readyState") != "READY":
        fail(f"deployment is {deployment.get('readyState')!r}, not READY")
    target = deployment.get("target")
    if mode == "production" and target != "production":
        fail(f"production deploy has server-side target {target!r}")
    if mode == "preview" and target not in (None, "preview"):
        fail(f"SECURITY: preview deploy has server-side target {target!r}; aliases: "
             f"{', '.join(aliases) or 'none'}. Follow the runbook remediation")
    if mode == "production":
        return
    results = {}
    with open(probes, encoding="utf-8") as handle:
        for line in handle.read().splitlines():
            host, code, location = (line.split("\t") + ["", ""])[:3]
            results[host] = (code, location)
    exposed = []
    for host in [deployment.get("url")] + aliases:
        code, location = results.get(host, ("missing", ""))
        if not (code == "401" or (code in {"302", "303", "307"} and location.startswith(SSO_LOGIN))):
            exposed.append(f"{host} ({code})")
    if exposed:
        fail("SECURITY: reachable without Vercel Authentication: " + ", ".join(exposed)
             + ". Follow the runbook remediation")


# ------------------------------------------------------------------------------------- cli


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("package")
    p.add_argument("--dist", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--repository", required=True)
    p.add_argument("--sha", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--event", required=True)

    p = sub.add_parser("selfcheck")
    p.add_argument("--dir", required=True)
    p.add_argument("--repository", required=True)
    p.add_argument("--sha", required=True)
    p.add_argument("--run-id", required=True)

    p = sub.add_parser("verify")
    p.add_argument("--zip", required=True)
    p.add_argument("--digest", required=True)
    p.add_argument("--repository", required=True)
    p.add_argument("--sha", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--mode", required=True, choices=["preview", "production"])
    p.add_argument("--out", required=True)

    p = sub.add_parser("workspace")
    p.add_argument("--vercel-json", required=True)
    p.add_argument("--out", required=True)

    p = sub.add_parser("check-ids")
    p.add_argument("--project-id", required=True)
    p.add_argument("--website-project-id", required=True)

    p = sub.add_parser("check-link")
    p.add_argument("--project-json", required=True)
    p.add_argument("--project-id", required=True)
    p.add_argument("--website-project-id", required=True)

    p = sub.add_parser("check-output")
    p.add_argument("--output", required=True)
    p.add_argument("--public", required=True)
    p.add_argument("--target", required=True, choices=["preview", "production"])

    p = sub.add_parser("check-project")
    p.add_argument("--project-api", required=True)
    p.add_argument("--project-id", required=True)

    p = sub.add_parser("check-deployment")
    p.add_argument("--deployment", required=True)
    p.add_argument("--aliases", required=True)
    p.add_argument("--probes", required=True)
    p.add_argument("--project-id", required=True)
    p.add_argument("--mode", required=True, choices=["preview", "production"])

    args = parser.parse_args(argv)
    try:
        if args.command == "package":
            m = package(args.dist, args.out, args.repository, args.sha, args.run_id, args.event)
            print(f"packaged {len(m['files'])} files for {m['sha']} (run {m['run_id']})")
        elif args.command == "selfcheck":
            blob = zip_dir(args.dir)
            files = verify(blob, "sha256:" + sha256(blob), args.repository, args.sha,
                           args.run_id, "preview")
            print(f"selfcheck: {len(files)} files pass the deploy-side verification")
        elif args.command == "verify":
            with open(args.zip, "rb") as handle:
                blob = handle.read(MAX_ZIP_BYTES + 1)
            files = verify(blob, args.digest, args.repository, args.sha, args.run_id, args.mode)
            write_site(files, args.out)
            print(f"verified {len(files)} files ({args.mode})")
            for path in sorted(files):
                print(f"  {path}")
        elif args.command == "workspace":
            workspace(args.vercel_json, args.out)
            print(f"workspace ready: {args.out}")
        elif args.command == "check-ids":
            check_ids(args.project_id, args.website_project_id)
            print("project ids ok")
        elif args.command == "check-link":
            check_link(args.project_json, args.project_id, args.website_project_id)
            print("project link ok")
        elif args.command == "check-output":
            check_output(args.output, args.public, args.target)
            print(f"prebuilt output ok ({args.target})")
        elif args.command == "check-project":
            check_project(args.project_api, args.project_id)
            print("project ok: production deployment exists, Vercel Authentication on")
        elif args.command == "check-deployment":
            check_deployment(args.deployment, args.aliases, args.probes, args.project_id, args.mode)
            checked = "target and Vercel Authentication" if args.mode == "preview" else "target"
            print(f"deployment ok ({args.mode}): server-side {checked} verified")
    except ArtifactError as error:
        print(f"::error::legal hub artifact: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
