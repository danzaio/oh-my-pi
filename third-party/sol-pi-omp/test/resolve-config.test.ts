import { describe, expect, it } from "bun:test";
import { resolveSolPiConfig, type SettingsView, type SolPiConfig } from "../src/resolve-config";

const OFF: SolPiConfig = Object.freeze({
	version: 1,
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	evidencePreservingReducerModel: "gpt-5.6-luna",
	evidencePreservingReducerProvider: "openai-codex",
	onlineContextCompact: false,
	cacheWriteReadRatio: 12.5,
});

const ALL_ON: SolPiConfig = Object.freeze({
	version: 1,
	actionFusion: true,
	observationPack: true,
	evidencePreservingReducer: true,
	evidencePreservingReducerModel: "my-model",
	evidencePreservingReducerProvider: "my-prov",
	onlineContextCompact: true,
	cacheWriteReadRatio: 7,
});

function viewOf(touched: Record<string, unknown>): SettingsView {
	return {
		get: path => touched[path],
		isConfigured: path => Object.hasOwn(touched, path),
	};
}

describe("resolveSolPiConfig", () => {
	it("untouched settings + all-off file stays all-off with built-in defaults", () => {
		const out = resolveSolPiConfig(OFF, viewOf({}));
		expect(out.actionFusion).toBe(false);
		expect(out.observationPack).toBe(false);
		expect(out.evidencePreservingReducer).toBe(false);
		expect(out.onlineContextCompact).toBe(false);
		expect(out.cacheWriteReadRatio).toBe(12.5);
		expect(out.evidencePreservingReducerProvider).toBe("openai-codex");
		expect(out.evidencePreservingReducerModel).toBe("gpt-5.6-luna");
		expect(Object.isFrozen(out)).toBe(true);
	});

	it("touched actionFusion wins while the rest keeps the file", () => {
		const out = resolveSolPiConfig(OFF, viewOf({ "solPi.actionFusion": true }));
		expect(out.actionFusion).toBe(true);
		expect(out.observationPack).toBe(false);
		expect(out.evidencePreservingReducer).toBe(false);
		expect(out.onlineContextCompact).toBe(false);
	});

	it("blank provider string falls back to the file value", () => {
		const file: SolPiConfig = Object.freeze({ ...OFF, evidencePreservingReducerProvider: "my-prov" });
		const out = resolveSolPiConfig(file, viewOf({ "solPi.evidencePreservingReducerProvider": "   " }));
		expect(out.evidencePreservingReducerProvider).toBe("my-prov");
	});

	it("explicit zero ratio is preserved, not treated as absent", () => {
		const out = resolveSolPiConfig(OFF, viewOf({ "solPi.cacheWriteReadRatio": 0 }));
		expect(out.cacheWriteReadRatio).toBe(0);
	});

	it("invalid ratios fall back to the file value", () => {
		const nan = resolveSolPiConfig(OFF, viewOf({ "solPi.cacheWriteReadRatio": Number.NaN }));
		expect(nan.cacheWriteReadRatio).toBe(12.5);
		const negative = resolveSolPiConfig(OFF, viewOf({ "solPi.cacheWriteReadRatio": -1 }));
		expect(negative.cacheWriteReadRatio).toBe(12.5);
	});

	it("all-enabled file is honored when settings are untouched", () => {
		const out = resolveSolPiConfig(ALL_ON, viewOf({}));
		expect(out.actionFusion).toBe(true);
		expect(out.observationPack).toBe(true);
		expect(out.evidencePreservingReducer).toBe(true);
		expect(out.onlineContextCompact).toBe(true);
		expect(out.cacheWriteReadRatio).toBe(7);
		expect(out.evidencePreservingReducerProvider).toBe("my-prov");
		expect(out.evidencePreservingReducerModel).toBe("my-model");
	});
});
