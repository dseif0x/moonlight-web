#!/usr/bin/env python3
"""Sound - flag offset from mw-click-sound's streamed onsets (--tick runs).

usage: sound_offset.py <listener output> [--before MS] [--after MS]

mw-click-sound --tick prints every onset as it comes, `beep <us>` and
`flag <us>`, both on the client's QPC clock. Its own summary pairs each beep
with the nearest flag within 250 ms, which a grown jitter buffer outruns: on a
loaded Wi-Fi the sound came 300-500 ms after its flag (05/10). This pairs each
flag with the first beep from --before ms ahead of it to --after ms behind it
(default -100 / +900; clicks come about a second apart), one beep per flag,
and prints the offsets: positive = the sound after the picture.
"""
import sys


def main():
    path = sys.argv[1]
    args = sys.argv[2:]
    before = float(args[args.index("--before") + 1]) if "--before" in args else 100.0
    after = float(args[args.index("--after") + 1]) if "--after" in args else 900.0
    beeps, flags = [], []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.split()
            if len(parts) == 2 and parts[0] in ("beep", "flag") and parts[1].lstrip("-").isdigit():
                (beeps if parts[0] == "beep" else flags).append(int(parts[1]))
    beeps.sort()
    flags.sort()
    used = set()
    offsets = []
    for fl in flags:
        for i, b in enumerate(beeps):
            if i in used:
                continue
            d = (b - fl) / 1000.0
            if -before <= d <= after:
                used.add(i)
                offsets.append(d)
                break
    print("%d flags, %d beeps, %d paired (%d flags without a beep, %d beeps without a flag)" % (
        len(flags), len(beeps), len(offsets), len(flags) - len(offsets), len(beeps) - len(offsets)))
    if offsets:
        o = sorted(offsets)
        q = lambda p: o[min(len(o) - 1, int(p * (len(o) - 1) + 0.5))]
        print("sound - flag  median %.1f  p10 %.1f  p90 %.1f  min %.1f  max %.1f ms" % (
            q(0.5), q(0.1), q(0.9), o[0], o[-1]))


if __name__ == "__main__":
    main()
