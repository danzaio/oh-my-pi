import {
	getAgentDir as getAgentDirFallback,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { loadSolPiConfig } from "../../sol-pi/src/sol-pi/config";
import { resolveSolPiConfig, type SettingsView } from "./resolve-config";

// Path-keyed lazy loading: the extension graph hook only follows static
// import/export edges, so lazy `await import()` of mechanism modules would
// skip legacy-Pi specifier rewriting and fail at load. String literals here
// name each mechanism entry for the static scanner (kept in sync by hand);
// loading itself stays lazy per enabled flag so the all-off default evaluates
// zero mechanism modules. A static `import` would instead pull all four
// mechanisms into the entry graph and break all-off loading on this host
// (notably `findCutPoint`, absent from the OMP root), which is exactly what
// the path keys avoid.
const MECHANISM_PATHS = {
	actionFusion: "../../sol-pi/src/sol-pi/extensions/action-fusion/index",
	observationPack: "../../sol-pi/src/sol-pi/extensions/observation-pack/index",
	evidencePreservingReducer: "../../sol-pi/src/sol-pi/extensions/evidence-preserving-reducer/index",
	onlineContextCompact: "../../sol-pi/src/sol-pi/extensions/online-context-compact/index",
} as const;

/**
 * OMP bridge for SoL-Pi (fork-owned, no submodule/core patches).
 *
 * Mechanism modules load lazily per enabled flag through path-keyed dynamic
 * import (see MECHANISM_PATHS: string literals keep each entry visible to the
 * static scanner while a plain static `import` would pull all four mechanisms
 * into the entry graph and break all-off loading on this host). Each load is
 * wrapped in try/catch (failure warns and leaves that mechanism off). The
 * all-off default therefore evaluates zero mechanism modules and loads clean
 * on stock and fork hosts. The loader runs post-`Settings.init`, so a
 * `/settings` change takes effect from the next session — same granularity
 * as editing `sol-pi.json`.
 */
export default function solPiOmpBridge(pi: ExtensionAPI): void {
	pi.setLabel("SoL-Pi (OMP bridge)");
	let initialized = false;
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (initialized) return;
		initialized = true;
		const manager = SettingsManager.create(ctx.cwd, getAgentDirFallback());
		const agentDir = manager.getAgentDir();
		const file = loadSolPiConfig(ctx.cwd, agentDir, ctx.isProjectTrusted());
		// `Settings.get/isConfigured` throw for unknown paths on hosts whose
		// schema lacks `solPi.*` (stock omp); treat that as "untouched" so the
		// file value wins and the bridge stays load-safe everywhere.
		const view: SettingsView = {
			get: path => manager.get(path as never) as unknown,
			isConfigured: path => {
				try {
					return manager.isConfigured(path as never);
				} catch {
					return false;
				}
			},
		};
		const config = resolveSolPiConfig(file, view);
		// `Function("p", "return import(p)")` keeps the specifier out of the
		// static graph scan (plain `await import(literal)` IS followed and
		// would pull every mechanism into the entry graph, breaking all-off
		// loading on this host); resolution still runs against the rewritten
		// graph at runtime. Kept behind one helper so the indirection is
		// visible and greppable rather than scattered per mechanism.
		const loadMechanism = <T>(mechanism: keyof typeof MECHANISM_PATHS): Promise<T> =>
			Function("path", "return import(path)")(MECHANISM_PATHS[mechanism]) as Promise<T>;
		if (config.actionFusion) {
			try {
				const mod = await loadMechanism<{ registerActionFusion(api: ExtensionAPI): void }>("actionFusion");
				mod.registerActionFusion(pi);
			} catch (error) {
				pi.logger.warn("SoL-Pi bridge: actionFusion failed to load, leaving it off", {
					error: String(error),
				});
			}
		}
		if (config.observationPack) {
			try {
				const mod = await loadMechanism<{ registerObservationPack(api: ExtensionAPI): void }>("observationPack");
				mod.registerObservationPack(pi);
			} catch (error) {
				pi.logger.warn("SoL-Pi bridge: observationPack failed to load, leaving it off", {
					error: String(error),
				});
			}
		}
		if (config.evidencePreservingReducer) {
			try {
				const mod = await loadMechanism<{
					registerEvidencePreservingReducer(
						api: ExtensionAPI,
						options: { reducerModel: string; reducerProvider: string },
					): void;
				}>("evidencePreservingReducer");
				mod.registerEvidencePreservingReducer(pi, {
					reducerModel: config.evidencePreservingReducerModel,
					reducerProvider: config.evidencePreservingReducerProvider,
				});
			} catch (error) {
				pi.logger.warn("SoL-Pi bridge: evidencePreservingReducer failed to load, leaving it off", {
					error: String(error),
				});
			}
		}
		if (config.onlineContextCompact) {
			try {
				const mod = await loadMechanism<{
					registerOnlineContextCompact(api: ExtensionAPI, ratio: number): void;
				}>("onlineContextCompact");
				mod.registerOnlineContextCompact(pi, config.cacheWriteReadRatio);
			} catch (error) {
				pi.logger.warn("SoL-Pi bridge: onlineContextCompact failed to load, leaving it off", {
					error: String(error),
				});
			}
		}
	});
}
