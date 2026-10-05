/**
 * Contract: a live collab room publishes the host's display name for the
 * `«name · host»` badge that plain user bubbles wear, on both sides of the
 * link. The host reads it from the same `collab.displayName` its `participants`
 * entry reports; a guest reads it from the `participants` list the host
 * broadcasts. Both drop it when the room ends, which returns a plain user
 * bubble to the solo rendering it has today.
 *
 * The badge is display-only: a host prompt typed with a room live must reach
 * the model byte-for-byte as typed, while a guest's prompt keeps arriving as a
 * `collab-prompt` custom message naming its author.
 *
 * A real CollabHost/CollabSocket and a real AgentSession (mock model) run over
 * the in-memory relay, exactly as host-registry.test.ts does; a per-test spy on
 * `publishCollabHost` redirects discovery metadata into a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collabHostBadgeLabel, setCollabHostAuthor } from "@oh-my-pi/pi-tui/chat/user-message";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const RELAY_URL = "ws://localhost:8788";
const WEB_URL = "https://collab.example";
/** `collab.displayName` for the host process. */
const HOST_NAME = "Bauke";

let tmp: string;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let host: CollabHost | undefined;
let guest: CollabGuestLink | undefined;
let guestHostSocket: CollabSocket | undefined;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authorbadge-"));
	installInMemoryRelay();
	const real = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		real(source, { ...options, dir: tmp }),
	);
	host = undefined;
	guest = undefined;
	guestHostSocket = undefined;
	setCollabHostAuthor(null);
});

afterEach(async () => {
	await guest?.leave("test cleanup").catch(() => {});
	guestHostSocket?.close();
	if (host) await host.stop("test cleanup").catch(() => {});
	uninstallInMemoryRelay();
	publishSpy?.mockRestore();
	setCollabHostAuthor(null);
	await fs.rm(tmp, { recursive: true, force: true });
});

/** A host context with just the seams `CollabHost.start()`/teardown touch. */
function makeHostContext(settings: Settings, session: AgentSession, manager: SessionManager): InteractiveModeContext {
	return {
		settings,
		session,
		sessionManager: manager,
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

/** A real session on a mock model, so `mock.calls` is what the model received. */
async function makeSession(): Promise<{ session: AgentSession; manager: SessionManager; mock: MockModel }> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Test model missing");
	const mock = createMockModel({ responses: [{ content: ["on it"] }, { content: ["on it"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	const manager = SessionManager.create(tmp, tmp);
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	return { session, manager, mock };
}

/** Everything the model saw, flattened to plain strings. */
function modelSaw(mock: MockModel, call: number): string[] {
	return (mock.calls[call]?.context.messages ?? []).flatMap(message => {
		const content = message.content;
		const parts = typeof content === "string" ? [content] : content.map(part => ("text" in part ? part.text : ""));
		return parts;
	});
}

describe("collab host author badge (#14082)", () => {
	it("names the host on its own prompts while a room is live, and drops the badge when the room ends", async () => {
		const settings = Settings.isolated({ "collab.displayName": HOST_NAME });
		const { session, manager } = await makeSession();
		host = new CollabHost(makeHostContext(settings, session, manager));
		try {
			await host.start(RELAY_URL, WEB_URL);
			// The same name `participants` reports, so the badge cannot drift from the roster.
			expect(host.participants[0]).toEqual({ name: HOST_NAME, role: "host" });
			expect(collabHostBadgeLabel()).toBe(`«${HOST_NAME} · host»`);

			await host.stop("room over");
			expect(collabHostBadgeLabel()).toBeNull();
		} finally {
			await session.dispose();
		}
	});

	it("leaves a solo session with no badge: a room that was never started publishes nothing", async () => {
		const { session, manager } = await makeSession();
		try {
			// A host object alone is not a room: without a live one, plain user
			// bubbles keep the solo rendering they have always had.
			const pending = new CollabHost(makeHostContext(Settings.isolated(), session, manager));
			expect(pending.ending).toBe(false);
			expect(collabHostBadgeLabel()).toBeNull();
		} finally {
			await session.dispose();
		}
	});

	it("keeps the badge out of the prompt the model receives, while a guest prompt still names its author", async () => {
		const settings = Settings.isolated({ "collab.displayName": HOST_NAME });
		const { session, manager, mock } = await makeSession();
		host = new CollabHost(makeHostContext(settings, session, manager));
		const guests: (() => void)[] = [];
		try {
			await host.start(RELAY_URL, WEB_URL);

			await session.prompt("rotate the staging key");
			// What the model received is exactly what the host typed.
			expect(modelSaw(mock, 0)).toEqual(["rotate the staging key"]);
			expect(modelSaw(mock, 0).join(" ")).not.toContain(HOST_NAME);
			expect(modelSaw(mock, 0).join(" ")).not.toContain("«");
			expect(collabHostBadgeLabel()).toBe(`«${HOST_NAME} · host»`);

			// A guest over the relay is still injected as a named collab-prompt entry.
			const parsed = parseCollabLink(host.link);
			if ("error" in parsed || !parsed.writeToken) throw new Error("Control link missing");
			const socket = new CollabSocket({
				wsUrl: parsed.wsUrl,
				role: "guest",
				key: await importRoomKey(parsed.key),
			});
			guests.push(() => socket.close());
			const welcomed = Promise.withResolvers<void>();
			socket.onFrame = frame => {
				if (frame.t === "welcome") welcomed.resolve();
			};
			socket.onOpen = () =>
				socket.send({
					t: "hello",
					proto: COLLAB_PROTO,
					name: "ada",
					writeToken: Buffer.from(parsed.writeToken!).toString("base64url"),
				});
			socket.connect();
			await welcomed.promise;
			await session.promptCustomMessage({
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				content: "one more idea",
				display: true,
				details: { from: "ada" },
				attribution: "user",
			});
			const entry = manager
				.getEntries()
				.find(e => e.type === "custom_message" && e.customType === COLLAB_PROMPT_MESSAGE_TYPE);
			if (!entry) throw new Error("Guest prompt entry missing");
			expect(entry).toMatchObject({
				type: "custom_message",
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				details: { from: "ada" },
			});
			// The guest's turn reaches the model as its own text, still unnamed-by-badge.
			expect(modelSaw(mock, 1).join(" ")).not.toContain(`«${HOST_NAME}`);
		} finally {
			for (const close of guests.reverse()) close();
			await session.dispose();
		}
	});
});

describe("collab guest host author badge (#14082)", () => {
	it("names the host from the broadcast participants and drops the badge on leave", async () => {
		const roomId = "guest-author-badge";
		const roomKey = generateRoomKey();
		const link = formatCollabLink(RELAY_URL, roomId, roomKey);
		const hostSocket = new CollabSocket({
			wsUrl: `${RELAY_URL}/r/${roomId}`,
			role: "host",
			key: await importRoomKey(roomKey),
		});
		guestHostSocket = hostSocket;
		const hostOpen = Promise.withResolvers<void>();
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") {
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
					state: {
						isStreaming: false,
						queuedMessageCount: 0,
						sessionName: "host session",
						cwd: "/tmp",
						participants: [
							{ name: HOST_NAME, role: "host" },
							{ name: "ada", role: "guest" },
						],
					},
					agents: [],
					entryCount: 0,
				} as CollabFrame);
			}
		};
		hostSocket.connect();
		await hostOpen.promise;

		guest = new CollabGuestLink(makeGuestContext());
		await guest.join(link);
		// The replica's plain user messages are the host's, so they wear its badge.
		expect(collabHostBadgeLabel()).toBe(`«${HOST_NAME} · host»`);

		await guest.leave("done");
		expect(collabHostBadgeLabel()).toBeNull();
	});
});

/** Minimal guest context: `#applyHostState` mutates a session agent stub. */
function makeGuestContext(): InteractiveModeContext {
	return {
		collabGuest: undefined,
		settings: Settings.isolated(),
		sessionManager: { getSessionFile: () => null, getSessionName: () => "local", getCwd: () => "/local" },
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
			extensionRunner: undefined,
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		ensureLoadingAnimation: () => {},
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve(), takeDisplaceableComponents: () => [] },
		syncRunningSubagentBadge: () => {},
		eventBus: undefined,
	} as unknown as InteractiveModeContext;
}
