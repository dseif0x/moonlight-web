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
// - The inverse wavelet is two plain passes (rows, then columns) per level and
//   component, with no shared-memory tile: correctness first, speed after.
//
// Output: the decoded planes in f32 (Y at the aligned size, Cb and Cr at half
// of it, before the DC shift), then `pack` turns them into 8-bit 4:2:0 bytes
// cropped to the picture, which is what the reference decoder writes.

const LEVELS = 5;
const NONE = 0xffffffff;
const ALIGN = 1 << LEVELS;
const MIN_SIZE = 4 << LEVELS;
const SEQ_MASK = 7;

const alignUp = (v, a) => (v + a - 1) & ~(a - 1);

const DEQUANT_WGSL = /* wgsl */ `
struct BlockMeta { plane: u32, width: u32, height: u32, xy: u32 }

@group(0) @binding(0) var<storage, read> payload: array<u32>;
@group(0) @binding(1) var<storage, read> offsets: array<u32>;
@group(0) @binding(2) var<storage, read> metas: array<BlockMeta>;
@group(0) @binding(3) var<storage, read_write> coef: array<f32>;

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
    let blockIndex = wg.x;
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

// One inverse CDF 9/7 lifting over a window of 10 samples of the interleaved
// signal (low band at even, high band at odd positions), giving the two
// samples in its middle. Constants and order are upstream's (dwt_common.h).
const LIFT_WGSL = /* wgsl */ `
const ALPHA: f32 = -1.586134342059924;
const BETA: f32 = -0.052980118572961;
const GAMMA: f32 = 0.882911075530934;
const DELTA: f32 = 0.443506852043971;
const K: f32 = 1.230174104914001;
const INV_K: f32 = 1.0 / 1.230174104914001;

// JPEG 2000 whole-sample symmetric extension of a signal of n samples.
fn mirror(i: i32, n: i32) -> i32 {
    var j = i;
    if (j < 0) { j = -j; }
    if (j > n - 1) { j = 2 * (n - 1) - j; }
    return j;
}

fn lift(w: ptr<function, array<f32, 10>>) -> vec2f {
    for (var j = 2; j <= 8; j += 2) { (*w)[j] -= DELTA * ((*w)[j - 1] + (*w)[j + 1]); }
    for (var j = 3; j <= 7; j += 2) { (*w)[j] -= GAMMA * ((*w)[j - 1] + (*w)[j + 1]); }
    for (var j = 4; j <= 6; j += 2) { (*w)[j] -= BETA * ((*w)[j - 1] + (*w)[j + 1]); }
    (*w)[5] -= ALPHA * ((*w)[4] + (*w)[6]);
    return vec2f((*w)[4], (*w)[5]);
}
`;

// Rows: the four bands of a level (w x h each) become 2h rows of 2w samples.
// Row 2y comes from LL and HL (vertical low-pass), row 2y+1 from LH and HH.
const IDWT_ROWS_WGSL = /* wgsl */ `
struct Pass { ll: u32, hl: u32, lh: u32, hh: u32, w: u32, h: u32, out: u32, final_: u32 }
@group(0) @binding(0) var<uniform> p: Pass;
@group(0) @binding(1) var<storage, read_write> coef: array<f32>;
@group(0) @binding(2) var<storage, read_write> tmp: array<f32>;
${LIFT_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;  // output pair along x
    let r = id.y;  // tmp row
    if (i >= p.w || r >= 2u * p.h) { return; }
    let y = r >> 1u;
    let lowBand = select(p.lh, p.ll, (r & 1u) == 0u);
    let highBand = select(p.hh, p.hl, (r & 1u) == 0u);
    let n = i32(2u * p.w);
    var w: array<f32, 10>;
    for (var j = 0; j < 10; j++) {
        let s = mirror(i32(2u * i) - 4 + j, n);
        if ((s & 1) == 0) {
            w[j] = coef[lowBand + y * p.w + u32(s >> 1)] * K;
        } else {
            w[j] = coef[highBand + y * p.w + u32(s >> 1)] * INV_K;
        }
    }
    let o = lift(&w);
    tmp[r * 2u * p.w + 2u * i] = o.x;
    tmp[r * 2u * p.w + 2u * i + 1u] = o.y;
}
`;

// Columns: the 2h tmp rows (even = low, odd = high) become 2h output rows.
const IDWT_COLS_WGSL = /* wgsl */ `
struct Pass { ll: u32, hl: u32, lh: u32, hh: u32, w: u32, h: u32, out: u32, final_: u32 }
@group(0) @binding(0) var<uniform> p: Pass;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read_write> tmp: array<f32>;
${LIFT_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let x = id.x;  // column
    let i = id.y;  // output pair along y
    let width = 2u * p.w;
    if (x >= width || i >= p.h) { return; }
    let n = i32(2u * p.h);
    var w: array<f32, 10>;
    for (var j = 0; j < 10; j++) {
        let s = mirror(i32(2u * i) - 4 + j, n);
        let k = select(INV_K, K, (s & 1) == 0);
        w[j] = tmp[u32(s) * width + x] * k;
    }
    let o = lift(&w);
    dst[p.out + (2u * i) * width + x] = o.x;
    dst[p.out + (2u * i + 1u) * width + x] = o.y;
}
`;

// f32 planes (before the DC shift) to 8-bit 4:2:0, cropped: 4 pixels a thread.
const PACK_WGSL = /* wgsl */ `
struct Pack { yOff: u32, cbOff: u32, crOff: u32, alignedW: u32, width: u32, height: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> p: Pack;
@group(0) @binding(1) var<storage, read_write> planes: array<f32>;
@group(0) @binding(2) var<storage, read_write> outBytes: array<u32>;
fn q(v: f32) -> u32 { return u32(round(clamp(v + 0.5, 0.0, 1.0) * 255.0)); }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let ySize = p.width * p.height;
    let cw = p.width / 2u;
    let cSize = cw * (p.height / 2u);
    let word = id.x + id.y * 65535u * 64u;
    let first = word * 4u;
    if (first >= ySize + 2u * cSize) { return; }
    var pw = 0u;
    for (var k = 0u; k < 4u; k++) {
        let b = first + k;
        var v = 0.0;
        if (b < ySize) {
            v = planes[p.yOff + (b / p.width) * p.alignedW + b % p.width];
        } else {
            let c = b - ySize;
            let plane = select(p.crOff, p.cbOff, c < cSize);
            let cc = c % cSize;
            v = planes[plane + (cc / cw) * (p.alignedW / 2u) + cc % cw];
        }
        pw = pw | (q(v) << (8u * k));
    }
    outBytes[word] = pw;
}
`;

export class PyroWaveDecoder {
    /**
     * @param {GPUDevice} device
     * @param {number} width picture width (even)
     * @param {number} height picture height (even)
     */
    constructor(device, width, height) {
        this.device = device;
        this.width = width;
        this.height = height;
        this.alignedW = Math.max(alignUp(width, ALIGN), MIN_SIZE);
        this.alignedH = Math.max(alignUp(height, ALIGN), MIN_SIZE);
        this._layout();
        this._resources();
        this.clear();
    }

    // Planes, block metadata and the block index order of bitstream.md.
    _layout() {
        const W = this.alignedW;
        const H = this.alignedH;
        this.planeOf = {}; // "level,comp,band" -> float offset
        let floats = 0;
        for (let level = 0; level < LEVELS; level++) {
            for (let comp = 0; comp < 3; comp++) {
                if (level === 0 && comp !== 0) continue;
                for (let band = 0; band < 4; band++) {
                    this.planeOf[`${level},${comp},${band}`] = floats;
                    floats += (W >> (level + 1)) * (H >> (level + 1));
                }
            }
        }
        this.outY = floats;
        floats += W * H;
        this.outCb = floats;
        floats += (W / 2) * (H / 2);
        this.outCr = floats;
        floats += (W / 2) * (H / 2);
        this.coefFloats = floats;

        const metas = [];
        for (let level = LEVELS - 1; level >= 0; level--) {
            for (let comp = 0; comp < 3; comp++) {
                if (level === 0 && comp !== 0) continue;
                for (let band = level === LEVELS - 1 ? 0 : 1; band < 4; band++) {
                    const w = W >> (level + 1);
                    const h = H >> (level + 1);
                    const plane = this.planeOf[`${level},${comp},${band}`];
                    for (let by = 0; by < Math.ceil(h / 32); by++) {
                        for (let bx = 0; bx < Math.ceil(w / 32); bx++) {
                            metas.push(plane, w, h, bx | (by << 16));
                        }
                    }
                }
            }
        }
        this.blockCount = metas.length / 4;
        this.metas = new Uint32Array(metas);
    }

    _resources() {
        const d = this.device;
        const S = GPUBufferUsage.STORAGE;
        const C = GPUBufferUsage.COPY_DST;
        this.offsetsCpu = new Uint32Array(this.blockCount);
        this.payloadCpu = new Uint32Array(1 << 20);
        this.payloadBuf = d.createBuffer({ size: this.payloadCpu.byteLength + 16, usage: S | C });
        this.offsetsBuf = d.createBuffer({ size: this.offsetsCpu.byteLength, usage: S | C });
        this.metaBuf = d.createBuffer({ size: this.metas.byteLength, usage: S | C });
        d.queue.writeBuffer(this.metaBuf, 0, this.metas);
        this.coefBuf = d.createBuffer({
            size: this.coefFloats * 4,
            usage: S | GPUBufferUsage.COPY_SRC,
        });
        this.tmpBuf = d.createBuffer({ size: this.alignedW * this.alignedH * 4, usage: S });
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
        this.rowsPipe = d.createComputePipeline({
            layout: 'auto',
            compute: { module: mod(IDWT_ROWS_WGSL), entryPoint: 'main' },
        });
        this.colsPipe = d.createComputePipeline({
            layout: 'auto',
            compute: { module: mod(IDWT_COLS_WGSL), entryPoint: 'main' },
        });
        this.packPipe = d.createComputePipeline({
            layout: 'auto',
            compute: { module: mod(PACK_WGSL), entryPoint: 'main' },
        });
        this._bindDequant();

        // One uniform slot per pass, all fixed at creation: decoding a frame
        // only uploads the payload and the block offsets.
        this.passes = [];
        for (let level = LEVELS - 1; level >= 0; level--) {
            for (let comp = 0; comp < 3; comp++) {
                if (level === 0 && comp !== 0) continue;
                const w = this.alignedW >> (level + 1);
                const h = this.alignedH >> (level + 1);
                let out;
                if (level === 0) out = this.outY;
                else if (level === 1 && comp !== 0) out = comp === 1 ? this.outCb : this.outCr;
                else out = this.planeOf[`${level - 1},${comp},0`];
                const band = (b) => this.planeOf[`${level},${comp},${b}`];
                this.passes.push({ w, h, u: [band(0), band(1), band(2), band(3), w, h, out, 0] });
            }
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
        const ubo = (k) => ({ buffer: this.uniformBuf, offset: slot * k, size: 32 });
        for (const [k, pass] of this.passes.entries()) {
            pass.rows = d.createBindGroup({
                layout: this.rowsPipe.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: ubo(k) },
                    { binding: 1, resource: { buffer: this.coefBuf } },
                    { binding: 2, resource: { buffer: this.tmpBuf } },
                ],
            });
            pass.cols = d.createBindGroup({
                layout: this.colsPipe.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: ubo(k) },
                    { binding: 1, resource: { buffer: this.coefBuf } },
                    { binding: 2, resource: { buffer: this.tmpBuf } },
                ],
            });
        }
        this.packBind = d.createBindGroup({
            layout: this.packPipe.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: ubo(packSlot) },
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
            ],
        });
    }

    clear() {
        this.offsetsCpu.fill(NONE);
        this.payloadWords = 0;
        this.decodedBlocks = 0;
        this.totalBlocks = this.blockCount;
        this.lastSeq = -1;
        this.decodedThisSeq = false;
    }

    /** Feeds one network packet (one or more 32x32 blocks). False on a malformed packet. */
    pushPacket(bytes) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let pos = 0;
        while (bytes.byteLength - pos >= 8) {
            const w0 = dv.getUint32(pos, true);
            const w1 = dv.getUint32(pos + 4, true);
            const seq = (w0 >>> 28) & 7;
            if (w0 >>> 31) {
                // Start of frame: dimensions and the number of coded blocks.
                if (!this._sequence(seq)) return true;
                if (((w1 >>> 24) & 3) !== 0) return false;
                if ((w0 & 0x3fff) + 1 !== this.width || ((w0 >>> 14) & 0x3fff) + 1 !== this.height)
                    return false;
                if (((w1 >>> 26) & 1) !== 0) return false; // 4:4:4 not handled here
                this.totalBlocks = w1 & 0xffffff;
                pos += 8;
                continue;
            }
            const words = (w0 >>> 16) & 0xfff;
            if (words < 2 || words * 4 > bytes.byteLength - pos) return false;
            if (!this._sequence(seq)) return true;
            const block = w1 >>> 8;
            if (block >= this.blockCount) return false;
            if (this.offsetsCpu[block] === NONE) {
                this._ensurePayload(this.payloadWords + words);
                this.offsetsCpu[block] = this.payloadWords;
                // The block's words, copied as they are (little-endian on every WebGPU platform).
                const src = new Uint8Array(bytes.buffer, bytes.byteOffset + pos, words * 4);
                new Uint8Array(this.payloadCpu.buffer, this.payloadWords * 4, words * 4).set(src);
                this.payloadWords += words;
                this.decodedBlocks++;
            }
            pos += words * 4;
        }
        return pos === bytes.byteLength;
    }

    // False when the packet belongs to an older frame than the one in progress.
    _sequence(seq) {
        if (this.lastSeq < 0) {
            this.clear();
            this.lastSeq = seq;
            return true;
        }
        const diff = (seq - this.lastSeq) & SEQ_MASK;
        if (diff > SEQ_MASK / 2) return false;
        if (diff !== 0) {
            this.clear();
            this.lastSeq = seq;
        }
        return true;
    }

    _ensurePayload(words) {
        if (words <= this.payloadCpu.length) return;
        let n = this.payloadCpu.length;
        while (n < words) n *= 2;
        const grown = new Uint32Array(n);
        grown.set(this.payloadCpu.subarray(0, this.payloadWords));
        this.payloadCpu = grown;
        this.payloadBuf.destroy();
        this.payloadBuf = this.device.createBuffer({
            size: n * 4 + 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._bindDequant();
    }

    /** Every block of the frame in progress arrived (or, partial, more than half). */
    isReady(allowPartial = false) {
        if (this.decodedThisSeq || this.lastSeq < 0) return false;
        if (this.decodedBlocks < this.totalBlocks) {
            return allowPartial && this.decodedBlocks > this.totalBlocks / 2;
        }
        return true;
    }

    /**
     * Records the decode of the frame in progress into `encoder`, ending with
     * the 8-bit planes in `packedBuf`. `timestampWrites` (optional) brackets the pass.
     */
    decode(encoder, timestampWrites) {
        const d = this.device;
        d.queue.writeBuffer(this.payloadBuf, 0, this.payloadCpu, 0, alignUp(this.payloadWords, 1));
        d.queue.writeBuffer(this.offsetsBuf, 0, this.offsetsCpu);
        const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : undefined);
        pass.setPipeline(this.dequantPipe);
        pass.setBindGroup(0, this.dequantBind);
        pass.dispatchWorkgroups(this.blockCount);
        for (const p of this.passes) {
            pass.setPipeline(this.rowsPipe);
            pass.setBindGroup(0, p.rows);
            pass.dispatchWorkgroups(Math.ceil(p.w / 64), 2 * p.h);
            pass.setPipeline(this.colsPipe);
            pass.setBindGroup(0, p.cols);
            pass.dispatchWorkgroups(Math.ceil((2 * p.w) / 64), p.h);
        }
        const words = Math.ceil((this.width * this.height * 3) / 2 / 4);
        pass.setPipeline(this.packPipe);
        pass.setBindGroup(0, this.packBind);
        pass.dispatchWorkgroups(
            Math.min(Math.ceil(words / 64), 65535),
            Math.ceil(words / 64 / 65535),
        );
        pass.end();
        this.decodedThisSeq = true;
    }

    destroy() {
        for (const b of [
            this.payloadBuf,
            this.offsetsBuf,
            this.metaBuf,
            this.coefBuf,
            this.tmpBuf,
            this.packedBuf,
            this.uniformBuf,
        ]) {
            b.destroy();
        }
    }
}
