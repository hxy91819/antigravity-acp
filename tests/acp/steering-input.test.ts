// @ts-nocheck
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { Adapter } from "../../src/acp/adapter";
import { AgyAcpAgent } from "../../src/acp/agent";
import { SessionManager } from "../../src/acp/sessions";

describe("mid-turn prompt validation", () => {
	let agent: AgyAcpAgent;
	let client: any;
	let runPrompt: any;

	beforeEach(() => {
		client = { update: mock(async () => {}) };
		spyOn(SessionManager.prototype, "ensure").mockResolvedValue({
			cwd: process.cwd(),
			conversationId: "c1",
			lastStepIdx: 1,
		} as any);
		spyOn(Adapter.prototype, "hasActiveRun").mockReturnValue(true);
		runPrompt = spyOn(Adapter.prototype, "runPrompt").mockResolvedValue({
			stopReason: "end_turn",
			conversationId: "c1",
			lastStepIdx: 1,
			hadUpdates: true,
		});
		agent = new AgyAcpAgent({
			workingDir: process.cwd(),
			skipNarration: false,
		} as any);
	});

	afterEach(() => {
		mock.restore();
	});

	test("rejects non-text input during an active run", async () => {
		await expect(
			agent.prompt(
				{
					sessionId: "s1",
					prompt: [
						{
							type: "resource_link",
							uri: "https://example.com",
							title: "Example",
						},
					],
				} as any,
				client,
			),
		).rejects.toThrow("plain text only");
		expect(runPrompt).not.toHaveBeenCalled();
	});

	test("rejects slash commands during an active run", async () => {
		await expect(
			agent.prompt(
				{
					sessionId: "s1",
					prompt: [{ type: "text", text: "/usage" }],
				} as any,
				client,
			),
		).rejects.toThrow("slash commands");
		expect(runPrompt).not.toHaveBeenCalled();
	});
});
