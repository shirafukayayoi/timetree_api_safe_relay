import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type AccountListing,
	type AccountSelectionRecord,
	type SelectedAccount,
	type SelectAccountInput,
	accountSelectionRecordSchema,
} from "timetree-api-safe-contracts";
import type { RelayProfile, Logger } from "../types.js";
import { TimeTreeError } from "../timetree/errors.js";

export type AccountServiceOptions = {
	profiles: RelayProfile[];
	selectionFile: string;
	logger: Logger;
};

/** 登録済みプロファイルの一覧と、新規操作の既定投稿先（選択アカウント）を管理する。 */
export class AccountService {
	#profiles: RelayProfile[];
	#selectionFile: string;
	#logger: Logger;

	constructor(options: AccountServiceOptions) {
		this.#profiles = options.profiles;
		this.#selectionFile = options.selectionFile;
		this.#logger = options.logger;
	}

	list(): AccountListing {
		return {
			accounts: this.#profiles.map((profile) => ({
				profile: profile.name,
				state: profile.client.state,
				accountId: profile.client.currentUser?.id ?? null,
				accountName: profile.client.currentUser?.name ?? null,
			})),
			selected: this.selected(),
		};
	}

	/** 保存済みの選択記録。プロファイルが設定から消えた場合は null を返す。 */
	selected(): SelectedAccount | null {
		if (!existsSync(this.#selectionFile)) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#selectionFile, "utf8"));
		} catch {
			this.#logger.warn("アカウント選択記録を読み込めませんでした");
			return null;
		}
		const record = accountSelectionRecordSchema.safeParse(parsed);
		if (!record.success) return null;
		if (!this.#profiles.some((profile) => profile.name === record.data.profile)) return null;
		return {
			profile: record.data.profile,
			accountId: record.data.accountId,
			accountName: record.data.accountName,
		};
	}

	/** 実ログインアカウントを照合してから選択を確定する。 */
	async select(input: SelectAccountInput): Promise<SelectedAccount> {
		const profile = this.#profiles.find((candidate) => candidate.name === input.profile);
		if (!profile) {
			throw new TimeTreeError("UNKNOWN_PROFILE", "指定されたプロファイルは登録されていません");
		}
		const user = await profile.client.checkSession();
		if (input.expectedAccountId !== undefined && input.expectedAccountId !== user.id) {
			throw new TimeTreeError("INVALID_INPUT", "指定されたアカウントIDとログイン中のTimeTreeアカウントが一致しません");
		}
		const selected: SelectedAccount = {
			profile: profile.name,
			accountId: user.id,
			accountName: user.name ?? String(user.id),
		};
		const record: AccountSelectionRecord = {
			...selected,
			savedAt: new Date().toISOString(),
		};
		const directory = dirname(this.#selectionFile);
		mkdirSync(directory, { recursive: true });
		const temp = `${this.#selectionFile}.tmp`;
		writeFileSync(temp, JSON.stringify(record, null, "\t"), "utf8");
		renameSync(temp, this.#selectionFile);
		return selected;
	}
}
