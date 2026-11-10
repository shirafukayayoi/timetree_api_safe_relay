import type { TimeTreeClient } from "./timetree/client.js";

/** Relay のプロファイル。1プロファイルが1つのTimeTreeアカウントに対応する。 */
export type RelayProfile = {
	name: string;
	client: TimeTreeClient;
};

export type Logger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};
