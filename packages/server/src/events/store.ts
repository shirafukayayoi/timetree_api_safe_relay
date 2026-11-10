import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EventJob, eventJobSchema, type JobKind } from "timetree-api-safe-contracts";

/** 要求内容の正規化ハッシュ。同一キーでの要求比較だけに使う。 */
export const requestHash = (request: unknown): string =>
	createHash("sha256").update(JSON.stringify(request)).digest("hex");

export const newJobId = (): string => randomUUID();

/** ジョブ台帳。ジョブ単位のJSONファイルで永続化し、再起動後も保持する。 */
export class EventJobStore {
	readonly directory: string;
	#jobs = new Map<string, EventJob>();
	#keys = new Map<string, { jobId: string; hash: string }>();

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true });
		this.#load();
	}

	#jobFile(id: string): string {
		return join(this.directory, `${id}.json`);
	}

	#keyOf(profile: string, kind: JobKind, key: string): string {
		return `${profile}:${kind}:${key}`;
	}

	#load(): void {
		if (!existsSync(this.directory)) return;
		for (const entry of readdirSync(this.directory)) {
			if (!entry.endsWith(".json")) continue;
			try {
				const parsed: unknown = JSON.parse(readFileSync(join(this.directory, entry), "utf8"));
				const job = eventJobSchema.parse(parsed);
				this.#jobs.set(job.id, job);
				this.#keys.set(this.#keyOf(job.profile, job.kind, job.key), {
					jobId: job.id,
					hash: requestHash(job.request),
				});
			} catch {
				// 破損したジョブファイルは読み飛ばす。台帳の再構築には使わない。
			}
		}
	}

	get(id: string): EventJob | undefined {
		return this.#jobs.get(id);
	}

	all(): EventJob[] {
		return [...this.#jobs.values()];
	}

	findByKey(profile: string, kind: JobKind, key: string): { job: EventJob; hash: string } | undefined {
		const entry = this.#keys.get(this.#keyOf(profile, kind, key));
		if (!entry) return undefined;
		const job = this.#jobs.get(entry.jobId);
		if (!job) return undefined;
		return { job, hash: entry.hash };
	}

	save(job: EventJob): void {
		const file = this.#jobFile(job.id);
		const temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify(job, null, "\t"), "utf8");
		renameSync(temp, file);
		this.#jobs.set(job.id, job);
		this.#keys.set(this.#keyOf(job.profile, job.kind, job.key), {
			jobId: job.id,
			hash: requestHash(job.request),
		});
	}
}
