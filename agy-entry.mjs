import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const binary = process.env.AGY_BIN || "agy";
const state = join(homedir(), ".agy-acp");
const cache = join(state, "models.json");
let populated = false;
try {
	const models = JSON.parse(await readFile(cache, "utf8"));
	populated = Array.isArray(models) && models.length > 0;
} catch {}

if (!populated && !process.argv.includes("--version")) {
	const { stdout } = await promisify(execFile)(binary, ["models"], {
		timeout: 8000,
		maxBuffer: 128 * 1024,
	});
	const models = stdout
		.trim()
		.split("\n")
		.map((line) => {
			const [value, ...name] = line.trim().split(/\s+/);
			return { value, name: name.join(" ") || value };
		})
		.filter(
			(model) => model.value && /^[a-z0-9][a-z0-9._-]+$/.test(model.value),
		);
	if (!models.length)
		throw new Error("agy did not return a usable model catalog");
	await mkdir(state, { recursive: true, mode: 0o700 });
	const temporary = join(state, `.models-bb-${process.pid}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(models), { mode: 0o600 });
		await rename(temporary, cache);
	} finally {
		await rm(temporary, { force: true });
	}
}

await import("./index.ts");
