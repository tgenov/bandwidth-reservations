#!/usr/bin/env python3
"""Check module boundaries (docs/process/engineering.md §3).

Usage: python3 tools/check_boundaries.py [--repo PATH]

Rules:
- A file under slices/<a>/ must not import from slices/<b>/ (b != a), by relative
  path or by a package name that belongs to slice b.
- A file under platform/ must not import from slices/.
Package names are read from each workspace's package.json.
Exit code 1 if a rule is broken.
"""
import json
import pathlib
import re
import sys

IMPORT = re.compile(r"""(?:^|\s)(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)""", re.M)


def main():
    repo = pathlib.Path(sys.argv[sys.argv.index("--repo") + 1] if "--repo" in sys.argv else ".").resolve()
    owner_of_pkg = {}
    for pj in list(repo.glob("slices/*/package.json")) + list(repo.glob("slices/*/*/package.json")) \
            + list(repo.glob("platform/*/package.json")) + list(repo.glob("platform/*/*/package.json")):
        if "node_modules" in pj.parts:
            continue
        name = json.loads(pj.read_text()).get("name")
        rel = pj.parent.relative_to(repo).parts
        if name:
            owner_of_pkg[name] = ("platform", None) if rel[0] == "platform" else ("slice", rel[1])
    problems = []
    for f in list(repo.glob("slices/**/*.ts")) + list(repo.glob("platform/**/*.ts")):
        if "node_modules" in f.parts or f.name.endswith(".d.ts"):
            continue
        rel = f.relative_to(repo).parts
        mine = ("platform", None) if rel[0] == "platform" else ("slice", rel[1])
        for m in IMPORT.finditer(f.read_text()):
            spec = m.group(1) or m.group(2)
            target = None
            if spec.startswith("."):
                p = (f.parent / spec).resolve()
                try:
                    tr = p.relative_to(repo).parts
                except ValueError:
                    continue
                if tr and tr[0] == "slices" and len(tr) > 1:
                    target = ("slice", tr[1])
                elif tr and tr[0] == "platform":
                    target = ("platform", None)
            else:
                base = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
                target = owner_of_pkg.get(base)
            if target is None:
                continue
            if mine[0] == "platform" and target[0] == "slice":
                problems.append(f"{f.relative_to(repo)}: platform imports slice '{target[1]}' ({spec})")
            elif mine[0] == "slice" and target[0] == "slice" and target[1] != mine[1]:
                problems.append(f"{f.relative_to(repo)}: slice '{mine[1]}' imports slice '{target[1]}' ({spec})")
    for p in problems:
        print(p)
    print(f"boundaries: {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
