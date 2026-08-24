import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils/dirs";

const originalProjectDir = getProjectDir();

afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
});

describe("project directory state", () => {
	it("keeps the previous directory when chdir fails", () => {
		const chdir = spyOn(process, "chdir").mockImplementation(() => {
			throw new Error("operation not permitted");
		});

		expect(() => setProjectDir("/blocked/project")).toThrow("operation not permitted");
		expect(getProjectDir()).toBe(originalProjectDir);
		chdir.mockRestore();
	});
});
