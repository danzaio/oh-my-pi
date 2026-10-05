import { lookupBuiltinSlashCommand } from "./builtin-registry";
import { parseSlashCommand, parseSubcommand } from "./helpers/parse";

/**
 * The non-builtin command sources that can claim a slash draft, in the same
 * shape the palette advertises them (`InteractiveMode.#buildPendingSlashCommands`
 * and `#rebuildSlashCommandAutocomplete`). Resolution consults exactly these:
 * everything the picker lists has to dispatch, and a token none of them list is
 * not a command at all.
 */
export interface SlashCommandRegistry {
	/** `/skill:<name>` tokens, keyed `skill:<name>`. */
	hasSkillCommand: (token: string) => boolean;
	/** File-based (project/user) slash command names. */
	hasFileCommand: (name: string) => boolean;
	/** Extension-registered command names. */
	hasExtensionCommand: (name: string) => boolean;
	/** TypeScript and MCP prompt command names. */
	hasCustomCommand: (name: string) => boolean;
	/** Prompt-template names. */
	hasPromptTemplate: (name: string) => boolean;
}

/**
 * The token a slash draft addresses, split the way every non-builtin registry
 * splits it (`expandSlashCommand`, `expandPromptTemplate`, `ExtensionRunner`):
 * the body after `/` up to the first space. A colon is deliberately *not* a
 * separator here, so `/skill:pdf` names one skill rather than a `skill` command
 * taking `pdf`. Returns `""` for text that is not a slash command.
 */
export function slashCommandToken(text: string): string {
	if (!text.startsWith("/")) return "";
	const body = text.slice(1);
	const space = body.indexOf(" ");
	return space === -1 ? body : body.slice(0, space);
}

/** Whether `token` names an extension, skill, file, custom, or prompt-template command. */
export function isNonBuiltinSlashCommand(token: string, registry: SlashCommandRegistry): boolean {
	return (
		registry.hasSkillCommand(token) ||
		registry.hasFileCommand(token) ||
		registry.hasExtensionCommand(token) ||
		registry.hasCustomCommand(token) ||
		registry.hasPromptTemplate(token)
	);
}

/** Whether `token` names a command the harness can run, by builtin name or alias. */
export function isKnownSlashCommand(token: string, registry: SlashCommandRegistry): boolean {
	return lookupBuiltinSlashCommand(token) !== undefined || isNonBuiltinSlashCommand(token, registry);
}

/**
 * Message for a slash draft the harness must refuse instead of forwarding to
 * the model, or `undefined` when the draft names a runnable command (or is not
 * a command at all).
 *
 * Slash-prefixed input is a harness command, so a token no registry claims —
 * `/foobar` — is a typo, not prose, and answering it would spend a turn on
 * nothing. A builtin that declined its arguments (`/jobs foo`) is the
 * invalid-subcommand case and fails the same way, with the usage the command
 * itself declares.
 */
export function rejectUnknownSlashCommand(text: string, registry: SlashCommandRegistry): string | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const token = slashCommandToken(text);
	if (token === "") return undefined;
	if (!isKnownSlashCommand(token, registry)) return `Unknown command: /${token}`;

	// The draft names a real command. Only a builtin gets a usage complaint, and
	// only when it refused these arguments — a builtin that ran already consumed
	// the draft with its own (richer) message.
	const builtin = lookupBuiltinSlashCommand(parsed.name);
	if (!builtin || parsed.args === "") return undefined;
	const subcommands = builtin.subcommands ?? [];
	if (subcommands.length > 0) {
		const { verb, rest } = parseSubcommand(parsed.args);
		if (!rest && subcommands.some(subcommand => subcommand.name === verb)) return undefined;
		return `Unknown subcommand: ${verb}. Usage: /${builtin.name} [${subcommands.map(sub => sub.name).join("|")}]`;
	}
	if (builtin.allowArgs) return undefined;
	return `Usage: /${builtin.name} takes no arguments (got "${parsed.args}")`;
}

/** Appended to every refusal so the escape is discoverable where it is hit. */
export const SLASH_ESCAPE_HINT = " (add a leading space to send it as a message)";
