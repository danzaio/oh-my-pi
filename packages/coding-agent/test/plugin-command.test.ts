import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Plugin from "@oh-my-pi/pi-coding-agent/commands/plugin";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("Plugin command scope parsing", () => {
	it("rejects invalid scope values", async () => {
		const command = new Plugin(["install", "--scope", "porject"], TEST_CONFIG);
		await expect(command.parse(Plugin)).rejects.toThrow(/Expected --scope to be one of: user, project/);
	});
});

describe("PluginManager legacy config settings", () => {
	let tmpRoot: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-config-"));
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "omp-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	it("lists plugin settings when an old lockfile has no settings object", async () => {
		await Bun.write(
			path.join(tmpRoot, "omp-plugins.lock.json"),
			JSON.stringify({ plugins: { "@scope/example": { version: "1.0.0", enabledFeatures: null } } }),
		);

		const manager = new PluginManager(tmpRoot);

		await expect(manager.getPluginSettings("@scope/example")).resolves.toEqual({});
	});

	it("creates the settings object before writing plugin settings", async () => {
		const lockfile = path.join(tmpRoot, "omp-plugins.lock.json");
		await Bun.write(
			lockfile,
			JSON.stringify({ plugins: { "@scope/example": { version: "1.0.0", enabledFeatures: null } } }),
		);

		const manager = new PluginManager(tmpRoot);
		await manager.setPluginSetting("@scope/example", "enabled", true);

		const saved = JSON.parse(await fs.readFile(lockfile, "utf8"));
		expect(saved.settings["@scope/example"].enabled).toBe(true);
	});
});
