"""Impact and coverage analysis for the design pipeline (stdlib only).

Usage:
  python3 tools/impact.py diff <old-ref> [<new-ref>|WORKTREE]
      What changed in the requirements between two git refs (scenarios added,
      changed, removed; policies changed; needs changed), and which slices
      (docs/process/slices.json) must be rebased because their RFC cites a
      changed ID or owns a changed scenario.
  python3 tools/impact.py coverage [<slice>...]
      For each slice (default: all), list primary-spec scenarios that its RFC
      never cites (traceability gaps), and IDs its RFC cites that no longer exist.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REG = json.loads((ROOT / "docs/process/slices.json").read_text())
SLICES = REG["slices"]
SCEN_TAG = re.compile(r"@([PX]\d-S\d+)\b")
ID = re.compile(r"\b([PX]\d)-([SN])(\d+)\b")
RANGE = re.compile(r"\b([PX]\d)-([SN])(\d+)\s*(?:…|\.\.\.?|–|to)\s*(?:\1-\2)?(\d+)\b")
POL = re.compile(r"\bPOL-(\d\d)\b")


def read(ref, path):
    if ref == "WORKTREE":
        p = ROOT / path
        return p.read_text() if p.exists() else ""
    r = subprocess.run(["git", "-C", str(ROOT), "show", f"{ref}:{path}"],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def ls(ref, pattern):
    if ref == "WORKTREE":
        return [str(p.relative_to(ROOT)) for p in ROOT.glob(pattern)]
    r = subprocess.run(["git", "-C", str(ROOT), "ls-tree", "-r", "--name-only", ref],
                       capture_output=True, text=True)
    return [f for f in r.stdout.split() if pathlib.PurePath(f).match(pattern)]


def scenarios(text):
    """Map scenario ID -> normalised block text."""
    out, cur, buf = {}, None, []
    for line in text.splitlines():
        m = SCEN_TAG.search(line) if line.lstrip().startswith("@") else None
        if m:
            if cur:
                out[cur] = "\n".join(buf).strip()
            cur, buf = m.group(1), [line.strip()]
        elif cur:
            if re.match(r"\s*(Rule|Feature):", line):
                out[cur] = "\n".join(buf).strip()
                cur, buf = None, []
            else:
                buf.append(line.strip())
    if cur:
        out[cur] = "\n".join(buf).strip()
    return out


def sections(text, head=r"^## (POL-\d\d)\."):
    parts = re.split(head, text.split("## Amendments")[0], flags=re.M)
    return {parts[i]: parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


def need_rows(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"^\| ([PX]\d-N\d+) \|.*$", text, re.M)}


def cited(text):
    ids = set(f"{a}-{b}{int(c):02d}" for a, b, c in ID.findall(text))
    for a, b, lo, hi in RANGE.findall(text):
        ids |= {f"{a}-{b}{n:02d}" for n in range(int(lo), int(hi) + 1)}
    return ids, {"POL-" + p for p in POL.findall(text)}


def norm(i):
    a, b, n = re.match(r"([PX]\d)-([SN])(\d+)", i).groups()
    return f"{a}-{b}{int(n):02d}"


def snapshot(ref):
    sc, needs = {}, {}
    for f in ls(ref, "docs/02-specs/*.feature"):
        sc.update(scenarios(read(ref, f)))
    for f in ls(ref, "docs/01-discovery/*.md"):
        needs.update(need_rows(read(ref, f)))
    pols = sections(read(ref, "docs/02-specs/policy-register.md"))
    return {norm(k): v for k, v in sc.items()}, {norm(k): v for k, v in needs.items()}, pols


def diff(old, new):
    so, no, po = snapshot(old)
    sn, nn, pn = snapshot(new)
    added = sorted(set(sn) - set(so))
    removed = sorted(set(so) - set(sn))
    changed = sorted(k for k in set(so) & set(sn) if so[k] != sn[k])
    pols = sorted(k for k in set(po) | set(pn) if po.get(k) != pn.get(k))
    needs = sorted(k for k in set(no) | set(nn) if no.get(k) != nn.get(k))
    print(f"scenarios: +{len(added)} ~{len(changed)} -{len(removed)}; policies changed: {len(pols)}; needs changed: {len(needs)}")
    for label, xs in (("added", added), ("changed", changed), ("removed", removed), ("policies", pols), ("needs", needs)):
        if xs:
            print(f"  {label}: {' '.join(xs)}")
    hot = set(added) | set(changed) | set(removed) | set(needs)
    print("impacted slices:")
    for name, s in SLICES.items():
        text = read(new, s["rfc"]) or read("WORKTREE", s["rfc"])
        ids, ps = cited(text)
        own = {i for i in hot if i[:2] in s["primary"]}
        hits = sorted((ids & hot) | own)
        phits = sorted(ps & set(pols))
        if hits or phits:
            print(f"  {name} ({s['rfc'].split('/')[-1]}): ids {' '.join(hits) or '-'}; policies {' '.join(phits) or '-'}")
    arch = read(new, REG["architecture"]["rfc"]) or ""
    aids, aps = cited(arch)
    if (aids & hot) or (aps & set(pols)):
        print("  ARCHITECTURE (RFC-000): cites " + " ".join(sorted((aids & hot) | (aps & set(pols)))))


def coverage(names):
    sc, needs, _ = snapshot("WORKTREE")
    allids = set(sc) | set(needs)
    for name in names or SLICES:
        s = SLICES[name]
        ids, _ = cited((ROOT / s["rfc"]).read_text())
        primary = {i for i in sc if i[:2] in s["primary"]}
        missing = sorted(primary - ids)
        dangling = sorted(i for i in ids if i not in allids)
        print(f"{name}: primary {len(primary)}, uncited {len(missing)}, dangling {len(dangling)}")
        if missing:
            print("  uncited: " + " ".join(missing))
        if dangling:
            print("  dangling: " + " ".join(dangling))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] not in ("diff", "coverage"):
        print(__doc__)
        sys.exit(2)
    if a[0] == "diff":
        diff(a[1], a[2] if len(a) > 2 else "WORKTREE")
    else:
        coverage(a[1:])
