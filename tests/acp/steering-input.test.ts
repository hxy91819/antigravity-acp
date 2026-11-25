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
import { readFileSync, statSync, unlinkSync } from "node:fs";
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
			hadUpdates: true,
			steered: true,
		});
		agent = new AgyAcpAgent({
			workingDir: process.cwd(),
			skipNarration: false,
		} as any);
	});

	afterEach(() => {
		mock.restore();
	});

	test("keeps the full input and saves the attached image privately for the active run", async () => {
		const image = "iVBORw0KGgo=";
		await expect(
			agent.prompt(
				{
					sessionId: "s1",
					prompt: [
						{ type: "text", text: "Read the image and the reference." },
						{ type: "image", data: image, mimeType: "image/png" },
						{
							type: "resource_link",
							uri: "file:///example.txt",
							name: "Example",
						},
						{
							type: "resource",
							resource: { uri: "file:///notes.txt", text: "Keep these notes." },
						},
					],
				},
				client,
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const text = runPrompt.mock.calls[0]?.[2];
		const imagePath = /Absolute path: (.+?)\. You must use your view_file/.exec(
			text,
		)?.[1];
		expect(imagePath).toBeDefined();
		try {
			expect(readFileSync(imagePath).toString("base64")).toBe(image);
			if (process.platform !== "win32")
				expect(statSync(imagePath).mode & 0o777).toBe(0o600);
			expect(text).toContain("Read the image and the reference.");
			expect(text).toContain("file:///example.txt");
			expect(text).toContain("Keep these notes.");
		} finally {
			unlinkSync(imagePath);
		}
	});

	test.each([
		{ type: "audio", data: "AA==" },
		{ type: "resource", resource: { uri: "file:///binary", blob: "AA==" } },
		{ type: "text", text: "/usage" },
	])("rejects an active prompt requiring separate delivery", async (block) => {
		await expect(
			agent.prompt({ sessionId: "s1", prompt: [block] }, client),
		).rejects.toMatchObject({
			code: -32602,
			message: expect.stringMatching(/already in flight/i),
		});
		expect(runPrompt).not.toHaveBeenCalled();
	});
});
