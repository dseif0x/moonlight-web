// PyroWave decoder on WebGPU compute, without subgroups (POC Ultra, U3.4).
//
// A port of the decoder of PyroWave by Hans-Kristian Arntzen
// (https://github.com/Themaister/pyrowave, commit 509e4f88): the packet parser
// of pyrowave_decoder.cpp and the shaders wavelet_dequant.comp and idwt.comp,
// rewritten in JS and WGSL. Upstream notice, which covers the ported parts:
//
//   Copyright (c) 2025 Hans-Kristian Arntzen
//   SPDX-License-Identifier: MIT
//
// The bitstream is upstream's (bitstream/bitstream.md). What differs from the
// upstream GPU code, on purpose:
// - No subgroup operation: the scans run on workgroup memory, so the decoder
//   works where WebGPU has no `subgroups` (Safari, most mobiles).
// - Coefficients live in one f32 storage buffer instead of FP16/FP32 images,
//   and the inverse wavelet reads them by index. Upstream's mirrored sampler
//   with its coordinate offsets is the JPEG 2000 whole-sample symmetric
//   extension of the interleaved signal; `mirror()` below does it directly.
// - The inverse wavelet works on 32x32 tiles in workgroup memory, like
//   upstream's, but in one dispatch per level for all components.
//
// Output: the decoded planes in f32 (Y at the aligned size, Cb and Cr at half
// of it, before the DC shift), then `pack` turns them into 8-bit 4:2:0 bytes
// cropped to the picture, which is what the reference decoder writes.
//
// The packet parser and the frame layout are in PyroWaveFrame.js, shared with
// the WebGL2 fallback.

import { LEVELS, NONE, PyroWaveFrame, alignUp } from './PyroWaveFrame.js';

const DEQUANT_WGSL = /* wgsl */ `
struct BlockMeta { plane: u32, width: u32, height: u32, xy: u32 }

@group(0) @binding(0) var<storage, read> payload: array<u32>;
@group(0) @binding(1) var<storage, read> offsets: array<u32>;
@group(0) @binding(2) var<storage, read> metas: array<BlockMeta>;
@group(0) @binding(3) var<storage, read_write> coef: array<f32>;
// x: the first block of the dispatch (a slice starts past the blocks before it).
@group(0) @binding(4) var<uniform> range: vec4u;

var<workgroup> sharedOffset: u32;
var<workgroup> planeOffsets: array<u32, 16>;
var<workgroup> costs: array<u32, 16>;
var<workgroup> signStart: u32;
var<workgroup> scanA: array<u32, 128>;
var<workgroup> scanB: array<u32, 128>;

fn u8at(i: u32) -> u32 { return (payload[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu; }
fn u16at(i: u32) -> u32 { return (payload[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu; }

// The planes of a 2-bit-per-subblock control word below a bit position.
fn planesBelow(code: u32, bits: u32) -> u32 {
    let mask = select((1u << bits) - 1u, 0xffffffffu, bits >= 32u);
    let lsbs = code & 0x5555u;
    var msbs = code & 0xaaaau;
    msbs = msbs | (msbs >> 1u);
    return countOneBits(lsbs & mask) + countOneBits(msbs & mask);
}

fn decodeQuant(q: u32) -> f32 {
    let e = 4 - i32(q >> 3u);
    let m = i32(q & 7u);
    return f32(8 + m) * exp2(f32(e - 3));
}

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
    let blockIndex = wg.x + range.x;
    let bm = metas[blockIndex];
    if (li == 0u) { sharedOffset = offsets[blockIndex]; }
    let off = workgroupUniformLoad(&sharedOffset);

    let sub = li & 7u;
    let bx = (li >> 3u) & 3u;
    let by = (li >> 5u) & 3u;
    let lb = by * 4u + bx;
    let x0 = (bm.xy & 0xffffu) * 32u + 8u * bx + 4u * (sub >> 2u);
    let y0 = (bm.xy >> 16u) * 32u + 8u * by + 2u * (sub & 3u);

    var v: array<f32, 8>;
    for (var k = 0u; k < 8u; k++) { v[k] = 0.0; }

    if (off != ${NONE}u) {
        let ballot = payload[off] & 0xffffu;
        let qCode = payload[off + 1u] & 0xffu;
        let pc = countOneBits(ballot);
        let codeBase = off * 2u + 4u;          // u16 index of CodeWords[]
        let qsBase = off * 4u + 8u + pc * 2u;  // byte index of QScale[]
        let dataBase = off * 4u + 8u + pc * 3u;

        if (li < 16u) {
            var cost = 0u;
            if (((ballot >> li) & 1u) != 0u) {
                let idx = countOneBits(ballot & ((1u << li) - 1u));
                let cw = u16at(codeBase + idx);
                let qb = u8at(qsBase + idx) & 0xfu;
                cost = planesBelow(cw, 32u) + qb * 8u;
            }
            costs[li] = cost;
        }
        workgroupBarrier();
        if (li == 0u) {
            var acc = dataBase;
            for (var k = 0u; k < 16u; k++) {
                planeOffsets[k] = acc;
                acc += costs[k];
            }
            signStart = acc * 8u;
        }
        workgroupBarrier();

        var count = 0u;
        if (((ballot >> lb) & 1u) != 0u) {
            let idx = countOneBits(ballot & ((1u << lb) - 1u));
            let cw = u16at(codeBase + idx);
            let qs = u8at(qsBase + idx);
            let qBits = qs & 0xfu;
            let lcode = (cw >> (2u * sub)) & 3u;
            if (cw != 0u) {
                var byteOffset = planesBelow(cw, 2u * sub) + qBits * sub + planeOffsets[lb];
                var mag: array<u32, 8>;
                for (var k = 0u; k < 8u; k++) { mag[k] = 0u; }
                let planes = qBits + lcode;
                for (var q = i32(planes) - 1; q >= 0; q--) {
                    let bv = u8at(byteOffset);
                    for (var b = 0u; b < 8u; b++) {
                        mag[b] = mag[b] | (((bv >> b) & 1u) << u32(q));
                    }
                    byteOffset++;
                }
                let scale = decodeQuant(qCode) * (f32((qs >> 4u) & 0xfu) / 8.0 + 0.25);
                for (var k = 0u; k < 8u; k++) {
                    if (mag[k] != 0u) {
                        v[k] = (f32(mag[k]) + 0.5) * scale;
                        count++;
                    }
                }
            }
        }

        // Sign bits follow all magnitudes, in thread order (8x8 block, then
        // subblock, then pixel): an exclusive scan of the non-zero counts.
        scanA[li] = count;
        workgroupBarrier();
        for (var s = 1u; s < 128u; s = s * 2u) {
            var t = scanA[li];
            if (li >= s) { t += scanA[li - s]; }
            workgroupBarrier();
            scanB[li] = t;
            workgroupBarrier();
            scanA[li] = scanB[li];
            workgroupBarrier();
        }
        let signOffset = signStart + scanA[li] - count;
        let w = signOffset >> 5u;
        let sh = signOffset & 31u;
        var signs = payload[w] >> sh;
        if (sh != 0u) { signs = signs | (payload[w + 1u] << (32u - sh)); }
        var n = 0u;
        for (var k = 0u; k < 8u; k++) {
            if (v[k] != 0.0) {
                if (((signs >> n) & 1u) != 0u) { v[k] = -v[k]; }
                n++;
            }
        }
    }

    // Pixel order inside a 4x2 subblock: column-major, two rows.
    for (var k = 0u; k < 8u; k++) {
        let x = x0 + (k >> 1u);
        let y = y0 + (k & 1u);
        if (x < bm.width && y < bm.height) {
            coef[bm.plane + y * bm.width + x] = v[k];
        }
    }
}
`;

// The inverse wavelet of one level, by 32x32 output tiles, the components
// of the level along z.
// A workgroup loads the four bands under its tile plus 4 samples of apron on
// each side into workgroup memory as the interleaved 2D signal (LL at even x
// and y, HL odd x, LH odd y, HH both odd), already scaled by K / 1/K in each
// direction. It then runs the four CDF 9/7 lifting steps along the rows, then
// along the columns, and writes the tile. Constants and step order are
// upstream's (dwt_common.h, idwt.comp). Scaling and mirroring before the row
// pass is the same as upstream's after it: both are per-row and linear.
const IDWT_WGSL = /* wgsl */ `
struct Pass { w: u32, h: u32, comps: u32, pad: u32, bands: array<vec4u, 3>, outs: vec4u }
@group(0) @binding(0) var<uniform> p: Pass;
@group(0) @binding(1) var<storage, read_write> coef: array<f32>;

const ALPHA: f32 = -1.586134342059924;
const BETA: f32 = -0.052980118572961;
const GAMMA: f32 = 0.882911075530934;
const DELTA: f32 = 0.443506852043971;
const K: f32 = 1.230174104914001;
const INV_K: f32 = 1.0 / 1.230174104914001;
const SPAN: u32 = 40u;  // 32 + 2 x 4 of apron
const T: u32 = 16u;  // the workgroup is T x T threads

var<workgroup> S: array<f32, 1600>;

// JPEG 2000 whole-sample symmetric extension of a signal of n samples.
fn mirror(i: i32, n: i32) -> i32 {
    var j = i;
    if (j < 0) { j = -j; }
    if (j > n - 1) { j = 2 * (n - 1) - j; }
    return j;
}

// One lifting step on positions first, first+2 .. last of every row (all 40)
// or of the 32 tile columns. Threads walk 2D, with no integer division: the
// AMD iGPU (2 CUs) pays dearly for a division by a value known at run time.
fn liftRows(t: vec2u, first: u32, last: u32, c: f32) {
    for (var r = t.y; r < SPAN; r += T) {
        for (var j = first + 2u * t.x; j <= last; j += 2u * T) {
            let i = r * SPAN + j;
            S[i] -= c * (S[i - 1u] + S[i + 1u]);
        }
    }
    workgroupBarrier();
}

fn liftCols(t: vec2u, first: u32, last: u32, c: f32) {
    for (var col = 4u + t.x; col < 36u; col += T) {
        for (var j = first + 2u * t.y; j <= last; j += 2u * T) {
            let i = j * SPAN + col;
            S[i] -= c * (S[i - SPAN] + S[i + SPAN]);
        }
    }
    workgroupBarrier();
}

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
    let t = lid.xy;
    let w2 = 2u * p.w;
    let h2 = 2u * p.h;
    let bands = p.bands[wg.z];  // LL, HL, LH, HH of this component
    let dst = p.outs[wg.z];
    let ox = i32(wg.x * 32u) - 4;
    let oy = i32(wg.y * 32u) - 4;
    for (var y = t.y; y < SPAN; y += T) {
        let sy = mirror(oy + i32(y), i32(h2));
        let yOdd = (sy & 1) == 1;
        let row = u32(sy >> 1) * p.w;
        for (var x = t.x; x < SPAN; x += T) {
            let sx = mirror(ox + i32(x), i32(w2));
            let xOdd = (sx & 1) == 1;
            // select(), not bands[i]: a vector indexed at run time can turn
            // into a scratch array in the HLSL that Chrome makes of this.
            let band = select(select(bands.x, bands.y, xOdd), select(bands.z, bands.w, xOdd), yOdd);
            let scale = select(K, INV_K, xOdd) * select(K, INV_K, yOdd);
            S[y * SPAN + x] = coef[band + row + u32(sx >> 1)] * scale;
        }
    }
    workgroupBarrier();

    // Each step only where its inputs are right: the tile's 32 samples need
    // 4 of apron after four steps.
    liftRows(t, 2u, 38u, DELTA);
    liftRows(t, 3u, 37u, GAMMA);
    liftRows(t, 4u, 36u, BETA);
    liftRows(t, 5u, 35u, ALPHA);
    liftCols(t, 2u, 38u, DELTA);
    liftCols(t, 3u, 37u, GAMMA);
    liftCols(t, 4u, 36u, BETA);
    liftCols(t, 5u, 35u, ALPHA);

    for (var y = t.y; y < 32u; y += T) {
        let gy = wg.y * 32u + y;
        for (var x = t.x; x < 32u; x += T) {
            let gx = wg.x * 32u + x;
            if (gx < w2 && gy < h2) {
                coef[dst + gy * w2 + gx] = S[(y + 4u) * SPAN + x + 4u];
            }
        }
    }
}
`;

// f32 planes (before the DC shift) to 8-bit 4:2:0, cropped: one thread per
// 4 bytes of a row, rows of Y, then Cb, then Cr (the width must be a
// multiple of 8, so a chroma row is whole words).
const PACK_WGSL = /* wgsl */ `
struct Pack { yOff: u32, cbOff: u32, crOff: u32, alignedW: u32, width: u32, height: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> p: Pack;
@group(0) @binding(1) var<storage, read_write> planes: array<f32>;
@group(0) @binding(2) var<storage, read_write> outBytes: array<u32>;
fn q(v: f32) -> u32 { return u32(round(clamp(v + 0.5, 0.0, 1.0) * 255.0)); }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let r = id.y;
    let ch = p.height / 2u;
    var src: u32;
    var dst: u32;
    var words: u32;
    if (r < p.height) {
        words = p.width / 4u;
        src = p.yOff + r * p.alignedW;
        dst = r * words;
    } else if (r < p.height + ch) {
        words = p.width / 8u;
        src = p.cbOff + (r - p.height) * (p.alignedW / 2u);
        dst = p.width * p.height / 4u + (r - p.height) * words;
    } else if (r < p.height + 2u * ch) {
        words = p.width / 8u;
        src = p.crOff + (r - p.height - ch) * (p.alignedW / 2u);
        dst = p.width * p.height / 4u + ch * words + (r - p.height - ch) * words;
    } else {
        return;
    }
    let x = id.x;
    if (x >= words) { return; }
    let s = src + 4u * x;
    outBytes[dst + x] = q(planes[s]) | (q(planes[s + 1u]) << 8u) | (q(planes[s + 2u]) << 16u) |
        (q(planes[s + 3u]) << 24u);
}
`;

// The decoded planes (f32, before the DC shift) drawn as RGB: a full-screen
// triangle whose fragment reads Y at its pixel and Cb, Cr at half resolution
// (nearest), BT.709, limited or full range.
const PRESENT_WGSL = /* wgsl */ `
struct Present { yOff: u32, cbOff: u32, crOff: u32, alignedW: u32, width: u32, height: u32, limited: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: Present;
@group(0) @binding(1) var<storage, read> planes: array<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let x = min(u32(pos.x), p.width - 1u);
    let y = min(u32(pos.y), p.height - 1u);
    let c = (y >> 1u) * (p.alignedW >> 1u) + (x >> 1u);
    var yv = clamp(planes[p.yOff + y * p.alignedW + x] + 0.5, 0.0, 1.0);
    var cb = clamp(planes[p.cbOff + c] + 0.5, 0.0, 1.0) - 0.5;
    var cr = clamp(planes[p.crOff + c] + 0.5, 0.0, 1.0) - 0.5;
    if (p.limited != 0u) {
        yv = (yv * 255.0 - 16.0) / 219.0;
        cb = cb * 255.0 / 224.0;
        cr = cr * 255.0 / 224.0;
    }
    let r = yv + 1.5748 * cr;
    let g = yv - 0.1873 * cb - 0.4681 * cr;
    let b = yv + 1.8556 * cb;
    return vec4f(clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

export class PyroWaveDecoder extends PyroWaveFrame {
    /**
     * @param {GPUDevice} device
     * @param {number} width picture width (even)
     * @param {number} height picture height (even)
     */
    constructor(device, width, height) {
        super(width, height);
        this.device = device;
        this._resources();
    }

    _resources() {
        const d = this.device;
        const S = GPUBufferUsage.STORAGE;
        const C = GPUBufferUsage.COPY_DST;
        this.payloadBuf = d.createBuffer({ size: this.payloadCpu.byteLength + 16, usage: S | C });
        this.offsetsBuf = d.createBuffer({ size: this.offsetsCpu.byteLength, usage: S | C });
        this.metaBuf = d.createBuffer({ size: this.metas.byteLength, usage: S | C });
        d.queue.writeBuffer(this.metaBuf, 0, this.metas);
        this.rangeBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | C });
        this._rangeFirst = 0;
        this.coefBuf = d.createBuffer({
            size: this.coefFloats * 4,
            usage: S | GPUBufferUsage.COPY_SRC,
        });
        const packedBytes = (this.width * this.height * 3) / 2;
        this.packedBuf = d.createBuffer({
            size: alignUp(packedBytes, 4),
            usage: S | GPUBufferUsage.COPY_SRC,
        });

        const mod = (code) => d.createShaderModule({ code });
        this.dequantPipe = d.createComputePipeline({
            layout: 'auto',
            compute: { module: mod(DEQUANT_WGSL), entryPoint: 'main' },
        });
        this.idwtPipe = d.createComputePipeline({
            layout: 'auto',
            compute: { module: mod(IDWT_WGSL), entryPoint: 'main' },
        });
        this.packPipe = d.createComputePipeline({
            layout: 'auto',
            compute: { module: mod(PACK_WGSL), entryPoint: 'main' },
        });
        this._bindDequant();

        // One uniform slot per level, all fixed at creation: decoding a frame
        // only uploads the payload and the block offsets. A level's components
        // go in one dispatch (z): WebGPU puts a barrier between dispatches that
        // write the same buffer, and on the AMD iGPU thirteen of them cost
        // more than the transform itself (4 ms against 0.7 in Vulkan).
        this.passes = [];
        for (let level = LEVELS - 1; level >= 0; level--) {
            const w = this.alignedW >> (level + 1);
            const h = this.alignedH >> (level + 1);
            const comps = level === 0 ? 1 : 3;
            const bands = [];
            const outs = [];
            for (let comp = 0; comp < 3; comp++) {
                if (comp >= comps) {
                    bands.push(0, 0, 0, 0);
                    outs.push(0);
                    continue;
                }
                for (let b = 0; b < 4; b++) bands.push(this.planeOf[`${level},${comp},${b}`]);
                if (level === 0) outs.push(this.outY);
                else if (level === 1 && comp !== 0) outs.push(comp === 1 ? this.outCb : this.outCr);
                else outs.push(this.planeOf[`${level - 1},${comp},0`]);
            }
            // The level's bands are whole once the blocks before the next
            // (finer) level's are: they come in that order.
            const end = level === 0 ? this.blockCount : this.firstBlockOf[`${level - 1},0,1`];
            this.passes.push({ w, h, comps, end, u: [w, h, comps, 0, ...bands, ...outs, 0] });
        }
        const slot = 256;
        this.uniformBuf = d.createBuffer({
            size: slot * (this.passes.length + 1),
            usage: GPUBufferUsage.UNIFORM | C,
        });
        const u = new Uint32Array((slot / 4) * (this.passes.length + 1));
        this.passes.forEach((pass, k) => u.set(pass.u, (slot / 4) * k));
        const packSlot = this.passes.length;
        u.set(
            [this.outY, this.outCb, this.outCr, this.alignedW, this.width, this.height, 0, 0],
            (slot / 4) * packSlot,
        );
        d.queue.writeBuffer(this.uniformBuf, 0, u);
        const ubo = (k, size) => ({ buffer: this.uniformBuf, offset: slot * k, size });
        for (const [k, pass] of this.passes.entries()) {
            pass.bind = d.createBindGroup({
                layout: this.idwtPipe.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: ubo(k, 80) },
                    { binding: 1, resource: { buffer: this.coefBuf } },
                ],
            });
        }
        this.packBind = d.createBindGroup({
            layout: this.packPipe.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: ubo(packSlot, 32) },
                { binding: 1, resource: { buffer: this.coefBuf } },
                { binding: 2, resource: { buffer: this.packedBuf } },
            ],
        });
    }

    _bindDequant() {
        this.dequantBind = this.device.createBindGroup({
            layout: this.dequantPipe.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.payloadBuf } },
                { binding: 1, resource: { buffer: this.offsetsBuf } },
                { binding: 2, resource: { buffer: this.metaBuf } },
                { binding: 3, resource: { buffer: this.coefBuf } },
                { binding: 4, resource: { buffer: this.rangeBuf } },
            ],
        });
    }

    _payloadGrown(words) {
        this.payloadBuf.destroy();
        this.payloadBuf = this.device.createBuffer({
            size: words * 4 + 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._bindDequant();
        // A frame by slices uploads its payload again from the start.
        this._sentWords = 0;
    }

    // The first block of the next dequantization dispatch, written only when it changes.
    _setRangeFirst(first) {
        if (first === this._rangeFirst) return;
        this.device.queue.writeBuffer(this.rangeBuf, 0, new Uint32Array([first, 0, 0, 0]));
        this._rangeFirst = first;
    }

    /** Starts a frame decoded by slices (after clear()): nothing of it is on the GPU yet. */
    startSlices() {
        this._sentWords = 0;
        this._dequantDone = 0;
        this._levelsDone = 0;
    }

    /**
     * Records, for the frame coming by slices, what its blocks so far allow:
     * the dequantization of the blocks new since the last call (every block
     * below the frontier is settled, came or not), and the inverse wavelet of
     * each level now whole. `last`: the frame is all there, everything left
     * is recorded. One call per command encoder (the dispatch offset is a
     * queue write). False when there was nothing new to record.
     */
    decodeSlice(encoder, last = false, timestampWrites) {
        const d = this.device;
        const end = last ? this.blockCount : this.frontier;
        const from = this._dequantDone;
        let levels = this._levelsDone;
        while (levels < this.passes.length && this.passes[levels].end <= end) levels++;
        if (end <= from && levels === this._levelsDone && !last) return false;
        if (this.payloadWords > this._sentWords) {
            d.queue.writeBuffer(
                this.payloadBuf,
                this._sentWords * 4,
                this.payloadCpu,
                this._sentWords,
                this.payloadWords - this._sentWords,
            );
            this._sentWords = this.payloadWords;
        }
        const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : undefined);
        if (end > from) {
            d.queue.writeBuffer(this.offsetsBuf, from * 4, this.offsetsCpu, from, end - from);
            this._setRangeFirst(from);
            pass.setPipeline(this.dequantPipe);
            pass.setBindGroup(0, this.dequantBind);
            pass.dispatchWorkgroups(end - from);
            this._dequantDone = end;
        }
        if (levels > this._levelsDone) {
            pass.setPipeline(this.idwtPipe);
            for (let k = this._levelsDone; k < levels; k++) this._idwt(pass, this.passes[k]);
            this._levelsDone = levels;
        }
        pass.end();
        if (last) this.decodedThisSeq = true;
        return true;
    }

    _idwt(pass, p) {
        pass.setBindGroup(0, p.bind);
        pass.dispatchWorkgroups(Math.ceil((2 * p.w) / 32), Math.ceil((2 * p.h) / 32), p.comps);
    }

    /**
     * Records the decode of the frame in progress into `encoder`, ending with
     * the 8-bit planes in `packedBuf`. `timestampWrites` (optional) brackets the pass.
     * `stages` ('dequant', 'idwt', 'pack', a list of them, or all when absent):
     * the lab times one stage alone, the player skips the packing.
     */
    decode(encoder, timestampWrites, stages) {
        const d = this.device;
        const run = (s) => !stages || (Array.isArray(stages) ? stages.includes(s) : stages === s);
        d.queue.writeBuffer(this.payloadBuf, 0, this.payloadCpu, 0, alignUp(this.payloadWords, 1));
        d.queue.writeBuffer(this.offsetsBuf, 0, this.offsetsCpu);
        const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : undefined);
        if (run('dequant')) {
            this._setRangeFirst(0);
            pass.setPipeline(this.dequantPipe);
            pass.setBindGroup(0, this.dequantBind);
            pass.dispatchWorkgroups(this.blockCount);
        }
        if (run('idwt')) {
            pass.setPipeline(this.idwtPipe);
            for (const p of this.passes) this._idwt(pass, p);
        }
        if (run('pack')) {
            pass.setPipeline(this.packPipe);
            pass.setBindGroup(0, this.packBind);
            // Rows: H of Y, then H/2 of Cb and H/2 of Cr.
            pass.dispatchWorkgroups(Math.ceil(this.width / 4 / 64), this.height * 2);
        }
        pass.end();
        this.decodedThisSeq = true;
    }

    /**
     * Draws the last decoded frame into a WebGPU canvas context (configured
     * by the caller, any 8-bit RGBA format), recorded into `encoder` after
     * decode(). `limited`: the planes are BT.709 limited range (the host's
     * NV12), else full range. `timestampWrites` (optional) brackets the pass.
     */
    present(encoder, context, limited = true, timestampWrites) {
        const d = this.device;
        const format =
            context.getConfiguration?.()?.format || navigator.gpu.getPreferredCanvasFormat();
        if (!this._presentPipe || this._presentFormat !== format) {
            const module = d.createShaderModule({ code: PRESENT_WGSL });
            this._presentPipe = d.createRenderPipeline({
                layout: 'auto',
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            });
            this._presentFormat = format;
            this._presentUbo = d.createBuffer({
                size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this._presentBind = d.createBindGroup({
                layout: this._presentPipe.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this._presentUbo } },
                    { binding: 1, resource: { buffer: this.coefBuf } },
                ],
            });
            this._presentLimited = undefined;
        }
        if (this._presentLimited !== limited) {
            d.queue.writeBuffer(
                this._presentUbo,
                0,
                new Uint32Array([
                    this.outY,
                    this.outCb,
                    this.outCr,
                    this.alignedW,
                    this.width,
                    this.height,
                    limited ? 1 : 0,
                    0,
                ]),
            );
            this._presentLimited = limited;
        }
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: context.getCurrentTexture().createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                },
            ],
            ...(timestampWrites ? { timestampWrites } : {}),
        });
        pass.setPipeline(this._presentPipe);
        pass.setBindGroup(0, this._presentBind);
        pass.draw(3);
        pass.end();
    }

    destroy() {
        for (const b of [
            this.payloadBuf,
            this.offsetsBuf,
            this.metaBuf,
            this.coefBuf,
            this.packedBuf,
            this.uniformBuf,
            this.rangeBuf,
            this._presentUbo,
        ].filter(Boolean)) {
            b.destroy();
        }
    }
}
