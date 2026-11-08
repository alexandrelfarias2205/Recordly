import { describe, expect, it } from "vitest";
import {
	ChunkedPcmBuffer,
	PCM_CHUNK_COALESCE_FRAMES,
	COMPACT_PCM_STORAGE_MIN_SAMPLES,
	resolvePcmStorageFormat,
} from "./pcmSource";

function ramp(start: number, count: number, scale = 1 / 1000): Float32Array {
	return Float32Array.from({ length: count }, (_, i) => (start + i) * scale);
}

function buildBuffer(storage: "float32" | "int16") {
	const buffer = new ChunkedPcmBuffer({ sampleRate: 1000, numberOfChannels: 2, storage });
	// Chunks of 5, 3 and 7 frames; right channel is the negated left channel.
	let offset = 0;
	for (const size of [5, 3, 7]) {
		const left = ramp(offset, size);
		const right = left.map((v) => -v);
		buffer.append([left, right]);
		offset += size;
	}
	return buffer;
}

describe("ChunkedPcmBuffer", () => {
	it("reports length and duration across chunks", () => {
		const buffer = buildBuffer("float32");
		expect(buffer.length).toBe(15);
		expect(buffer.duration).toBeCloseTo(0.015, 10);
		expect(buffer.numberOfChannels).toBe(2);
		expect(buffer.sampleRate).toBe(1000);
	});

	it.each(["float32", "int16"] as const)("copies across chunk boundaries (%s)", (storage) => {
		const buffer = buildBuffer(storage);
		const out = new Float32Array(10);
		buffer.copyFromChannel(out, 0, 3);
		const expected = ramp(3, 10);
		for (let i = 0; i < out.length; i++) {
			expect(out[i]).toBeCloseTo(expected[i], 4);
		}

		const right = new Float32Array(15);
		buffer.copyFromChannel(right, 1);
		for (let i = 0; i < 15; i++) {
			expect(right[i]).toBeCloseTo(-i / 1000, 4);
		}
	});

	it("leaves the tail untouched when the request runs past the end", () => {
		const buffer = buildBuffer("float32");
		const out = new Float32Array(6).fill(9);
		buffer.copyFromChannel(out, 0, 12);
		expect(Array.from(out.subarray(0, 3))).toEqual(Array.from(ramp(12, 3)));
		expect(Array.from(out.subarray(3))).toEqual([9, 9, 9]);
	});

	it("copies nothing for offsets at or beyond the end", () => {
		const buffer = buildBuffer("int16");
		const out = new Float32Array(4).fill(7);
		buffer.copyFromChannel(out, 0, 15);
		buffer.copyFromChannel(out, 0, 400);
		expect(Array.from(out)).toEqual([7, 7, 7, 7]);
	});

	it("round-trips int16 storage within one quantization step", () => {
		const buffer = new ChunkedPcmBuffer({
			sampleRate: 48_000,
			numberOfChannels: 1,
			storage: "int16",
		});
		const samples = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 17) * 0.99);
		samples[0] = 1;
		samples[1] = -1;
		samples[2] = 5;
		buffer.append([samples.slice(0, 700)]);
		buffer.append([samples.slice(700)]);

		const out = new Float32Array(2000);
		buffer.copyFromChannel(out, 0);
		for (let i = 3; i < out.length; i++) {
			expect(Math.abs(out[i] - samples[i])).toBeLessThanOrEqual(1 / 32768);
		}
		expect(Math.abs(out[0] - 1)).toBeLessThanOrEqual(1 / 32768);
		expect(out[1]).toBe(-1);
		expect(Math.abs(out[2] - 1)).toBeLessThanOrEqual(1 / 32768);
	});

	it("ignores empty chunks and rejects mismatched channel lengths", () => {
		const buffer = new ChunkedPcmBuffer({ sampleRate: 1000, numberOfChannels: 2 });
		buffer.append([new Float32Array(0), new Float32Array(0)]);
		expect(buffer.length).toBe(0);
		expect(() => buffer.append([new Float32Array(2), new Float32Array(3)])).toThrow();
		expect(() => buffer.append([new Float32Array(2)])).toThrow();
	});
});

describe("ChunkedPcmBuffer coalescing", () => {
	it.each([
		"float32",
		"int16",
	] as const)("coalesces small appends and reads across the block boundary (%s)", (storage) => {
		const buffer = new ChunkedPcmBuffer({ sampleRate: 48_000, numberOfChannels: 1, storage });
		const total = PCM_CHUNK_COALESCE_FRAMES + 3000;
		const source = Float32Array.from({ length: total }, (_, i) => (i % 2000) / 4000);
		for (let offset = 0; offset < total; offset += 1024) {
			buffer.append([source.slice(offset, Math.min(total, offset + 1024))]);
		}

		// Unflushed frames are already counted.
		expect(buffer.length).toBe(total);
		expect(buffer.duration).toBeCloseTo(total / 48_000, 10);

		const start = PCM_CHUNK_COALESCE_FRAMES - 500;
		const out = new Float32Array(1500);
		buffer.copyFromChannel(out, 0, start);
		for (let i = 0; i < out.length; i++) {
			expect(Math.abs(out[i] - source[start + i])).toBeLessThanOrEqual(1 / 32768);
		}

		// Appending after a read still works and stays contiguous.
		buffer.append([Float32Array.of(0.25, 0.5)]);
		expect(buffer.length).toBe(total + 2);
		const tail = new Float32Array(4);
		buffer.copyFromChannel(tail, 0, total - 2);
		expect(tail[2]).toBeCloseTo(0.25, 4);
		expect(tail[3]).toBeCloseTo(0.5, 4);
	});

	it("keeps a single small append readable without reaching the block size", () => {
		const buffer = new ChunkedPcmBuffer({ sampleRate: 1000, numberOfChannels: 2 });
		buffer.append([Float32Array.of(0.1, 0.2), Float32Array.of(-0.1, -0.2)]);
		const out = new Float32Array(3).fill(9);
		buffer.copyFromChannel(out, 1);
		expect(out[0]).toBeCloseTo(-0.1, 6);
		expect(out[1]).toBeCloseTo(-0.2, 6);
		expect(out[2]).toBe(9);
	});
});

describe("resolvePcmStorageFormat", () => {
	it("keeps short sources as float32 and long or unknown sources as int16", () => {
		expect(resolvePcmStorageFormat(60, 48_000, 2)).toBe("float32");
		expect(resolvePcmStorageFormat(600, 48_000, 2)).toBe("float32");
		expect(resolvePcmStorageFormat(4112, 48_000, 2)).toBe("int16");
		expect(resolvePcmStorageFormat(null, 48_000, 2)).toBe("int16");
		expect(COMPACT_PCM_STORAGE_MIN_SAMPLES).toBe(57_600_000);
	});
});
