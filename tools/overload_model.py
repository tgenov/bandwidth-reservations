#!/usr/bin/env python3
"""Discrete-event model of one owner-runtime slot lane under overload (RFC-006 erratum 7.1, draft 2 with local edits).

This is a design model, not code of the runtime. It applies the rules of RFC-006 §4.7 rule 5
(5a sojourn admission control, 5b per-entry batch cap, 5c abandon handling) and reports the
per-second goodput and the count of state changes for the cases of review 77,
and judges the §22.1 "Overload recovery" criteria in their final form (review 78 D-78-1 … D-78-5 and the
coordinator decisions of the final pass, 2026-10-14: a bounded backlog after the drain, a drain deadline, and
state-change limits from 20 noisy seeds under the final rules).

Database time of a batch of n entries: d = F + c·n (ms), optionally multiplied by noise.
A batch not at COMMIT within A = 2,000 ms of BEGIN is abandoned (C01 abandonBeforeCommitMs).

Caller model (§22.1): a call answered `Overloaded(retryAfterMs)` is sent again after retryAfterMs;
a call answered `Retry` is sent again at once; a caller gives up 30 s after its first send
(the POL-26 default deadline).

Usage: python3 tools/overload_model.py            (prints every case)
"""
import heapq
import math
import random

A = 2000.0          # abandonBeforeCommitMs
HARD_CAP = 2000     # slot_batch_max_entries


def run(F=50.0, c=2.0, phases=((3000, 1000), (33000, 200)), initial=0, seed=1, rules=True,
        budget=400.0, target=500.0, interval=1000.0, retry_floor=250.0, retry_max=5000.0,
        fresh_attempt=True, noise=0.0, giveup=30000.0, stall=None, slow=None, dead=None, end=None,
        reset=True):
    """Return a dict of results. phases: ((until_ms, rate_per_s), ...). initial: calls queued at t = 0.
    stall: (from_ms, to_ms, extra_ms, excluded) extra time per batch that starts in [from, to);
    excluded=True means the runtime knows the cause (a per-tier fallback) and takes no sample.
    slow: (from_ms, to_ms, factor) multiplies c for batches that start in [from, to) (a slowed database).
    dead: (from_ms, to_ms) a lease wait (§22.1 run (d)): a batch that starts in [from, to) waits until `to`
    before its database work starts.
    reset: the regime reset of 5b (coordinator decision on the last pass): a completed batch of at least
    16 entries that took more than 2 times the fit's prediction, or an abandon at the default budget,
    discards the older samples; a fit with a floor slope uses the latest batch's per-entry bound."""
    rnd = random.Random(seed)
    end = end or phases[-1][0]
    ev = []
    seqn = [0]

    def push(t, kind, data=None):
        seqn[0] += 1
        heapq.heappush(ev, (t, seqn[0], kind, data))

    cid = 0
    first = {}
    for _ in range(initial):
        push(0.0, 'arr', cid); first[cid] = 0.0; cid += 1
    t = 0.0
    for until, rate in phases:
        while t < until:
            push(t, 'arr', cid); first[cid] = t; cid += 1
            t += 1000.0 / rate

    queue = []                # (enqueue_ms, call_id), queue order
    busy = [False]
    state = ['adm']
    above_since = [None]
    changes = [0]
    trace = []
    shed_k = [0]              # calls shed in this episode
    est = {'F': None, 'c': None, 'samples': [], 'bound_run': 0, 'resets': []}
    commits = []
    bstarts = []              # start time of each batch
    abandon_at = []           # time of each abandon
    lost_at = []              # time at which each caller that gave up did so
    durs = []                 # (start, duration) of each committed batch
    waits = []                # queue wait of committed calls (first enqueue to take)
    stats = {'abandons': 0, 'batches': 0, 'fresh': 0, 'shed': 0, 'lost': 0, 'retry': 0, 'max_d': 0.0}

    def fit():
        s = est['samples'][-32:]
        if not s:
            return
        ns = [n for n, _ in s]
        ds = [d for _, d in s]
        if max(ns) >= 2 * min(ns) and len(s) >= 3:
            mn = sum(ns) / len(ns); md = sum(ds) / len(ds)
            var = sum((n - mn) ** 2 for n in ns)
            cov = sum((n - mn) * (d - md) for n, d in s)
            raw = cov / var
            ch = max(raw, 0.001)
            Fh = min(max(md - ch * mn, 0.0), min(ds))
        else:                                       # no spread: keep F, refit c on batches of 16 or more
            Fh = est['F'] if est['F'] is not None else min(ds)
            big = [(n, d) for n, d in s if n >= 16]
            if not big:
                return
            n_bar = sum(n for n, _ in big) / len(big); d_bar = sum(d for _, d in big) / len(big)
            raw = (d_bar - Fh) / n_bar
            ch = max(raw, 0.001)
        if reset:                                   # 5b: the fit never undercuts the latest batch alone
            n_l, d_l = s[-1]
            bound = (d_l - Fh) / n_l                # the latest batch's per-entry part, per entry
            if raw <= 0.001 or (n_l >= 16 and bound > 2 * ch):
                ch = max(ch, bound)
        est['F'], est['c'] = Fh, ch

    def n_cap():
        if not rules or est['c'] is None:
            return HARD_CAP
        n = max(1, int(budget / est['c']))
        n = min(HARD_CAP, n)
        if n < HARD_CAP and est['bound_run'] >= 8:   # probe: a larger batch now and then gives the fit a spread
            est['bound_run'] = 0
            n = min(HARD_CAP, max(n + 16, int(n * 1.5)))
        return n

    def drain_ms(q):
        """Expected drain of q entries (5a `D`); 500 ms with no estimate."""
        if est['c'] is None:
            return 500.0
        cap = max(1, min(HARD_CAP, int(budget / est['c'])))
        return q * est['c'] + math.ceil(q / cap) * (est['F'] or 0.0)

    def sample(now, s):
        """5a: a sojourn sample at a take (0 if the take emptied the queue)."""
        if s > target:
            if above_since[0] is None:
                above_since[0] = now
            if state[0] == 'adm' and now - above_since[0] >= interval:
                state[0] = 'ovl'; changes[0] += 1; shed_k[0] = 0; trace.append(('enter', round(now)))
        else:
            above_since[0] = None

    def expected_sojourn(now):
        """5a: with no estimate, the age of the oldest queued call (review 78 D-78-4)."""
        if est['c'] is None:
            return (now - queue[0][0]) if queue else 0.0
        return drain_ms(len(queue))

    def maybe_release(now):
        if state[0] == 'ovl' and trace[-1][1] != round(now) and expected_sojourn(now) <= target:
            state[0] = 'adm'; changes[0] += 1; above_since[0] = None; trace.append(('release', round(now)))

    def start(now, batch=None, fresh=False):
        if busy[0]:
            return
        if batch is None:
            if not queue:
                return
            cap = n_cap()
            batch = queue[:cap]; del queue[:cap]
            est['bound_run'] = est['bound_run'] + 1 if queue else 0
            if rules:
                sample(now, (now - batch[-1][0]) if queue else 0.0)
                maybe_release(now)
        n = len(batch)
        cc = c * slow[2] if slow and slow[0] <= now < slow[1] else c
        d = F + cc * n
        if dead and dead[0] <= now < dead[1]:
            d += dead[1] - now                      # the lease wait
        if noise:
            d *= rnd.uniform(1 - noise, 1 + noise)
        excluded = False
        if stall and stall[0] <= now < stall[1]:
            d += stall[2]; excluded = stall[3]
        busy[0] = True; stats['batches'] += 1
        bstarts.append(now)
        if fresh:
            stats['fresh'] += 1
        if d > A:
            push(now + A, 'abandon', (batch, fresh))
        else:
            push(now + d, 'done', (batch, d, excluded))

    while ev:
        now, _, kind, data = heapq.heappop(ev)
        if now > end:
            break
        if kind == 'arr':
            if now - first[data] > giveup:
                stats['lost'] += 1; lost_at.append(first[data] + giveup)   # the caller gave up at its deadline
                continue
            if rules and state[0] == 'ovl':
                stats['shed'] += 1; shed_k[0] += 1
                drain = min(retry_max, drain_ms(len(queue) + shed_k[0]))
                retry_after = min(retry_max, retry_floor + rnd.uniform(0, drain))   # clamped after the base (D-78-5)
                push(now + retry_after, 'arr', data)
            else:
                queue.append((now, data)); start(now)
        elif kind == 'done':
            batch, d, excluded = data
            busy[0] = False
            stats['max_d'] = max(stats['max_d'], d)
            durs.append((now - d, d))
            for (e, i) in batch:
                commits.append(now); waits.append(now - d - e)
            if rules and not excluded:
                n = len(batch)
                if (reset and n >= 16 and est['c'] is not None and est['F'] is not None
                        and d > 2 * (est['F'] + est['c'] * n)):
                    est['samples'] = []; est['resets'].append(round(now))   # regime reset
                est['samples'].append((n, d)); fit()
            if rules:
                maybe_release(now)
            start(now)
        elif kind == 'abandon':
            batch, was_fresh = data
            busy[0] = False; stats['abandons'] += 1
            abandon_at.append(now)
            if rules and reset:
                est['samples'] = []; est['resets'].append(round(now))       # regime reset
            if rules and est['F'] is not None:
                est['c'] = max(est['c'] or 0.0, (A - est['F']) / len(batch))
            elif rules:
                est['F'] = 0.0; est['c'] = A / len(batch)
            if not rules:
                stats['fresh'] += 1   # the v1 runtime without 5b: a fresh attempt of the whole batch
                if not was_fresh:
                    start(now, batch, fresh=True); continue
            elif fresh_attempt and not was_fresh:
                cap = n_cap()
                queue[:0] = batch[cap:]                 # the rest keep their place at the head
                start(now, batch[:cap], fresh=True)
                continue
            for (_, i) in batch:                       # Retry: the caller re-sends at once
                stats['retry'] += 1
                push(now, 'arr', i)
            start(now)

    secs = int(end // 1000)
    per_s = [0] * secs
    for t in commits:
        s = int(t // 1000)
        if s < secs:
            per_s[s] += 1
    per_s_b = [0] * secs
    for t in bstarts:
        s = int(t // 1000)
        if s < secs:
            per_s_b[s] += 1
    waits.sort()
    p99w = waits[int(0.99 * (len(waits) - 1))] if waits else 0.0
    offers = sorted(t for t in first.values() if t <= end)     # first sends only, not re-sends
    return dict(trace=trace, per_s=per_s, per_s_b=per_s_b, changes=changes[0], p99_wait=p99w,
                abandon_at=abandon_at, resets=est['resets'], offers=offers, commits=commits,
                lost_at=sorted(lost_at), durs=durs, end=end, **stats)


def offered(phases, s):
    for until, rate in phases:
        if s * 1000 < until:
            return rate
    return phases[-1][1]


def report(name, r, phases, from_s):
    g = r['per_s'][from_s:]
    off = [offered(phases, s) for s in range(from_s, len(r['per_s']))]
    ratio = [x / o for x, o in zip(g, off)]
    two = [(g[i] + g[i + 1]) / (off[i] + off[i + 1]) for i in range(len(g) - 1)]
    print(f"{name}: state changes at {r['trace']}")
    print(f"{name}: per-second goodput from t={from_s}s min {min(g)}/s, mean {sum(g)/len(g):.0f}/s "
          f"(min {min(ratio):.0%} of offered; per 2 s min {min(two):.0%}); state changes {r['changes']}; abandons {r['abandons']}; "
          f"fresh {r['fresh']}; shed {r['shed']}; lost {r['lost']}; batches {r['batches']}; "
          f"max batch {r['max_d']:.0f} ms; p99 queue wait {r['p99_wait']:.0f} ms")
    if r['abandon_at'] or r['resets']:
        print(f"   abandons at {[round(t) for t in r['abandon_at']]}; regime resets at {r['resets']}")
    print('   per-s:', r['per_s'])


def backlog_events(r):
    """(time, change of the backlog): +1 at each first send, -1 at each commit and at each caller that gives up."""
    ev = [(t, 0, -1) for t in r['commits']] + [(t, 0, -1) for t in r['lost_at']] + [(t, 1, 1) for t in r['offers']]
    ev.sort()
    return ev


def judge(r, phases, C, ref_s, Td, start_s=0, window=None, limit=None, quiet=False, literal=False):
    """§22.1 "Overload recovery" criteria (1) to (4) on one run (final rules, coordinator decisions of 2026-10-14).
    ref_s: the end of the burst (3 s) in (a) and (a′); the end of the slowdown window W in (b) and (d).
    Td: the drain time. start_s: the burst start. window: (from_s, to_s), W, exempt from the zero-goodput check.
    Backlog B(t) = calls first sent by t - calls committed by t - callers that gave up by t.
    Bound: lambda * max(0.5 s, 2 * D), D the p99 batch duration at lambda in steady state (in the model: of the
    batches that start from 1 s to the event in (b) and (d), in the last 10 s of the run in (a), (a') and (b')); 0.5 s * lambda in every run below except (b') and DT-50 (2).
    End of the drain t_e: the first time at or after ref_s at which B(t) <= the bound.
    (1) No second (window of 20 batch durations on a slow slot) with zero goodput after the burst starts, except in W;
        t_e <= ref_s + 1.5 * Td + 5 s.
    (2) From t_e: the deficit (calls first sent after t_e - calls committed after t_e) never exceeds the bound;
        no second with zero goodput; no abandon. Secondary: mean goodput from t_e to the end >= 95% of offered.
    (3) State changes <= limit; none after t_e.
    (4) Abandons outside W <= 1% of the batches."""
    g, nb = r['per_s'], r['per_s_b']
    secs = len(g)
    lam = offered(phases, int(ref_s))
    # the bound: lambda * max(0.5 s, 2 * D), D the p99 batch duration at lambda in steady state (RFC-006 erratum 7.1,
    # "Final pass" issue F-1: a batch longer than 0.5 s holds more than 0.5 s of arrivals, so a healthy slot in (b')
    # never has a backlog of 0.5 s * lambda or less; case 10)
    pre = sorted(d for t, d in r['durs']                              # steady state at lambda: before the event,
                 if (1000 <= t < start_s * 1000 if start_s else t >= r['end'] - 10000))   # else the last 10 s
    D = pre[int(0.99 * (len(pre) - 1))] / 1000 if pre else 0.0
    bound = 0.5 * lam if literal else lam * max(0.5, 2 * D)
    exempt = (lambda s: window[0] <= s < window[1]) if window else (lambda s: False)
    # end of the drain
    q, te = 0, None
    ev = backlog_events(r)
    i = 0
    while i < len(ev):
        t = ev[i][0]
        while i < len(ev) and ev[i][0] == t:
            q += ev[i][2]; i += 1
        if t >= ref_s * 1000 and q <= bound:
            te = t; break
    if te is None and q <= bound:
        te = ref_s * 1000.0
    deadline = ref_s + 1.5 * Td + 5
    # (2): the deficit from t_e, at every event
    maxdef, d = 0, 0
    if te is not None:
        offs = [t for t in r['offers'] if t > te]
        coms = [t for t in r['commits'] if t > te]
        merged = sorted([(t, 0, -1) for t in coms] + [(t, 1, 1) for t in offs])
        for t, _, x in merged:
            d += x
            maxdef = max(maxdef, d)
    a = int(math.ceil(te / 1000)) if te is not None else secs
    bps = sum(nb[a:]) / max(1, secs - a) if a < secs else sum(nb) / max(1, secs)
    w1 = 1 if bps >= 20 else min(10, max(2, int(math.ceil(20 / bps)))) if bps else 2

    def win(i, w):
        return sum(g[i:i + w]), sum(offered(phases, s) for s in range(i, i + w))

    zeros = [i for i in range(start_s + 1, secs - w1 + 1)
             if not any(exempt(s) for s in range(i, i + w1)) and win(i, w1)[0] == 0]
    zeros_after = [i for i in zeros if i >= a]
    mean2 = (sum(g[a:]) / sum(offered(phases, s) for s in range(a, secs))) if a < secs else 0.0
    ab_after = [t for t in r['abandon_at'] if te is None or t > te]
    ab_out = [t for t in r['abandon_at'] if not (window and window[0] * 1000 <= t < window[1] * 1000)]
    last = r['trace'][-1][1] if r['trace'] else 0
    ok1 = te is not None and te / 1000 <= deadline and not zeros
    ok2 = te is not None and maxdef <= bound and not zeros_after and not ab_after and mean2 >= 0.95
    ok3 = (limit is None or r['changes'] <= limit) and te is not None and last <= te
    ok4 = len(ab_out) <= 0.01 * r['batches']
    # reported, not judged: goodput per 2 s window while draining, against C
    d_end = int(te / 1000) if te is not None else secs
    drain = [i for i in range(start_s, d_end - 1) if not any(exempt(s) for s in range(i, i + 2))]
    two = min((win(i, 2)[0] / 2 / C for i in drain), default=None)
    if not quiet:
        print(f"   criteria (ref {ref_s:.1f} s, T_d {Td:.1f} s, lambda {lam}/s): (1) drain ends at "
              f"{te / 1000 if te is not None else '-'} s (deadline {deadline:.1f} s), zero windows ({w1} s) "
              f"{zeros or 'none'}; (2) max deficit {maxdef} (bound {bound:.0f}), mean {mean2:.1%} of offered, "
              f"abandons after {len(ab_after)}; (3) {r['changes']} state changes (limit {limit}), last at "
              f"{last / 1000} s; (4) {len(ab_out)} abandons of {r['batches']} batches outside W; reported: "
              f"min per 2 s while draining {two if two is None else f'{two:.0%}'} of C: "
              f"{'PASS' if ok1 and ok2 and ok3 and ok4 else 'FAIL'}")
    return dict(ok=ok1 and ok2 and ok3 and ok4, ok1=ok1, ok2=ok2, ok3=ok3, ok4=ok4, te=te, maxdef=maxdef,
                bound=bound, mean2=mean2, zeros=zeros, deadline=deadline, two=two)


def slow_backlog(r, phases, C, window):
    """(b), (d): the backlog E that the slowdown window leaves, its drain time T_d and C_slow seen."""
    lo, hi = window
    off = sum(offered(phases, s) for s in range(lo, hi))
    done = sum(r['per_s'][lo:hi])
    lam = offered(phases, hi)
    E = off - done
    return E, E / (C - lam), done / (hi - lo)


if __name__ == '__main__':
    test = ((3000, 1000), (33000, 200))
    print('Case 1, the runtime test (F = 50 ms, c = 2 ms/row; 1,000/s for 3 s, then 200/s)')
    for label, kw in [('  rules off (C01 v1 runtime)', dict(rules=False)),
                      ('  rules on, v1 fallback', dict()),
                      ('  rules on, CI6-5 (no fresh attempt)', dict(fresh_attempt=False)),
                      ('  rules on, v1, noise 20%', dict(noise=0.2))]:
        r = run(phases=test, **kw)
        report(label, r, test, 12)
        if kw == {}:
            report('  rules on, v1 (whole run)', r, test, 0)
    steady = ((33000, 300),)
    print('Case 2, fixed cost (F = 450 ms, c = 0.2 ms/row; 300/s)')
    for label, kw in [('  rules off', dict(rules=False)), ('  rules on', dict()),
                      ('  rules on, noise 20%', dict(noise=0.2))]:
        r = run(F=450.0, c=0.2, phases=steady, **kw)
        report(label, r, steady, 2)
    hot = ((20000, 2500),)
    print('Case 3, takeover on the hottest link (F = 30 ms, c = 0.2 ms/row; 8,750 calls at t = 0, then 2,500/s)')
    for label, kw in [('  rules off', dict(rules=False)), ('  rules on', dict())]:
        r = run(F=30.0, c=0.2, phases=hot, initial=8750, **kw)
        report(label, r, hot, 0)
    print('Case 4, a per-tier timeout (+800 ms for each batch in 10.0 to 10.5 s) on case 1 at 200/s')
    st = ((33000, 200),)
    r = run(phases=st, stall=(10000, 10500, 800.0, True))
    report('  rules on, fallback batches not sampled', r, st, 2)
    C = 444                                     # capacity of the case 1 database with 5b (calls/s)
    seeds = range(1, 21)                        # D-78-2: 20 seeds with 20% noise

    print('Case 2 with 20% noise, seeds 1 to 20 (per-second minimum; 5 s window minimum)')
    lo1, lo5 = [], []
    for k in seeds:
        g = run(F=450.0, c=0.2, phases=steady, noise=0.2, seed=k)['per_s'][2:]
        lo1.append(min(g)); lo5.append(min(sum(g[i:i + 5]) / 5 for i in range(len(g) - 4)))
    print(f"  per second min {min(lo1)}/s; per 5 s window min {min(lo5):.0f}/s (of 300/s) over the seeds")

    def noisy(label, phases, ref=None, Td=None, sw=None, **kw):
        """20 seeds with 20% noise. The state-change limit of the run is the largest count over the seeds, plus 2
        (D-78-2, coordinator decision 3 of the final pass). Each seed is then judged on criteria (1) to (4) with its
        own E and T_d. Returns the limit."""
        runs = []
        for k in seeds:
            r = run(noise=0.2, seed=k, phases=phases, **kw)
            if sw:
                _, td, _ = slow_backlog(r, phases, C, sw)
                runs.append((k, r, sw[1], td))
            else:
                runs.append((k, r, ref, Td))
        cs = sorted(x[1]['changes'] for x in runs)
        limit = cs[-1] + 2
        rows = []
        for k, r, rf, td in runs:
            v = judge(r, phases, C, rf, td, start_s=sw[0] if sw else 0, window=sw, limit=limit, quiet=True)
            rows.append((k, v, r))
        print(f"{label}: state changes with 20% noise, seeds 1 to 20: {cs} (min {cs[0]}, median "
              f"{cs[len(cs) // 2]}, max {cs[-1]}); limit {limit}")
        print(f"   drain end - reference per seed (s): {[round(v['te'] / 1000 - (sw[1] if sw else ref), 1) if v['te'] else None for _, v, _ in rows]}; "
              f"slack to the deadline min {min((v['deadline'] - v['te'] / 1000) for _, v, _ in rows if v['te']):.1f} s")
        print(f"   max deficit per seed (bound {rows[0][1]['bound']:.0f}): {[v['maxdef'] for _, v, _ in rows]}; "
              f"post-drain mean {min(v['mean2'] for _, v, _ in rows):.1%} to {max(v['mean2'] for _, v, _ in rows):.1%}; "
              f"abandons per seed {[len(r['abandon_at']) for _, _, r in rows]}")
        for c in (1, 2, 3, 4):
            bad = [k for k, v, _ in rows if not v[f'ok{c}']]
            print(f"   criterion ({c}): {20 - len(bad)} of 20 seeds pass; fail: {bad or 'none'}")
        return limit

    print('Case 5, a burst of 2 C for 3 s then 0.8 C (§22.1 run (a) with the case 1 database; C = 444/s, T_d = 15 s)')
    ph = ((3000, 888), (40000, 355))
    lim = noisy('  rules on, v1', ph, ref=3, Td=15.0, end=40000)
    r = run(phases=ph, end=40000)
    report('  rules on, v1', r, ph, 0)
    judge(r, ph, C, 3, 15.0, limit=lim)
    print('Case 6, a burst of 5 C for 3 s then 0.8 C to 93 s (§22.1 run (a′) with the case 1 database; T_d = 60 s)')
    ph = ((3000, 2220), (93000, 355))
    lim = noisy('  rules on, v1', ph, ref=3, Td=60.0, end=93000)
    for label, kw in [('  rules off', dict(rules=False)), ('  rules on, v1', dict())]:
        r = run(phases=ph, end=93000, **kw)
        report(label, r, ph, 0)
        judge(r, ph, C, 3, 60.0, limit=lim)
    print('Case 7, §22.1 run (b): 0.8 C (355/s) to 120 s, c 10 times larger per row in 10 to 20 s (c = 20 ms/row)')
    ph = ((120000, 355),)
    sw = (10, 24)                               # slowdown window: the slowdown and 2 abandon budgets after the restore
    lim = noisy('  rules on, v1', ph, sw=sw, slow=(10000, 20000, 10.0), end=120000)
    for label, kw in [('  rules off', dict(rules=False)),
                      ('  rules on, v1, without the regime reset (draft 2 at f36e34e)', dict(reset=False)),
                      ('  rules on, v1 fallback', dict()),
                      ('  rules on, CI6-5 (no fresh attempt)', dict(fresh_attempt=False))]:
        r = run(phases=ph, slow=(10000, 20000, 10.0), end=120000, **kw)
        report(label, r, ph, 0)
        E, Td, seen = slow_backlog(r, ph, C, sw)
        print(f"   slowdown window 10 to 24 s: goodput {seen:.0f}/s (C_slow about 44/s); backlog E = {E}; "
              f"T_d = E / (C - 355) = {Td:.1f} s")
        judge(r, ph, C, sw[1], Td, start_s=sw[0], window=sw, limit=lim)
    st = ((60000, 200),)
    print('Case 8, the database 30 times slower per row for 10 s (c = 60 ms/row in 10 to 20 s) at 200/s to 60 s: abandons occur')
    for label, kw in [('  rules off', dict(rules=False)), ('  rules on, v1 fallback', dict()),
                      ('  rules on, CI6-5 (no fresh attempt)', dict(fresh_attempt=False))]:
        r = run(phases=st, slow=(10000, 20000, 30.0), **kw)
        report(label, r, st, 0)
        E, Td, seen = slow_backlog(r, st, C, sw)
        print(f"   slowdown window 10 to 24 s: goodput {seen:.0f}/s (C_slow about 15/s); backlog E = {E}; "
              f"T_d = E / (C - 200) = {Td:.1f} s")
        judge(r, st, C, sw[1], Td, start_s=sw[0], window=sw)
    print('Case 9, §22.1 run (d): 0.8 C (355/s) to 120 s, the leaseholder node killed at 10 s, leases back at 19 s '
          '(a lease wait of 9 s, the upper estimate; W 10 to 23 s)')
    ph = ((120000, 355),)
    sw = (10, 23)
    lim = noisy('  rules on, v1', ph, sw=sw, dead=(10000, 19000), end=120000)
    for label, kw in [('  rules off', dict(rules=False)), ('  rules on, v1 fallback', dict()),
                      ('  rules on, CI6-5 (no fresh attempt)', dict(fresh_attempt=False))]:
        r = run(phases=ph, dead=(10000, 19000), end=120000, **kw)
        report(label, r, ph, 0)
        E, Td, seen = slow_backlog(r, ph, C, sw)
        print(f"   slowdown window 10 to 23 s: goodput {seen:.0f}/s (C_slow 0 during the wait); backlog E = {E}; "
              f"T_d = E / (C - 355) = {Td:.1f} s")
        judge(r, ph, C, sw[1], Td, start_s=sw[0], window=sw, limit=lim)
    print("Case 10, §22.1 run (b'): F = 450 ms, c = 0.2 ms; 0.8 C_F = 1,600/s for 60 s (C_F 2,000/s: the highest rate "
          "that commits in full in all 20 noisy seeds)")
    ph = ((60000, 1600),)
    rows = []
    for k in seeds:
        r = run(F=450.0, c=0.2, phases=ph, end=60000, noise=0.2, seed=k)
        v = judge(r, ph, 2000, 2, 0.0, limit=0, quiet=True)
        w = judge(r, ph, 2000, 2, 0.0, limit=0, quiet=True, literal=True)
        rows.append((k, v, w, r))
    print(f"  max deficit per seed {[v['maxdef'] for _, v, _, _ in rows]}; bound lambda * max(0.5 s, 2 D) "
          f"{min(round(v['bound']) for _, v, _, _ in rows)} to {max(round(v['bound']) for _, v, _, _ in rows)}; "
          f"state changes {sorted(set(r['changes'] for *_, r in rows))}; abandons {sum(r['abandons'] for *_, r in rows)}")
    print(f"  with that bound: {sum(v['ok'] for _, v, _, _ in rows)} of 20 seeds pass (1) to (4); with the literal "
          f"0.5 s * lambda = 800: (2) passes in {sum(w['ok2'] for _, _, w, _ in rows)} of 20 "
          f"(a batch of about 0.65 s holds more than 0.5 s of arrivals)")
    print('DT-50 (1), the runtime test: F = 50 ms, c = 2 ms; 1,000/s for 3 s, then 200/s to 33 s (C 444/s; one '
          'deterministic run)')
    ph = ((3000, 1000), (33000, 200))
    r = run(phases=ph)
    judge(r, ph, C, 3, (3000 - 3 * C) / (C - 200), limit=2)
    print('DT-50 (3) and (3a) at 200/s to 33 s (one deterministic run each)')
    for label, kw in [('  (3) lease wait 10 to 19 s, v1', dict(dead=(10000, 19000))),
                      ('  (3) lease wait 10 to 19 s, CI6-5', dict(dead=(10000, 19000), fresh_attempt=False)),
                      ('  (3a) c 30 times larger in 10 to 20 s', dict(slow=(10000, 20000, 30.0)))]:
        st = ((33000, 200),)
        w = (10, 23) if 'dead' in kw else (10, 24)
        r = run(phases=st, **kw)
        E, Td, _ = slow_backlog(r, st, C, w)
        print(f"{label}: E {E}, T_d {Td:.1f} s; abandons at {[round(t) for t in r['abandon_at']]}; "
              f"per-s {r['per_s']}")
        judge(r, st, C, w[1], Td, start_s=w[0], window=w)
