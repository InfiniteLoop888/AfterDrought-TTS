// WebAudio 播放引擎：一条 voice 只解码一次，句间没有 new Audio 的解码空隙，
// 并且支持暂停/继续。没有 AudioContext 或解码失败时由调用方回退到 <audio>。

const BUFFER_LIMIT = 10;
const BLOB_LIMIT = 24;

// ---------- 电话 / 心声：从 voice-fx.js 搬过来的两条音效链 ----------
// 房间噪声每条 AudioContext 只生成一次，2.4 秒的尾巴按左/右声道各抖一点。
const rooms = new WeakMap();

function roomBuffer(ctx, seconds = 2.4) {
    const cached = rooms.get(ctx);
    if (cached) return cached;
    const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i += 1) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
        }
    }
    rooms.set(ctx, buffer);
    return buffer;
}

function crunchCurve(amount) {
    const size = 1024;
    const curve = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
        const x = (i / (size - 1)) * 2 - 1;
        curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    return curve;
}

function makeFilter(ctx, type, frequency, Q = 0.7, dbGain = 0) {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = Q;
    node.gain.value = dbGain;
    return node;
}

function makeLevel(ctx, value) {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
}

// {input, tail, dispose()}：句子先过这条链，再进总音量节点。没有音效时返回 null。
export function effectChain(ctx, effect, out) {
    if (!ctx || !out || (effect !== 'phone' && effect !== 'inner')) return null;
    const nodes = [];
    const add = (node) => { nodes.push(node); return node; };
    const link = (...list) => {
        for (let i = 0; i < list.length - 1; i += 1) list[i].connect(list[i + 1]);
        return list[0];
    };
    let input;
    let tail = 0;
    if (effect === 'phone') {
        // 听筒：没有低频和高频，中频顶出来，再加一点粗糙。
        const shaper = add(ctx.createWaveShaper());
        shaper.curve = crunchCurve(4);
        shaper.oversample = '2x';
        input = link(
            add(makeFilter(ctx, 'highpass', 380, 0.9)),
            add(makeFilter(ctx, 'highpass', 380, 0.9)),
            add(makeFilter(ctx, 'peaking', 1700, 1.1, 6)),
            shaper,
            add(makeFilter(ctx, 'lowpass', 3300, 1)),
            add(makeFilter(ctx, 'lowpass', 3300, 1)),
            add(makeLevel(ctx, 0.8)),
            out,
        );
    } else {
        // 心声：贴近、柔和，外面裹一层不太真实的房间。
        input = add(makeLevel(ctx, 1));
        const dry = add(makeLevel(ctx, 0.72));
        const delay = add(ctx.createDelay(0.2));
        const verb = add(ctx.createConvolver());
        const wet = add(makeLevel(ctx, 0.55));
        delay.delayTime.value = 0.035;
        verb.buffer = roomBuffer(ctx);
        link(input, add(makeFilter(ctx, 'lowpass', 7000, 0.6)), dry, out);
        link(input, delay, verb, add(makeFilter(ctx, 'highpass', 250, 0.7)), add(makeFilter(ctx, 'lowpass', 4200, 0.7)), wet, out);
        tail = 2.6;
    }
    let gone = false;
    return {
        input,
        tail,
        dispose() {
            if (gone) return;
            gone = true;
            for (const node of nodes) {
                try { node.disconnect(); } catch { /* 已经断开 */ }
            }
        },
    };
}

export class VoiceEngine {
    constructor() {
        this.ctx = null;
        this.buffers = new Map();
        this.blobs = new Map();
        this.gain = null;
        this.node = null;
        this.current = null;
        this.paused = false;
        this.volume = 1;
        this.rate = 1;
        this.sequence = 0;
        this.clock = null;
        this.tailTimer = 0;
        // 播放进度回调（字幕条 / 逐句高亮用），由调用方挂。
        this.onProgress = null;
    }

    get currentKey() {
        return this.current ? this.current.key : '';
    }

    get supported() {
        return !!(globalThis.AudioContext || globalThis.webkitAudioContext);
    }

    context() {
        if (!this.ctx) {
            const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!Ctor) return null;
            this.ctx = new Ctor();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { /* 需要用户手势 */ });
        return this.ctx;
    }

    setVolume(value) {
        this.volume = Math.max(0, Math.min(1, Number(value)));
        if (Number.isNaN(this.volume)) this.volume = 1;
        if (this.gain) this.gain.gain.value = this.volume;
    }

    // 只改即将播放的句子。正在播的那句等下一句生效，避免播到一半变速。
    setRate(value) {
        this.rate = Math.max(0.5, Math.min(2, Number(value)));
        if (Number.isNaN(this.rate)) this.rate = 1;
    }

    setBlob(key, blob) {
        if (!key || !blob) return;
        this.blobs.delete(key);
        this.blobs.set(key, blob);
        while (this.blobs.size > BLOB_LIMIT) {
            this.blobs.delete(this.blobs.keys().next().value);
        }
    }

    dropBlob(key) {
        this.blobs.delete(key);
        this.buffers.delete(key);
    }

    async buffer(key, url) {
        const ctx = this.context();
        if (!ctx) return null;
        const cached = this.buffers.get(key);
        if (cached) return cached;
        let blob = this.blobs.get(key);
        if (!blob && url) {
            const response = await fetch(url);
            if (!response.ok) return null;
            blob = await response.blob();
            this.setBlob(key, blob);
        }
        if (!blob) return null;
        const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        this.buffers.delete(key);
        this.buffers.set(key, buffer);
        while (this.buffers.size > BUFFER_LIMIT) {
            this.buffers.delete(this.buffers.keys().next().value);
        }
        return buffer;
    }

    // 提前解码下一句，播到它时就不用等 decodeAudioData。
    prime(key, url) {
        if (!this.supported || !key || !url) return;
        this.buffer(key, url).catch(() => { /* 预解码失败就算了，播放时还有一次机会 */ });
    }

    // 当前时间 / 总时长，字幕条和逐句进度都从这一份算。
    snapshot() {
        if (!this.current) return null;
        const rate = this.current.rate || 1;
        const duration = Number(this.current.buffer.duration) || 0;
        const played = this.current.offset + Math.max(0, (this.ctx.currentTime - this.current.startedAt) * rate);
        return {
            key: this.current.key,
            time: Math.min(played, duration),
            duration,
            progress: duration ? Math.min(1, played / duration) : 0,
        };
    }

    emitProgress() {
        if (!this.onProgress) return;
        const snapshot = this.snapshot();
        if (!snapshot || this.paused) return;
        try {
            this.onProgress(snapshot);
        } catch { /* 回调出错不影响播放 */ }
    }

    // 200ms 一次够字幕和进度条用了，比 rAF 省电，后台标签页也不会停。
    startClock() {
        this.stopClock();
        this.emitProgress();
        this.clock = setInterval(() => this.emitProgress(), 200);
    }

    stopClock() {
        if (this.clock) clearInterval(this.clock);
        this.clock = null;
    }

    begin(buffer, key, offset, resolve, effect = '') {
        const ctx = this.context();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = this.rate;
        if (!this.gain) {
            this.gain = ctx.createGain();
            this.gain.connect(ctx.destination);
        }
        this.gain.gain.value = this.volume;
        let chain = null;
        try {
            chain = effectChain(ctx, effect, this.gain);
        } catch { chain = null; }
        if (chain) source.connect(chain.input);
        else source.connect(this.gain);
        this.node = source;
        this.current = {
            key,
            buffer,
            offset,
            rate: this.rate, // 记下起播时的语速，中途改了也不影响暂停点的换算
            effect: chain ? effect : '',
            chain,
            tail: chain ? chain.tail : 0,
            startedAt: ctx.currentTime,
            resolve,
            done: false,
        };
        this.paused = false;
        source.onended = () => {
            if (this.node !== source) return; // 主动 pause/stop 时不算播完
            // 心声的回响还在响，等尾巴散完再让下一句接上。
            if (this.current && this.current.tail) {
                clearTimeout(this.tailTimer);
                this.tailTimer = setTimeout(() => {
                    if (this.node === source) this.finish();
                }, this.current.tail * 1000);
                return;
            }
            this.finish();
        };
        const duration = Number(buffer.duration) || 0;
        source.start(0, Math.max(0, Math.min(offset, Math.max(0, duration - 0.01))));
        this.startClock();
    }

    finish() {
        clearTimeout(this.tailTimer);
        this.tailTimer = 0;
        this.stopClock();
        const current = this.current;
        this.current = null;
        this.node = null;
        this.paused = false;
        if (current && current.chain) current.chain.dispose();
        if (current && !current.done) {
            current.done = true;
            current.resolve();
        }
    }

    async play(url, key, options = {}) {
        this.stop();
        const seq = this.sequence;
        let buffer = null;
        try {
            buffer = await this.buffer(key, url);
        } catch {
            buffer = null;
        }
        if (!buffer) return false;
        // 解码期间用户已经切歌/停止，就别再放了。
        if (seq !== this.sequence) return true;
        await new Promise((resolve) => {
            try {
                this.begin(buffer, key, 0, resolve, options.effect || '');
            } catch {
                resolve();
            }
        });
        return true;
    }

    pause() {
        if (!this.node || !this.current || this.paused) return false;
        const ctx = this.context();
        // 变速播放时，实际播掉的是 elapsed * rate 秒的音频。
        const rate = this.current.rate || 1;
        const played = this.current.offset + Math.max(0, (ctx.currentTime - this.current.startedAt) * rate);
        this.current.offset = Math.min(played, this.current.buffer.duration || played);
        if (this.current.chain) {
            this.current.chain.dispose();
            this.current.chain = null;
        }
        clearTimeout(this.tailTimer);
        this.tailTimer = 0;
        this.stopClock();
        this.node.onended = null;
        try { this.node.stop(); } catch { /* 已停止 */ }
        this.node = null;
        this.paused = true;
        return true;
    }

    resume() {
        if (!this.paused || !this.current) return false;
        const { buffer, key, offset, resolve, effect } = this.current;
        const seq = this.sequence;
        try {
            this.begin(buffer, key, offset, resolve, effect);
        } catch {
            return false;
        }
        if (seq !== this.sequence) return true;
        return true;
    }

    stop() {
        this.sequence += 1;
        this.stopClock();
        clearTimeout(this.tailTimer);
        this.tailTimer = 0;
        const current = this.current;
        const node = this.node;
        this.node = null;
        this.current = null;
        this.paused = false;
        if (node) {
            node.onended = null;
            try { node.stop(); } catch { /* 已经结束 */ }
        }
        if (current && current.chain) current.chain.dispose();
        if (current && !current.done) {
            current.done = true;
            current.resolve();
        }
    }
}

// ---------- 长句兜底：网关嫌句子太长时，把拆出来的半句拼回一句 ----------
// 两段都解成 24k 单声道再拼，中间留 0.2 秒；段首段尾各 10ms 淡入淡出，接缝不会爆音。
const JOIN_RATE = 24000;
const JOIN_GAP = 0.2;

async function decodeMono(blobs, rate) {
    const Ctor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Ctor) return null;
    // 用目标采样率的离线上下文解码，decodeAudioData 会自动重采样。
    const ctx = new Ctor(1, 1, rate);
    const clips = [];
    for (const blob of blobs) {
        const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        const mono = new Float32Array(buffer.length);
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / buffer.numberOfChannels;
        }
        clips.push(mono);
    }
    return clips;
}

function encodeJoinWav(clips, rate) {
    const gap = Math.round(rate * JOIN_GAP);
    const total = clips.reduce((sum, clip) => sum + clip.length, 0) + gap * Math.max(0, clips.length - 1);
    const view = new DataView(new ArrayBuffer(44 + total * 2));
    const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + total * 2, true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, total * 2, true);
    let offset = 44;
    clips.forEach((clip, index) => {
        const fade = Math.min(Math.round(rate * 0.01), Math.floor(clip.length / 2));
        for (let i = 0; i < clip.length; i += 1) {
            let sample = clip[i];
            if (fade && i < fade) sample *= i / fade;
            if (fade && i >= clip.length - fade) sample *= (clip.length - 1 - i) / fade;
            view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
            offset += 2;
        }
        if (index < clips.length - 1) offset += gap * 2;
    });
    return new Blob([view.buffer], { type: 'audio/wav' });
}

// 拼不起来（没有 OfflineAudioContext、解码失败）就返回 null，调用方按原样报错。
export async function joinBlobs(blobs) {
    const list = (Array.isArray(blobs) ? blobs : []).filter((blob) => blob && blob.size);
    if (list.length < 2) return null;
    try {
        const clips = await decodeMono(list, JOIN_RATE);
        if (!clips || clips.length < 2) return null;
        return encodeJoinWav(clips, JOIN_RATE);
    } catch {
        return null;
    }
}
