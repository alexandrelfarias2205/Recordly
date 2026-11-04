import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), session: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.stubEnv("VITE_RECORDLY_LOCAL_ONLY", "true");
	// Local mode must win even if someone leaves cloud configuration in the build environment.
	vi.stubEnv("VITE_SUPABASE_URL", "https://auth.example.test");
	vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-key");
	vi.stubEnv("VITE_CLOUD_SHARE_ENDPOINT", "https://videos.recordly.dev/api/upload");
	mocks.createClient.mockReturnValue({ auth: { getSession: mocks.session } });
});

afterEach(() => vi.unstubAllEnvs());

it("allows local recording without constructing an auth client or fabricating a session", async () => {
	const auth = await import("./auth/recordlyAuth");
	expect(auth.recordlyAuthConfigured).toBe(false);
	await expect(auth.canStartRecording()).resolves.toBe(true);
	await expect(auth.hasRecordlySession()).resolves.toBe(false);
	expect(mocks.createClient).not.toHaveBeenCalled();
	expect(mocks.session).not.toHaveBeenCalled();
});

it("removes the cloud endpoint and rejects cloud IPC endpoints in local builds", async () => {
	const { CLOUD_SHARE_ENDPOINT } = await import("../components/video-editor/cloud/endpoint");
	const { normalizeCloudEndpoint } = await import("../../electron/ipc/cloudShareContract");
	expect(CLOUD_SHARE_ENDPOINT).toBe("");
	expect(() => normalizeCloudEndpoint("https://videos.recordly.dev/api/upload")).toThrow(
		"Cloud sharing is disabled",
	);
});

it("keeps account requirements in the default online build", async () => {
	vi.stubEnv("VITE_RECORDLY_LOCAL_ONLY", "false");
	mocks.session.mockResolvedValue({ data: { session: null }, error: null });
	const auth = await import("./auth/recordlyAuth");
	await expect(auth.canStartRecording()).resolves.toBe(false);
	mocks.session.mockResolvedValue({
		data: { session: { user: { id: "user", is_anonymous: false } } },
		error: null,
	});
	await expect(auth.canStartRecording()).resolves.toBe(true);
});
