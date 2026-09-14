import {
	getAgentDir as getAgentDirFallback,
	settings as settingsFallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { loadSolPiConfig } from "../../sol-pi/src/sol-pi/config";
import { createSolPiExtension } from "../../sol-pi/src/sol-pi/index";
import { resolveSolPiConfig } from "./resolve-config";

function isHostSettings(value: unknown): value is { get(path: string): unknown; isConfigured(path: string): boolean } {
	if (value === null || typeof value !== "object") return false;
	return "get" in value && "isConfigured" in value;
}

/**
 * OMP bridge for SoL-Pi: reuses the upstream entry without patching it,
 * injecting a loader that merges OMP `solPi.*` settings over `sol-pi.json`.
 * The loader runs on `session_start` (post-`Settings.init`), so a `/settings`
 * change takes effect from the next session — same granularity as the file.
 */
export default function solPiOmpBridge(pi: ExtensionAPI): void {
	pi.setLabel("SoL-Pi (OMP bridge)");
	const factory = createSolPiExtension((ctx: ExtensionContext) => {
		const host = "pi" in pi && pi.pi !== null && typeof pi.pi === "object" ? pi.pi : undefined;
		const candidateSettings =
			host !== undefined && "settings" in host ? host.settings : (settingsFallback as unknown);
		const view = isHostSettings(candidateSettings)
			? candidateSettings
			: (settingsFallback as unknown as { get(path: string): unknown; isConfigured(path: string): boolean });
		const candidateAgentDir = host !== undefined && "getAgentDir" in host ? host.getAgentDir : undefined;
		const agentDir = typeof candidateAgentDir === "function" ? candidateAgentDir() : getAgentDirFallback();
		return resolveSolPiConfig(loadSolPiConfig(ctx.cwd, agentDir, ctx.isProjectTrusted()), view);
	});
	factory(pi);
}
