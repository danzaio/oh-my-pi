import type { SolPiConfig } from "../../sol-pi/src/sol-pi/config";
export type { SolPiConfig };

/** Minimal settings surface the merge needs; satisfied by the OMP singleton or a test stub. */
export interface SettingsView {
	get(path: string): unknown;
	isConfigured(path: string): boolean;
}

function configuredString(view: SettingsView, path: string, fallback: string): string {
	if (!view.isConfigured(path)) return fallback;
	const value = view.get(path);
	return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/**
 * Merge OMP `solPi.*` settings over a loaded `sol-pi.json` config.
 *
 * Settings win only where the user touched them (`isConfigured`); everything
 * else keeps the file value, preserving upstream semantics (file defaults to
 * built-in off, project file replaces the user-wide file without merging).
 * Invalid ratio values fall back to the file; explicit zero is preserved.
 */
export function resolveSolPiConfig(file: SolPiConfig, view: SettingsView): SolPiConfig {
	const actionFusion = view.isConfigured("solPi.actionFusion")
		? (view.get("solPi.actionFusion") as boolean)
		: file.actionFusion;
	const observationPack = view.isConfigured("solPi.observationPack")
		? (view.get("solPi.observationPack") as boolean)
		: file.observationPack;
	const evidencePreservingReducer = view.isConfigured("solPi.evidencePreservingReducer")
		? (view.get("solPi.evidencePreservingReducer") as boolean)
		: file.evidencePreservingReducer;
	const onlineContextCompact = view.isConfigured("solPi.onlineContextCompact")
		? (view.get("solPi.onlineContextCompact") as boolean)
		: file.onlineContextCompact;
	const evidencePreservingReducerProvider = configuredString(
		view,
		"solPi.evidencePreservingReducerProvider",
		file.evidencePreservingReducerProvider,
	);
	const evidencePreservingReducerModel = configuredString(
		view,
		"solPi.evidencePreservingReducerModel",
		file.evidencePreservingReducerModel,
	);

	let cacheWriteReadRatio = file.cacheWriteReadRatio;
	if (view.isConfigured("solPi.cacheWriteReadRatio")) {
		const value = view.get("solPi.cacheWriteReadRatio");
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			cacheWriteReadRatio = value;
		}
	}

	return Object.freeze({
		version: 1 as const,
		actionFusion,
		observationPack,
		evidencePreservingReducer,
		evidencePreservingReducerModel,
		evidencePreservingReducerProvider,
		onlineContextCompact,
		cacheWriteReadRatio,
	});
}
