#!/usr/bin/env python3
"""Exercise candidate generation in real repositories, without GitHub or credentials."""

import os
import json
from pathlib import Path
import itertools
import re
import subprocess
import tempfile
import unittest


SCRIPT = Path(os.environ.get("SYNC_SCRIPT_PATH", Path(__file__).with_name("sync-upstream.sh")))
WORKFLOW = Path(os.environ.get("SYNC_WORKFLOW_PATH", Path(__file__).parents[1] / ".github/workflows/sync-upstream.yml"))


class SyncUpstreamTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.upstream.mkdir()
        self.env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                    "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
        self.git(self.upstream, "init", "-b", "main")
        self.write(self.upstream, "LICENSE", "MIT fixture copyright\n")
        self.write(self.upstream, "shared.txt", "original\n")
        self.commit(self.upstream, "shared history")
        self.origin = self.root / "origin.git"
        self.git(self.root, "clone", "--bare", str(self.upstream), str(self.origin))
        self.repo = self.root / "fork"
        self.git(self.root, "clone", str(self.origin), str(self.repo))
        self.write(self.repo, "scripts/sync-upstream.sh", SCRIPT.read_text())
        self.write(self.repo, "team.txt", "fork isolation must survive\n")
        self.commit(self.repo, "fork commits")
        self.git(self.repo, "push", "origin", "main")
        self.base = self.git(self.repo, "rev-parse", "HEAD").strip()

    def git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, env=self.env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout

    def write(self, repo, name, content):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self, repo, message):
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", message)

    def sync(self, expected):
        output = self.root / "output"
        output.write_text("")
        result = subprocess.run(["bash", "scripts/sync-upstream.sh"], cwd=self.repo,
                                env={**self.env, "SYNC_UPSTREAM_URL": str(self.upstream),
                                     "GITHUB_OUTPUT": str(output)}, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        print(f"{self.id()}: exit={result.returncode} expected={expected}", flush=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD").strip(), self.base)
        self.assertEqual(self.git(self.repo, "rev-parse", "main").strip(), self.base)
        self.assertEqual(self.git(self.repo, "ls-remote", "origin", "refs/heads/main").split()[0], self.base)
        self.assertEqual(self.git(self.repo, "status", "--porcelain"), "")
        return dict(line.split("=", 1) for line in output.read_text().splitlines())

    def update(self, name="upstream.txt", content="upstream update\n"):
        self.write(self.upstream, name, content)
        self.commit(self.upstream, "upstream update")

    def test_no_update(self):
        self.assertEqual(self.sync(0)["status"], "no-update")
        self.assertEqual(self.git(self.repo, "for-each-ref", "refs/heads/sync/"), "")

    def test_clean_update_and_repeat(self):
        self.update()
        candidate = self.sync(0)
        self.assertEqual(candidate["status"], "clean")
        self.assertEqual(self.git(self.repo, "show", f'{candidate["head"]}:team.txt'), "fork isolation must survive\n")
        self.assertEqual(self.git(self.repo, "show", f'{candidate["head"]}:upstream.txt'), "upstream update\n")
        self.assertEqual(self.git(self.repo, "show", f'{candidate["head"]}:LICENSE'), "MIT fixture copyright\n")
        self.assertEqual(self.git(self.repo, "show", "-s", "--format=%P", candidate["head"]).strip(),
                         f'{self.base} {candidate["upstream"]}')
        self.assertEqual(self.sync(0), candidate)

    def test_conflict_and_repeat(self):
        self.write(self.repo, "shared.txt", "team boundary\n")
        self.commit(self.repo, "team boundary")
        self.git(self.repo, "push", "origin", "main")
        self.base = self.git(self.repo, "rev-parse", "HEAD").strip()
        self.update("shared.txt", "upstream boundary\n")
        candidate = self.sync(2)
        self.assertEqual(candidate["status"], "blocked")
        self.assertEqual(self.git(self.repo, "diff", "--name-only", self.base, candidate["head"]),
                         "UPSTREAM_SYNC_BLOCKED.md\n")
        self.assertIn("shared.txt", self.git(self.repo, "show", f'{candidate["head"]}:UPSTREAM_SYNC_BLOCKED.md'))
        self.assertEqual(self.sync(2), candidate)

    def test_license_change_is_blocked(self):
        self.update("LICENSE", "different license\n")
        candidate = self.sync(2)
        self.assertEqual(self.git(self.repo, "show", f'{candidate["head"]}:LICENSE'), "MIT fixture copyright\n")

    def test_existing_candidate_edits_are_not_overwritten(self):
        self.update()
        candidate = self.sync(0)
        self.git(self.repo, "branch", "-f", candidate["branch"], self.base)
        self.sync(1)
        self.assertEqual(self.git(self.repo, "rev-parse", candidate["branch"]).strip(), self.base)

    def test_operational_git_failure_exits_one(self):
        self.update()
        env = {**self.env, "SYNC_UPSTREAM_URL": str(self.root / "missing.git")}
        result = subprocess.run(["bash", "scripts/sync-upstream.sh"], cwd=self.repo,
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.git(self.repo, "remote", "set-url", "origin", str(self.root / "missing.git"))
        result = subprocess.run(["bash", "scripts/sync-upstream.sh"], cwd=self.repo,
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD").strip(), self.base)
        self.assertEqual(self.git(self.repo, "for-each-ref", "refs/heads/sync/"), "")

    def test_dirty_checkout_is_rejected(self):
        self.update()
        self.write(self.repo, "untracked.txt", "must survive\n")
        result = subprocess.run(["bash", "scripts/sync-upstream.sh"], cwd=self.repo,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual((self.repo / "untracked.txt").read_text(), "must survive\n")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD").strip(), self.base)

    def test_workflow_publish_deduplicates(self):
        self.update()
        candidate = self.sync(0)
        tools = self.root / "bin"
        tools.mkdir()
        gh = tools / "gh"
        gh.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ["GH_FIXTURE_STATE"])
state = json.loads(p.read_text()) if p.exists() else []
args = sys.argv[1:]
if args[0] == "api":
    print(json.dumps([state]))
elif args[:2] == ["pr", "create"]:
    state.append({"number": len(state)+1, "state": "open", "draft": True, "user": {"login": "github-actions[bot]"},
        "head": {"ref": os.environ["BRANCH"], "repo": {"full_name": os.environ["GITHUB_REPOSITORY"]}},
        "body": Path(args[args.index("--body-file")+1]).read_text()})
elif args[:2] == ["pr", "view"]:
    print(next(x["state"].upper() for x in state if str(x["number"]) == args[2]))
elif args[:2] == ["pr", "edit"]:
    next(x for x in state if str(x["number"]) == args[2])["body"] = Path(args[-1]).read_text()
elif args[:2] == ["pr", "close"]:
    next(x for x in state if str(x["number"]) == args[2])["state"] = "closed"
else:
    sys.exit("unexpected gh call: " + str(args))
p.write_text(json.dumps(state))
''')
        gh.chmod(0o755)
        publish = WORKFLOW.read_text().split("          git push origin", 1)[1].split("      - name: Report blocked", 1)[0]
        publish = "git push origin" + publish
        publish = "\n".join(line[10:] if line.startswith("          ") else line for line in publish.splitlines())
        state = self.root / "prs.json"
        env = {**self.env, **{key.upper(): value for key, value in candidate.items()},
               "PATH": str(tools) + os.pathsep + os.environ["PATH"], "GH_FIXTURE_STATE": str(state),
               "RUNNER_TEMP": str(self.root), "GITHUB_REPOSITORY": "IchenDEV/team", "GITHUB_RUN_ID": "fixture"}
        for _ in range(2):
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", publish], cwd=self.repo, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        prs = json.loads(state.read_text())
        self.assertEqual(len(prs), 1)
        self.assertEqual(prs[0]["state"], "open")
        prs[0]["user"]["login"] = "another-author"
        state.write_text(json.dumps(prs))
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", publish], cwd=self.repo, env=env,
                                capture_output=True, text=True, errors="replace")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(state.read_text()), prs)
        prs[0]["user"]["login"] = "github-actions[bot]"
        prs[0]["state"] = "closed"
        state.write_text(json.dumps(prs))
        subprocess.run(["bash", "-euo", "pipefail", "-c", publish], cwd=self.repo, env=env, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(json.loads(state.read_text()), prs)
        prs[0]["state"] = "open"
        prs.append({**prs[0], "number": 2, "user": {"login": "another-author"}})
        prs.append({**prs[0], "number": 3, "body": "unmarked candidate"})
        prs.append({**prs[0], "number": 4, "draft": False})
        state.write_text(json.dumps(prs))
        self.update("new.txt", "next update\n")
        replacement = self.sync(0)
        env.update({key.upper(): value for key, value in replacement.items()})
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", publish], cwd=self.repo, env=env,
                                capture_output=True, text=True, errors="replace")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        prs = json.loads(state.read_text())
        self.assertEqual([pr["state"] for pr in prs], ["closed", "open", "open", "open", "open"])


class WorkflowGuardTest(unittest.TestCase):
    def test_candidate_guard_matrix_and_permissions(self):
        workflow = WORKFLOW.read_text()
        job = workflow.split("  candidate-check:", 1)[1]
        guard = job.split("    if: >-\n", 1)[1].split("    runs-on:", 1)[0]
        keys = ["needs.sync.result", "needs.sync.outputs.status", "github.repository", "github.ref", "github.event_name"]
        values = [("success", "failure", "skipped"), ("clean", "blocked", "no-update"),
                  ("IchenDEV/team", "pingdotgg/t3code"), ("refs/heads/main", "refs/heads/other"),
                  ("schedule", "workflow_dispatch", "pull_request")]
        for case in itertools.product(*values):
            context = dict(zip(keys, case))
            actual = True
            for clause in guard.split("&&"):
                key, op, value = re.fullmatch(r"\s*([\w.]+)\s*(==|!=)\s*'([^']+)'\s*", clause).groups()
                actual = actual and ((context[key] == value) if op == "==" else (context[key] != value))
            expected = case[:4] == ("success", "clean", "IchenDEV/team", "refs/heads/main") and case[4] != "pull_request"
            self.assertEqual(actual, expected, context)
        self.assertIn("    permissions:\n      contents: read\n", job)
        # persist-credentials removal walks the .repos/ gitlinks, which have no
        # .gitmodules URL, and fails the checkout; job permissions bind the token.
        self.assertNotIn("persist-credentials", job)
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("pull_request_target", workflow)
        self.assertNotIn("continue-on-error", workflow)
        self.assertEqual(workflow.count("runs-on: ubuntu-latest"), 3)


if __name__ == "__main__":
    unittest.main()
