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
        // A piece: every byte is a whole "block", but a last 0xcc is one cut short.
        pushPiece(bytes) {
            this.pieces = (this.pieces || []).concat([...bytes]);
            return bytes[bytes.length - 1] === 0xcc ? bytes.length - 1 : bytes.length;
        }
        clear() {
            this.cleared = (this.cleared || 0) + 1;
        }
        startSlices() {
            this.slices = [];
        }
        decodeSlice(enc, last = false) {
            this.slices.push(last ? 'last' : 'some');
            return true;
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

    it('by slices: pieces go to the GPU as they come, the frame finishes the decode', async () => {
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
        let submits = 0;
        p.device.queue.submit = () => submits++;
        p.decoder = new PyroWaveDecoder();
        p.canvas = {};
        p.context = {};
        p.pushPart(7, 0, new Uint8Array([1, 2, 0xcc]));
        p.pushPart(7, 3, new Uint8Array([3, 4]));
        expect(submits).toBe(2);
        // The cut tail comes again in front of the next piece.
        expect(p.decoder.pieces).toEqual([1, 2, 0xcc, 0xcc, 3, 4]);
        p.push(new Uint8Array([1, 2, 0xcc, 3, 4, 5]), 1, 10, 7);
        expect(p.decoder.pieces.slice(-1)).toEqual([5]); // only the rest
        expect(p.decoder.slices).toEqual(['some', 'some', 'last']);
        expect(p.decoder.pushed).toEqual([]); // never parsed whole
        done();
        await Promise.resolve();
        await Promise.resolve();
        expect(frames).toEqual([1]);
        expect(p.stats.sliced).toBe(1);
    });

    it('by slices: a piece missing, and the frame decodes whole', async () => {
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
        p.pushPart(8, 0, new Uint8Array([1, 2]));
        p.pushPart(8, 5, new Uint8Array([6])); // 2..4 never came as a piece
        p.push(new Uint8Array([9, 2, 3, 4, 5, 6, 7]), 1, 10, 8);
        expect(p.decoder.pushed).toEqual([9]);
        done();
        await Promise.resolve();
        await Promise.resolve();
        expect(frames).toEqual([1]);
        expect(p.stats.sliced).toBe(0);
    });
});
