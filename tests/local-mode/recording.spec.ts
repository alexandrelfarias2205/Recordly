import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "../ui/bridge";

test("local builds open permissions without sign-in and keep OS permission checks", async ({
	page,
}) => {
	const authRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("auth.recordly.test")) authRequests.push(request.url());
	});
	await installDesktopBridge(page, "preview.mp4", { signedIn: false });
	await page.addInitScript(() => {
		window.electronAPI.getAppSetting = () => null;
		window.electronAPI.getScreenRecordingPermissionStatus = async () => ({
			success: true,
			status: "denied",
		});
		window.electronAPI.openScreenRecordingPreferences = async () => {
			window.electronAPI.getScreenRecordingPermissionStatus = async () => ({
				success: true,
				status: "granted",
			});
			return { success: true };
		};
		window.electronAPI.showRecordingHud = async () => {
			document.documentElement.dataset.hudOpened = "true";
		};
	});
	await page.goto("/?windowType=editor");
	const permissions = page.getByRole("dialog", { name: "Recordly local permissions" });
	await expect(
		permissions.getByRole("heading", { name: "Allow Recordly to record" }),
	).toBeVisible();
	const start = permissions.getByRole("button", { name: "Start recording", exact: true });
	await expect(start).toBeDisabled();
	await expect(permissions.getByRole("button", { name: "Back to account" })).toHaveCount(0);
	await permissions.getByRole("button", { name: "Allow Screen Recording" }).click();
	await expect(start).toBeEnabled();
	await start.click();
	await expect(permissions).not.toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("data-hud-opened", "true");
	expect(authRequests).toEqual([]);
});
