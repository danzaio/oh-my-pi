import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	rejectUnknownSlashCommand,
	type SlashCommandRegistry,
	slashCommandToken,
} from "@oh-my-pi/pi-coding-agent/slash-commands/resolve";

// Issue #14123: slash-prefixed input is a harness command. A draft nothing can
// run — `/foobar`, or a builtin that refused its arguments — used to fall
// through to the model, burning a turn to answer a typo. It must be refused in
// the composer, with the draft handed back so it can be corrected.
function emptyRegistry(overrides: Partial<SlashCommandRegistry> = {}): SlashCommandRegistry {
	const never = () => false;
	return {
		hasSkillCommand: never,
		hasFileCommand: never,
		hasExtensionCommand: never,
		hasCustomCommand: never,
		hasPromptTemplate: never,
		...overrides,
	};
}

describe("slash command resolution", () => {
	it("reports an unknown command for a token no registry claims", () => {
		expect(rejectUnknownSlashCommand("/foobar", emptyRegistry())).toBe("Unknown command: /foobar");
	});

	it("reports an unknown command for a bare word with arguments", () => {
		expect(rejectUnknownSlashCommand("/foobar and more", emptyRegistry())).toBe("Unknown command: /foobar");
	});

	it("leaves non-command text and a lone slash alone", () => {
		expect(rejectUnknownSlashCommand("foobar", emptyRegistry())).toBeUndefined();
		expect(rejectUnknownSlashCommand("/", emptyRegistry())).toBeUndefined();
	});

	it("accepts every source the palette advertises", () => {
		const known = emptyRegistry({
			hasSkillCommand: name => name === "skill:pdf",
			hasFileCommand: name => name === "review",
			hasExtensionCommand: name => name === "deploy",
			hasCustomCommand: name => name === "notes:export",
			hasPromptTemplate: name => name === "standup",
		});

		expect(rejectUnknownSlashCommand("/skill:pdf chapters", known)).toBeUndefined();
		expect(rejectUnknownSlashCommand("/review src", known)).toBeUndefined();
		expect(rejectUnknownSlashCommand("/deploy prod", known)).toBeUndefined();
		expect(rejectUnknownSlashCommand("/notes:export", known)).toBeUndefined();
		expect(rejectUnknownSlashCommand("/standup", known)).toBeUndefined();
	});

	it("accepts builtins by alias and free-form arguments they declare", () => {
		expect(rejectUnknownSlashCommand("/models", emptyRegistry())).toBeUndefined();
		expect(rejectUnknownSlashCommand("/switch anthropic/claude", emptyRegistry())).toBeUndefined();
	});

	it("names the offending subcommand and the usage the builtin declares", () => {
		expect(rejectUnknownSlashCommand("/jobs foo", emptyRegistry())).toBe(
			"Unknown subcommand: foo. Usage: /jobs [full]",
		);
		expect(rejectUnknownSlashCommand("/jobs full", emptyRegistry())).toBeUndefined();
	});

	it("refuses arguments to a builtin that declares none", () => {
		expect(rejectUnknownSlashCommand("/hotkeys now", emptyRegistry())).toBe(
			'Usage: /hotkeys takes no arguments (got "now")',
		);
		expect(rejectUnknownSlashCommand("/hotkeys", emptyRegistry())).toBeUndefined();
	});

	it("splits a colon-namespaced command as one token, not a name plus argument", () => {
		expect(slashCommandToken("/skill:pdf")).toBe("skill:pdf");
		expect(slashCommandToken("/jobs full")).toBe("jobs");
		expect(slashCommandToken("not a command")).toBe("");
	});
});

interface HarnessEditor {
	onSubmit?: (t: string) => Promise<void>;
	getExpandedText: () => string;
	setText: (t: string) => void;
	pendingImages: ImageContent[];
}

interface Harness {
	ctx: InteractiveModeContext;
	editor: HarnessEditor;
	/** Every provider-bound dispatch the controller can reach. */
	prompt: Mock<() => Promise<boolean>>;
	steer: Mock<(text: string, images?: ImageContent[]) => Promise<void>>;
	followUp: Mock<(text: string, images?: ImageContent[]) => Promise<void>>;
	onInputCallback: Mock<() => void>;
	showStatus: Mock<(message: string) => void>;
	showError: Mock<(message: string) => void>;
	setForcedToolChoice: Mock<(choice: string) => void>;
	setExtensionCommand: (name: string) => void;
}

interface FakeExtensionRunner {
	getCommand: (name: string) => unknown;
	hasHandlers: (hook: string) => boolean;
}

function makeCtx(isStreaming = false, messages: AgentMessage[] = []): Harness {
	const addToHistory = vi.fn();
	const followUp = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const steer = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const prompt = vi.fn(async () => false);
	const onInputCallback = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const setForcedToolChoice = vi.fn();
	// Swapped per test so each case can install its own command registry without
	// the controller ever seeing a differently shaped session object.
	const extensionRunner: { current?: FakeExtensionRunner } = { current: undefined };
	let text = "";
	const editor = {
		onSubmit: undefined as undefined | ((t: string) => Promise<void>),
		getText: () => text,
		getExpandedText: () => text,
		setText: (t: string) => {
			text = t;
		},
		setCollapsedText: (t: string) => {
			text = t;
		},
		composerChips: () => [],
		addToHistory,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			text = "";
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	const locallySubmittedUserSignatures = new Set<string>();
	const sessionManager = { sessionId: "session-a", getSessionId: () => sessionManager.sessionId };
	const session = {
		messages,
		maybeStartTitleGeneration: vi.fn(),
		isStreaming,
		isCompacting: false,
		queuedMessageCount: 0,
		get extensionRunner(): FakeExtensionRunner | undefined {
			return extensionRunner.current;
		},
		customCommands: [],
		promptTemplates: [],
		setForcedToolChoice,
		followUp,
		steer,
		prompt,
	};
	const ctx = {
		editor,
		sessionManager,
		session,
		focusedAgentId: undefined,
		collabGuest: undefined,
		shutdown: vi.fn(async () => {}),
		locallySubmittedUserSignatures,
		flushPendingBashComponents: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handleMCPCommand: vi.fn(async () => {}),
		showStatus,
		onInputCallback,
		startPendingSubmission: (input: {
			text: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			customType?: string;
			display?: boolean;
			streamingBehavior?: "steer" | "followUp";
		}) => {
			locallySubmittedUserSignatures.add(`${input.text}\u0000${input.images?.length ?? 0}`);
			return { ...input, cancelled: false, started: false };
		},
		ui: { requestRender: vi.fn() },
		compactionQueuedMessages: [],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showWarning: vi.fn(),
		showError,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		editor,
		prompt,
		steer,
		followUp,
		onInputCallback,
		showStatus,
		showError,
		setForcedToolChoice,
		setExtensionCommand: (name: string) => {
			extensionRunner.current = {
				getCommand: candidate => (candidate === name ? {} : undefined),
				hasHandlers: () => false,
			};
		},
	};
}

function controllerFor(ctx: InteractiveModeContext): InputController {
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return controller;
}

describe("input controller — unknown slash commands are refused locally (#14123)", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	it("refuses an unknown command without sending it to the model and keeps the draft", async () => {
		const { ctx, editor, prompt, steer, onInputCallback, showError } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/foobar");

		expect(showError).toHaveBeenCalledWith("Unknown command: /foobar (add a leading space to send it as a message)");
		expect(editor.getExpandedText()).toBe("/foobar");
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("refuses an unknown command while streaming instead of steering it", async () => {
		const { ctx, editor, prompt, showError } = makeCtx(true);
		controllerFor(ctx);

		await editor.onSubmit?.("/foobar");

		expect(showError).toHaveBeenCalledWith("Unknown command: /foobar (add a leading space to send it as a message)");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("refuses an unknown command submitted with Ctrl+Enter and restores the draft", async () => {
		const { ctx, editor, prompt, followUp, showError } = makeCtx();
		const controller = controllerFor(ctx);
		editor.setText("/foobar");

		await controller.handleFollowUp();

		expect(showError).toHaveBeenCalledWith("Unknown command: /foobar (add a leading space to send it as a message)");
		expect(editor.getExpandedText()).toContain("/foobar");
		expect(prompt).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("refuses an unsupported subcommand with the builtin's usage and spends no turn", async () => {
		const { ctx, editor, prompt, onInputCallback, showStatus, showError } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/jobs foo");

		expect(showStatus).toHaveBeenCalledWith("Usage: /jobs [full]");
		expect(showError).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("still dispatches a valid builtin command", async () => {
		const { ctx, editor, prompt, onInputCallback, showError } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/hotkeys");

		expect(ctx.handleHotkeysCommand).toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("still dispatches an extension-registered command", async () => {
		const { ctx, editor, prompt, onInputCallback, showError, setExtensionCommand } = makeCtx();
		setExtensionCommand("deploy");
		controllerFor(ctx);

		await editor.onSubmit?.("/deploy prod");

		expect(prompt).toHaveBeenCalledWith("/deploy prod", { images: undefined });
		expect(onInputCallback).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	it("sends an absolute-path draft that used the leading-space escape", async () => {
		const { ctx, editor, showError } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("  /usr/local/bin");

		// The escape's whole point: a prompt that happens to start with `/` still
		// reaches the model instead of being refused as a typo'd command.
		expect(showError).not.toHaveBeenCalled();
		expect([...ctx.locallySubmittedUserSignatures].some(s => s.startsWith("/usr/local/bin"))).toBe(true);
	});

	it("still expands a file-based command into a prompt", async () => {
		const { ctx, editor, onInputCallback, showError } = makeCtx();
		ctx.fileSlashCommands.add("review");
		controllerFor(ctx);

		await editor.onSubmit?.("/review src");

		expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: "/review src" }));
		expect(showError).not.toHaveBeenCalled();
	});

	it("sends a prompt a command handed back verbatim without re-resolving it", async () => {
		const { ctx, editor, onInputCallback, showError, setForcedToolChoice } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/force:bash /foobar");

		expect(setForcedToolChoice).toHaveBeenCalledWith("bash");
		expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: "/foobar" }));
		expect(showError).not.toHaveBeenCalled();
	});
});
