import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StepRow } from "../types";
import type { AcpClient } from "./client";

export interface SteerEntry {
	id: string;
	text: string;
	client: AcpClient;
	initialNumSteps: number | null;
	resolve: () => void;
	reject: (error: Error) => void;
}

export interface SteerMatch {
	entry: SteerEntry;
	text: string;
}

function rawUserPromptText(row: StepRow): string | null {
	const prompt = row.stepPayload.userPrompt;
	if (!prompt) return null;
	const text = prompt.text || prompt.content?.text;
	return typeof text === "string" ? text : null;
}

export class SteerQueue {
	private pending: SteerEntry[] = [];
	private claimed: SteerEntry[] = [];
	private closed = false;

	enqueue(text: string, client: AcpClient): Promise<void> {
		if (this.closed) {
			return Promise.reject(new Error("agy steer queue is closed"));
		}
		return new Promise<void>((resolve, reject) => {
			this.pending.push({
				id: randomUUID(),
				text,
				client,
				initialNumSteps: null,
				resolve,
				reject,
			});
		});
	}

	claim(initialNumSteps: number): SteerEntry[] {
		if (this.closed) return [];
		const batch = this.pending.splice(0);
		for (const entry of batch) {
			entry.initialNumSteps = initialNumSteps;
			this.claimed.push(entry);
		}
		return batch;
	}

	take(row: StepRow): SteerMatch | null {
		const text = rawUserPromptText(row);
		if (text === null) return null;
		const entry = this.claimed[0];
		if (!entry) return null;
		const floor = Math.max(entry.initialNumSteps ?? 0, 1);
		if (row.idx < floor) return null;
		if (text !== entry.text) return null;
		this.claimed.shift();
		return { entry, text };
	}

	failAll(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		const entries = [...this.pending, ...this.claimed];
		this.pending = [];
		this.claimed = [];
		for (const entry of entries) entry.reject(error);
	}
}

export class SteerIpc {
	readonly socketPath: string;
	private readonly server: ReturnType<typeof Bun.serve>;
	private closed = false;

	constructor(
		private readonly owner: string,
		private readonly queue: SteerQueue,
		private readonly onConversation: (id: string) => boolean,
	) {
		this.socketPath = path.join(
			os.tmpdir(),
			`agy-acp-steer-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
		fs.rmSync(this.socketPath, { force: true });
		this.server = Bun.serve({
			unix: this.socketPath,
			fetch: async (request) => {
				const url = new URL(request.url);
				if (request.method !== "POST" || url.pathname !== "/claim") {
					return new Response("not found", { status: 404 });
				}
				if (request.headers.get("x-agy-acp-owner") !== this.owner) {
					return new Response("stale owner", { status: 409 });
				}
				let parsed: unknown;
				try {
					parsed = await request.json();
				} catch {
					return new Response("invalid payload", { status: 400 });
				}
				if (
					parsed === null ||
					typeof parsed !== "object" ||
					Array.isArray(parsed)
				) {
					return new Response("invalid payload", { status: 400 });
				}
				const payload = parsed as {
					conversationId?: unknown;
					initialNumSteps?: unknown;
				};
				if (
					typeof payload.conversationId !== "string" ||
					payload.conversationId.trim().length === 0
				) {
					return new Response("invalid conversation id", { status: 400 });
				}
				if (
					typeof payload.initialNumSteps !== "number" ||
					!Number.isInteger(payload.initialNumSteps) ||
					payload.initialNumSteps < 0
				) {
					return new Response("invalid initial step", { status: 400 });
				}
				let bound = false;
				try {
					bound = this.onConversation(payload.conversationId);
				} catch {
					bound = false;
				}
				if (!bound) {
					return new Response("conversation mismatch", { status: 409 });
				}
				const messages = this.queue
					.claim(payload.initialNumSteps)
					.map((entry) => ({ id: entry.id, text: entry.text }));
				return Response.json({ owner: this.owner, messages });
			},
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.server.stop(true);
		fs.rmSync(this.socketPath, { force: true });
	}
}
