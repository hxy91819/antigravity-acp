// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgyAcpAgent } from "../../src/acp/agent";

let dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function fakeAgy(pluginList: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-capability-test-"));
	dirs.push(dir);
	const binary = path.join(dir, "agy");
	fs.writeFileSync(
		binary,
		`#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '${pluginList}'
  exit 0
fi
if [ "$1" = "models" ]; then
  printf 'model-one Model One\\n'
  exit 0
fi
exit 0
`,
		{ mode: 0o755 },
	);
	return binary;
}

function agentFor(binary: string, dir: string) {
	return new AgyAcpAgent({
		binary,
		conversationsDir: dir,
		workingDir: dir,
		skipNarration: false,
		version: "test",
	});
}

describe("steering capability negotiation", () => {
	test("advertises native steering only when the installed plugin is enabled", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-capability-cwd-"));
		dirs.push(dir);
		const binary = fakeAgy(
			'[{"name":"agy-acp-steer","enabled":true,"hooks":["agy-acp-steer"]}]',
		);
		const result = await agentFor(binary, dir).initialize();
		expect((result as any)._meta?.midTurnSteering).toBe(true);
	});

	test("does not advertise native steering when the plugin is disabled or absent", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-capability-cwd-"));
		dirs.push(dir);
		const binary = fakeAgy(
			'[{"name":"agy-acp-steer","enabled":false,"hooks":["agy-acp-steer"]}]',
		);
		const result = await agentFor(binary, dir).initialize();
		expect((result as any)._meta?.midTurnSteering).not.toBe(true);
	});
});
