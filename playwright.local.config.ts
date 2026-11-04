import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
	...base,
	testDir: "./tests/local-mode",
	webServer: {
		...base.webServer,
		command: "npx vite --host 127.0.0.1 --port 5178 --strictPort",
		url: "http://127.0.0.1:5178",
		env: {
			RECORDLY_RENDERER_ONLY: "1",
			VITE_RECORDLY_LOCAL_ONLY: "true",
			VITE_SUPABASE_URL: "https://auth.recordly.test",
			VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_ui_test",
			VITE_CLOUD_SHARE_ENDPOINT: "https://videos.recordly.dev/api/upload",
		},
	},
});
