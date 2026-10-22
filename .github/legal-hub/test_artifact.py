"""ONCHAINFEST-LEGAL-04/06 · Tests for artifact.py: the deploy-side artifact verification.

  python3 -I -m unittest discover -s .github/legal-hub -p 'test_*.py'

Builds the real hub once (node legal/scripts/build.mjs), packages it, then checks that the
verification accepts it and rejects every malicious or broken variant. fixtures/ holds the
config.json that Vercel CLI 62.4.0 `vercel build` really emits for the hub, with and without the
root rewrite (LEGAL-06).
"""

import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import artifact  # noqa: E402

REPOSITORY = "OnChainFest/Onchainfest-WebSite"
SHA = "0123456789abcdef0123456789abcdef01234567"
RUN_ID = "4242"
WEBSITE_PROJECT = "prj_websiteProject0000000000"
LEGAL_PROJECT = "prj_legalHubProject000000000"
FIXTURES = os.path.join(HERE, "fixtures")
CLI_CONFIG = os.path.join(FIXTURES, "vercel-62.4.0-config.json")
CLI_CONFIG_NO_ROOT = os.path.join(FIXTURES, "vercel-62.4.0-config-no-root-rewrite.json")
DEPLOY_URL = "onchainfest-legal-abc123-victor-valverdes-projects.vercel.app"
SCOPED_ALIAS = "onchainfest-legal-victor-valverdes-projects.vercel.app"
PUBLIC_ALIAS = "onchainfest-legal.vercel.app"
LOGIN = "https://vercel.com/sso-api?url=https%3A%2F%2F"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def digest(blob):
    return "sha256:" + hashlib.sha256(blob).hexdigest()


def make_zip(entries):
    """entries: [(name, bytes, unix_mode or None)]"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if mode is not None:
                info.external_attr = mode << 16
            archive.writestr(info, data)
    return buffer.getvalue()


class ArtifactTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="legal-hub-artifact-")
        subprocess.run(
            ["node", os.path.join(REPO, "legal", "scripts", "build.mjs")],
            check=True, capture_output=True,
        )
        dist = os.path.join(REPO, "legal", "dist")
        cls.files = artifact.read_dist(dist)
        shutil.rmtree(dist)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # helpers -------------------------------------------------------------------------------

    def entries(self, files=None, manifest=None, mode=0o100644):
        files = dict(self.files if files is None else files)
        if manifest is None:
            manifest = artifact.build_manifest(files, REPOSITORY, SHA, RUN_ID, "pull_request")
        result = [("manifest.json", json.dumps(manifest).encode(), mode)]
        result += [(f"site/{p}", d, mode) for p, d in sorted(files.items())]
        return result

    def verify(self, entries=None, mode="preview", blob=None, dig=None, **overrides):
        blob = make_zip(self.entries() if entries is None else entries) if blob is None else blob
        args = {"repository": REPOSITORY, "sha": SHA, "run_id": RUN_ID}
        args.update(overrides)
        return artifact.verify(blob, digest(blob) if dig is None else dig, mode=mode, **args)

    def rejects(self, pattern, **kwargs):
        with self.assertRaisesRegex(artifact.ArtifactError, pattern):
            self.verify(**kwargs)

    def final_files(self):
        """The site as it would look once every document is approved (for production tests)."""
        files = {}
        for path, data in self.files.items():
            if path.endswith(".html"):
                text = data.decode()
                text = text.replace('content="noindex, nofollow"', 'content="index, follow"')
                text = text.replace('class="review', 'class="x').replace("draft-banner", "x")
                data = text.encode()
            if path == "robots.txt":
                data = artifact.ROBOTS_FINAL.encode()
            files[path] = data
        return files

    # accepted ------------------------------------------------------------------------------

    def test_accepts_the_real_build_for_preview(self):
        files = self.verify()
        self.assertEqual(set(files), set(self.files))
        self.assertTrue(artifact.REQUIRED <= set(files))

    def test_accepts_directory_entries(self):
        self.verify(entries=[("site/", b"", 0o40755)] + self.entries())

    def test_writes_only_after_verification_with_plain_permissions(self):
        out = os.path.join(self.tmp, "public-ok")
        artifact.write_site(self.verify(), out)
        mode = os.stat(os.path.join(out, "index.html")).st_mode
        self.assertEqual(stat.S_IMODE(mode), 0o644)
        with self.assertRaisesRegex(artifact.ArtifactError, "not empty"):
            artifact.write_site(self.verify(), out)

    # integrity and provenance -------------------------------------------------------------

    def test_rejects_a_tampered_archive(self):
        blob = bytearray(make_zip(self.entries()))
        good = digest(bytes(blob))
        blob[len(blob) // 2] ^= 0xFF
        self.rejects("digest mismatch", blob=bytes(blob), dig=good)

    def test_rejects_a_missing_or_malformed_digest(self):
        self.rejects("digest", dig="")
        self.rejects("digest", dig="md5:abc")
        self.rejects("digest", dig="sha256:" + "0" * 63)

    def test_rejects_another_commit_run_or_repository(self):
        self.rejects("commit does not match", sha="f" * 40)
        self.rejects("run id does not match", run_id="999")
        self.rejects("repository mismatch", repository="someone/else")
        self.rejects("malformed commit", sha="main")

    def test_rejects_a_file_changed_after_the_manifest(self):
        entries = self.entries()
        entries = [(n, d + b"<!-- x -->" if n == "site/index.html" else d, m) for n, d, m in entries]
        self.rejects("hashes do not match", entries=entries)

    def test_rejects_a_missing_or_foreign_manifest(self):
        self.rejects("no manifest", entries=self.entries()[1:])
        manifest = artifact.build_manifest(self.files, REPOSITORY, SHA, RUN_ID, "push")
        manifest["extra"] = 1
        self.rejects("unexpected keys", entries=self.entries(manifest=manifest))

    # archive structure --------------------------------------------------------------------

    def test_rejects_path_traversal_and_unsafe_names(self):
        for name in (
            "site/../evil.html", "../evil.html", "/etc/passwd", "site\\index.html",
            "site/.env", "site//index.html", "C:/evil.html",
        ):
            with self.subTest(name=name):
                self.rejects("unsafe path", entries=self.entries() + [(name, b"x", 0o100644)])

    def test_rejects_symlinks(self):
        link = ("site/assets/link.css", b"/etc/passwd", stat.S_IFLNK | 0o777)
        self.rejects("symlink", entries=self.entries() + [link])

    def test_rejects_executable_files(self):
        entries = [(n, d, 0o100755 if n == "site/index.html" else m) for n, d, m in self.entries()]
        self.rejects("executable", entries=entries)

    def test_rejects_duplicate_entries(self):
        entries = self.entries()
        with self.assertWarns(UserWarning):  # zipfile warns about the duplicate name itself
            blob = make_zip(entries + [entries[1]])
        self.rejects("duplicate", blob=blob)

    def test_rejects_files_outside_site_and_unexpected_files(self):
        self.rejects("outside site", entries=self.entries() + [("evil.sh", b"#!/bin/sh", 0o100644)])
        for path, data in (
            ("site/evil.html", self.files["index.html"]),
            ("site/assets/app.js", b"alert(1)"),
            ("site/api/handler.html", self.files["index.html"]),
            ("site/assets/logo.svg", b"<svg/>"),
        ):
            with self.subTest(path=path):
                files = dict(self.files)
                files[path[len("site/"):]] = data
                self.rejects("unexpected file", entries=self.entries(files=files))

    def test_rejects_a_missing_required_file(self):
        files = dict(self.files)
        del files["privacy.html"]
        self.rejects("missing required", entries=self.entries(files=files))

    def test_rejects_oversized_content(self):
        files = dict(self.files)
        files["assets/logo.png"] = artifact.PNG_MAGIC + b"\0" * artifact.MAX_FILE_BYTES
        self.rejects("too large", entries=self.entries(files=files))

    def test_rejects_something_that_is_not_a_zip(self):
        self.rejects("not a zip", blob=b"not a zip at all")

    # content ------------------------------------------------------------------------------

    def test_rejects_active_content_in_pages(self):
        for snippet in (
            "<script>alert(1)</script>", '<img src=x onerror="alert(1)">', "<iframe></iframe>",
            '<a href="javascript:alert(1)">x</a>', '<meta http-equiv="refresh" content="0">',
            "<form action=x></form>", '<base href="https://evil.example/">',
        ):
            with self.subTest(snippet=snippet):
                files = dict(self.files)
                files["terms.html"] = files["terms.html"].replace(b"</main>", snippet.encode() + b"</main>")
                self.rejects("active content", entries=self.entries(files=files))

    def test_rejects_pages_without_the_legal_hub_marker(self):
        files = dict(self.files)
        files["index.html"] = files["index.html"].replace(artifact.MARKER.encode(), b"")
        self.rejects("marker", entries=self.entries(files=files))

    def test_rejects_wrong_file_types(self):
        cases = {
            "assets/logo.png": b"GIF89a....",
            "assets/favicon.ico": b"<html>",
            "assets/legal.css": b'@import url("https://evil.example/x.css");',
            "robots.txt": b"User-agent: *\nAllow: /admin\n",
            "index.html": b"\x7fELF\x02\x01\x01",
        }
        for path, data in cases.items():
            with self.subTest(path=path):
                files = dict(self.files)
                files[path] = data
                with self.assertRaises(artifact.ArtifactError):
                    self.verify(entries=self.entries(files=files))

    # production ---------------------------------------------------------------------------

    def test_production_rejects_the_current_drafts(self):
        self.rejects("draft, review marker or noindex", mode="production")

    def test_production_accepts_a_fully_approved_site(self):
        files = self.final_files()
        self.verify(entries=self.entries(files=files), mode="production")

    def test_production_rejects_a_single_leftover_review_marker(self):
        files = self.final_files()
        files["privacy.html"] = files["privacy.html"].replace(b"</main>", b'<div class="review"></div></main>')
        self.rejects("draft", entries=self.entries(files=files), mode="production")

    # deploy workspace, project link, prebuilt output -------------------------------------

    def test_workspace_drops_the_build_command_and_serves_public(self):
        out = os.path.join(self.tmp, "ws")
        config = artifact.workspace(os.path.join(REPO, "legal", "vercel.json"), out)
        self.assertNotIn("buildCommand", config)
        self.assertEqual(config["outputDirectory"], "public")
        with open(os.path.join(out, "vercel.json"), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), config)

    def test_workspace_refuses_code_or_routing_keys(self):
        for extra in (
            {"rewrites": []},
            {"rewrites": [{"source": "/", "destination": "https://example.com/"}]},
            {"rewrites": artifact.ROOT_REWRITES + [{"source": "/x", "destination": "/terms"}]},
            {"redirects": []},
            {"routes": []},
            {"functions": {}},
            {"builds": []},
            {"framework": "nextjs"},
        ):
            with self.subTest(extra=extra):
                path = os.path.join(self.tmp, "vercel-extra.json")
                with open(os.path.join(REPO, "legal", "vercel.json"), encoding="utf-8") as handle:
                    config = json.load(handle)
                config.update(extra)
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump(config, handle)
                with self.assertRaises(artifact.ArtifactError):
                    artifact.workspace(path, os.path.join(self.tmp, "ws-extra"))

    def link(self, **settings):
        project_id = settings.pop("_id", LEGAL_PROJECT)
        base = {"rootDirectory": None, "framework": None, "buildCommand": None}
        base.update(settings)
        fd, path = tempfile.mkstemp(suffix="-project.json", dir=self.tmp)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"projectId": project_id, "settings": base}, handle)
        return path

    def test_project_link_must_be_the_legal_project(self):
        artifact.check_link(self.link(), LEGAL_PROJECT, WEBSITE_PROJECT)
        cases = [
            (self.link(), WEBSITE_PROJECT, WEBSITE_PROJECT, "website project"),
            (self.link(), "", WEBSITE_PROJECT, "missing or malformed"),
            (self.link(), "not-a-project", WEBSITE_PROJECT, "missing or malformed"),
            (self.link(), LEGAL_PROJECT, "", "website project id is missing"),
            (self.link(_id=WEBSITE_PROJECT), LEGAL_PROJECT, WEBSITE_PROJECT, "not the legal hub"),
            (self.link(rootDirectory="legal"), LEGAL_PROJECT, WEBSITE_PROJECT, "Root Directory"),
            (self.link(buildCommand="npm run x"), LEGAL_PROJECT, WEBSITE_PROJECT, "buildCommand"),
            (self.link(installCommand="npm i"), LEGAL_PROJECT, WEBSITE_PROJECT, "installCommand"),
        ]
        for project_json, project_id, website_id, pattern in cases:
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(artifact.ArtifactError, pattern):
                    artifact.check_link(project_json, project_id, website_id)

    def test_workspace_requires_the_root_rewrite(self):
        path = os.path.join(self.tmp, "vercel-no-rewrite.json")
        config = load(os.path.join(REPO, "legal", "vercel.json"))
        self.assertEqual(config["rewrites"], artifact.ROOT_REWRITES)
        del config["rewrites"]
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(config, handle)
        with self.assertRaisesRegex(artifact.ArtifactError, "rewrites"):
            artifact.workspace(path, os.path.join(self.tmp, "ws-no-rewrite"))

    def output(self, name, target="preview", extra=None, functions=False, config=CLI_CONFIG):
        public = os.path.join(self.tmp, name, "public")
        if not os.path.exists(public):
            artifact.write_site(self.files, public)
        output = os.path.join(self.tmp, name, "output")
        shutil.rmtree(output, ignore_errors=True)
        shutil.copytree(public, os.path.join(output, "static"))
        shutil.copy(config, os.path.join(output, "config.json"))
        with open(os.path.join(output, "builds.json"), "w", encoding="utf-8") as handle:
            json.dump({"target": target, "builds": [{"use": "@vercel/static"}]}, handle)
        if extra:
            with open(os.path.join(output, "static", extra), "w", encoding="utf-8") as handle:
                handle.write("x")
        if functions:
            os.makedirs(os.path.join(output, "functions"))
        return output, public

    def test_prebuilt_output_must_match_the_verified_files(self):
        artifact.check_output(*self.output("out-ok"), "preview")
        with self.assertRaisesRegex(artifact.ArtifactError, "target"):
            artifact.check_output(*self.output("out-ok"), "production")
        with self.assertRaisesRegex(artifact.ArtifactError, "differs"):
            artifact.check_output(*self.output("out-ok", extra="contact.html"), "preview")
        with self.assertRaisesRegex(artifact.ArtifactError, "functions"):
            artifact.check_output(*self.output("out-ok", functions=True), "preview")

    # root routing (LEGAL-05: / answered 404) ---------------------------------------------

    def test_real_cli_output_serves_every_route(self):
        config = load(CLI_CONFIG)
        expected = {
            "/": ("file", "index.html"),
            "/terms": ("file", "terms.html"),
            "/privacy": ("file", "privacy.html"),
            "/products/listalaboda": ("file", "products/listalaboda.html"),
            "/es": ("file", "es.html"),
            "/es/terms": ("file", "es/terms.html"),
            "/es/privacy": ("file", "es/privacy.html"),
            "/es/products/listalaboda": ("file", "es/products/listalaboda.html"),
            "/assets/legal.css": ("file", "assets/legal.css"),
            "/robots.txt": ("file", "robots.txt"),
            # cleanUrls redirects; /index goes to / and / is served, so there is no loop
            "/index": ("redirect", "/"),
            "/index.html": ("redirect", "/"),
            "/terms.html": ("redirect", "/terms"),
            "/es/": ("redirect", "/es"),
            "/es/index": ("redirect", "/es"),
            "/terms/": ("redirect", "/terms"),
            # unknown paths reach the error phase (404.html, status 404)
            "/nope": ("missing", None),
            "/es/nope": ("missing", None),
            "/products/unknown": ("missing", None),
        }
        for path, result in expected.items():
            with self.subTest(path=path):
                self.assertEqual(artifact.route(config, self.files, path), result)
        artifact.check_routing(config, self.files)

    def test_output_without_the_root_rewrite_is_refused(self):
        """The configuration deployed in LEGAL-05: / is not served."""
        config = load(CLI_CONFIG_NO_ROOT)
        self.assertEqual(artifact.route(config, self.files, "/"), ("missing", None))
        self.assertEqual(artifact.route(config, self.files, "/terms"), ("file", "terms.html"))
        with self.assertRaisesRegex(artifact.ArtifactError, "/ would not serve index.html"):
            artifact.check_output(*self.output("out-no-root", config=CLI_CONFIG_NO_ROOT), "preview")

    def test_routing_refuses_unknown_route_shapes(self):
        for rule in (
            {"handle": "miss"},
            {"src": "^/$", "dest": "https://example.com/"},
            {"src": "^/(.*)$", "dest": "/$1", "middlewarePath": "x"},
        ):
            with self.subTest(rule=rule):
                config = load(CLI_CONFIG)
                config["routes"].insert(0, rule)
                with self.assertRaises(artifact.ArtifactError):
                    artifact.check_routing(config, self.files)
        config = load(CLI_CONFIG)
        config["routes"] = [r for r in config["routes"] if r.get("status") != 404]
        with self.assertRaisesRegex(artifact.ArtifactError, "404"):
            artifact.check_routing(config, self.files)

    # Vercel server-side target and protection (LEGAL-05: first deploy became production) ----

    def json_file(self, data):
        fd, path = tempfile.mkstemp(suffix=".json", dir=self.tmp)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        return path

    def project(self, **changes):
        data = {
            "id": LEGAL_PROJECT,
            "ssoProtection": {"deploymentType": "all_except_custom_domains"},
            "targets": {"production": {"id": "dpl_existingProduction"}},
        }
        data.update(changes)
        return self.json_file(data)

    def test_preview_requires_an_existing_production_deployment_and_protection(self):
        artifact.check_project(self.project(), LEGAL_PROJECT)
        cases = [
            (self.project(targets={}), "no production deployment"),
            (self.project(targets=None), "no production deployment"),
            (self.project(ssoProtection=None), "Vercel Authentication"),
            (self.project(id=WEBSITE_PROJECT), "another project"),
        ]
        for path, pattern in cases:
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(artifact.ArtifactError, pattern):
                    artifact.check_project(path, LEGAL_PROJECT)

    def deployment(self, aliases=(SCOPED_ALIAS,), probes=None, **changes):
        data = {"projectId": LEGAL_PROJECT, "readyState": "READY", "target": None,
                "url": DEPLOY_URL}
        data.update(changes)
        if probes is None:
            probes = {host: ("302", LOGIN + host) for host in (DEPLOY_URL, *aliases)}
        fd, probe_path = tempfile.mkstemp(suffix=".tsv", dir=self.tmp)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for host, (code, location) in probes.items():
                handle.write(f"{host}\t{code}\t{location}\n")
        return (self.json_file(data), self.json_file({"aliases": [{"alias": a} for a in aliases]}),
                probe_path)

    def test_a_protected_preview_passes(self):
        artifact.check_deployment(*self.deployment(), LEGAL_PROJECT, "preview")
        artifact.check_deployment(*self.deployment(target="preview"), LEGAL_PROJECT, "preview")
        probes = {DEPLOY_URL: ("401", ""), SCOPED_ALIAS: ("302", LOGIN + SCOPED_ALIAS)}
        artifact.check_deployment(*self.deployment(probes=probes), LEGAL_PROJECT, "preview")

    def test_a_preview_promoted_to_production_fails(self):
        """What happened in LEGAL-05 (run 39714230172)."""
        files = self.deployment(aliases=(PUBLIC_ALIAS, SCOPED_ALIAS), target="production",
                                probes={DEPLOY_URL: ("302", LOGIN), SCOPED_ALIAS: ("302", LOGIN),
                                        PUBLIC_ALIAS: ("200", "")})
        with self.assertRaisesRegex(artifact.ArtifactError,
                                    "SECURITY: preview deploy has server-side target 'production'"
                                    ".*onchainfest-legal.vercel.app"):
            artifact.check_deployment(*files, LEGAL_PROJECT, "preview")

    def test_a_public_alias_fails_even_on_a_preview_target(self):
        probes = {DEPLOY_URL: ("302", LOGIN + DEPLOY_URL), PUBLIC_ALIAS: ("200", "")}
        files = self.deployment(aliases=(PUBLIC_ALIAS,), probes=probes)
        with self.assertRaisesRegex(artifact.ArtifactError,
                                    r"SECURITY: reachable without Vercel Authentication: "
                                    r"onchainfest-legal\.vercel\.app \(200\)"):
            artifact.check_deployment(*files, LEGAL_PROJECT, "preview")

    def test_unproven_protection_fails_closed(self):
        cases = {
            "missing probe": {DEPLOY_URL: ("302", LOGIN)},
            "redirect elsewhere": {DEPLOY_URL: ("302", "https://example.com/"),
                                   SCOPED_ALIAS: ("302", LOGIN)},
            "network error": {DEPLOY_URL: ("000", ""), SCOPED_ALIAS: ("302", LOGIN)},
            "not found": {DEPLOY_URL: ("404", ""), SCOPED_ALIAS: ("302", LOGIN)},
        }
        for name, probes in cases.items():
            with self.subTest(name):
                with self.assertRaisesRegex(artifact.ArtifactError, "SECURITY: reachable"):
                    artifact.check_deployment(*self.deployment(probes=probes), LEGAL_PROJECT,
                                              "preview")

    def test_deployment_identity_and_state(self):
        with self.assertRaisesRegex(artifact.ArtifactError, "does not belong"):
            artifact.check_deployment(*self.deployment(projectId=WEBSITE_PROJECT), LEGAL_PROJECT,
                                      "preview")
        with self.assertRaisesRegex(artifact.ArtifactError, "not READY"):
            artifact.check_deployment(*self.deployment(readyState="ERROR"), LEGAL_PROJECT,
                                      "preview")

    def test_production_target_check(self):
        artifact.check_deployment(*self.deployment(target="production", probes={}),
                                  LEGAL_PROJECT, "production")
        with self.assertRaisesRegex(artifact.ArtifactError, "server-side target None"):
            artifact.check_deployment(*self.deployment(probes={}), LEGAL_PROJECT, "production")

    def test_cli_reports_security_failures_as_errors(self):
        files = self.deployment(target="production")
        args = ["check-deployment", "--deployment", files[0], "--aliases", files[1],
                "--probes", files[2], "--project-id", LEGAL_PROJECT, "--mode", "preview"]
        self.assertEqual(artifact.main(args), 1)
        self.assertEqual(artifact.main(args[:-1] + ["production"]), 0)


if __name__ == "__main__":
    unittest.main()
