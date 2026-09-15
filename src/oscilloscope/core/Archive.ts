// src/oscilloscope/core/Archive.ts

export interface Sample {
    time: number;   // timestamp in ms
    value: number;  // физическое (масштабированное) значение
    raw: number;    // сырое значение из регистра
}

export class ChannelRingBuffer {
    public timestamps: Float64Array;
    public values: Float64Array;      // Float64 — чтобы 32-битные IP-адреса не теряли младшие биты
    public rawValues: Float64Array;   // Float64 — по той же причине
    public capacity: number;
    public head: number = 0;
    public size: number = 0;

    constructor(capacity: number = 180000) {//Время записи при 20 мС = 1 час
        this.capacity = capacity;
        this.timestamps = new Float64Array(capacity);
        this.values = new Float64Array(capacity);
        this.rawValues = new Float64Array(capacity);
    }

    public push(time: number, value: number, raw: number): void {
        this.timestamps[this.head] = time;
        this.values[this.head] = value;
        this.rawValues[this.head] = raw;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size++;
        }
    }

    public clear(): void {
        this.head = 0;
        this.size = 0;
    }

    public getRecentSamples(durationMs: number, currentTime?: number): Sample[] {
        if (this.size === 0) return [];

        const now = currentTime !== undefined ? currentTime : this.timestamps[(this.head - 1 + this.capacity) % this.capacity];
        const minTime = now - durationMs;

        const result: Sample[] = [];
        const startIndex = (this.head - this.size + this.capacity) % this.capacity;
        let addedPrevious = false;

        for (let i = 0; i < this.size; i++) {
            const idx = (startIndex + i) % this.capacity;
            const t = this.timestamps[idx];
            if (t >= minTime) {
                if (!addedPrevious) {
                    if (i > 0) {
                        const prevIdx = (startIndex + i - 1 + this.capacity) % this.capacity;
                        result.push({ time: this.timestamps[prevIdx], value: this.values[prevIdx], raw: this.rawValues[prevIdx] });
                    }
                    addedPrevious = true;
                }
                result.push({ time: t, value: this.values[idx], raw: this.rawValues[idx] });
            }
        }

        if (result.length === 0 && this.size > 0) {
            const lastIdx = (this.head - 1 + this.capacity) % this.capacity;
            result.push({ time: this.timestamps[lastIdx], value: this.values[lastIdx], raw: this.rawValues[lastIdx] });
        }

        return result;
    }

    public getAllSamples(): Sample[] {
        if (this.size === 0) return [];
        const result: Sample[] = [];
        const startIndex = (this.head - this.size + this.capacity) % this.capacity;
        for (let i = 0; i < this.size; i++) {
            const idx = (startIndex + i) % this.capacity;
            result.push({ time: this.timestamps[idx], value: this.values[idx], raw: this.rawValues[idx] });
        }
        return result;
    }

    public getValueAtTime(timeMs: number): number | null {
        if (this.size === 0) return null;

        const startIndex = (this.head - this.size + this.capacity) % this.capacity;

        let lo = 0;
        let hi = this.size - 1;

        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const midIdx = (startIndex + mid) % this.capacity;
            if (this.timestamps[midIdx] < timeMs) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        const idxAfter = (startIndex + lo) % this.capacity;
        const tAfter = this.timestamps[idxAfter];

        if (lo > 0) {
            const idxBefore = (startIndex + lo - 1 + this.capacity) % this.capacity;
            const tBefore = this.timestamps[idxBefore];
            if (timeMs - tBefore <= tAfter - timeMs) {
                return this.values[idxBefore];
            }
        }

        return this.values[idxAfter];
    }

    /** То же, что getValueAtTime, но возвращает сырое значение (raw). */
    public getRawAtTime(timeMs: number): number | null {
        if (this.size === 0) return null;

        const startIndex = (this.head - this.size + this.capacity) % this.capacity;

        let lo = 0;
        let hi = this.size - 1;

        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const midIdx = (startIndex + mid) % this.capacity;
            if (this.timestamps[midIdx] < timeMs) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        const idxAfter = (startIndex + lo) % this.capacity;
        const tAfter = this.timestamps[idxAfter];

        if (lo > 0) {
            const idxBefore = (startIndex + lo - 1 + this.capacity) % this.capacity;
            const tBefore = this.timestamps[idxBefore];
            if (timeMs - tBefore <= tAfter - timeMs) {
                return this.rawValues[idxBefore];
            }
        }

        return this.rawValues[idxAfter];
    }

    public getStepValueAtTime(timeMs: number): number | null {
        if (this.size === 0) return null;

        const startIndex = (this.head - this.size + this.capacity) % this.capacity;

        if (this.timestamps[startIndex] > timeMs) return null;

        let lo = 0;
        let hi = this.size - 1;

        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            const midIdx = (startIndex + mid) % this.capacity;
            if (this.timestamps[midIdx] <= timeMs) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        const idx = (startIndex + lo) % this.capacity;
        return this.values[idx];
    }

    public getMinMax(durationMs?: number, currentTime?: number): { min: number; max: number } {
        if (this.size === 0) return { min: -10, max: 10 };

        const now = currentTime !== undefined ? currentTime : this.timestamps[(this.head - 1 + this.capacity) % this.capacity];
        const minTime = durationMs ? now - durationMs : -Infinity;

        let min = Infinity;
        let max = -Infinity;
        let found = false;

        const startIndex = (this.head - this.size + this.capacity) % this.capacity;
        for (let i = 0; i < this.size; i++) {
            const idx = (startIndex + i) % this.capacity;
            const t = this.timestamps[idx];
            if (t >= minTime) {
                const v = this.values[idx];
                if (v < min) min = v;
                if (v > max) max = v;
                found = true;
            }
        }

        if (!found || min === max) {
            return { min: min === Infinity ? -10 : min - 10, max: max === -Infinity ? 10 : max + 10 };
        }

        return { min, max };
    }
}

export class Archive {
    private buffers: Map<string, ChannelRingBuffer> = new Map();
    private capacityPerChannel: number;

    constructor(capacityPerChannel: number = 100000) {
        this.capacityPerChannel = capacityPerChannel;
    }

    public getOrCreateBuffer(channelId: string): ChannelRingBuffer {
        let buffer = this.buffers.get(channelId);
        if (!buffer) {
            buffer = new ChannelRingBuffer(this.capacityPerChannel);
            this.buffers.set(channelId, buffer);
        }
        return buffer;
    }

    public addSample(channelId: string, time: number, value: number, raw: number): void {
        const buffer = this.getOrCreateBuffer(channelId);
        buffer.push(time, value, raw);
    }

    public getRecentSamples(channelId: string, durationMs: number, currentTime?: number): Sample[] {
        const buffer = this.buffers.get(channelId);
        if (!buffer) return [];
        return buffer.getRecentSamples(durationMs, currentTime);
    }

    public getAllSamples(channelId: string): Sample[] {
        const buffer = this.buffers.get(channelId);
        if (!buffer) return [];
        return buffer.getAllSamples();
    }

    public getValueAtTime(channelId: string, timeMs: number): number | null {
        const buffer = this.buffers.get(channelId);
        if (!buffer) return null;
        return buffer.getValueAtTime(timeMs);
    }

    public getRawAtTime(channelId: string, timeMs: number): number | null {
        const buffer = this.buffers.get(channelId);
        if (!buffer) return null;
        return buffer.getRawAtTime(timeMs);
    }

    public getStepValueAtTime(channelId: string, timeMs: number): number | null {
        const buffer = this.buffers.get(channelId);
        if (!buffer) return null;
        return buffer.getStepValueAtTime(timeMs);
    }

    public getMinMax(channelId: string, durationMs?: number, currentTime?: number): { min: number; max: number } {
        const buffer = this.buffers.get(channelId);
        if (!buffer) return { min: -10, max: 10 };
        return buffer.getMinMax(durationMs, currentTime);
    }

    public clear(): void {
        this.buffers.forEach(b => b.clear());
    }

    public getTimeRange(): { min: number; max: number } {
        let min = Infinity;
        let max = -Infinity;
        let hasData = false;

        this.buffers.forEach(buffer => {
            if (buffer.size > 0) {
                hasData = true;
                const startIndex = (buffer.head - buffer.size + buffer.capacity) % buffer.capacity;
                const firstTime = buffer.timestamps[startIndex];
                const lastIdx = (buffer.head - 1 + buffer.capacity) % buffer.capacity;
                const lastTime = buffer.timestamps[lastIdx];

                if (firstTime < min) min = firstTime;
                if (lastTime > max) max = lastTime;
            }
        });
        if (!hasData) {
            const now = Date.now();
            return { min: now, max: now };
        }

        return { min, max };
    }
}