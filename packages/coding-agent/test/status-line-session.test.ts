import { beforeAll, describe, expect, it } from "bun:test";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function renderSessionId(sessionId: string, length?: number): string {
	const ctx = {
		session: { sessionManager: { getSessionId: () => sessionId } },
		options: { session: length === undefined ? undefined : { length } },
	} as unknown as SegmentContext;
	const content = Bun.stripANSI(renderSegment("session", ctx).content);
	return theme.icon.session ? content.slice(theme.icon.session.length + 1) : content;
}

describe("session status-line segment", () => {
	it("distinguishes UUIDv7 sessions created within one 65-second prefix window", () => {
		const first = renderSessionId("01a03242-993e-73f7-9bb9-4be42368e12f");
		const second = renderSessionId("01a03242-e0d8-7074-806e-79104cd3e1d3");

		expect(first).toBe("01a03242-993e");
		expect(second).toBe("01a03242-e0d8");
		expect(first).not.toBe(second);
	});

	it("honors the configured session prefix length", () => {
		expect(renderSessionId("01a03242-993e-73f7-9bb9-4be42368e12f", 16)).toBe("01a03242-993e-73");
	});

	it("clamps non-positive prefix lengths to one character", () => {
		const sessionId = "01a03242-993e-73f7-9bb9-4be42368e12f";

		expect(renderSessionId(sessionId, 0)).toBe("0");
		expect(renderSessionId(sessionId, -1)).toBe("0");
	});
});
