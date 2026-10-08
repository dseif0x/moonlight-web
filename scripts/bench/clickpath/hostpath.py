"""The click's way through the host, click by click (plan « attente », A0).

The click → flag measured 13 to 15 ms at 120 Hz between the host receiving the
click and the present of the picture that shows the flag. This splits it, all
on the host's steady clock, from a pass run with:

  - MW_NATIVE_TUNING (or native_tuning) clicktrace=1: the host writes
    click-trace-<pid>-<ms>.csv (each press handed to the OS, each wake-up of the
    capture with the OS's and DWM's stamps), copied as <tag>.click-trace.csv,
    and the relay logs each stamped input (received, handled);
  - MW_LATENCY_FLAG_TRACE=1 in the server's environment: the flag's log line
    has the hook's moment, and a second line when DWM composed it;
  - or, instead of the flag, mw-click-target's log (--target): the click as the
    application got it, its present, and when the OS says it reached the screen.

Files of the pass, in bench-out/content-age: <tag>.server.log, <tag>.click-trace.csv,
and when the client's are there (<tag>.json, <tag>.clicks.frames.csv) they name
the frame that showed the flag; without them it is the first frame presented
after the flag was composed.

The legs, in ms:
  queue      received by the relay → SendInput called (a SYSTEM worker's hop)
  sendinput  the SendInput call
  hook       SendInput returned → the flag's hook ran   (app: → WM_LBUTTONDOWN)
  raise      hook → flag shown (its window painted)     (app: → Present returned)
  composed   shown → DWM composed it (DwmFlush returned) (app: → on the screen)
  present    shown → the present of the frame that showed it (LastPresentTime)
  handoff    that present → the capture handed the frame over
  host       received → handed over: the host's whole share
and: `vblank` where in DWM's refresh the flag went up (0: at a vblank, 1: just
before the next), `wait` shown → the next vblank, `between` frames presented
after the flag went up that did not carry it.

Usage: hostpath.py <tag> [<tag>...] [--dir bench-out/content-age] [--target file] [--clicks]
"""
import argparse
import bisect
import csv
import json
import os
import re
import statistics

FLAG = re.compile(r"\[LatencyFlag\] injected click.*?(?:hooked at steady (\d+) us, )?"
                  r"shown at steady (\d+) us")
FLAG_TRACE = re.compile(r"\[LatencyFlag\] trace: flushed at steady (\d+) us(?:.*?DWM vblank "
                        r"(\d+) us, period (\d+) us, composed (\d+) us)?")
RELAY = re.compile(r"click trace: input stamp (\d+) received at steady (\d+) us, handled at "
                   r"(\d+) us")
LEGS = ["queue", "sendinput", "hook", "raise", "composed", "present", "handoff", "host",
        "vblank", "wait", "between"]


def num(v):
    try:
        return float(v) if v not in ("", None) else None
    except ValueError:
        return None


def q(xs, p):
    xs = sorted(x for x in xs if x is not None)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else None


def fmt(v):
    return "   -  " if v is None else "%6.2f" % v


def read_flags(log_path):
    """Each flag: {hook, shown, flushed, vblank, period, composed} in µs."""
    flags = []
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = FLAG.search(line)
            if m:
                flags.append({"hook": num(m.group(1)), "shown": float(m.group(2))})
                continue
            m = FLAG_TRACE.search(line)
            if m and flags and "flushed" not in flags[-1]:
                flags[-1].update(flushed=float(m.group(1)), vblank=num(m.group(2)),
                                 period=num(m.group(3)), composed=num(m.group(4)))
    return flags


def read_target(path):
    """mw-click-target's clicks, as flags: the app's own moments."""
    flags = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                j = json.loads(line)
            except ValueError:
                continue
            if "click" in j:
                flags.append({"hook": j["downUs"], "shown": j["presentUs"],
                              "flushed": j.get("displayedUs")})
    return flags


def read_relay(log_path):
    out = []
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = RELAY.search(line)
            if m:
                out.append((float(m.group(2)), float(m.group(3))))
    return sorted(out)


def client_flag_frames(base):
    """Per click the client measured, the host stamp (ms) of the frame that
    showed the flag, and the click's host time estimated (µs)."""
    if not (os.path.exists(base + ".json") and os.path.exists(base + ".clicks.frames.csv")):
        return []
    j = json.load(open(base + ".json"))
    c = j.get("clicks") or {}
    org = c.get("timeOrigin")
    fr = []
    for r in csv.DictReader(open(base + ".clicks.frames.csv")):
        r = {k: num(v) for k, v in r.items()}
        if r.get("drawnMs") is not None and r.get("hostMs") is not None:
            fr.append(r)
    if not fr or org is None:
        return []
    fr.sort(key=lambda r: r["drawnMs"])
    drawn = [r["drawnMs"] for r in fr]
    off = statistics.median(r["hostMs"] - r["captureMs"] for r in fr)
    out = []
    for s in c.get("samples") or []:
        if not s.get("ok"):
            continue
        ck = s["ts"] / 1000 - org
        i = bisect.bisect_right(drawn, ck + s["latencyMs"]) - 1
        if i < 0:
            continue
        out.append({"frameMs": fr[i]["hostMs"], "clickUs": (ck + off) * 1000})
    return out


def one(tag, a):
    base = os.path.join(a.dir, tag)
    trace = list(csv.DictReader(open(base + ".click-trace.csv")))
    presses = sorted((num(r["startUs"]), num(r["us"])) for r in trace if r["kind"] == "press")
    caps = [{k: num(v) for k, v in r.items() if k not in ("kind", "status")}
            for r in trace if r["kind"] == "capture" and r["status"] == "ok"]
    caps.sort(key=lambda r: r["presentUs"])
    present = [r["presentUs"] for r in caps]
    log = base + ".server.log"
    flags = read_target(a.target) if a.target else read_flags(log)
    relay = read_relay(log) if os.path.exists(log) else []
    seen = sorted(client_flag_frames(base), key=lambda s: s["frameMs"])
    seen_frames = [s["frameMs"] for s in seen]

    rows = []
    for fl in flags:
        s_us = fl["shown"]
        hook = fl.get("hook") or None
        # The press that raised it: the last one handed over before the hook
        # (before the flag, when the hook was not logged), within 50 ms.
        ref = hook or s_us
        i = bisect.bisect_right([p[1] for p in presses], ref) - 1
        press = presses[i] if i >= 0 and ref - presses[i][1] < 50000 else None
        rel = None
        if press:
            for recv, done in relay:
                if recv <= press[0] <= done + 1:
                    rel = (recv, done)
        # The frame that showed it: the client's, when the pass has it (its
        # stamp is the present less under a millisecond), else the first
        # presented after the flag was composed (or shown).
        frame = None
        k = bisect.bisect_left(seen_frames, s_us / 1000 - 1)
        if k < len(seen) and seen_frames[k] * 1000 - s_us < 200000:
            lo = seen_frames[k] * 1000
            j = bisect.bisect_left(present, lo)
            if j < len(caps) and caps[j]["presentUs"] < lo + 1000:
                frame = caps[j]
        if frame is None and not seen:
            after = fl.get("flushed") or s_us
            j = bisect.bisect_left(present, after)
            if j < len(caps):
                frame = caps[j]
        row = {k: None for k in LEGS}
        if press:
            row["sendinput"] = (press[1] - press[0]) / 1000
            if hook:
                row["hook"] = (hook - press[1]) / 1000
        if rel and press:
            row["queue"] = (press[0] - rel[0]) / 1000
        if hook:
            row["raise"] = (s_us - hook) / 1000
        if fl.get("flushed"):
            row["composed"] = (fl["flushed"] - s_us) / 1000
        if frame:
            row["present"] = (frame["presentUs"] - s_us) / 1000
            row["handoff"] = (frame["us"] - frame["presentUs"]) / 1000
            if rel:
                row["host"] = (frame["us"] - rel[0]) / 1000
            j0 = bisect.bisect_right(present, s_us)
            j1 = bisect.bisect_left(present, frame["presentUs"])
            row["between"] = max(0, j1 - j0)
        # Where in DWM's refresh the flag went up: from the trace line, else
        # from the capture row nearest before it.
        vb, per = fl.get("vblank"), fl.get("period")
        if not (vb and per):
            j = bisect.bisect_right(present, s_us) - 1
            if j >= 0 and caps[j].get("vblankUs") and caps[j].get("periodUs"):
                vb, per = caps[j]["vblankUs"], caps[j]["periodUs"]
        if vb and per:
            phase = ((s_us - vb) % per) / per
            row["vblank"] = phase
            row["wait"] = (1 - phase) * per / 1000
        rows.append(row)

    print("%s: %d flags, %d presses, %d frames, %d client clicks" % (
        tag, len(flags), len(presses), len(caps), len(seen)))
    if a.clicks:
        print("  " + " ".join("%9s" % k for k in LEGS))
        for r in rows:
            print("  " + " ".join("%9s" % fmt(r[k]).strip() for k in LEGS))
    for label, p in (("p50", .5), ("p90", .9)):
        print("  %-4s " % label + " ".join("%s=%s" % (k, fmt(q([r[k] for r in rows], p)).strip())
                                          for k in LEGS))
    print("  mean " + " ".join(
        "%s=%s" % (k, fmt(statistics.mean(v)).strip() if v else "-")
        for k, v in ((k, [r[k] for r in rows if r[k] is not None]) for k in LEGS)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tags", nargs="+")
    ap.add_argument("--dir", default=os.path.join("bench-out", "content-age"))
    ap.add_argument("--target", help="mw-click-target's log, for its clicks instead of the flag's")
    ap.add_argument("--clicks", action="store_true", help="every click, not only the summary")
    a = ap.parse_args()
    for t in a.tags:
        one(t, a)


if __name__ == "__main__":
    main()
