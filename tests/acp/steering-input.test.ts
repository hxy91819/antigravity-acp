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

	test.each([
		{
			type: "image",
			data: "iVBORw0KGgo=",
			mimeType: "image/png",
		},
		{
			type: "resource_link",
			uri: "file:///example.txt",
			name: "Example",
		},
		{ type: "text", text: "/usage" },
	])("requests interrupt delivery for an unsupported active prompt", async (block) => {
		await expect(
			agent.prompt({ sessionId: "s1", prompt: [block] }, client),
		).rejects.toMatchObject({
			code: -32602,
			message: expect.stringMatching(/already in flight/i),
		});
		expect(runPrompt).not.toHaveBeenCalled();
	});
});
