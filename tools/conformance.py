#!/usr/bin/env python3
"""Measure implementation conformance: scenarios with a named, passing test.

Usage:
  python3 tools/conformance.py [--repo PATH] [--scripts a,b] [--integration]
                               [--write] [--json] [--timeout SECONDS]

--repo         code worktree to measure (default: current directory). Its
               docs/02-specs/*.feature files give the scenario IDs.
--scripts      npm scripts to run (default: every `test:<name>` script in the
               repo's package.json, except `*:integration`).
--integration  also run every `test:<name>:integration` script.
--write        write the Tests and Status cells and a summary into the repo's
               docs/02-specs/conformance.md.
--json         print the result as JSON.

Rules:
- A test counts for a scenario when its title contains the scenario ID, for
  example "P1-S01 ...". The test runner is `node --test` with its default spec
  reporter (lines that start with the pass or fail mark).
- A scenario is `met` when at least one test for it passes in its owning
  slice's test script (`test_script` in docs/process/slices.json) and no test
  for it fails. It is `partly met` when only another slice's tests pass it
  (for example the link side of a P2 scenario). It is `not met` when a test
  for it fails.
- A scenario with no test keeps its existing cells in conformance.md.
- An npm script that times out or exits without test output is reported as an
  error. Its scenarios are not counted.
"""
import json
import pathlib
import re
import subprocess
import sys

PASS, FAIL = "✔", "✖"
ID = re.compile(r"\b([PX]\d-S\d+)\b")
LINE = re.compile(r"^\s*([✔✖])\s+(.*?)(?:\s+\([\d.]+m?s\))?\s*$")


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        return sys.argv[i + 1] if i + 1 < len(sys.argv) else default
    return default


def scenario_ids(repo):
    ids = []
    for f in sorted((repo / "docs/02-specs").glob("*.feature")):
        for m in re.finditer(r"@([PX]\d-S\d+)\b", f.read_text()):
            if m.group(1) not in ids:
                ids.append(m.group(1))
    return ids


def scripts_to_run(repo):
    pkg = json.loads((repo / "package.json").read_text())
    names = list(pkg.get("scripts", {}))
    chosen = arg("--scripts")
    if chosen:
        return [s for s in chosen.split(",") if s in names]
    out = [s for s in names if s.startswith("test:") and not s.endswith(":integration")]
    if "--integration" in sys.argv:
        out += [s for s in names if s.startswith("test:") and s.endswith(":integration")]
    return out


def run_script(repo, script, timeout):
    try:
        p = subprocess.run(["npm", "run", "-s", script], cwd=repo, capture_output=True,
                           text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout} s"
    text = p.stdout + "\n" + p.stderr
    results = []
    for line in text.splitlines():
        m = LINE.match(line)
        if m:
            results.append((m.group(1) == PASS, m.group(2)))
    if not results:
        return None, f"no test output (exit {p.returncode})"
    return results, None


DEFAULT_OWNER = {"P1": "test:link", "P2": "test:account", "P3": "test:rate",
                 "P4": "test:account", "X1": "test:sec", "X2": "test:platform"}


def owner_scripts(repo):
    owners = dict(DEFAULT_OWNER)
    path = repo / "docs/process/slices.json"
    if path.exists():
        for s in json.loads(path.read_text()).get("slices", {}).values():
            for pre in s.get("primary", []):
                if s.get("test_script"):
                    owners[pre] = s["test_script"]
    return owners


def measure(repo, timeout):
    ids = scenario_ids(repo)
    known = set(ids)
    tests = {}      # id -> list of (script, title, passed)
    errors = {}
    for script in scripts_to_run(repo):
        results, err = run_script(repo, script, timeout)
        if err:
            errors[script] = err
            continue
        for passed, title in results:
            for sid in set(ID.findall(title)):
                if sid in known:
                    tests.setdefault(sid, []).append((script, title, passed))
    owners = owner_scripts(repo)
    status = {}
    for sid, ts in tests.items():
        if any(not p for _, _, p in ts):
            status[sid] = "not met"
        elif any(p and s.split(":")[0:2] == owners.get(sid[:2], "").split(":")[0:2]
                 for s, _, p in ts):
            status[sid] = "met"
        else:
            status[sid] = "partly met"
    per = {}
    for sid in ids:
        pre = sid[:2]
        row = per.setdefault(pre, {"total": 0, "met": 0, "partly met": 0, "not met": 0})
        row["total"] += 1
        if sid in status:
            row[status[sid]] += 1
    return ids, tests, status, per, errors


def summary_lines(per, errors, repo):
    total = sum(r["total"] for r in per.values())
    met = sum(r["met"] for r in per.values())
    part = sum(r["partly met"] for r in per.values())
    bad = sum(r["not met"] for r in per.values())
    rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=repo,
                         capture_output=True, text=True).stdout.strip()
    branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo,
                            capture_output=True, text=True).stdout.strip()
    out = [f"Measured by `tools/conformance.py` on `{branch}` at `{rev}`.", "",
           "| Prefix | Met | Partly met | Not met | No test | Total |",
           "|---|---|---|---|---|---|"]
    for pre in sorted(per):
        r = per[pre]
        none = r["total"] - r["met"] - r["partly met"] - r["not met"]
        out.append(f"| {pre} | {r['met']} | {r['partly met']} | {r['not met']} | "
                   f"{none} | {r['total']} |")
    out.append(f"| **All** | **{met}** | **{part}** | **{bad}** | "
               f"**{total - met - part - bad}** | **{total}** |")
    if errors:
        out += ["", "Scripts not counted: " + "; ".join(f"`{s}` ({e})" for s, e in errors.items())]
    return out


def write(repo, tests, status, per, errors):
    path = repo / "docs/02-specs/conformance.md"
    conf = path.read_text()
    head, rest = conf.split("## Matrix", 1)
    matrix, tail = rest.split("\n## ", 1) if "\n## " in rest else (rest, "")
    lines = matrix.split("\n")
    row = re.compile(r"^\| ([PX]\d-S\d+) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \|$")
    for k, line in enumerate(lines):
        m = row.match(line)
        if not m or m.group(1) not in tests:
            continue
        sid, title, design = m.group(1), m.group(2), m.group(3)
        cell = "<br>".join(
            f"`{s}` › \"{t.replace('|', '/')}\"" + ("" if p else " **(fails)**")
            for s, t, p in tests[sid])
        lines[k] = f"| {sid} | {title} | {design} | {cell} | {status[sid]} |"
    matrix = "\n".join(lines)
    sections = ("\n## " + tail) if tail else ""
    sections = re.sub(r"\n## Implementation summary\n.*?(?=\n## |\Z)", "", sections, flags=re.S)
    summary = "\n## Implementation summary\n\n" + "\n".join(summary_lines(per, errors, repo)) + "\n"
    path.write_text(head + "## Matrix" + matrix.rstrip("\n") + "\n" + summary + sections)


def main():
    repo = pathlib.Path(arg("--repo", ".")).resolve()
    timeout = int(arg("--timeout", "600"))
    ids, tests, status, per, errors = measure(repo, timeout)
    if "--json" in sys.argv:
        print(json.dumps({"per": per, "status": status, "errors": errors}, indent=2))
    else:
        print("\n".join(summary_lines(per, errors, repo)))
        failing = sorted(s for s, v in status.items() if v == "not met")
        if failing:
            print("\nNot met: " + " ".join(failing))
    if "--write" in sys.argv:
        write(repo, tests, status, per, errors)
        print(f"\nwrote {repo / 'docs/02-specs/conformance.md'}")


if __name__ == "__main__":
    main()
