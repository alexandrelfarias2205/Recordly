import { LOCAL_ONLY } from "@/lib/runtimeMode";

export const CLOUD_SHARE_ENDPOINT = LOCAL_ONLY
	? ""
	: import.meta.env.VITE_CLOUD_SHARE_ENDPOINT?.trim() ||
		(import.meta.env.DEV ? "http://localhost:8787/api/upload" : "");
