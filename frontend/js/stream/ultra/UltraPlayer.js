/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * UltraPlayer — the page's half of the POC Ultra stream (U4.4): a PyroWave
 * frame in (the bytes of all its packets, as the audio road delivers them),
 * a VideoFrame out, so that the rest of the page (pacing, Canvas2D presenter,
 * frame log, latency probe) treats it like a frame from WebCodecs.
 *
 * Decode and conversion to RGB run on WebGPU (PyroWaveDecoder.js) into an
 * OffscreenCanvas; the VideoFrame is made from that canvas, which stays on the
 * GPU. One frame in flight at a time: a frame that arrives while the GPU is
 * still busy with the previous one replaces any other waiting frame (the
 * freshest wins), never queues behind it.
 */

import { PyroWaveDecoder } from './PyroWaveDecoder.js';

// Per-frame times kept for the breakdown (globalThis.__mwUltraPlayer): the
// last minute or so at 60 fps, enough for a bench pass.
const KEEP = 4096;
// One frame in this many carries GPU timestamps (their read-back costs a map).
const GPU_EVERY = 8;

function quantiles(xs) {
    if (!xs.length) return null;
    const s = Float64Array.from(xs).sort();
    const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 1000) / 1000;
    return { n: s.length, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}

/** True when this browser can run the decoder (WebGPU with a GPU adapter). */
export function ultraPlayerSupported() {
    return (
        typeof navigator !== 'undefined' && !!navigator.gpu && typeof OffscreenCanvas === 'function'
    );
}

export class UltraPlayer {
    /**
     * @param {number} width picture width (even)
     * @param {number} height picture height (even)
     * @param {(frame: VideoFrame, meta: {timestamp: number, backendTs: number, decodeMs: number}) => void} onFrame
     *        receives each VideoFrame (to close) with its chunk timestamp and host stamp
     * @param {{limited?: boolean, log?: function(string): void}} [options]
     */
    constructor(width, height, onFrame, { limited = true, log = console.log } = {}) {
        this.width = width;
        this.height = height;
        this.onFrame = onFrame;
        this.limited = limited;
        this.log = log;
        this.device = null;
        this.decoder = null;
        this._busy = false;
        this._waiting = null;
        this.stats = { frames: 0, replaced: 0, incomplete: 0, errors: 0 };
        // Where a frame's time goes, ms: waiting for the GPU to finish the
        // previous one, parsing its packets, recording and submitting the
        // work, submit to work done, the VideoFrame made from the canvas, and
        // the GPU's own time for the decode and the present passes.
        this.times = {
            wait: [],
            parse: [],
            record: [],
            done: [],
            frame: [],
            gpuDecode: [],
            gpuPresent: [],
        };
        this._gpuReading = false;
        // Bench switch (localStorage mw_ultra_early=1): hand the frame over at submit.
        try {
            this.early = globalThis.localStorage?.getItem('mw_ultra_early') === '1';
        } catch {
            this.early = false;
        }
        globalThis.__mwUltraPlayer = this;
    }

    _note(key, ms) {
        const a = this.times[key];
        if (a.length >= KEEP) a.shift();
        a.push(ms);
    }

    /** The breakdown, for the bench (pass.py) and the console. */
    summary() {
        const out = {
            stats: { ...this.stats },
            gpuTimestamps: !!this._querySet,
            early: this.early,
        };
        for (const [k, xs] of Object.entries(this.times)) out[k] = quantiles(xs);
        return out;
    }

    /** Opens the GPU and builds the decoder. False when WebGPU is missing. */
    async init() {
        if (!ultraPlayerSupported()) return false;
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return false;
        const timestamps = adapter.features.has('timestamp-query');
        this.device = await adapter.requestDevice({
            requiredFeatures: timestamps ? ['timestamp-query'] : [],
            requiredLimits: {
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                maxBufferSize: adapter.limits.maxBufferSize,
            },
        });
        this.device.lost.then((info) => this.log('[MW-ULTRA] GPU device lost: ' + info.message));
        this.decoder = new PyroWaveDecoder(this.device, this.width, this.height);
        this.canvas = new OffscreenCanvas(this.width, this.height);
        this.context = this.canvas.getContext('webgpu');
        this.context.configure({ device: this.device, format: 'rgba8unorm', alphaMode: 'opaque' });
        if (timestamps) {
            this._querySet = this.device.createQuerySet({ type: 'timestamp', count: 4 });
            this._queryBuf = this.device.createBuffer({
                size: 32,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            });
            this._queryRead = this.device.createBuffer({
                size: 32,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
        }
        this.log('[MW-ULTRA] PyroWave decoder ready, ' + this.width + 'x' + this.height);
        return true;
    }

    /**
     * One frame from the host. @param {Uint8Array} bytes its packets, back to
     * back @param {number} timestamp the chunk timestamp the page tracks it by
     * @param {number} backendTs the host's capture stamp
     */
    push(bytes, timestamp, backendTs) {
        if (!this.decoder) return;
        if (this._busy) {
            if (this._waiting) this.stats.replaced++;
            this._waiting = { bytes, timestamp, backendTs, at: performance.now() };
            return;
        }
        this._note('wait', 0);
        this._run(bytes, timestamp, backendTs);
    }

    _run(bytes, timestamp, backendTs) {
        const dec = this.decoder;
        const tp = performance.now();
        const parsed = dec.pushPacket(bytes);
        this._note('parse', performance.now() - tp);
        if (!parsed) {
            this.stats.errors++;
            return this._next();
        }
        // The whole frame came at once, so a frame short of blocks is one the
        // host sent so (packets lost before the road): decoded as it is.
        if (!dec.isReady(true)) {
            this.stats.incomplete++;
            return this._next();
        }
        this._busy = true;
        const t0 = performance.now();
        const enc = this.device.createCommandEncoder();
        // Now and then, GPU timestamps around both passes (when the adapter has them).
        const q =
            this._querySet && !this._gpuReading && this.stats.frames % GPU_EVERY === 0
                ? this._querySet
                : null;
        const tw = (a, b) =>
            q ? { querySet: q, beginningOfPassWriteIndex: a, endOfPassWriteIndex: b } : undefined;
        // Dequantization and the inverse transform only: the present pass
        // reads the f32 planes, the 8-bit packing is the lab's.
        dec.decode(enc, tw(0, 1), ['dequant', 'idwt']);
        dec.present(enc, this.context, this.limited, tw(2, 3));
        if (q) {
            enc.resolveQuerySet(q, 0, 4, this._queryBuf, 0);
            enc.copyBufferToBuffer(this._queryBuf, 0, this._queryRead, 0, 32);
        }
        this.device.queue.submit([enc.finish()]);
        const t1 = performance.now();
        this._note('record', t1 - t0);
        if (q) this._readGpuTimes();
        const emit = (from) => {
            let frame = null;
            try {
                frame = new VideoFrame(this.canvas, { timestamp });
            } catch (e) {
                this.stats.errors++;
                this.log('[MW-ULTRA] VideoFrame from the canvas failed: ' + e.message);
            }
            const t3 = performance.now();
            this._note('frame', t3 - from);
            if (frame) this.onFrame(frame, { timestamp, backendTs, decodeMs: t3 - t0 });
        };
        // Early: the frame goes to the page as soon as the work is submitted;
        // Chrome's own fences hold its draw until the GPU is done, without
        // the callback's round trip. The next decode still waits for this one.
        if (this.early) emit(t1);
        this.device.queue.onSubmittedWorkDone().then(
            () => {
                this._busy = false;
                this.stats.frames++;
                const t2 = performance.now();
                this._note('done', t2 - t1);
                if (!this.early) emit(t2);
                this._next();
            },
            () => {
                this._busy = false;
                this.stats.errors++;
            },
        );
    }

    _readGpuTimes() {
        this._gpuReading = true;
        const buf = this._queryRead;
        buf.mapAsync(GPUMapMode.READ).then(
            () => {
                const t = new BigUint64Array(buf.getMappedRange());
                // Nanoseconds; a pair out of order (a quantized or reset clock) is skipped.
                if (t[1] > t[0]) this._note('gpuDecode', Number(t[1] - t[0]) / 1e6);
                if (t[3] > t[2]) this._note('gpuPresent', Number(t[3] - t[2]) / 1e6);
                buf.unmap();
                this._gpuReading = false;
            },
            () => {
                this._gpuReading = false;
            },
        );
    }

    _next() {
        const w = this._waiting;
        if (!w) return;
        this._waiting = null;
        this._note('wait', performance.now() - w.at);
        this._run(w.bytes, w.timestamp, w.backendTs);
    }

    destroy() {
        this.decoder?.destroy();
        this.device?.destroy();
        this.decoder = null;
        this.device = null;
    }
}
