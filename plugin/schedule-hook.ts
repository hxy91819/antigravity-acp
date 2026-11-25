await Bun.stdin.text();

const decision =
	process.env.AGY_ACP_USE_BB_AUTOMATIONS === "1"
		? {
				decision: "deny",
				reason:
					"Use BB agent automation targeting the current thread for scheduled follow-ups.",
			}
		: {};

process.stdout.write(`${JSON.stringify(decision)}\n`);

export {};
