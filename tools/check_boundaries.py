#!/usr/bin/env python3
"""Check module boundaries (docs/process/engineering.md §3).

Usage: python3 tools/check_boundaries.py [--repo PATH]

Rules:
- A file under slices/<a>/ must not import from slices/<b>/ (b != a), by relative
  path or by a package name that belongs to slice b.
- A file under platform/ must not import from slices/.
- contracts/ (the contract suites) is neutral. Every slice and the platform may
  import it. A file under contracts/ may import only platform packages and
  contracts/ itself: never a slice.
- Kafka (E-001, engineering.md §3): a file in a src/ folder under platform/ or slices/ must
  not import or require kafkajs or @nestjs/microservices. Only platform/runtime/src/ may import
  @platformatic/kafka: all Kafka traffic goes through FeedBus and the runtime publisher.
Package names are read from each workspace's package.json.
Exit code 1 if a rule is broken.
"""
import json
import pathlib
import re
import sys

IMPORT = re.compile(r"""(?:^|\s)(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)""", re.M)
REQUIRE = re.compile(r"""\brequire\(\s*['"]([^'"]+)['"]\s*\)""")
KAFKA_BANNED = ("kafkajs", "@nestjs/microservices")
KAFKA_CLIENT = "@platformatic/kafka"


def package_of(spec):
    """The package name of a bare import specifier (`@scope/name` or `name`)."""
    return "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]


def kafka_problem(rel, spec):
    """The Kafka rule for one import of the file at repository path `rel`, or None."""
    if spec.startswith(".") or rel[0] not in ("platform", "slices") or "src" not in rel:
        return None
    pkg = package_of(spec)
    if pkg in KAFKA_BANNED:
        return f"{'/'.join(rel)}: imports {pkg} ({spec}); use FeedBus and the runtime publisher (E-001)"
    if pkg == KAFKA_CLIENT and tuple(rel[:3]) != ("platform", "runtime", "src"):
        return f"{'/'.join(rel)}: imports {pkg} outside platform/runtime/src; use FeedBus and the runtime publisher (E-001)"
    return None


def area_of(rel):
    """The area of a repository path: ("platform", None), ("contracts", None) or ("slice", <name>)."""
    if rel[0] in ("platform", "contracts"):
        return (rel[0], None)
    return ("slice", rel[1])


def main():
    repo = pathlib.Path(sys.argv[sys.argv.index("--repo") + 1] if "--repo" in sys.argv else ".").resolve()
    owner_of_pkg = {}
    for pj in list(repo.glob("slices/*/package.json")) + list(repo.glob("slices/*/*/package.json")) \
            + list(repo.glob("platform/*/package.json")) + list(repo.glob("platform/*/*/package.json")) \
            + list(repo.glob("contracts/*/package.json")):
        if "node_modules" in pj.parts:
            continue
        name = json.loads(pj.read_text()).get("name")
        rel = pj.parent.relative_to(repo).parts
        if name:
            owner_of_pkg[name] = area_of(rel)
    problems = []
    for f in list(repo.glob("slices/**/*.ts")) + list(repo.glob("platform/**/*.ts")) + list(repo.glob("contracts/**/*.ts")):
        if "node_modules" in f.parts or f.name.endswith(".d.ts"):
            continue
        rel = f.relative_to(repo).parts
        mine = area_of(rel)
        text = f.read_text()
        specs = [m.group(1) or m.group(2) for m in IMPORT.finditer(text)] + [m.group(1) for m in REQUIRE.finditer(text)]
        problems.extend(p for p in (kafka_problem(rel, s) for s in specs) if p)
        for m in IMPORT.finditer(text):
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
                elif tr and tr[0] in ("platform", "contracts"):
                    target = (tr[0], None)
            else:
                target = owner_of_pkg.get(package_of(spec))
            if target is None:
                continue
            if mine[0] == "platform" and target[0] == "slice":
                problems.append(f"{f.relative_to(repo)}: platform imports slice '{target[1]}' ({spec})")
            elif mine[0] == "slice" and target[0] == "slice" and target[1] != mine[1]:
                problems.append(f"{f.relative_to(repo)}: slice '{mine[1]}' imports slice '{target[1]}' ({spec})")
            elif mine[0] == "contracts" and target[0] == "slice":
                problems.append(f"{f.relative_to(repo)}: contracts imports slice '{target[1]}' ({spec})")
    for p in problems:
        print(p)
    print(f"boundaries: {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
