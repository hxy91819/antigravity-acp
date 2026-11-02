import { request } from "node:http";

const event = process.argv[2] === "post" ? "post" : "pre";
const socketPath = process.env.AGY_ACP_STEER_IPC;

function output(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function postClaim(body: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!socketPath) {
			resolve(null);
			return;
		}
		const req = request(
			{
				socketPath,
				path: `/claim?event=${event}`,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body).toString(),
					"x-agy-acp-owner": process.env.AGY_ACP_STEER_OWNER ?? "",
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						reject(new Error("steer IPC rejected"));
						return;
					}
					try {
						resolve(JSON.parse(data));
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.setTimeout(2000, () => {
			req.destroy(new Error("steer IPC timeout"));
		});
		req.on("error", reject);
		req.end(body);
	});
}

if (!socketPath) {
	output({});
	process.exit(0);
}

try {
	const input = await new Response(Bun.stdin.stream()).text();
	const payload = JSON.parse(input);
	const result = (await postClaim(JSON.stringify(payload))) as {
		messages?: Array<{ id?: unknown; text?: unknown }>;
	} | null;
	const messages = Array.isArray(result?.messages) ? result.messages : [];
	const injectSteps = messages
		.filter((message) => typeof message.text === "string")
		.map((message) => ({ userMessage: message.text as string }));
	output(
		injectSteps.length === 0
			? {}
			: event === "post"
				? { injectSteps, terminationBehavior: "force_continue" }
				: { injectSteps },
	);
} catch {
	output({});
}
