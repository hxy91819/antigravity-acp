import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(
	new URL("../../plugin/schedule-hook.ts", import.meta.url),
);

test.each([
	{ bbAutomations: "1", expectedDecision: "deny" },
	{ bbAutomations: "", expectedDecision: undefined },
])("redirects native scheduling according to the launcher setting", ({
	bbAutomations,
	expectedDecision,
}) => {
	const result = Bun.spawnSync([process.execPath, hook], {
		env: { ...process.env, AGY_ACP_USE_BB_AUTOMATIONS: bbAutomations },
	});
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString()).decision).toBe(expectedDecision);
});
