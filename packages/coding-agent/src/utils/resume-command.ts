import * as path from "node:path";
import { APP_NAME, getActiveProfile, procmgr } from "@oh-my-pi/pi-utils";
import { isManagedSessionFile } from "../session/session-paths";

/**
 * Build the shell command that resumes a session by id.
 *
 * Sessions launched under a named profile are stored in that profile's agent
 * directory (`~/.omp/profiles/<name>/agent`), so a bare `omp --resume <id>`
 * run without the profile looks in the default directory and fails with
 * `Session "<id>" not found`. When a profile is active, prefix `--profile
 * <name>` so the emitted hint is a command the user can paste verbatim
 * (issue #9018). Profile names are validated against a strict charset
 * (`normalizeProfileName`), so no shell quoting is required.
 */
export function resumeCommand(sessionId: string): string {
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	return `${APP_NAME} ${profileFlag}--resume ${sessionId}`;
}

/**
 * Build the resume command a shutdown/recovery banner advertises for the active
 * session. A managed session resolves by id, so the compact `--resume <id>`
 * form is emitted. A path-resumed foreign session (e.g. a pi transcript opened
 * by explicit path) is invisible to id lookup — {@link isManagedSessionFile}
 * is false — so the hint carries the explicit file path, which the path branch
 * of `--resume` opens directly. Without this the banner hands the user an
 * unresolvable key (issue #9544).
 */
export function resumeCommandForSession(sessionId: string, sessionFile: string): string {
	if (isManagedSessionFile(sessionFile)) return resumeCommand(sessionId);
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	// Foreign session paths are pasted into the user's host shell: leave a
	// shell-safe path bare, otherwise quote it per the host shell's rules.
	const resolved = path.resolve(sessionFile);
	const target = /^[\w@%+=:,./-]+$/.test(resolved) ? resolved : procmgr.quoteHostShellArg(resolved);
	return `${APP_NAME} ${profileFlag}--resume ${target}`;
}
