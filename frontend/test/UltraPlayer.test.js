/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The GPU half is stubbed: what is tested is the player's flow.
vi.mock('../js/stream/ultra/PyroWaveDecoder.js', () => ({
    PyroWaveDecoder: class {
        constructor() {
            this.pushed = [];
            this.decoded = 0;
        }
        pushPacket(bytes) {
            this.pushed.push(bytes[0]);
            return bytes[0] !== 0xee;
        }
        isReady() {
            return true;
        }
        decode() {
            this.decoded++;
        }
        present() {}
        destroy() {}
    },
}));

const { UltraPlayer } = await import('../js/stream/ultra/UltraPlayer.js');

function player() {
    const frames = [];
    const p = new UltraPlayer(64, 64, (frame, meta) => frames.push(meta.timestamp), {
        log: () => {},
    });
    let release = null;
    p.device = {
        createCommandEncoder: () => ({ finish: () => ({}) }),
        queue: {
            submit() {},
            onSubmittedWorkDone: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        },
    };
    return { p, frames, done: () => release() };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('UltraPlayer', () => {
    it('keeps one frame in flight and lets the freshest waiting one win', async () => {
        vi.stubGlobal(
            'VideoFrame',
            class {
                constructor(src, { timestamp }) {
                    this.timestamp = timestamp;
                }
            },
        );
        const { PyroWaveDecoder } = await import('../js/stream/ultra/PyroWaveDecoder.js');
        const { p, frames, done } = player();
        p.decoder = new PyroWaveDecoder();
        p.canvas = {};
        p.context = {};
        p.push(new Uint8Array([1]), 1, 10);
        p.push(new Uint8Array([2]), 2, 11); // waits
        p.push(new Uint8Array([3]), 3, 12); // replaces frame 2
        expect(p.decoder.pushed).toEqual([1]);
        done();
        await Promise.resolve();
        await Promise.resolve();
        expect(frames).toEqual([1]);
        expect(p.decoder.pushed).toEqual([1, 3]);
        expect(p.stats.replaced).toBe(1);
        done();
        await Promise.resolve();
        await Promise.resolve();
        expect(frames).toEqual([1, 3]);
    });

    it('drops a malformed frame without stalling the next', async () => {
        vi.stubGlobal(
            'VideoFrame',
            class {
                constructor(src, { timestamp }) {
                    this.timestamp = timestamp;
                }
            },
        );
        const { PyroWaveDecoder } = await import('../js/stream/ultra/PyroWaveDecoder.js');
        const { p, frames, done } = player();
        p.decoder = new PyroWaveDecoder();
        p.canvas = {};
        p.context = {};
        p.push(new Uint8Array([0xee]), 1, 10);
        expect(p.stats.errors).toBe(1);
        p.push(new Uint8Array([4]), 2, 11);
        done();
        await Promise.resolve();
        await Promise.resolve();
        expect(frames).toEqual([2]);
    });

    it('on WebGL2, hands each frame over at once and holds the next until the fence', async () => {
        vi.useFakeTimers();
        // The fence is polled at the next task: a message, or here a timeout.
        vi.stubGlobal('MessageChannel', undefined);
        try {
            vi.stubGlobal(
                'VideoFrame',
                class {
                    constructor(src, { timestamp }) {
                        this.timestamp = timestamp;
                    }
                },
            );
            const { PyroWaveDecoder } = await import('../js/stream/ultra/PyroWaveDecoder.js');
            const frames = [];
            const p = new UltraPlayer(64, 64, (frame, meta) => frames.push(meta.timestamp), {
                log: () => {},
            });
            let signaled = false;
            p.gl = {
                TIMEOUT_EXPIRED: 1,
                WAIT_FAILED: 2,
                SYNC_GPU_COMMANDS_COMPLETE: 3,
                fenceSync: () => ({}),
                flush() {},
                clientWaitSync: () => (signaled ? 0 : 1),
                deleteSync() {},
            };
            p.decoder = new PyroWaveDecoder();
            p.canvas = {};
            p.push(new Uint8Array([1]), 1, 10);
            expect(frames).toEqual([1]); // at once, not at the fence
            p.push(new Uint8Array([2]), 2, 11); // waits
            p.push(new Uint8Array([3]), 3, 12); // replaces frame 2
            vi.advanceTimersByTime(5);
            expect(p.decoder.pushed).toEqual([1]);
            signaled = true;
            vi.advanceTimersByTime(1);
            expect(p.decoder.pushed).toEqual([1, 3]);
            expect(frames).toEqual([1, 3]);
            expect(p.stats.replaced).toBe(1);
            expect(p.stats.frames).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
