// WebAudio 播放引擎：一条 voice 只解码一次，句间没有 new Audio 的解码空隙，
// 并且支持暂停/继续。没有 AudioContext 或解码失败时由调用方回退到 <audio>。

const BUFFER_LIMIT = 10;
const BLOB_LIMIT = 24;

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
        this.sequence = 0;
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

    begin(buffer, key, offset, resolve) {
        const ctx = this.context();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        if (!this.gain) {
            this.gain = ctx.createGain();
            this.gain.connect(ctx.destination);
        }
        this.gain.gain.value = this.volume;
        source.connect(this.gain);
        this.node = source;
        this.current = {
            key,
            buffer,
            offset,
            startedAt: ctx.currentTime,
            resolve,
            done: false,
        };
        this.paused = false;
        source.onended = () => {
            if (this.node !== source) return; // 主动 pause/stop 时不算播完
            this.finish();
        };
        const duration = Number(buffer.duration) || 0;
        source.start(0, Math.max(0, Math.min(offset, Math.max(0, duration - 0.01))));
    }

    finish() {
        const current = this.current;
        this.current = null;
        this.node = null;
        this.paused = false;
        if (current && !current.done) {
            current.done = true;
            current.resolve();
        }
    }

    async play(url, key) {
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
                this.begin(buffer, key, 0, resolve);
            } catch {
                resolve();
            }
        });
        return true;
    }

    pause() {
        if (!this.node || !this.current || this.paused) return false;
        const ctx = this.context();
        const played = this.current.offset + Math.max(0, ctx.currentTime - this.current.startedAt);
        this.current.offset = Math.min(played, this.current.buffer.duration || played);
        this.node.onended = null;
        try { this.node.stop(); } catch { /* 已停止 */ }
        this.node = null;
        this.paused = true;
        return true;
    }

    resume() {
        if (!this.paused || !this.current) return false;
        const { buffer, key, offset, resolve } = this.current;
        const seq = this.sequence;
        try {
            this.begin(buffer, key, offset, resolve);
        } catch {
            return false;
        }
        if (seq !== this.sequence) return true;
        return true;
    }

    stop() {
        this.sequence += 1;
        const current = this.current;
        const node = this.node;
        this.node = null;
        this.current = null;
        this.paused = false;
        if (node) {
            node.onended = null;
            try { node.stop(); } catch { /* 已经结束 */ }
        }
        if (current && !current.done) {
            current.done = true;
            current.resolve();
        }
    }
}
