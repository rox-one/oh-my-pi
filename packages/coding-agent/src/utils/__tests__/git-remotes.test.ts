import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GitRepository, repo } from "../git";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function repositoryWithConfig(config: string): GitRepository {
	const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-git-remotes-"));
	tempDirs.push(commonDir);
	fs.writeFileSync(path.join(commonDir, "config"), config);
	return {
		commonDir,
		gitDir: commonDir,
		gitEntryPath: path.join(commonDir, ".git"),
		headPath: path.join(commonDir, "HEAD"),
		repoRoot: commonDir,
	};
}

describe("repo.getRemotesSync", () => {
	it("unquotes Git config remote URL values", () => {
		const git = repositoryWithConfig(`
[remote "origin"]
	url = "https://github.com/owner/repo.git"
`);

		expect(repo.getRemotesSync(git)).toEqual([{ name: "origin", fetchUrl: "https://github.com/owner/repo.git" }]);
	});
});
