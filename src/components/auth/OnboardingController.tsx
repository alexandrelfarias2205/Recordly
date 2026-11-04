import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { loadAppSetting, saveAppSetting } from "@/lib/appSettings";
import { RecordlySignInDialog } from "./RecordlySignInDialog";
import { Modal } from "@heroui/react";
import { LOCAL_ONLY } from "@/lib/runtimeMode";
import { OnboardingPermissions } from "./OnboardingPermissions";

const SEEN_KEY = "recordly.onboarding.v1.seen";

export function OnboardingController({
	requestNonce,
	ready,
	user,
	configured,
	callbackError,
}: {
	requestNonce: number;
	ready: boolean;
	user: User | null;
	configured: boolean;
	callbackError?: string;
}) {
	const [open, setOpen] = useState(false);
	const [startWithPermissions, setStartWithPermissions] = useState(false);
	const checked = useRef(false);
	useEffect(() => {
		if (requestNonce > 0) {
			setStartWithPermissions(true);
			setOpen(true);
		}
	}, [requestNonce]);
	const close = useCallback(() => {
		saveAppSetting("recordly.onboarding.permissionsRequested", false);
		setStartWithPermissions(false);
		setOpen(false);
	}, []);

	useEffect(() => {
		if (!ready) return;
		if (!user && !LOCAL_ONLY) {
			setOpen(true);
			return;
		}
		if (checked.current) return;
		checked.current = true;
		if (loadAppSetting<boolean>("recordly.onboarding.permissionsRequested")) {
			setStartWithPermissions(true);
			setOpen(true);
		} else if (!loadAppSetting<boolean>(SEEN_KEY)) setOpen(true);
	}, [ready, user]);

	useEffect(
		() =>
			window.electronAPI.onRecordingPermissionsRequested?.(() => {
				setStartWithPermissions(true);
				setOpen(true);
			}),
		[],
	);

	const finish = () => {
		if (!user && !LOCAL_ONLY) return;
		saveAppSetting(SEEN_KEY, true);
		close();
		void window.electronAPI.showRecordingHud();
	};

	if (LOCAL_ONLY) {
		return (
			<Modal
				isOpen={open}
				onOpenChange={(value) => {
					if (!value) close();
				}}
			>
				<Modal.Backdrop>
					<Modal.Container placement="center">
						<Modal.Dialog
							aria-label="Recordly local permissions"
							className="max-w-[640px] rounded-3xl p-0"
						>
							<OnboardingPermissions onFinish={finish} />
						</Modal.Dialog>
					</Modal.Container>
				</Modal.Backdrop>
			</Modal>
		);
	}

	return (
		<RecordlySignInDialog
			onboarding
			startWithPermissions={startWithPermissions}
			variant="wide"
			open={open}
			onOpenChange={(value) => {
				if (!value && user) close();
			}}
			user={user}
			configured={configured}
			callbackError={callbackError}
			onAuthenticated={finish}
		/>
	);
}
