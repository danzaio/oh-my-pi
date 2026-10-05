/**
 * Contract: while a collab room is live the host's own user prompts carry the
 * same author badge a guest's `collab-prompt` custom message already carries,
 * so everyone reading a shared transcript can tell who asked what instead of
 * inferring that an unnamed turn is system or agent input.
 *
 * The badge is drawn beside the bubble, never merged into the stored prompt
 * text the model sees, and a process with no room active renders exactly what
 * it rendered before.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { CollabPromptMessageComponent } from "@oh-my-pi/pi-tui/chat/collab-prompt-message";
import type { CollabPromptDetails, CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-tui/chat/messages";
import { setCollabHostAuthor, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { span } from "@oh-my-pi/pi-tui/native/describe";
import type { TspNode } from "@oh-my-pi/pi-wire";

const WIDTH = 80;
/** The host's `collab.displayName`, as `participants` reports it. */
const HOST_NAME = "Bauke";
const HOST_BADGE = "«Bauke · host» ›";
const PROMPT = "rotate the staging key please";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	setCollabHostAuthor(null);
});

/** A component's painted rows, ANSI stripped and blank padding rows dropped. */
function visibleRows(component: { render(width: number): readonly string[] }): string[] {
	return component
		.render(WIDTH)
		.map(row => Bun.stripANSI(row).trim())
		.filter(row => row.trim().length > 0);
}

/** A guest prompt as the host injects it: a `collab-prompt` naming its author. */
function guestPrompt(from: string, text: string): CustomMessage<CollabPromptDetails> {
	return {
		role: "custom",
		customType: COLLAB_PROMPT_MESSAGE_TYPE,
		content: [{ type: "text", text } satisfies TextContent],
		details: { from },
		display: true,
		attribution: "user",
		timestamp: 1,
	};
}

/** Every markdown body a card paints, in document order. */
function markdownBodies(node: TspNode): string[] {
	const own = node.k === "md" ? [node.p?.text ?? ""] : [];
	return [...own, ...(node.c ?? []).flatMap(markdownBodies)];
}

describe("collab host author badge", () => {
	it("names the host on a host prompt while a room is active, and leaves a guest prompt on its own name", () => {
		setCollabHostAuthor(HOST_NAME);
		const host = new UserMessageComponent(PROMPT);
		const guest = new CollabPromptMessageComponent(guestPrompt("ada", "one more idea"));

		expect(visibleRows(host)).toEqual([HOST_BADGE, PROMPT]);
		expect(visibleRows(guest)).toEqual(["«ada» ›", "one more idea"]);
	});

	it("keeps the host's prompt text exactly as the model sent it — the badge is drawn, not prepended", () => {
		setCollabHostAuthor(HOST_NAME);
		const card = new UserMessageComponent(PROMPT).describe() as TspNode;
		if (card.k !== "card") throw new Error("user bubble is not a card");

		// The author sits in the card head; the markdown body is the stored text.
		expect(card.p?.head).toEqual([span(HOST_BADGE, "accent strong")]);
		expect(markdownBodies(card)).toEqual([PROMPT]);
	});

	it("renders a solo session exactly as it always has: the prompt, and nothing else", () => {
		const solo = new UserMessageComponent("ship it");
		const painted = Bun.stripANSI(solo.render(WIDTH).join("\n"));
		// Byte-level proof that the no-room path carries no badge markup at all.
		expect(painted).not.toContain("«");
		expect(painted).not.toContain("host");
		expect(visibleRows(solo)).toEqual(["ship it"]);

		// The badge row is the only thing a live room adds to the same prompt.
		setCollabHostAuthor(HOST_NAME);
		expect(visibleRows(new UserMessageComponent("ship it"))).toEqual(["«Bauke · host» ›", "ship it"]);
	});

	it("drops the badge again once the room ends", () => {
		setCollabHostAuthor(HOST_NAME);
		expect(visibleRows(new UserMessageComponent("ship it"))).toEqual([HOST_BADGE, "ship it"]);

		setCollabHostAuthor(null);
		expect(visibleRows(new UserMessageComponent("ship it"))).toEqual(["ship it"]);
	});

	it("never badges agent-attributed input, which is nobody's hand", () => {
		setCollabHostAuthor(HOST_NAME);
		const synthetic = new UserMessageComponent("Session update: compaction finished", { synthetic: true });
		expect(visibleRows(synthetic)).not.toContain(HOST_BADGE);
	});
});
