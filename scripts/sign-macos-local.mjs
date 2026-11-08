import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { signApp as signElectronApp } from "@electron/osx-sign";

// Local macOS builds are signed ad hoc by electron-builder. An ad hoc designated requirement is the
// cdhash of that exact build, so every rebuild invalidates the TCC grants (Screen Recording,
// Accessibility, Microphone, Camera) the user already gave. Re-signing with a stable self-signed
// identity turns the requirement into `identifier "dev.recordly.app" and certificate root = H"…"`,
// which survives rebuilds. See docs/macos-local-installation.md.

const DEFAULT_IDENTITY = "Recordly Local Signing";
const projectRoot = process.cwd();
const identity = process.env.RECORDLY_MAC_SIGN_IDENTITY?.trim() || DEFAULT_IDENTITY;
const loginKeychain = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");

function relativePath(filePath) {
	return path.relative(projectRoot, filePath) || ".";
}

function fail(message) {
	throw new Error(`[sign-macos-local] ${message}`);
}

function run(file, args, { allowFailure = false } = {}) {
	const result = spawnSync(file, args, { encoding: "utf8" });
	if (result.status !== 0 && !allowFailure) {
		fail(
			`${file} ${args.join(" ")} exited with ${result.status ?? result.signal}\n${result.stderr || result.stdout}`,
		);
	}
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function parseArgs(argv) {
	const options = { appPath: null, createIdentity: false };
	for (const arg of argv) {
		if (arg === "--create-identity") {
			options.createIdentity = true;
		} else if (arg.startsWith("--")) {
			fail(`Unknown option ${arg}`);
		} else if (options.appPath) {
			fail("Only one app path may be given");
		} else {
			options.appPath = path.resolve(arg);
		}
	}
	options.appPath ??= path.join(projectRoot, "release", "mac-arm64", "Recordly.app");
	return options;
}

function identityIsAvailable() {
	const output = run("security", ["find-identity", "-v", "-p", "codesigning"]);
	return output.includes(`"${identity}"`);
}

function createIdentity() {
	if (identityIsAvailable()) {
		console.log(
			`[sign-macos-local] identity "${identity}" already exists in the login keychain`,
		);
		return;
	}
	const workDir = mkdtempSync(path.join(os.tmpdir(), "recordly-local-sign-"));
	const keyPath = path.join(workDir, "key.pem");
	const certPath = path.join(workDir, "cert.pem");
	const p12Path = path.join(workDir, "identity.p12");
	const p12Password = "recordly-local";
	try {
		execFileSync("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-sha256",
			"-days",
			"3650",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-subj",
			`/CN=${identity}/O=Recordly Local/OU=Local Development`,
			"-addext",
			"keyUsage=critical,digitalSignature",
			"-addext",
			"extendedKeyUsage=critical,codeSigning",
			"-addext",
			"basicConstraints=critical,CA:FALSE",
		]);
		execFileSync("openssl", [
			"pkcs12",
			"-export",
			"-legacy",
			"-out",
			p12Path,
			"-inkey",
			keyPath,
			"-in",
			certPath,
			"-name",
			identity,
			"-passout",
			`pass:${p12Password}`,
		]);
		execFileSync("security", [
			"import",
			p12Path,
			"-k",
			loginKeychain,
			"-P",
			p12Password,
			"-T",
			"/usr/bin/codesign",
			"-T",
			"/usr/bin/security",
		]);
		console.log(
			"[sign-macos-local] macOS will ask for your login password to trust the new certificate for code signing.",
		);
		execFileSync(
			"security",
			["add-trusted-cert", "-p", "codeSign", "-k", loginKeychain, certPath],
			{
				stdio: "inherit",
			},
		);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
	if (!identityIsAvailable()) {
		fail(
			`identity "${identity}" was imported but is not valid for code signing; check its trust settings`,
		);
	}
	console.log(`[sign-macos-local] created identity "${identity}" in the login keychain`);
}

async function signApp(appPath) {
	if (process.platform !== "darwin") {
		fail("this script only runs on macOS");
	}
	if (!existsSync(appPath) || path.extname(appPath) !== ".app") {
		fail(`app bundle not found at ${relativePath(appPath)}`);
	}
	if (!identityIsAvailable()) {
		fail(
			`identity "${identity}" is not in the login keychain. Run "node scripts/sign-macos-local.mjs --create-identity" once, or set RECORDLY_MAC_SIGN_IDENTITY.`,
		);
	}

	const appEntitlements = path.join(projectRoot, "build", "entitlements.mac.plist");
	const inheritEntitlements = path.join(projectRoot, "build", "entitlements.mac.inherit.plist");
	const resolvedApp = path.resolve(appPath);

	console.log(`[sign-macos-local] signing ${relativePath(appPath)} with "${identity}"`);
	await signElectronApp({
		app: appPath,
		identity,
		// osx-sign lists identities with `security find-identity -v` under the default policy, where a
		// self-signed certificate trusted only for code signing is not listed. identityIsAvailable()
		// already validated it with `-p codesigning`, so let codesign resolve the name itself.
		identityValidation: false,
		platform: "darwin",
		type: "distribution",
		preAutoEntitlements: false,
		strictVerify: true,
		optionsForFile(filePath) {
			const isTopLevelApp = path.resolve(filePath) === resolvedApp;
			return {
				entitlements: isTopLevelApp ? appEntitlements : inheritEntitlements,
				hardenedRuntime: true,
				// A self-signed identity cannot obtain an Apple timestamp.
				timestamp: "none",
			};
		},
	});

	run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
	const requirement = run("codesign", ["-d", "-r-", appPath]);
	const designated = requirement
		.split("\n")
		.map((line) => line.replace(/^#\s*/, "").trim())
		.find((line) => line.startsWith("designated =>"));
	if (!designated || designated.includes("cdhash")) {
		fail(`designated requirement is still build-specific: ${designated ?? "unknown"}`);
	}
	console.log(`[sign-macos-local] ${designated}`);
	console.log(
		"[sign-macos-local] done. Grants given to this identity stay valid for future rebuilds signed the same way.",
	);
}

const options = parseArgs(process.argv.slice(2));
if (options.createIdentity) {
	createIdentity();
}
await signApp(options.appPath);
