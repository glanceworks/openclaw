#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
DEPLOYMENT = HERE.parent
TOOLS = DEPLOYMENT / "tools"
FIXTURES = HERE / "fixtures"
MANIFEST = DEPLOYMENT / "deployment-manifest.json"
PYTHON = sys.executable
sys.path.insert(0, str(TOOLS))
from integrity import IntegrityError, load_manifest, resolve_target

PATCH = TOOLS / "patch_bundle.py"
VERIFY = TOOLS / "verify_startup.py"
READINESS = TOOLS / "validate_readiness.py"
DERIVE = TOOLS / "derive_evidence.py"
VALIDATE_BASE = TOOLS / "validate_base_image.py"
WRAPPER = DEPLOYMENT / "entrypoint.sh"
EVIDENCE = DEPLOYMENT / "evidence/known-good-image-20260713T045521Z.json"
REGISTRY_EVIDENCE = DEPLOYMENT / "evidence/registry-openclaw-2026.5.4-20260713T163330Z.json"
DOCKERFILE = DEPLOYMENT.parents[1] / "Dockerfile.playwright-runtime"
COMPOSE = DEPLOYMENT.parents[1] / "docker-compose.yml"
YEAR_FIX_PROVENANCE = DEPLOYMENT / "provenance/year-clarification-refresh-2168d50.json"
RUNTIME_SMOKE = HERE / "runtime-media-clarification-smoke.mjs"
RUNBOOK = DEPLOYMENT / "RUNBOOK.md"
EXPECTED_IMAGE_ENTRYPOINT = (
    'ENTRYPOINT ["/opt/openclaw-telegram-media-gate/deployment/entrypoint.sh"]'
)
EXPECTED_IMAGE_CMD = 'CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]'
EXPECTED_WRAPPER_DELEGATION = 'exec docker-entrypoint.sh "$@"'

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def assert_image_command_contract(dockerfile: str, compose: str, wrapper: str) -> None:
    entrypoints = [
        line.strip() for line in dockerfile.splitlines()
        if re.match(r"^\s*ENTRYPOINT(?:\s|$)", line)
    ]
    if entrypoints != [EXPECTED_IMAGE_ENTRYPOINT]:
        raise AssertionError(f"unexpected image ENTRYPOINT: {entrypoints!r}")
    commands = [
        line.strip() for line in dockerfile.splitlines()
        if re.match(r"^\s*CMD(?:\s|$)", line)
    ]
    if commands != [EXPECTED_IMAGE_CMD]:
        raise AssertionError(f"unexpected image CMD: {commands!r}")
    if re.search(r"^\s*command\s*:", compose, re.MULTILINE):
        raise AssertionError("Compose must not override the image command")
    delegations = [
        line.strip() for line in wrapper.splitlines()
        if re.match(r"^\s*exec\s+docker-entrypoint\.sh(?:\s|$)", line)
    ]
    if delegations != [EXPECTED_WRAPPER_DELEGATION]:
        raise AssertionError(f"unexpected wrapper delegation: {delegations!r}")

class DeploymentFrameworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.app = self.root / "app"
        self.dist = self.app / "dist"
        self.bundle = self.dist / "chunks" / "telegram.js"
        self.bundle.parent.mkdir(parents=True)
        shutil.copyfile(FIXTURES / "package.json", self.app / "package.json")
        self.original = (FIXTURES / "original-bundle.js").read_bytes()
        self.patched = (FIXTURES / "patched-bundle.js").read_bytes()

    def manifest(self, *, original=None, patched_hash=None, anchor_counts=(1, 1), expected_path="chunks/telegram.js"):
        value = load_manifest(MANIFEST)
        fake_digest = "sha256:" + "a" * 64
        value["upstream_base_image"]["verified_manifest_digest"] = fake_digest
        value["upstream_base_image"]["reference"] = "ghcr.io/openclaw/openclaw:2026.5.4@" + fake_digest
        value["version_probe"]["contract"] = {
            "kind": "json-file",
            "path": "package.json",
            "checks": [
                {"field_path": ["name"], "expected": "openclaw"},
                {"field_path": ["version"], "expected": "2026.5.4"},
            ],
        }
        value["version_probe"]["evidence"] = {
            "fixture": True,
            "package_sha256": sha((FIXTURES / "package.json").read_bytes()),
        }
        value["bundle"]["selector"] = {"kind": "relative-glob", "pattern": "chunks/*.js"}
        value["bundle"]["expected_path"] = expected_path
        value["bundle"]["original_sha256"] = sha(original if original is not None else self.original)
        value["bundle"]["patched_sha256"] = patched_hash or sha(self.patched)
        for entry, count in zip(value["bundle"]["structural_anchors"], anchor_counts):
            entry["expected_count"] = count
        path = self.root / f"manifest-{len(list(self.root.glob('manifest-*.json')))}.json"
        path.write_text(json.dumps(value))
        return path

    def run_tool(self, tool, manifest):
        return subprocess.run(
            [
                PYTHON, str(tool), "--manifest", str(manifest),
                "--app-root", str(self.app), "--dist-root", str(self.dist),
            ],
            text=True, capture_output=True, check=False,
        )

    def run_base_validation(self, reference=None, manifest=MANIFEST):
        command = [PYTHON, str(VALIDATE_BASE), "--manifest", str(manifest)]
        if reference is not None:
            command.extend(["--supplied-reference", reference])
        return subprocess.run(command, text=True, capture_output=True, check=False)

    def test_manifest_readiness_succeeds_with_all_evidence_resolved(self):
        result = subprocess.run(
            [
                PYTHON, str(READINESS), "--manifest", str(MANIFEST),
                "--runtime-root", str(DEPLOYMENT), "--source-layout",
            ],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(),
            "telegram media-gate deployment manifest is ready",
        )

    def test_original_patches_deterministically_and_matches_hash(self):
        self.bundle.write_bytes(self.original)
        result = self.run_tool(PATCH, self.manifest())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.bundle.read_bytes(), self.patched)
        self.assertEqual(sha(self.bundle.read_bytes()), sha(self.patched))

    def test_already_patched_succeeds_without_mutation(self):
        self.bundle.write_bytes(self.patched)
        before = self.bundle.stat().st_mtime_ns
        result = self.run_tool(PATCH, self.manifest())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.bundle.read_bytes(), self.patched)
        self.assertEqual(self.bundle.stat().st_mtime_ns, before)

    def test_unknown_hash_is_rejected(self):
        self.bundle.write_bytes(self.original + b"\nunknown")
        result = self.run_tool(PATCH, self.manifest())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown target bundle", result.stderr)

    def test_wrong_openclaw_version_is_rejected(self):
        self.bundle.write_bytes(self.original)
        (self.app / "package.json").write_text(
            '{"name":"openclaw","version":"2026.5.5"}'
        )
        result = self.run_tool(PATCH, self.manifest())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("version mismatch", result.stderr)

    def test_missing_bundle_is_rejected(self):
        result = self.run_tool(PATCH, self.manifest())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("found 0", result.stderr)

    def test_ambiguous_bundle_is_rejected(self):
        self.bundle.write_bytes(self.original)
        (self.bundle.parent / "second.js").write_bytes(self.original)
        result = self.run_tool(PATCH, self.manifest())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("found 2", result.stderr)

    def test_anchor_absence_is_rejected(self):
        mutated = self.original.replace(b"const createTelegramUpdateDedupe", b"const missingDedupe")
        self.bundle.write_bytes(mutated)
        result = self.run_tool(PATCH, self.manifest(original=mutated))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("anchor", result.stderr)

    def test_wrong_anchor_count_is_rejected(self):
        self.bundle.write_bytes(self.original)
        result = self.run_tool(PATCH, self.manifest(anchor_counts=(2, 1)))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("count mismatch", result.stderr)

    def test_patched_result_hash_mismatch_is_rejected_without_mutation(self):
        self.bundle.write_bytes(self.original)
        result = self.run_tool(PATCH, self.manifest(patched_hash="0" * 64))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("patched-result SHA-256 mismatch", result.stderr)
        self.assertEqual(self.bundle.read_bytes(), self.original)

    def test_startup_accepts_patched_and_rejects_original(self):
        manifest = self.manifest()
        self.bundle.write_bytes(self.patched)
        accepted = self.run_tool(VERIFY, manifest)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.bundle.write_bytes(self.original)
        rejected = self.run_tool(VERIFY, manifest)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("not patched at build time", rejected.stderr)

    def test_wrapper_exec_forwards_arguments_pid_and_exit_status(self):
        wrapper_root = self.root / "wrapper"
        (wrapper_root / "tools").mkdir(parents=True)
        shutil.copyfile(WRAPPER, wrapper_root / "entrypoint.sh")
        (wrapper_root / "tools/verify_startup.py").write_text(
            "#!/usr/bin/env python3\nraise SystemExit(0)\n"
        )
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        fake_entrypoint = fake_bin / "docker-entrypoint.sh"
        fake_entrypoint.write_text(
            "#!/usr/bin/python3\n"
            "import json, os, pathlib, sys\n"
            "pathlib.Path(os.environ['CAPTURE']).write_text("
            "json.dumps({'args': sys.argv[1:], 'pid': os.getpid()}))\n"
            "raise SystemExit(int(os.environ['FAKE_EXIT']))\n"
        )
        fake_entrypoint.chmod(0o755)
        capture = self.root / "capture.json"
        env = os.environ.copy()
        env.update({
            "PATH": str(fake_bin) + os.pathsep + env["PATH"],
            "CAPTURE": str(capture),
            "FAKE_EXIT": "37",
        })
        process = subprocess.Popen(
            ["/bin/sh", str(wrapper_root / "entrypoint.sh"), "one", "two words", ""],
            env=env,
        )
        launched_pid = process.pid
        self.assertEqual(process.wait(), 37)
        result = json.loads(capture.read_text())
        self.assertEqual(result["args"], ["one", "two words", ""])
        self.assertEqual(result["pid"], launched_pid)

    def test_runtime_hashes_match_layered_provenance(self):
        export = json.loads((DEPLOYMENT / "provenance/export-manifest.json").read_text())
        refresh = json.loads(YEAR_FIX_PROVENANCE.read_text())
        baseline = {
            entry["original_repository_path"]: entry["sha256"]
            for entry in export["files"] if entry["classification"] == "runtime"
        }
        declared = dict(baseline)
        refreshed_paths = set()
        for entry in refresh["files"]:
            self.assertEqual(baseline[entry["source_path"]], entry["old_sha256"])
            declared[entry["source_path"]] = entry["new_sha256"]
            refreshed_paths.add(entry["source_path"])
        self.assertEqual(len(declared), 8)
        self.assertEqual(
            refreshed_paths,
            {
                "scripts/telegram-media-handler.mjs",
                "scripts/media-mvp-resolve.mjs",
                "scripts/media-mvp-add-gated.mjs",
            },
        )
        changed_from_baseline = set()
        for rel, expected in declared.items():
            actual = sha((DEPLOYMENT / "runtime" / rel).read_bytes())
            self.assertEqual(actual, expected)
            if actual != baseline[rel]:
                changed_from_baseline.add(rel)
        self.assertEqual(changed_from_baseline, refreshed_paths)
        manifest_hashes = {
            entry["image_relative_path"]: entry["sha256"]
            for entry in load_manifest(MANIFEST)["runtime_files"]
        }
        self.assertEqual(manifest_hashes, declared)
        self.assertEqual(refresh["source_commit"], "2168d504507edf6117a13f9b9aeef2ac88808bb2")
        self.assertEqual(refresh["parent_commit"], "580007d45bd4e903d829d1f17ed61dd4341e0dcd")
        self.assertEqual(
            refresh["archive_sha256"],
            "659a3b69e5b4bd05f5d8483d0789a8172bda7d162259eb982b6fb0daabcb292b",
        )
        self.assertFalse(refresh["exact_historical_lookup_error_reproduced"])
        self.assertFalse(refresh["test_only_provenance"]["copied_into_image_runtime"])
        self.assertFalse((DEPLOYMENT / "runtime/scripts/telegram-media-pending-tests.mjs").exists())

    def test_year_clarification_runtime_contract_fixtures_are_offline(self):
        handler = (DEPLOYMENT / "runtime/scripts/telegram-media-handler.mjs").read_text()
        resolver = (DEPLOYMENT / "runtime/scripts/media-mvp-resolve.mjs").read_text()
        gated = (DEPLOYMENT / "runtime/scripts/media-mvp-add-gated.mjs").read_text()
        for snippet in (
            "function canonicalFromQuery(query, mediaType)",
            "function mergeClarificationIntoCanonical(pending, clarification)",
            "return { ...current, year: Number(bareYear[1]) }",
            "const requestText = canonicalQueryText(canonical, true)",
            "function safeFailureForLog(result)",
        ):
            self.assertIn(snippet, handler)
        self.assertIn("failure: safeFailureMeta('lookup', lookup)", resolver)
        self.assertIn("failure: safeFailureMeta('library', library)", resolver)
        self.assertIn("text: ''", resolver)
        self.assertIn("failure: resolved.failure || null", gated)

        data_root = self.root / "year-clarification-data"
        state_path = data_root / "state/pending.json"
        log_path = data_root / "logs/failures.jsonl"
        state_path.parent.mkdir(parents=True)
        log_path.parent.mkdir(parents=True)
        runner_inputs = []

        def parse_title_year(value):
            value = " ".join(str(value or "").split())
            match = re.match(r"^(.*?)\s*\((19\d{2}|20\d{2}|21\d{2})\)$", value)
            match = match or re.match(r"^(.*?)\s+(19\d{2}|20\d{2}|21\d{2})$", value)
            return {
                "title": match.group(1).strip() if match else value,
                "year": int(match.group(2)) if match else None,
            }

        def canonical(value, media_type):
            parsed = parse_title_year(value)
            return {**parsed, "mediaType": "show" if media_type == "show" else "movie"}

        def merge(pending, clarification):
            current = dict(pending["canonical"])
            value = " ".join(str(clarification or "").split())
            if re.match(r"^(19\d{2}|20\d{2}|21\d{2})$", value):
                return {**current, "year": int(value)}
            parsed = parse_title_year(value)
            return {
                **current,
                "title": parsed["title"] or current["title"],
                "year": parsed["year"] or current["year"],
            }

        def query(value):
            return " ".join(filter(None, (
                value["title"], str(value["year"]) if value["year"] else None,
                value["mediaType"],
            )))

        def stub_runner(value):
            runner_inputs.append(value)
            if value == "strange harvest 2026 movie":
                return {"resolverState": "resolved", "addResult": "success"}
            return {"resolverState": "low_confidence", "addResult": "not_attempted"}

        pending = {"canonical": canonical("Dragons: Race to the Edge (2015)", "show")}
        self.assertEqual(
            pending["canonical"],
            {"title": "Dragons: Race to the Edge", "year": 2015, "mediaType": "show"},
        )
        state_path.write_text(json.dumps(pending))
        first = merge(pending, "2015")
        second = merge({"canonical": first}, "2015")
        self.assertEqual(first, pending["canonical"])
        self.assertEqual(second, first)
        self.assertEqual(query(second), "Dragons: Race to the Edge 2015 show")
        stub_runner(query(second))
        self.assertEqual(runner_inputs[-1], "Dragons: Race to the Edge 2015 show")

        self.assertEqual(
            canonical("Dragons: Race to the Edge 2015", "show"),
            pending["canonical"],
        )
        specific = merge(pending, "Race to the Edge 2015")
        self.assertEqual(
            specific,
            {"title": "Race to the Edge", "year": 2015, "mediaType": "show"},
        )
        movie = merge({"canonical": canonical("strange harvest", "movie")}, "2026")
        self.assertEqual(query(movie), "strange harvest 2026 movie")
        self.assertEqual(stub_runner(query(movie))["addResult"], "success")

        approved = {"phase", "category", "status", "errorClass"}
        sensitive = {
            "url": "fixture-url", "apiKey": "fixture-key", "responseBody": "fixture-body",
            "telegramId": "fixture-id", "secret": "fixture-secret",
        }
        for phase, category, status, error_class in (
            ("lookup", "HTTP 5xx", 503, "Response"),
            ("library", "timeout", None, "TimeoutError"),
        ):
            raw = {"phase": phase, "category": category, "status": status,
                   "errorClass": error_class, **sensitive}
            sanitized = {key: raw[key] for key in approved}
            self.assertEqual(set(sanitized), approved)
            serialized = json.dumps(sanitized)
            for key, value in sensitive.items():
                self.assertNotIn(key, serialized)
                self.assertNotIn(value, serialized)
            with log_path.open("a") as stream:
                stream.write(json.dumps(sanitized) + "\n")

        self.assertTrue(state_path.is_relative_to(self.root))
        self.assertTrue(log_path.is_relative_to(self.root))
        self.assertNotIn("/home/deploy", str(data_root))
        self.assertNotIn("/app/dist", str(data_root))

    def test_node_runtime_smoke_contract_is_static_safe_and_image_copyable(self):
        self.assertTrue(RUNTIME_SMOKE.is_file())
        source = RUNTIME_SMOKE.read_text()
        self.assertIn("OPENCLAW_TELEGRAM_MEDIA_RUNTIME_ROOT", source)
        self.assertIn("new URL('../runtime/scripts/', import.meta.url)", source)
        self.assertIn("telegram-media-gate.mjs", source)
        self.assertIn("telegram-media-handler.mjs", source)
        self.assertEqual(source.count("await import("), 2)
        for scenario in (
            "/show Dragons: Race to the Edge (2015)",
            "/show Dragons: Race to the Edge 2015",
            "await mediaAccess('2015')",
            "await mediaAccess('Race to the Edge 2015')",
            "/movie strange harvest",
            "await mediaAccess('2026')",
            "lookup_error",
            "library_error",
            "sensitive-api-key-value",
            "sensitive-url-value",
            "sensitive-response-body-value",
            "sensitive-token-value",
            "userId: 'smoke-user'",
            "runtime media clarification smoke passed",
        ):
            self.assertIn(scenario, source)
        self.assertIn("fs.mkdtempSync", source)
        self.assertIn("fs.rmSync(dataRoot, { recursive: true, force: true })", source)
        self.assertIn("globalThis.fetch = async () =>", source)
        for forbidden in (
            "node:child_process", "docker ", "docker-compose", "node:http",
            "node:https", "node:net", "node:tls", "/home/deploy", "/app/dist",
            "/home/node/.openclaw/workspace-coordinator",
        ):
            self.assertNotIn(forbidden, source)
        dockerfile = DOCKERFILE.read_text()
        self.assertEqual(
            dockerfile.count(
                "COPY deployment/telegram-media-gate/tests/"
                "runtime-media-clarification-smoke.mjs"
            ),
            1,
        )
        self.assertIn(
            "/opt/openclaw-telegram-media-gate/deployment/tests/", dockerfile
        )
        runbook = RUNBOOK.read_text()
        self.assertIn("This isolated source host has no Node runtime", runbook)
        self.assertIn("--network none", runbook)
        self.assertIn("--read-only", runbook)
        self.assertIn("--tmpfs /tmp:rw,nosuid,nodev,size=16m", runbook)
        self.assertIn(
            "OPENCLAW_TELEGRAM_MEDIA_RUNTIME_ROOT="
            "/opt/openclaw-telegram-media-gate/scripts",
            runbook,
        )
        self.assertIn(
            "/opt/openclaw-telegram-media-gate/deployment/tests/"
            "runtime-media-clarification-smoke.mjs",
            runbook,
        )

    def test_runtime_has_no_executable_import_from_mutable_data_root(self):
        for source in (DEPLOYMENT / "runtime/scripts").glob("*.mjs"):
            for line in source.read_text().splitlines():
                if line.startswith(("import ", "export ")):
                    self.assertNotIn("/home/node/.openclaw/workspace-coordinator", line)

    def test_all_local_executable_imports_are_relative(self):
        pattern = re.compile(r"""(?:from\s+|import\()["']([^"']+)["']""")
        for source in (DEPLOYMENT / "runtime/scripts").glob("*.mjs"):
            for specifier in pattern.findall(source.read_text()):
                if specifier.endswith(".mjs"):
                    self.assertTrue(
                        specifier.startswith("./") or specifier.startswith("../"),
                        f"{source.name}: {specifier}",
                    )

    def test_command_metadata_resolves_from_immutable_tree(self):
        registry = (DEPLOYMENT / "runtime/scripts/telegram-media-command-registry.mjs").read_text()
        self.assertIn("new URL('../config/telegram-media-commands.json', import.meta.url)", registry)
        commands = json.loads(
            (DEPLOYMENT / "runtime/config/telegram-media-commands.json").read_text()
        )
        self.assertEqual(
            [entry["command"] for entry in commands["telegram"]["commands"]],
            ["/movie", "/show", "/mediahelp"],
        )

    def test_content_count_selector_requires_exact_candidate_counts(self):
        manifest = load_manifest(MANIFEST)
        selector_root = self.root / "selector"
        selector_root.mkdir()
        candidate_text = "\n".join([
            "const handleInboundMessageLike = async (event) => {",
            "await processInboundMessage({",
            'bot.on("message", async (ctx) => {',
            " ".join(["createTelegramBot"] * 4),
        ])
        expected = selector_root / manifest["bundle"]["expected_path"]
        expected.write_text(candidate_text)
        self.assertEqual(resolve_target(manifest, selector_root, None), expected.resolve())

        nonmatch = selector_root / "bot-nonmatch.js"
        nonmatch.write_text(candidate_text.replace("createTelegramBot", "notTheCandidate", 1))
        self.assertEqual(resolve_target(manifest, selector_root, None), expected.resolve())

        duplicate = selector_root / "bot-duplicate.js"
        duplicate.write_text(candidate_text)
        with self.assertRaisesRegex(IntegrityError, "found 2"):
            resolve_target(manifest, selector_root, None)

    def test_wrong_openclaw_package_name_is_rejected(self):
        self.bundle.write_bytes(self.original)
        (self.app / "package.json").write_text(
            '{"name":"not-openclaw","version":"2026.5.4"}'
        )
        result = self.run_tool(PATCH, self.manifest())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("name mismatch", result.stderr)

    def test_evidence_record_and_manifest_values_are_exact(self):
        evidence = json.loads(EVIDENCE.read_text())
        manifest = load_manifest(MANIFEST)
        self.assertEqual(
            set(evidence),
            {
                "schema_version", "collection_timestamp", "collection", "image",
                "version_probe", "bundle", "derivation", "upstream_base_image",
            },
        )
        self.assertEqual(evidence["schema_version"], "1.0.0")
        self.assertEqual(evidence["collection_timestamp"], "2026-07-13T04:55:21Z")
        self.assertEqual(
            evidence["collection"]["archive_sha256"],
            "605c9098d8fbbe0750800244fe7aa778aa8ca79f6ed4a6a111b0a1726c91763a",
        )
        self.assertEqual(evidence["collection"]["evidence_file_hashes_verified"], 5085)
        self.assertFalse(evidence["collection"]["live_container_inspected"])
        self.assertFalse(evidence["collection"]["production_filesystem_inspected"])
        self.assertEqual(
            evidence["image"]["local_image_id"],
            "sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2",
        )
        self.assertEqual(evidence["image"]["openclaw_version"], "2026.5.4")
        self.assertEqual(evidence["image"]["configured_user"], "node")
        self.assertEqual(evidence["image"]["entrypoint"], ["docker-entrypoint.sh"])
        self.assertEqual(
            evidence["image"]["command"],
            ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"],
        )
        bundle = evidence["bundle"]
        self.assertEqual(bundle["image_relative_path"], "dist/bot-D-7bCSXH.js")
        self.assertEqual(bundle["dist_relative_path"], manifest["bundle"]["expected_path"])
        self.assertEqual(bundle["size_bytes"], 244956)
        self.assertEqual(bundle["original_sha256"], manifest["bundle"]["original_sha256"])
        self.assertEqual(bundle["patched_sha256"], manifest["bundle"]["patched_sha256"])
        self.assertEqual(
            bundle["candidate_selector_counts"],
            {
                "const handleInboundMessageLike = async (event) => {": 1,
                "await processInboundMessage({": 1,
                'bot.on("message", async (ctx) => {': 1,
                "createTelegramBot": 4,
            },
        )
        self.assertEqual(
            {entry["name"]: entry["expected_count"] for entry in bundle["structural_anchors"]},
            {"telegram_dedupe_helper": 1, "inbound_message_handoff": 1},
        )
        self.assertEqual(
            {entry["name"]: entry["expected_count"] for entry in manifest["bundle"]["structural_anchors"]},
            {"telegram_dedupe_helper": 1, "inbound_message_handoff": 1},
        )
        self.assertTrue(evidence["derivation"]["idempotent_second_pass"])
        self.assertEqual(
            evidence["derivation"]["changed_files"], ["dist/bot-D-7bCSXH.js"]
        )
        self.assertEqual(
            manifest["upstream_base_image"]["reference"],
            "ghcr.io/openclaw/openclaw:2026.5.4@sha256:"
            "69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56",
        )
        self.assertEqual(
            manifest["upstream_base_image"]["verified_manifest_digest"],
            "sha256:69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56",
        )

    def test_evidence_derivation_matches_production_patcher(self):
        derive_dist = self.root / "derive-dist"
        derive_bundle = derive_dist / "chunks/telegram.js"
        derive_bundle.parent.mkdir(parents=True)
        derive_bundle.write_bytes(self.original)
        manifest = self.manifest()
        result = subprocess.run(
            [
                PYTHON, str(DERIVE), "--manifest", str(manifest),
                "--dist-root", str(derive_dist),
                "--target-relative-path", "chunks/telegram.js",
            ],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        derived = json.loads(result.stdout)
        self.assertEqual(derived["original_sha256"], sha(self.original))
        self.assertEqual(derived["patched_sha256"], sha(self.patched))
        self.assertEqual(derived["changed_files"], ["chunks/telegram.js"])
        self.assertEqual(
            derived["anchor_counts"],
            {"telegram_dedupe_helper": 1, "inbound_message_handoff": 1},
        )
        self.assertTrue(derived["idempotent"])
        derived_bytes = derive_bundle.read_bytes()
        self.assertEqual(derived_bytes, self.patched)

        self.bundle.write_bytes(self.original)
        patched = self.run_tool(PATCH, manifest)
        self.assertEqual(patched.returncode, 0, patched.stderr)
        self.assertEqual(self.bundle.read_bytes(), derived_bytes)
        before = self.bundle.stat().st_mtime_ns
        second = self.run_tool(PATCH, manifest)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.bundle.stat().st_mtime_ns, before)

    def test_tools_have_no_production_or_external_invocation_defaults(self):
        for tool in (PATCH, VERIFY, READINESS, DERIVE, VALIDATE_BASE):
            source = tool.read_text()
            self.assertNotIn('default=pathlib.Path("/app/dist")', source)
            self.assertNotIn("subprocess", source)
            self.assertNotIn("socket", source)
            self.assertNotIn("docker ", source.lower())
        help_result = subprocess.run(
            [PYTHON, str(DERIVE)],
            text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(help_result.returncode, 0)
        self.assertIn("--dist-root", help_result.stderr)
        self.assertIn("--target-relative-path", help_result.stderr)

    def test_registry_evidence_schema_and_manifest_pin_are_exact(self):
        evidence = json.loads(REGISTRY_EVIDENCE.read_text())
        manifest = load_manifest(MANIFEST)
        upstream = manifest["upstream_base_image"]
        self.assertEqual(
            set(evidence),
            {"schema_version", "collection_timestamp", "collection", "registry", "digest_roles"},
        )
        self.assertEqual(evidence["schema_version"], "1.0.0")
        self.assertEqual(evidence["collection_timestamp"], "2026-07-13T16:33:30Z")
        self.assertEqual(
            evidence["collection"]["archive_sha256"],
            "ab516262727b0e2e8440706674b77d39fd0297c6cf4c957bee3d4affd3259e10",
        )
        self.assertEqual(
            evidence["collection"]["method"], "docker buildx imagetools inspect"
        )
        self.assertFalse(evidence["collection"]["image_pulled"])
        self.assertFalse(evidence["collection"]["image_built"])
        self.assertFalse(evidence["collection"]["container_changed"])
        self.assertFalse(evidence["collection"]["compose_service_changed"])
        self.assertEqual(evidence["collection"]["nonself_evidence_hashes_verified"], 10)
        self.assertFalse(evidence["collection"]["hash_manifest_self_entry"]["match"])

        registry = evidence["registry"]
        index_digest = "sha256:7f4dfd4ed0d5469a4f12eccaa5f46b0c70fca802806be625dce782e69203e689"
        platform_digest = "sha256:69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56"
        approved = "ghcr.io/openclaw/openclaw:2026.5.4@" + platform_digest
        self.assertEqual(registry["repository"], "ghcr.io/openclaw/openclaw")
        self.assertEqual(registry["tag"], "2026.5.4")
        self.assertEqual(registry["tag_reference"], "ghcr.io/openclaw/openclaw:2026.5.4")
        self.assertEqual(registry["index"]["digest"], index_digest)
        self.assertEqual(
            registry["index"]["media_type"], "application/vnd.oci.image.index.v1+json"
        )
        self.assertEqual(
            registry["target_platform"],
            {"os": "linux", "architecture": "amd64", "matching_descriptor_count": 1},
        )
        self.assertEqual(registry["platform_manifest"]["digest"], platform_digest)
        self.assertEqual(registry["platform_manifest"]["size"], 4660)
        self.assertEqual(
            registry["platform_manifest"]["media_type"],
            "application/vnd.oci.image.manifest.v1+json",
        )
        self.assertTrue(registry["platform_manifest"]["independently_inspected"])
        self.assertEqual(registry["approved_base_reference"], approved)
        self.assertNotEqual(index_digest, platform_digest)
        self.assertNotIn(index_digest, approved)

        self.assertEqual(upstream["registry_index_digest"], index_digest)
        self.assertEqual(upstream["verified_manifest_digest"], platform_digest)
        self.assertEqual(upstream["verified_manifest_digest_kind"], "platform-manifest")
        self.assertEqual(upstream["selected_platform"], {"os": "linux", "architecture": "amd64"})
        self.assertEqual(upstream["reference"], approved)
        self.assertEqual(
            upstream["evidence_record"],
            "evidence/registry-openclaw-2026.5.4-20260713T163330Z.json",
        )
        local_id = evidence["digest_roles"]["local_image_id"]
        self.assertEqual(local_id, upstream["local_known_good_image_id"])
        self.assertNotEqual(local_id, index_digest)
        self.assertNotEqual(local_id, platform_digest)

    def test_base_image_validation_rejects_missing_argument(self):
        result = self.run_base_validation()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--supplied-reference", result.stderr)

    def test_base_image_validation_rejects_tag_only_reference(self):
        result = self.run_base_validation("ghcr.io/openclaw/openclaw:2026.5.4")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must exactly equal", result.stderr)

    def test_base_image_validation_rejects_index_digest_reference(self):
        result = self.run_base_validation(
            "ghcr.io/openclaw/openclaw:2026.5.4@sha256:"
            "7f4dfd4ed0d5469a4f12eccaa5f46b0c70fca802806be625dce782e69203e689"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must exactly equal", result.stderr)

    def test_base_image_validation_rejects_wrong_repository_tag_or_digest(self):
        alternatives = [
            "ghcr.io/not-openclaw/openclaw:2026.5.4@sha256:"
            "69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56",
            "ghcr.io/openclaw/openclaw:2026.5.5@sha256:"
            "69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56",
            "ghcr.io/openclaw/openclaw:2026.5.4@sha256:" + "b" * 64,
        ]
        for reference in alternatives:
            with self.subTest(reference=reference):
                result = self.run_base_validation(reference)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("must exactly equal", result.stderr)

    def test_base_image_validation_accepts_only_reviewed_platform_reference(self):
        reference = load_manifest(MANIFEST)["upstream_base_image"]["reference"]
        result = self.run_base_validation(reference)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("exactly matches", result.stdout)
        dockerfile = DOCKERFILE.read_text()
        self.assertEqual(dockerfile.count("ARG OPENCLAW_BASE_IMAGE"), 2)
        self.assertIn('--supplied-reference "${OPENCLAW_BASE_IMAGE}"', dockerfile)
        self.assertLess(
            dockerfile.index("validate_base_image.py"),
            dockerfile.index("validate_readiness.py"),
        )
        self.assertLess(
            dockerfile.index("validate_readiness.py"),
            dockerfile.index("patch_bundle.py"),
        )

    def test_image_command_contract_is_explicit_and_compose_does_not_override(self):
        assert_image_command_contract(
            DOCKERFILE.read_text(),
            COMPOSE.read_text(),
            WRAPPER.read_text(),
        )

    def test_image_command_contract_rejects_invalid_static_variants(self):
        dockerfile = DOCKERFILE.read_text()
        compose = COMPOSE.read_text()
        wrapper = WRAPPER.read_text()
        invalid_dockerfiles = {
            "missing CMD": dockerfile.replace(EXPECTED_IMAGE_CMD + "\n", "", 1),
            "shell-form CMD": dockerfile.replace(
                EXPECTED_IMAGE_CMD,
                "CMD node openclaw.mjs gateway --allow-unconfigured",
                1,
            ),
            "wrong CMD arguments": dockerfile.replace(
                EXPECTED_IMAGE_CMD,
                'CMD ["node", "openclaw.mjs", "gateway"]',
                1,
            ),
        }
        for case, invalid in invalid_dockerfiles.items():
            with self.subTest(case=case):
                with self.assertRaisesRegex(AssertionError, "CMD"):
                    assert_image_command_contract(invalid, compose, wrapper)

        compose_override = compose + (
            "\n# Synthetic invalid fixture\n"
            "services:\n"
            "  openclaw-gateway:\n"
            "    command: [\"node\", \"openclaw.mjs\"]\n"
        )
        with self.assertRaisesRegex(AssertionError, "must not override"):
            assert_image_command_contract(dockerfile, compose_override, wrapper)

    def test_local_image_id_cannot_be_used_as_upstream_digest(self):
        manifest = load_manifest(MANIFEST)
        local_id = manifest["upstream_base_image"]["local_known_good_image_id"]
        manifest["upstream_base_image"]["verified_manifest_digest"] = local_id
        manifest["upstream_base_image"]["reference"] = (
            "ghcr.io/openclaw/openclaw:2026.5.4@" + local_id
        )
        path = self.root / "local-id-manifest.json"
        path.write_text(json.dumps(manifest))
        result = subprocess.run(
            [
                PYTHON, str(READINESS), "--manifest", str(path),
                "--runtime-root", str(DEPLOYMENT), "--source-layout",
            ],
            text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("local image ID cannot be used", result.stderr)

if __name__ == "__main__":
    unittest.main()
