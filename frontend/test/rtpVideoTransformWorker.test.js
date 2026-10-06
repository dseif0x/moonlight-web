/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { afterEach, describe, expect, it } from 'vitest';

// The audio road's repair (plan « Wi-Fi », W4): a frame lost whole shows only
// as a hole in the seqs and is asked for whole; asks left unanswered go again.

function chunk(seq, idx, count, len = 100) {
    const b = new ArrayBuffer(12 + len);
    const dv = new DataView(b);
    dv.setUint8(0, 0x4d);
    dv.setUint16(2, seq);
    dv.setUint16(4, idx);
    dv.setUint16(6, count);
    dv.setUint32(8, seq);
    return { data: b, timestamp: seq, getMetadata: () => ({}) };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function road(options) {
    const posts = [];
    const queue = [];
    let wake = null;
    const reader = {
        read: () =>
            queue.length
                ? Promise.resolve({ value: queue.shift(), done: false })
                : new Promise((r) => {
                      wake = r;
                  }),
    };
    globalThis.self = { postMessage: (m) => posts.push(m) };
    await import('../js/api/rtpVideoTransformWorker.js?' + Math.random());
    globalThis.self.onrtctransform({
        transformer: {
            options: { mid: 'vaudio', ...options },
            readable: { getReader: () => reader },
        },
    });
    const give = (f) => {
        if (wake) {
            const w = wake;
            wake = null;
            w({ value: f, done: false });
        } else queue.push(f);
    };
    return { posts, give, nacks: () => posts.filter((p) => p.nack).map((p) => p.nack) };
}

describe('rtpVideoTransformWorker — the audio road repair', () => {
    const saved = globalThis.self;
    afterEach(() => {
        globalThis.self = saved;
    });

    it('asks for frames lost whole, asks again, and stops once answered', async () => {
        const r = await road({});
        r.give(chunk(0, 0, 1));
        await tick(1);
        r.give(chunk(3, 0, 1)); // seqs 1 and 2: no chunk came
        await tick(1);
        r.give(chunk(4, 0, 2)); // frame 4's chunk 1 lost
        await tick(1);
        r.give(chunk(5, 0, 1)); // a newer frame: frame 4's chunk 1 asked for
        await tick(45);
        const nacks = r.nacks();
        expect(nacks.filter((n) => n.all && !n.reask).map((n) => n.s)).toEqual([1, 2]);
        expect(nacks.some((n) => n.s === 4 && !n.reask && n.i[0] === 1)).toBe(true);
        // Coarse timers (Windows: 15.6 ms) fit one or two asks again.
        for (const s of [1, 2, 4]) {
            const again = nacks.filter((n) => n.reask && n.s === s).length;
            expect(again).toBeGreaterThanOrEqual(1);
            expect(again).toBeLessThanOrEqual(2);
        }
        r.posts.length = 0;
        r.give(chunk(1, 0, 1));
        r.give(chunk(2, 0, 1));
        r.give(chunk(4, 1, 2));
        await tick(30);
        expect(r.nacks()).toEqual([]);
    });

    it('asks nothing whole nor twice with mw_aroad_reask=0 (reask: false)', async () => {
        const r = await road({ reask: false });
        r.give(chunk(0, 0, 1));
        await tick(1);
        r.give(chunk(3, 0, 1));
        await tick(1);
        r.give(chunk(4, 0, 2));
        await tick(1);
        r.give(chunk(5, 0, 1));
        await tick(45);
        const nacks = r.nacks();
        expect(nacks.some((n) => n.all || n.reask)).toBe(false);
        expect(nacks).toEqual([{ t: 'v', s: 4, i: [1] }]);
    });
});
