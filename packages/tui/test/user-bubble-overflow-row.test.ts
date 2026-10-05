import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();

/** The prompt-zone opener a user bubble writes on its first row. */
const ZONE_START = "\x1b]133;A\x07";
const COLUMNS = 80;
const ROWS = 20;
const FRAME = { tick: 0, now: 0 };
const MESSAGE = "is there a reason we haven't tested against the real device yet?";

/**
 * A single-row transcript block; `finalized: false` keeps it active. Declared
 * as a class (like `transcript-container.test.ts`'s `Block`) because the
 * finalization hook is optional on the container's block interface and an
 * object literal would trip the excess-property check.
 */
class OneRowBlock implements Component {
	#text: string;
	#finalized: boolean;

	constructor(text: string, finalized = true) {
		this.#text = text;
		this.#finalized = finalized;
	}

	render(): string[] {
		return [this.#text];
	}

	invalidate(): void {}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
}

/**
 * A {@link VirtualTerminal} that records the absolute buffer line of every
 * `133;A` prompt mark handed to it. iTerm2 records the mark on whichever line
 * wrote it and keeps it when that line is later overwritten, so the recorded
 * lines are exactly the staircase a shifting bubble leaves behind (#13835).
 */
class PromptMarkTerminal extends VirtualTerminal {
	readonly markLines: number[] = [];

	override write(data: string): void {
		let rest = data;
		for (let at = rest.indexOf(ZONE_START); at >= 0; at = rest.indexOf(ZONE_START)) {
			// An OSC payload has no grid effect, so the engine's cursor after the
			// preceding bytes is the line this mark lands on.
			super.write(rest.slice(0, at));
			this.markLines.push(this.getBufferPosition().baseY + this.getCursor().row);
			super.write(ZONE_START);
			rest = rest.slice(at + ZONE_START.length);
		}
		super.write(rest);
	}
}

beforeAll(async () => {
	await initTheme();
});

describe("user bubble in the overflow transcript layout (#13835)", () => {
	it("shows the message text instead of the bubble's blank padding row", () => {
		const transcript = new TranscriptContainer();
		// An unfinalized block pins retirement, so the live region outgrows the
		// viewport and the transcript drops to one row per block.
		transcript.addChild(new OneRowBlock("stuck tool", false));
		for (let index = 0; index < 6; index++) transcript.addChild(new OneRowBlock(`settled ${index}`));
		transcript.addChild(new UserMessageComponent(MESSAGE));
		transcript.addChild(new OneRowBlock("after 1"));
		transcript.addChild(new OneRowBlock("after 2"));

		const rows = transcript.renderViewport(COLUMNS, 5, FRAME);
		expect(rows.map(row => Bun.stripANSI(row).trim())).toEqual([
			"settled 4",
			"settled 5",
			MESSAGE,
			"after 1",
			"after 2",
		]);
	});

	it("leaves no prompt mark on lines a live bubble is shifted off", async () => {
		const terminal = new PromptMarkTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(new OneRowBlock("stuck tool", false));
		for (let index = 0; index < 25; index++) transcript.addChild(new OneRowBlock(`settled ${index}`));
		composer.setRuntimeChildren([transcript]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);

		transcript.addChild(new UserMessageComponent(MESSAGE));
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		// Each settled block below the bubble pushes it one row up the viewport,
		// which is what a replayed prompt marker would leave a mark on.
		for (let index = 0; index < 8; index++) {
			transcript.addChild(new OneRowBlock(`after ${index}`));
			composer.ui.requestRender();
			await scheduler.settle(terminal);
		}

		expect(new Set(terminal.markLines).size).toBeLessThanOrEqual(1);
		composer.stop();
	});
});
