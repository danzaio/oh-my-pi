import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { shouldHideUnsupportedThinkingWhenOff } from "@oh-my-pi/pi-coding-agent/thinking";

function model(provider: string, id: string): Model {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	} as Model;
}

describe("shouldHideUnsupportedThinkingWhenOff", () => {
	test("hides MiniMax and GLM thinking artifacts when the user selected off", () => {
		expect(shouldHideUnsupportedThinkingWhenOff(model("minimax-code", "MiniMax-M3"), ThinkingLevel.Off)).toBe(true);
		expect(shouldHideUnsupportedThinkingWhenOff(model("opencode-go", "glm-5.1"), ThinkingLevel.Off)).toBe(true);
	});

	test("does not hide unrelated providers or enabled thinking levels", () => {
		expect(shouldHideUnsupportedThinkingWhenOff(model("anthropic", "claude-sonnet-4-5"), ThinkingLevel.Off)).toBe(
			false,
		);
		expect(shouldHideUnsupportedThinkingWhenOff(model("minimax-code", "MiniMax-M3"), ThinkingLevel.High)).toBe(false);
		expect(shouldHideUnsupportedThinkingWhenOff(undefined, ThinkingLevel.Off)).toBe(false);
	});
});
