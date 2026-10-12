"""Mechanical checks over the requirements baseline (stdlib only).

Usage: python3 tools/check_specs.py [docsDir=docs] [--regen]
  --regen  regenerate docs/02-specs/conformance.md rows (keeps existing cells)
"""
import pathlib
import re
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
docs = pathlib.Path(args[0] if args else "docs")
specs, disc = docs / "02-specs", docs / "01-discovery"
problems = []
P = problems.append

register = (specs / "policy-register.md").read_text()
pols = set(re.findall(r"^## (POL-\d\d)\.", register, re.M))
params = set(re.findall(r"^\| `([a-z_]+)` \|", register, re.M))
extra = {"request_age", "retry_after", "wait", "pending"}

entries = register.split("## Amendments")[0]
if re.search(r"Amended \(round|\(round \d\)", entries, re.I):
    P("register: round marker inside entries")
for m in re.finditer(r"POL-(\d\d)", register):
    if "POL-" + m.group(1) not in pols:
        P("register: unknown " + m.group(0))

needs = set()
for f in disc.glob("*.md"):
    needs |= set(re.findall(r"^\| ([PX]\d-N\d+) \|", f.read_text(), re.M))
cited = set()

term_rules = [
    (r"\bkey headroom\b", "POL-25"),
    (r"(?<!key )\bheadroom\b", "POL-18"),
    (r"\bsuspended\b", "POL-16"),
    (r"\binsufficient funds\b", "POL-15"),
    (r"\bcounter-offer\b", "POL-10"),
    (r"\bcancellation fee\b", "POL-08"),
    (r"\bterminat(e|ed|es|ion)\b", "POL-30"),
]

STEP = re.compile(r"^(Given|When|Then|And|But|\*) (.*)$")
order, ids = [], []
files = sorted(specs.glob("*.feature"))
for f in files:
    prefix = f.name[:2]
    lines = f.read_text().split("\n")
    nfeat = sum(1 for l in lines if l.strip().startswith("Feature:"))
    if nfeat != 1:
        P(f"{f.name}: {nfeat} Feature lines")
    in_rule = False
    bg = None  # list of step texts of current rule background
    cur = None
    pending_tags = []
    mode = None  # 'bg', 'sc', 'ex', None

    def close():
        global cur
        if not cur:
            return
        c = cur
        cur = None
        tags = c["tags"]
        sid = [t for t in tags if re.fullmatch(r"[PX]\d-S\d+", t)]
        if len(sid) != 1:
            P(f"{f.name}:{c['line']}: {len(sid)} IDs")
            return
        i = sid[0]
        if not i.startswith(prefix):
            P(f"{i}: wrong prefix")
        ids.append(i)
        order.append((i, c["name"]))
        for t in tags:
            if t.startswith("need-"):
                n = t[5:]
                if n not in needs:
                    P(f"{i}: dangling {t}")
                cited.add(n)
            elif t.startswith("POL-"):
                if t not in pols:
                    P(f"{i}: unknown {t}")
            elif t != i:
                P(f"{i}: stray tag {t}")
        last, eff = "", []
        for k, _ in c["steps"]:
            if k in ("And", "But", "*"):
                eff.append(last)
            else:
                last = k
                eff.append(k)
        if "When" not in eff or "Then" not in eff:
            P(f"{i}: missing When/Then")
        for _, s in c["steps"]:
            if re.match(r"^[^\w\"`'(\[<]", s):
                P(f"{i}: step starts with punctuation")
        own = [c["name"]] + [s for _, s in c["steps"]]
        if not c["outline"] and c["tables"]:
            P(f"{i}: plain Scenario with Examples")
        if c["outline"] and not c["tables"]:
            P(f"{i}: outline without Examples")
        ex_text = []
        for head, rows in c["tables"]:
            used = [any(f"<{h}>" in t for t in own) for h in head]
            unused = [h for h, u in zip(head, used) if not u]
            if len(unused) > 1 or (len(unused) == 1 and used[-1]):
                P(f"{i}: unused columns {unused}")
            for t in own:
                for m in re.finditer(r"<([^>]+)>", t):
                    if m.group(1) not in head:
                        P(f"{i}: placeholder <{m.group(1)}> has no column")
            for r in rows:
                if len(r) != len(head):
                    P(f"{i}: row width {len(r)} != {len(head)}")
                ex_text.append(" | ".join(r))
        text = "\n".join(own + ex_text)
        named = set(re.findall(r"POL-\d\d", text + "\n" + "\n".join(c["bg"])))
        for n in named:
            if n not in tags:
                P(f"{i}: names {n} untagged")
        for rx, pol in term_rules:
            if re.search(rx, text, re.I) and pol not in tags:
                P(f"{i}: term /{rx}/ needs {pol}")
        stripped = re.sub(r"`wait` setting|without waiting for|may wait for capacity", "", text, flags=re.I)
        if re.search(r"\bwait(s|ing)\b", stripped, re.I) and "POL-05" not in tags:
            P(f"{i}: term wait(s|ing) needs POL-05")

    for n, raw in enumerate(lines, 1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("Feature:"):
            continue
        if s.startswith("Rule:"):
            close(); in_rule = True; bg = []; mode = None
            continue
        if s.startswith("Background:"):
            close()
            if not in_rule:
                P(f"{f.name}:{n}: Background outside a Rule")
            bg = []; mode = "bg"
            continue
        if s.startswith("@"):
            close(); pending_tags = [t[1:] for t in s.split()]; mode = None
            continue
        m = re.match(r"^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$", s)
        if m:
            close()
            if not in_rule:
                P(f"{f.name}:{n}: Scenario outside a Rule")
            cur = dict(tags=pending_tags, name=m.group(2).strip(), outline="Outline" in m.group(1) or "Template" in m.group(1),
                       steps=[], tables=[], bg=list(bg or []), line=n)
            pending_tags = []; mode = "sc"
            continue
        if s.startswith("Examples:") or s.startswith("Scenarios:"):
            if cur is None:
                P(f"{f.name}:{n}: Examples outside a scenario")
            else:
                cur["tables"].append([None, []]); mode = "ex"
            continue
        if s.startswith("|"):
            cells = [x.strip() for x in s.strip().strip("|").split("|")]
            if mode == "ex":
                tb = cur["tables"][-1]
                if tb[0] is None:
                    tb[0] = cells
                else:
                    tb[1].append(cells)
            elif mode == "sc" and cur is not None and cur["steps"]:
                k, s0 = cur["steps"][-1]
                cur["steps"][-1] = (k, s0 + " " + " | ".join(cells))  # data table
            elif mode == "bg" and bg:
                bg[-1] = bg[-1] + " " + " | ".join(cells)
            else:
                P(f"{f.name}:{n}: table outside Examples")
            continue
        sm = STEP.match(s)
        if sm:
            if mode == "bg":
                bg.append(sm.group(2))
            elif mode == "sc" and cur is not None:
                cur["steps"].append((sm.group(1), sm.group(2)))
            elif mode == "ex":
                P(f"{f.name}:{n}: step after Examples")
            continue
        # free text (feature description, user stories) allowed only before first Rule
        if in_rule and mode in ("sc", "ex", "bg"):
            P(f"{f.name}:{n}: unexpected line: {s[:60]}")
    close()

if len(set(ids)) != len(ids):
    P(f"duplicate IDs: {len(ids) - len(set(ids))}")
for n in sorted(needs):
    if n not in cited:
        P(f"need {n} not cited")

bt_files = files + [specs / "glossary.md"] + sorted(disc.glob("*.md"))
for f in bt_files:
    for m in re.finditer(r"`([a-z][a-z_]*)`", f.read_text()):
        w = m.group(1)
        if "_" not in w and w not in extra:
            continue
        if w not in params and w not in extra:
            P(f"{f.name}: backticked {w} undefined")

conf_path = specs / "conformance.md"
conf = conf_path.read_text()
head, rest = conf.split("## Matrix", 1)
matrix, tail = rest.split("\n## ", 1)
rows = re.findall(r"^\| ([PX]\d-S\d+) \| (.*?) \| (.*) \|$", matrix, re.M)
if "--regen" in sys.argv:
    byid = {r[0]: r[2] for r in rows}
    out = []
    added, retitled = [], []
    oldtitle = {r[0]: r[1] for r in rows}
    for i, name in order:
        if i in byid:
            if oldtitle[i] != name:
                retitled.append(i)
            out.append(f"| {i} | {name} | {byid[i]} |")
        else:
            added.append(i)
            out.append(f"| {i} | {name} | TBD | — | not assessed |")
    removed = [r[0] for r in rows if r[0] not in dict(order)]
    pre = matrix.split("|---|---|---|---|---|")[0] + "|---|---|---|---|---|\n"
    conf_path.write_text(head + "## Matrix" + pre + "\n".join(out) + "\n\n## " + tail)
    print("regen: added", added, "retitled", retitled, "removed", removed)
    conf = conf_path.read_text()
    matrix = conf.split("## Matrix", 1)[1].split("\n## ", 1)[0]
    rows = re.findall(r"^\| ([PX]\d-S\d+) \| (.*?) \| (.*) \|$", matrix, re.M)
if len(rows) != len(order):
    P(f"conformance: {len(rows)} rows vs {len(order)} scenarios")
for k, (i, name) in enumerate(order):
    if k >= len(rows) or rows[k][0] != i:
        P(f"conformance: row {k} is {rows[k][0] if k < len(rows) else None}, expected {i}")
        break
    if rows[k][1] != name:
        P(f"conformance: {i} title differs")

per = {}
for i in ids:
    per[i[:2]] = per.get(i[:2], 0) + 1
print({"scenarios": len(ids), "per": per, "needs": len(needs), "pols": len(pols), "params": len(params)})
allow_file = pathlib.Path(__file__).with_suffix(".allow")
allow = set(l.strip() for l in allow_file.read_text().splitlines() if l.strip() and not l.startswith("#")) if allow_file.exists() else set()
problems = [p for p in problems if p not in allow]
print("\n".join(problems) if problems else "NO PROBLEMS")
sys.exit(1 if problems else 0)
