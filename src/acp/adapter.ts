import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
	buildAgyArgs,
	extraArgsFromEnv,
	preparePromptArg,
	spawnAgy,
} from "../agy/process";
import { POLL_INTERVAL_MS } from "../constants";
import type { ErrorDetails } from "../conversation/columns";
import { conversationSnapshot } from "../conversation/scan";
import { StreamPoller } from "../conversation/streaming";
import type { StepRow } from "../types";
import type { Session } from "../types/session";
import type { AcpClient } from "./client";
import { SteerIpc, SteerQueue } from "./steering";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** agy retries per-minute 429 rate limits itself, so only a longer wait is a
 *  usage limit worth stopping for. */
const QUOTA_STOP_MS = 60_000;

/** Milliseconds until the quota resets, from "Resets in 1d2h3m4s", or null. */
export function resetDelayMs(text: string): number | null {
	const r = text.match(
		/Resets in (?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\.?\s*$/,
	);
	if (!r?.slice(1).some(Boolean)) return null;
	const [d = 0, h = 0, m = 0, s = 0] = r.slice(1).map((n) => Number(n ?? 0));
	return (((d * 24 + h) * 60 + m) * 60 + s) * 1000;
}

/** Format agy's 429 text like the Antigravity IDE: the message, its Error ID,
 *  and the clock time the quota refreshes. */
export function formatQuotaError(e: ErrorDetails, now = Date.now()): string {
	const text = e.message || e.detail;
	// "API error (attempt 1): RESOURCE_EXHAUSTED (code 429): <message> Resets in 7m11s."
	let message = text.replace(/^.*\(code 429\):\s*/, "");
	const delay = resetDelayMs(text);
	let refresh = "";
	if (delay !== null) {
		const at = new Date(now + delay).toLocaleString("en-US");
		message = message.replace(/\s*Resets in .*$/, "");
		refresh = `Your plan's baseline quota will refresh on ${at}.`;
	}
	return [message, e.id && `Error ID: ${e.id}`, refresh]
		.filter(Boolean)
		.join("\n\n");
}

export interface PromptOutcome {
	stopReason: "end_turn" | "cancelled";
	conversationId: string | null;
	lastStepIdx: number;
	hadUpdates: boolean;
	/** Set when agy failed to start, hit a usage limit, or exited non-zero with nothing streamed. */
	error?: string;
	steered?: boolean;
}

export interface AdapterConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	skipNarration: boolean;
}

interface ActiveRun {
	sessionId: string;
	owner: string;
	queue: SteerQueue;
	ipc: SteerIpc | null;
	accepting: boolean;
	closed: boolean;
	cancelled: boolean;
	hookBinding: boolean;
	conversationId: string | null;
	lastStepIdx: number;
	seenUserPromptIdxs: Set<number>;
}

export class Adapter {
	private readonly children = new Map<string, Bun.Subprocess>();
	private readonly cancelled = new Set<string>();
	private readonly active = new Map<string, ActiveRun>();
	private steerAvailable = false;

	constructor(private readonly config: AdapterConfig) {}

	setSteerAvailable(available: boolean): void {
		this.steerAvailable = available;
	}

	hasActiveRun(sessionId: string): boolean {
		const run = this.active.get(sessionId);
		return run !== undefined && !run.closed;
	}

	/** Request cancellation of an in-flight prompt for a session. */
	cancel(sessionId: string): void {
		this.cancelled.add(sessionId);
		const run = this.active.get(sessionId);
		if (run) {
			run.cancelled = true;
			run.accepting = false;
			run.queue.failAll(new Error("agy steer cancelled"));
			run.ipc?.close();
			run.ipc = null;
		}
		const child = this.children.get(sessionId);
		if (child) {
			// SIGINT allows agy to flush its DB before exiting; on Windows we fall
			// back to an ungraceful kill because SIGINT is not a real signal there.
			if (process.platform === "win32") {
				child.kill();
			} else {
				child.kill("SIGINT");
			}
		}
	}

	/** Run a prompt turn end-to-end: spawn agy, stream deltas, finalize. */
	async runPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
		steer?: { text: string; allowed: boolean },
	): Promise<PromptOutcome> {
		const current = this.active.get(sessionId);
		if (current)
			return this.steer(
				current,
				steer?.text ?? promptText,
				client,
				steer?.allowed ?? true,
			);

		this.cancelled.delete(sessionId);

		// Use the session's cwd if set, otherwise fall back to the server's workingDir.
		const effectiveCwd = session.cwd || this.config.workingDir;

		// Snapshot existing conversations so we can bind the new DB agy creates.
		const snapshot =
			session.conversationId === null
				? conversationSnapshot(this.config.conversationsDir)
				: null;
		const { promptArg, tempFilePath } = preparePromptArg(promptText, sessionId);
		const args = buildAgyArgs({
			workingDir: effectiveCwd,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			permissionMode: session.permissionMode,
			sandbox: session.sandbox,
			prompt: promptArg,
			extraArgs: extraArgsFromEnv(),
		});

		const run: ActiveRun = {
			sessionId,
			owner: randomUUID(),
			queue: new SteerQueue(),
			ipc: null,
			accepting: true,
			closed: false,
			cancelled: false,
			hookBinding: false,
			conversationId: session.conversationId,
			lastStepIdx: session.lastStepIdx,
			seenUserPromptIdxs: new Set(),
		};
		this.active.set(sessionId, run);

		let poller: StreamPoller | null = null;
		const bindHookConversation = (id: string): boolean => {
			if (
				(run.conversationId !== null && run.conversationId !== id) ||
				(session.conversationId !== null && session.conversationId !== id)
			) {
				return false;
			}
			if (poller && !poller.bindConversationId(id)) return false;
			run.conversationId = id;
			return true;
		};

		if (this.steerAvailable && process.platform !== "win32") {
			try {
				run.ipc = new SteerIpc(run.owner, run.queue, bindHookConversation);
				run.hookBinding = true;
			} catch (error) {
				run.accepting = false;
				console.error(
					`[agy-acp] steering IPC unavailable: ${(error as Error).message}`,
				);
			}
		} else if (this.steerAvailable) {
			run.accepting = false;
		}

		let child: Bun.Subprocess;
		try {
			child = spawnAgy(
				this.config.binary,
				args,
				effectiveCwd,
				run.ipc
					? {
							AGY_ACP_STEER_IPC: run.ipc.socketPath,
							AGY_ACP_STEER_OWNER: run.owner,
						}
					: undefined,
			);
		} catch (err) {
			run.accepting = false;
			run.closed = true;
			run.queue.failAll(new Error("agy failed to start"));
			run.ipc?.close();
			this.active.delete(sessionId);
			if (tempFilePath) {
				try {
					if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
				} catch {}
			}
			return {
				stopReason: "end_turn",
				conversationId: session.conversationId,
				lastStepIdx: session.lastStepIdx,
				hadUpdates: false,
				error: `failed to run agy: ${(err as Error).message}`,
			};
		}
		this.children.set(sessionId, child);

		try {
			// Drain stderr concurrently (resolves when the process exits).
			const stderrPromise = child.stderr
				? new Response(child.stderr as ReadableStream).text()
				: Promise.resolve("");

			const activePoller = new StreamPoller({
				dir: this.config.conversationsDir,
				conversationId: run.conversationId,
				baseStepIdx: session.lastStepIdx,
				skipNarration: this.config.skipNarration,
				cwd: effectiveCwd,
				snapshot: run.hookBinding ? null : snapshot,
			});
			poller = activePoller;

			// Serialized poll loop: emit updates in order, never overlapping.
			const pollOnce = async () => {
				for (const update of activePoller.poll()) {
					await client.update(sessionId, update);
				}
				if (!run.hookBinding) {
					run.conversationId =
						activePoller.conversationId ?? run.conversationId;
				}
				run.lastStepIdx = activePoller.lastStepIdx;
				for (const row of activePoller.lastRows) {
					await this.confirmSteer(run, row);
				}
				run.lastStepIdx = activePoller.lastStepIdx;
			};

			let polling = true;
			let quotaError: ErrorDetails | null = null;
			const loop = (async () => {
				while (polling) {
					try {
						await pollOnce();
						// agy retries a usage-limit 429 for minutes without exiting; stop it.
						const e = activePoller.quotaError;
						if (
							e &&
							(resetDelayMs(e.message || e.detail) ?? 0) > QUOTA_STOP_MS
						) {
							quotaError = e;
							this.cancel(sessionId);
							break;
						}
					} catch (err) {
						console.error(`[agy-acp] poll error: ${(err as Error).message}`);
					}
					if (!polling) break;
					await sleep(POLL_INTERVAL_MS);
				}
			})();

			const exitCode = await child.exited;
			run.accepting = false;
			polling = false;
			await loop;

			// A few trailing polls to catch rows flushed right around exit.
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					await pollOnce();
				} catch (err) {
					console.error(
						`[agy-acp] final poll error: ${(err as Error).message}`,
					);
				}
				if (attempt < 2) await sleep(100);
			}
			activePoller.close();

			const stderr = (await stderrPromise).trim();
			if (stderr.length > 0) console.error(`[agy-acp] agy stderr: ${stderr}`);

			const wasCancelled = run.cancelled || this.cancelled.delete(sessionId);
			run.queue.failAll(
				new Error(
					wasCancelled
						? "agy steer cancelled"
						: "agy turn ended before steer insertion was confirmed",
				),
			);

			const outcome: PromptOutcome = {
				stopReason: wasCancelled ? "cancelled" : "end_turn",
				conversationId: poller.conversationId,
				lastStepIdx: poller.lastStepIdx,
				hadUpdates: poller.hadUpdates,
			};

			if (quotaError) {
				outcome.error = formatQuotaError(quotaError);
			} else if (!wasCancelled && exitCode !== 0) {
				console.error(`[agy-acp] WARN: agy exited with status ${exitCode}`);
				if (!poller.hadUpdates) {
					outcome.error =
						stderr.length > 0
							? `agy failed: ${stderr}`
							: `agy exited with status: ${exitCode}`;
				}
			}

			return outcome;
		} finally {
			run.accepting = false;
			run.closed = true;
			run.queue.failAll(new Error("agy steer run closed"));
			run.ipc?.close();
			run.ipc = null;
			if (this.children.get(sessionId) === child) {
				this.children.delete(sessionId);
			}
			if (this.active.get(sessionId) === run) {
				this.active.delete(sessionId);
			}
			if (tempFilePath) {
				try {
					if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
				} catch {}
			}
		}
	}

	private async steer(
		run: ActiveRun,
		promptText: string,
		client: AcpClient,
		allowed: boolean,
	): Promise<PromptOutcome> {
		const fail = (error: string): PromptOutcome => ({
			stopReason: "end_turn",
			conversationId: run.conversationId,
			lastStepIdx: run.lastStepIdx,
			hadUpdates: false,
			error,
			steered: true,
		});
		if (!this.steerAvailable || !run.accepting || run.closed) {
			return fail("agy turn is not accepting mid-turn steering");
		}
		if (!allowed) {
			return fail("agy mid-turn steering supports plain text only");
		}
		if (promptText.trim().length === 0) {
			return fail("agy mid-turn steering requires non-empty text");
		}
		try {
			await run.queue.enqueue(promptText, client);
			return {
				stopReason: "end_turn",
				conversationId: run.conversationId,
				lastStepIdx: run.lastStepIdx,
				hadUpdates: true,
				steered: true,
			};
		} catch (error) {
			return fail((error as Error).message);
		}
	}

	private async confirmSteer(run: ActiveRun, row: StepRow): Promise<void> {
		if (row.stepType !== 14) return;
		if (run.seenUserPromptIdxs.has(row.idx)) return;
		const match = run.queue.take(row);
		if (!match) return;
		run.seenUserPromptIdxs.add(row.idx);
		const update: SessionUpdate = {
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: match.text },
			messageId: String(row.idx),
		};
		try {
			await match.entry.client.update(run.sessionId, update);
			match.entry.resolve();
		} catch (error) {
			match.entry.reject(error as Error);
		}
	}
}
