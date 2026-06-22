import type { Context, ImageContent, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import { providerImageBudget } from "@oh-my-pi/snapcompact";

const IMAGE_LIMIT_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

type ImageBearingMessage = Extract<Message, { content: string | (TextContent | ImageContent)[] }>;

function countImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

function clampImageBearingMessage(
	message: ImageBearingMessage,
	state: { remainingDrops: number },
): ImageBearingMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;

	let changed = false;
	const content: (TextContent | ImageContent)[] = [];
	for (const part of message.content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			content.push(IMAGE_LIMIT_OMISSION);
			continue;
		}
		content.push(part);
	}
	return changed ? { ...message, content } : message;
}

/** Drops oldest transient image blocks so the outgoing request fits the active provider's image cap. */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const limit = providerImageBudget(model.provider);
	const totalImages = countImages(context);
	if (totalImages <= limit) return context;

	const state = { remainingDrops: totalImages - limit };
	const messages = context.messages.map(message => {
		if (message.role === "user" || message.role === "developer" || message.role === "toolResult") {
			return clampImageBearingMessage(message, state);
		}
		return message;
	});
	return { ...context, messages };
}
