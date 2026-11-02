// @ts-nocheck
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { request } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Adapter } from "../../src/acp/adapter";
import type { AcpClient } from "../../src/acp/client";
import { conversationDbPath } from "../../src/conversation/database";
import { StepPayload } from "../../src/gen/steps";
import { newSession } from "../../src/types/session";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
	predicate: () => boolean,
	timeout = 5000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error("timed out");
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function createConversation(dir: string, id: string): void {
	const sqlite = new Database(conversationDbPath(dir, id));
	sqlite
		.query(
			"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
		)
		.run();
	sqlite.close();
}

function appendUser(dir: string, id: string, idx: number, text: string): void {
	const payload = StepPayload.encode(
		StepPayload.create({ userPrompt: { text } }),
	).finish();
	const sqlite = new Database(conversationDbPath(dir, id));
	sqlite
		.query(
			"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
		)
		.run(idx, 14, 3, payload);
	sqlite.close();
}

function claimRawBody(
	socketPath: string,
	body: string,
	owner: string,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath,
				path: "/claim?event=pre",
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body).toString(),
					"x-agy-acp-owner": owner,
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: data }),
				);
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

function claimRaw(
	socketPath: string,
	conversationId: string,
	initialNumSteps: number,
	owner: string,
): Promise<{ status: number; body: string }> {
	return claimRawBody(
		socketPath,
		JSON.stringify({ conversationId, initialNumSteps }),
		owner,
	);
}

async function claim(
	socketPath: string,
	conversationId: string,
	initialNumSteps: number,
	owner: string,
): Promise<any> {
	const result = await claimRaw(
		socketPath,
		conversationId,
		initialNumSteps,
		owner,
	);
	if (result.status !== 200) throw new Error(`claim failed: ${result.status}`);
	return JSON.parse(result.body);
}

function fakeAgy() {
	const calls: Array<{ args: string[]; opts: any; child: any }> = [];
	spyOn(Bun, "spawn").mockImplementation(((args: string[], opts: any) => {
		let exit: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			exit = resolve;
		});
		const child: any = {
			stderr: null,
			exited,
			kill: () => exit(130),
			finish: (code = 0) => exit(code),
		};
		calls.push({ args, opts, child });
		return child;
	}) as any);
	return calls;
}

function clientFor(updates: any[]): AcpClient {
	return {
		update: async (_sessionId: string, update: any) => {
			updates.push(update);
		},
	} as unknown as AcpClient;
}

function tempSetup(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-steer-test-"));
	dirs.push(dir);
	return dir;
}

let dirs: string[] = [];

afterEach(() => {
	mock.restore();
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

describe("Adapter mid-turn steering", () => {
	test("does not spawn a second agy and resolves only after the SQLite user row", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const session = newSession(dir);
		session.conversationId = "c1";
		const firstUpdates: any[] = [];
		const steerUpdates: any[] = [];
		const first = adapter.runPrompt(
			"s1",
			session,
			"FIRST",
			clientFor(firstUpdates),
		);
		await waitFor(() => calls.length === 1);
		const socketPath = calls[0]!.opts.env.AGY_ACP_STEER_IPC as string;
		const owner = calls[0]!.opts.env.AGY_ACP_STEER_OWNER as string;
		const steer = adapter.runPrompt(
			"s1",
			session,
			"STEER_ONE",
			clientFor(steerUpdates),
		);
		const stale = await claimRaw(socketPath, "c1", 1, "stale-owner");
		expect(stale.status).toBe(409);
		const claimed = await claim(socketPath, "c1", 1, owner);
		expect(claimed.messages).toHaveLength(1);
		const duplicateClaim = await claim(socketPath, "c1", 1, owner);
		expect(duplicateClaim.messages).toHaveLength(0);
		appendUser(dir, "c1", 1, "STEER_ONE");
		const steerOutcome = await steer;
		expect(steerOutcome.steered).toBe(true);
		expect(steerOutcome.error).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(
			steerUpdates.some(
				(update) =>
					update.sessionUpdate === "user_message_chunk" &&
					update.messageId === "1",
			),
		).toBe(true);
		expect(firstUpdates).toHaveLength(0);
		let firstDone = false;
		void first.then(() => {
			firstDone = true;
		});
		await sleep(250);
		expect(firstDone).toBe(false);
		calls[0]!.child.finish();
		const firstOutcome = await first;
		expect(firstOutcome.stopReason).toBe("end_turn");
	});

	test("injects every queued steer from one claim in FIFO order", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const session = newSession(dir);
		session.conversationId = "c1";
		const first = adapter.runPrompt("s1", session, "FIRST", clientFor([]));
		await waitFor(() => calls.length === 1);
		const socketPath = calls[0]!.opts.env.AGY_ACP_STEER_IPC as string;
		const owner = calls[0]!.opts.env.AGY_ACP_STEER_OWNER as string;
		const firstUpdates: any[] = [];
		const secondUpdates: any[] = [];
		const firstSteer = adapter.runPrompt(
			"s1",
			session,
			"STEER_ONE",
			clientFor(firstUpdates),
		);
		const secondSteer = adapter.runPrompt(
			"s1",
			session,
			"STEER_TWO",
			clientFor(secondUpdates),
		);
		const claimed = await claim(socketPath, "c1", 1, owner);
		expect(claimed.messages.map((message: any) => message.text)).toEqual([
			"STEER_ONE",
			"STEER_TWO",
		]);
		appendUser(dir, "c1", 1, "STEER_ONE");
		appendUser(dir, "c1", 2, "STEER_TWO");
		const outcomes = await Promise.all([firstSteer, secondSteer]);
		expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(firstUpdates[0]?.messageId).toBe("1");
		expect(secondUpdates[0]?.messageId).toBe("2");
		calls[0]!.child.finish();
		await first;
	});

	test("keeps concurrent session queues isolated", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		createConversation(dir, "c2");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const sessionOne = newSession(dir);
		sessionOne.conversationId = "c1";
		const sessionTwo = newSession(dir);
		sessionTwo.conversationId = "c2";
		const firstOne = adapter.runPrompt(
			"s1",
			sessionOne,
			"FIRST_ONE",
			clientFor([]),
		);
		const firstTwo = adapter.runPrompt(
			"s2",
			sessionTwo,
			"FIRST_TWO",
			clientFor([]),
		);
		await waitFor(() => calls.length === 2);
		const callOne = calls.find((call) => call.args.includes("FIRST_ONE"))!;
		const callTwo = calls.find((call) => call.args.includes("FIRST_TWO"))!;
		const socketOne = callOne.opts.env.AGY_ACP_STEER_IPC as string;
		const socketTwo = callTwo.opts.env.AGY_ACP_STEER_IPC as string;
		const ownerOne = callOne.opts.env.AGY_ACP_STEER_OWNER as string;
		const ownerTwo = callTwo.opts.env.AGY_ACP_STEER_OWNER as string;
		const updatesOne: any[] = [];
		const updatesTwo: any[] = [];
		const steerOne = adapter.runPrompt(
			"s1",
			sessionOne,
			"STEER_ONE",
			clientFor(updatesOne),
		);
		const steerTwo = adapter.runPrompt(
			"s2",
			sessionTwo,
			"STEER_TWO",
			clientFor(updatesTwo),
		);
		await claim(socketOne, "c1", 1, ownerOne);
		await claim(socketTwo, "c2", 1, ownerTwo);
		appendUser(dir, "c1", 1, "STEER_ONE");
		appendUser(dir, "c2", 1, "STEER_TWO");
		await Promise.all([steerOne, steerTwo]);
		expect(updatesOne[0]?.content?.text).toBe("STEER_ONE");
		expect(updatesTwo[0]?.content?.text).toBe("STEER_TWO");
		for (const call of calls) call.child.finish();
		await Promise.all([firstOne, firstTwo]);
	});

	test("rejects a steer and keeps the active run when no hook is available", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		const session = newSession(dir);
		session.conversationId = "c1";
		const first = adapter.runPrompt("s1", session, "FIRST", clientFor([]));
		await waitFor(() => calls.length === 1);
		expect(adapter.hasActiveRun("s1")).toBe(true);
		const outcomePromise = adapter.runPrompt(
			"s1",
			session,
			"STEER_ONE",
			clientFor([]),
		);
		await sleep(250);
		expect(calls).toHaveLength(1);
		const outcome = await outcomePromise;
		expect(outcome.steered).toBe(true);
		expect(outcome.error).toContain("not accepting");
		for (const call of calls) call.child.finish();
		await first;
		expect(adapter.hasActiveRun("s1")).toBe(false);
	});

	test("cancels pending steers and allows a fresh run after the child exits", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const session = newSession(dir);
		session.conversationId = "c1";
		const first = adapter.runPrompt("s1", session, "FIRST", clientFor([]));
		await waitFor(() => calls.length === 1);
		const steer = adapter.runPrompt("s1", session, "STEER_ONE", clientFor([]));
		adapter.cancel("s1");
		const steerOutcome = await steer;
		expect(steerOutcome.error).toContain("cancelled");
		const firstOutcome = await first;
		expect(firstOutcome.stopReason).toBe("cancelled");
		expect(adapter.hasActiveRun("s1")).toBe(false);
		const fresh = adapter.runPrompt("s1", session, "FRESH", clientFor([]));
		await waitFor(() => calls.length === 2);
		calls[1]!.child.finish();
		await fresh;
	});

	test("fails claimed steers when the child exits without a matching row", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const session = newSession(dir);
		session.conversationId = "c1";
		const first = adapter.runPrompt("s1", session, "FIRST", clientFor([]));
		await waitFor(() => calls.length === 1);
		const owner = calls[0]!.opts.env.AGY_ACP_STEER_OWNER as string;
		const socketPath = calls[0]!.opts.env.AGY_ACP_STEER_IPC as string;
		const steer = adapter.runPrompt("s1", session, "STEER_ONE", clientFor([]));
		await claim(socketPath, "c1", 1, owner);
		calls[0]!.child.finish();
		const steerOutcome = await steer;
		expect(steerOutcome.error).toContain("turn ended");
		const firstOutcome = await first;
		expect(firstOutcome.stopReason).toBe("end_turn");
		expect(adapter.hasActiveRun("s1")).toBe(false);
	});

	test("rejects malformed or mismatched IPC payloads without claiming", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const session = newSession(dir);
		session.conversationId = "c1";
		const first = adapter.runPrompt("s1", session, "FIRST", clientFor([]));
		await waitFor(() => calls.length === 1);
		const socketPath = calls[0]!.opts.env.AGY_ACP_STEER_IPC as string;
		const owner = calls[0]!.opts.env.AGY_ACP_STEER_OWNER as string;
		const steer = adapter.runPrompt("s1", session, "STEER_ONE", clientFor([]));
		await sleep(20);
		const nullPayload = await claimRawBody(socketPath, "null", owner);
		expect(nullPayload.status).toBe(400);
		const missingConversation = await claimRawBody(
			socketPath,
			JSON.stringify({ initialNumSteps: 1 }),
			owner,
		);
		expect(missingConversation.status).toBe(400);
		const badInitial = await claimRawBody(
			socketPath,
			JSON.stringify({ conversationId: "c1", initialNumSteps: "1" }),
			owner,
		);
		expect(badInitial.status).toBe(400);
		const mismatch = await claimRawBody(
			socketPath,
			JSON.stringify({ conversationId: "c2", initialNumSteps: 1 }),
			owner,
		);
		expect(mismatch.status).toBe(409);
		const claimed = await claim(socketPath, "c1", 1, owner);
		expect(claimed.messages).toHaveLength(1);
		appendUser(dir, "c1", 1, "STEER_ONE");
		const outcome = await steer;
		expect(outcome.error).toBeUndefined();
		calls[0]!.child.finish();
		await first;
	});

	test("binds each fresh run to its hook conversation without cross-confirmation", async () => {
		const dir = tempSetup();
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const sessionOne = newSession(dir);
		const sessionTwo = newSession(dir);
		const firstOne = adapter.runPrompt(
			"s1",
			sessionOne,
			"FIRST_ONE",
			clientFor([]),
		);
		const firstTwo = adapter.runPrompt(
			"s2",
			sessionTwo,
			"FIRST_TWO",
			clientFor([]),
		);
		await waitFor(() => calls.length === 2);
		createConversation(dir, "c1");
		await sleep(350);
		createConversation(dir, "c2");
		const callOne = calls.find((call) => call.args.includes("FIRST_ONE"))!;
		const callTwo = calls.find((call) => call.args.includes("FIRST_TWO"))!;
		const updatesOne: any[] = [];
		const updatesTwo: any[] = [];
		const steerOne = adapter.runPrompt(
			"s1",
			sessionOne,
			"SAME_TEXT",
			clientFor(updatesOne),
		);
		const steerTwo = adapter.runPrompt(
			"s2",
			sessionTwo,
			"SAME_TEXT",
			clientFor(updatesTwo),
		);
		const claimedOne = await claim(
			callOne.opts.env.AGY_ACP_STEER_IPC as string,
			"c1",
			1,
			callOne.opts.env.AGY_ACP_STEER_OWNER as string,
		);
		const claimedTwo = await claim(
			callTwo.opts.env.AGY_ACP_STEER_IPC as string,
			"c2",
			1,
			callTwo.opts.env.AGY_ACP_STEER_OWNER as string,
		);
		expect(claimedOne.messages).toHaveLength(1);
		expect(claimedTwo.messages).toHaveLength(1);
		let secondSettled = false;
		void steerTwo.then(
			() => {
				secondSettled = true;
			},
			() => {
				secondSettled = true;
			},
		);
		let firstOutcome: any;
		let secondOutcome: any;
		try {
			appendUser(dir, "c1", 1, "SAME_TEXT");
			const outcomeOne = await within(steerOne, 1200, "first steer");
			expect(outcomeOne.error).toBeUndefined();
			expect(updatesOne[0]?.content?.text).toBe("SAME_TEXT");
			expect(updatesOne[0]?.messageId).toBe("1");
			await sleep(300);
			expect(updatesTwo).toHaveLength(0);
			expect(secondSettled).toBe(false);
			appendUser(dir, "c2", 1, "SAME_TEXT");
			const outcomeTwo = await within(steerTwo, 1200, "second steer");
			expect(outcomeTwo.error).toBeUndefined();
			expect(updatesTwo[0]?.content?.text).toBe("SAME_TEXT");
			expect(updatesTwo[0]?.messageId).toBe("1");
			callOne.child.finish();
			callTwo.child.finish();
			firstOutcome = await firstOne;
			secondOutcome = await firstTwo;
			expect(firstOutcome.conversationId).toBe("c1");
			expect(secondOutcome.conversationId).toBe("c2");
		} finally {
			callOne.child.finish();
			callTwo.child.finish();
			await Promise.allSettled([firstOne, firstTwo, steerOne, steerTwo]);
		}
	});

	test("matches and echoes literal XML and resource text without display parsing", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const session = newSession(dir);
		session.conversationId = "c1";
		const first = adapter.runPrompt("s1", session, "FIRST", clientFor([]));
		await waitFor(() => calls.length === 1);
		const socketPath = calls[0]!.opts.env.AGY_ACP_STEER_IPC as string;
		const owner = calls[0]!.opts.env.AGY_ACP_STEER_OWNER as string;
		const literal =
			'<user_text>\nliteral <resource_link uri="file:///tmp/a" title="A"/>\n</user_text>';
		const plain = "PLAIN_AFTER_LITERAL";
		const literalUpdates: any[] = [];
		const plainUpdates: any[] = [];
		const literalSteer = adapter.runPrompt(
			"s1",
			session,
			literal,
			clientFor(literalUpdates),
		);
		const plainSteer = adapter.runPrompt(
			"s1",
			session,
			plain,
			clientFor(plainUpdates),
		);
		const claimed = await claim(socketPath, "c1", 1, owner);
		expect(claimed.messages.map((message: any) => message.text)).toEqual([
			literal,
			plain,
		]);
		try {
			appendUser(dir, "c1", 1, literal);
			appendUser(dir, "c1", 2, plain);
			const outcomes = await within(
				Promise.all([literalSteer, plainSteer]),
				1500,
				"literal steer",
			);
			expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(
				true,
			);
			expect(literalUpdates[0]).toMatchObject({
				sessionUpdate: "user_message_chunk",
				content: { type: "text", text: literal },
				messageId: "1",
			});
			expect(plainUpdates[0]).toMatchObject({
				sessionUpdate: "user_message_chunk",
				content: { type: "text", text: plain },
				messageId: "2",
			});
		} finally {
			calls[0]!.child.finish();
			await Promise.allSettled([literalSteer, plainSteer]);
			await first;
		}
	});

	test("does not bind a fresh run from invalid or mismatched IPC payloads", async () => {
		const dir = tempSetup();
		createConversation(dir, "c1");
		const calls = fakeAgy();
		const adapter = new Adapter({
			workingDir: dir,
			binary: "agy",
			conversationsDir: dir,
			skipNarration: false,
		});
		adapter.setSteerAvailable(true);
		const session = newSession(dir);
		const first = adapter.runPrompt("s1", session, "FIRST", clientFor([]));
		await waitFor(() => calls.length === 1);
		const socketPath = calls[0]!.opts.env.AGY_ACP_STEER_IPC as string;
		const owner = calls[0]!.opts.env.AGY_ACP_STEER_OWNER as string;
		const updatesOne: any[] = [];
		const firstSteer = adapter.runPrompt(
			"s1",
			session,
			"STEER_ONE",
			clientFor(updatesOne),
		);
		const invalid = await claimRawBody(
			socketPath,
			JSON.stringify({ conversationId: "c2", initialNumSteps: "bad" }),
			owner,
		);
		expect(invalid.status).toBe(400);
		const claimed = await claim(socketPath, "c1", 1, owner);
		expect(claimed.messages).toHaveLength(1);
		appendUser(dir, "c1", 1, "STEER_ONE");
		const firstOutcome = await firstSteer;
		expect(firstOutcome.error).toBeUndefined();
		expect(updatesOne[0]?.content?.text).toBe("STEER_ONE");
		const secondSteer = adapter.runPrompt(
			"s1",
			session,
			"STEER_TWO",
			clientFor([]),
		);
		await sleep(20);
		const mismatch = await claimRaw(socketPath, "c2", 1, owner);
		expect(mismatch.status).toBe(409);
		const claimedAgain = await claim(socketPath, "c1", 1, owner);
		expect(claimedAgain.messages).toHaveLength(1);
		appendUser(dir, "c1", 2, "STEER_TWO");
		const secondOutcome = await secondSteer;
		expect(secondOutcome.error).toBeUndefined();
		calls[0]!.child.finish();
		await first;
	});
});
