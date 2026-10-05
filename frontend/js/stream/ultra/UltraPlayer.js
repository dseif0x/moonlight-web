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
    }

    /** Opens the GPU and builds the decoder. False when WebGPU is missing. */
    async init() {
        if (!ultraPlayerSupported()) return false;
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return false;
        this.device = await adapter.requestDevice({
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
            this._waiting = { bytes, timestamp, backendTs };
            return;
        }
        this._run(bytes, timestamp, backendTs);
    }

    _run(bytes, timestamp, backendTs) {
        const dec = this.decoder;
        if (!dec.pushPacket(bytes)) {
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
        dec.decode(enc);
        dec.present(enc, this.context, this.limited);
        this.device.queue.submit([enc.finish()]);
        this.device.queue.onSubmittedWorkDone().then(
            () => {
                this._busy = false;
                this.stats.frames++;
                let frame = null;
                try {
                    frame = new VideoFrame(this.canvas, { timestamp });
                } catch (e) {
                    this.stats.errors++;
                    this.log('[MW-ULTRA] VideoFrame from the canvas failed: ' + e.message);
                }
                if (frame)
                    this.onFrame(frame, { timestamp, backendTs, decodeMs: performance.now() - t0 });
                this._next();
            },
            () => {
                this._busy = false;
                this.stats.errors++;
            },
        );
    }

    _next() {
        const w = this._waiting;
        if (!w) return;
        this._waiting = null;
        this._run(w.bytes, w.timestamp, w.backendTs);
    }

    destroy() {
        this.decoder?.destroy();
        this.device?.destroy();
        this.decoder = null;
        this.device = null;
    }
}
