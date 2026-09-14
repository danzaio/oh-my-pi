import {
	getAgentDir as getAgentDirFallback,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { loadSolPiConfig } from "../../sol-pi/src/sol-pi/config";
import { resolveSolPiConfig, type SettingsView } from "./resolve-config";

// Mechanism paths, one per SoL-Pi mechanism entry. Loading is lazy per
// enabled flag through `loadMechanism` below, so the all-off default
// evaluates zero mechanism modules and loads clean on stock and fork hosts.
// (A plain static `import` of these entries would instead pull all four
// mechanisms into the entry graph and break all-off loading on this host —
// notably the Online Context Compact module, whose `findCutPoint` /
// `sessionEntryToContextMessages` root imports OMP does not re-export.)
const MECHANISM_PATHS = {
	actionFusion: "../../sol-pi/src/sol-pi/extensions/action-fusion/index",
	observationPack: "../../sol-pi/src/sol-pi/extensions/observation-pack/index",
	evidencePreservingReducer: "../../sol-pi/src/sol-pi/extensions/evidence-preserving-reducer/index",
	onlineContextCompact: "../../sol-pi/src/sol-pi/extensions/online-context-compact/index",
} as const;

/**
 * OMP bridge for SoL-Pi (fork-owned, no submodule/core patches).
 *
 * Actual registration stays gated per enabled flag in `session_start`, each
 * load wrapped in try/catch (failure warns and leaves that mechanism off).
 * The all-off default therefore registers nothing and loads clean on stock
 * and fork hosts. The loader runs post-`Settings.init`, so a `/settings`
 * change takes effect from the next session — same granularity as `sol-pi.json`.
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
		// `Function("path", "return import(path)")` keeps each specifier out of
		// the static entry graph (a plain `await import(literal)` would pull all
		// four mechanism modules into the entry graph and break all-off loading
		// on this host); resolution still runs at runtime. One helper keeps the
		// indirection visible and greppable rather than scattered per mechanism.
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
