"""ONCHAINFEST-LEGAL-04 · Tests for artifact.py: the deploy-side artifact verification.

  python3 -I -m unittest discover -s .github/legal-hub -p 'test_*.py'

Builds the real hub once (node legal/scripts/build.mjs), packages it, then checks that the
verification accepts it and rejects every malicious or broken variant.
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
        for extra in ({"rewrites": []}, {"functions": {}}, {"builds": []}, {"framework": "nextjs"}):
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

    def output(self, name, target="preview", extra=None, functions=False):
        public = os.path.join(self.tmp, name, "public")
        if not os.path.exists(public):
            artifact.write_site(self.files, public)
        output = os.path.join(self.tmp, name, "output")
        shutil.rmtree(output, ignore_errors=True)
        shutil.copytree(public, os.path.join(output, "static"))
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


if __name__ == "__main__":
    unittest.main()
