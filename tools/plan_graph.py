#!/usr/bin/env python3
"""Build the delivery dependency graph from the slice plans.

Usage: python3 tools/plan_graph.py [--done ID,ID,...] [--write]

Reads docs/04-delivery/plan/S-*.md. For each increment heading "### <ID>. <title>"
it reads the "| Dependencies | ... |" row and the "| Goal | ... |" row:
- a local ID ("I3", "SP2") means the same plan;
- a full ID (S-PLAT-I1, S-SEC-I3, AM-I5, MONEY-I2, ACCT-I4, S-LINK-I2, S-RATE-I6) is
  taken as written;
- cross-slice edges that the plans state as contract parts are read from
  docs/04-delivery/plan/cross-deps.tsv (provider, consumer, part, source).
--done marks increments as delivered. --write writes docs/04-delivery/plan/graph.md.
"""
import pathlib
import re
import sys

PLAN = pathlib.Path(__file__).resolve().parent.parent / "docs/04-delivery/plan"
FULL = re.compile(r"\b(S-PLAT-I\d+|S-LINK-I\d+|S-SEC-I\d+|S-RATE-I\d+|AM-I\d+|ACCT-I\d+|MONEY-I\d+)\b")
LOCAL = re.compile(r"(?<![\w-])(I\d+|SP\d+)\b")
PLATL = re.compile(r"\bPLAT-([A-Z])\b")
HEAD = re.compile(r"^### ((?:S-PLAT|S-LINK|S-SEC|S-RATE|AM|ACCT|MONEY)-I\d+)\. (.*)$")
SLICE_OF = {"S-PLAT": "S-PLAT", "S-LINK": "S-LINK", "S-SEC": "S-SEC", "S-RATE": "S-RATE",
            "AM": "S-ACCT+MONEY", "ACCT": "S-ACCT+MONEY", "MONEY": "S-ACCT+MONEY"}


def slice_of(inc):
    return SLICE_OF[inc.rsplit("-I", 1)[0]]


def prefix_for_local(plan_name, local, known):
    if plan_name == "S-ACCT-S-MONEY":
        for p in ("AM", "ACCT", "MONEY"):
            if f"{p}-{local}" in known:
                return f"{p}-{local}"
        return None
    return f"{plan_name}-{local}"


def parse():
    incs, deps = {}, {}
    for f in sorted(PLAN.glob("S-*.md")):
        text = f.read_text()
        plat_map = {m.group(1): m.group(2) for m in
                    re.finditer(r"^\| \*\*PLAT-([A-Z])\*\*.*\| (I\d+)\s*\|\s*$", text, re.M)}
        cur = None
        for line in text.splitlines():
            h = HEAD.match(line)
            if h:
                cur = h.group(1)
                incs[cur] = {"title": h.group(2), "plan": f.stem, "plat": plat_map}
                deps[cur] = set()
                continue
            if cur and line.startswith("| Dependencies |"):
                deps[cur].add(("raw", line))
            if line.startswith("## ") and not line.startswith("## 5"):
                cur = None
    known = set(incs)
    edges = set()
    for inc, ds in deps.items():
        for _, line in ds:
            body = line.split("|", 2)[2]
            for m in FULL.finditer(body):
                if m.group(1) != inc:
                    edges.add((m.group(1), inc))
            stripped = FULL.sub("", body)
            for m in LOCAL.finditer(stripped):
                if m.group(1).startswith("SP"):
                    continue
                full = prefix_for_local(incs[inc]["plan"], m.group(1), known)
                if full and full != inc and full in known:
                    edges.add((full, inc))
    parts = {}
    tsv = PLAN / "cross-deps.tsv"
    if tsv.exists():
        for line in tsv.read_text().splitlines()[1:]:
            cols = line.split("\t")
            if len(cols) >= 3 and cols[0] in known and cols[1] in known:
                edges.add((cols[0], cols[1]))
                parts.setdefault((cols[0], cols[1]), []).append(cols[2])
    edges = {(a, b) for a, b in edges if a in known and b in known}
    return incs, edges, parts


def node_id(inc):
    return inc.replace("-", "_").replace("+", "_")


def short(t, n=38):
    t = re.sub(r"[`*\"]", "", t)
    return t if len(t) <= n else t[: n - 1] + "…"


WAVE0 = "2026-10-19"
COLOR = {"S-PLAT": "#e8eaed", "S-SEC": "#fde2e2", "S-LINK": "#e6f5e6",
         "S-ACCT+MONEY": "#e3f0fb", "S-RATE": "#fff3d6"}


def waves(incs, edges, done):
    """Earliest wave of each increment: done = 0; else 1 + the latest wave it needs."""
    preds = {i: set() for i in incs}
    for a, b in edges:
        preds[b].add(a)
    wave = {}

    def w(i, seen=()):
        if i in wave:
            return wave[i]
        if i in seen:
            raise SystemExit(f"cycle at {i}")
        if i in done:
            wave[i] = 0
        else:
            wave[i] = 1 + max((w(p, seen + (i,)) for p in preds[i]), default=0)
        return wave[i]

    for i in incs:
        w(i)
    return wave, preds


def critical_path(wave, preds):
    end = max(wave, key=lambda i: (wave[i], i))
    path = [end]
    while preds[path[-1]]:
        nxt = max(preds[path[-1]], key=lambda p: (wave[p], p))
        if wave[nxt] == 0:
            break
        path.append(nxt)
    return list(reversed(path))


def render(incs, edges, done, parts):
    slices = ["S-PLAT", "S-SEC", "S-LINK", "S-ACCT+MONEY", "S-RATE"]
    wave, preds = waves(incs, edges, done)
    crit = critical_path(wave, preds)
    cross = {}
    for a, b in edges:
        sa, sb = slice_of(a), slice_of(b)
        if sa != sb:
            cross[(sa, sb)] = cross.get((sa, sb), 0) + 1
    total = {s: sum(1 for i in incs if slice_of(i) == s) for s in slices}
    ndone = {s: sum(1 for i in incs if slice_of(i) == s and i in done) for s in slices}
    out = ["# Delivery dependency graph", "",
           "Generated by `python3 tools/plan_graph.py --write` from the slice plans. Do not edit by hand.",
           "", "## 1. Slices", "",
           "An arrow A → B means some increment of B needs an increment of A. The label is the "
           "number of such increment dependencies.", "", "```mermaid", "flowchart LR"]
    for s in slices:
        out.append(f'  {node_id(s)}["{s}<br/>{ndone[s]} / {total[s]} increments done"]')
    for (a, b), n in sorted(cross.items()):
        out.append(f"  {node_id(a)} -- {n} --> {node_id(b)}")
    out += ["  classDef started fill:#e6f5e6,stroke:#27ae60",
            "  class " + ",".join(node_id(s) for s in slices if ndone[s]) + " started", "```", ""]
    nw = max(wave.values())
    out += ["## 2. Waves (planning view)", "",
            f"Each increment is placed in the earliest wave in which every increment it needs is "
            f"done. Wave 0 is delivered. There are {nw} waves after the delivered work. The chart "
            f"draws one wave as one week from {WAVE0}; that pace is a placeholder, the order is what "
            f"the graph proves. Red bars are the critical path ({len(crit)} increments): "
            + " → ".join(crit) + ".", "", "```mermaid", "gantt",
            "  title Delivery waves (one bar per increment)", "  dateFormat YYYY-MM-DD",
            "  axisFormat W%W", "  tickInterval 1week"]
    import datetime
    base = datetime.date.fromisoformat(WAVE0)
    for s in slices:
        out.append(f"  section {s}")
        for i in sorted((i for i in incs if slice_of(i) == s), key=lambda x: (wave[x], x)):
            start = base + datetime.timedelta(weeks=wave[i] - 1)
            tags = "done, " if wave[i] == 0 else ("crit, " if i in crit else "")
            label = f"{i} {short(incs[i]['title'], 34)}".replace(":", " ").replace(";", ",")
            out.append(f"  {label} :{tags}{start.isoformat()}, 7d")
    out += ["```", "", "| Wave | " + " | ".join(slices) + " |", "|---|" + "---|" * len(slices)]
    for k in range(0, nw + 1):
        row = [", ".join(sorted((i for i in incs if wave[i] == k and slice_of(i) == s),
                                key=lambda x: x)) or "—" for s in slices]
        out.append(f"| {k if k else '0 (done)'} | " + " | ".join(row) + " |")
    out += ["", "## 3. Increments", "",
            "Green: delivered. Bold border: on the critical path to the walking skeletons of every "
            "slice and the money path (S-PLAT-I1, MONEY-I2, AM-I5, AM-I6). Lanes are slices.", "",
            "```mermaid", "flowchart TB"]
    for s in slices:
        out.append(f'  subgraph L_{node_id(s)}["{s}"]')
        out.append("    direction TB")
        mine = sorted((i for i in incs if slice_of(i) == s),
                      key=lambda x: int(x.rsplit("-I", 1)[1]))
        for i in mine:
            out.append(f'    {node_id(i)}["{i}<br/>{short(incs[i]["title"])}"]')
        out.append("  end")
    for a, b in sorted(edges):
        style = "-->" if slice_of(a) == slice_of(b) else "==>"
        out.append(f"  {node_id(a)} {style} {node_id(b)}")
    if done:
        out.append("  classDef done fill:#c8e6c9,stroke:#2e7d32")
        out.append("  class " + ",".join(node_id(i) for i in sorted(done) if i in incs) + " done")
    key = [i for i in ("S-PLAT-I1", "MONEY-I2", "AM-I5", "AM-I6") if i in incs]
    out.append("  classDef key stroke-width:3px")
    out.append("  class " + ",".join(node_id(i) for i in key) + " key")
    out += ["```", "", "## 4. Cross-slice dependencies", "",
            "| Provider increment | Consumer increment | Part |", "|---|---|---|"]
    for a, b in sorted(edges, key=lambda e: (slice_of(e[0]), e[0], e[1])):
        if slice_of(a) != slice_of(b):
            what = "; ".join(sorted(set(parts.get((a, b), [])))) or "(plan dependency row)"
            out.append(f"| {a} {short(incs[a]['title'], 40)} | {b} {short(incs[b]['title'], 40)} | {what} |")
    return "\n".join(out) + "\n"


def main():
    done = set()
    if "--done" in sys.argv:
        done = set(sys.argv[sys.argv.index("--done") + 1].split(","))
    incs, edges, parts = parse()
    md = render(incs, edges, done, parts)
    print(f"increments: {len(incs)}, edges: {len(edges)}, "
          f"cross-slice: {sum(1 for a, b in edges if slice_of(a) != slice_of(b))}")
    if "--write" in sys.argv:
        (PLAN / "graph.md").write_text(md)
        print(f"wrote {PLAN / 'graph.md'}")
    else:
        print(md)


if __name__ == "__main__":
    main()
