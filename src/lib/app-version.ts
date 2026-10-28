import manifest from "../../android/AndroidManifest.xml?raw";

/**
 * The installed app's version is `android:versionName` on the manifest.
 * The phone UI reads that same attribute so the footer tracks the APK
 * version instead of a second copy of the number.
 */
export function appVersionFromManifest(xml: string): string {
  const match = /android:versionName="([^"]+)"/.exec(xml);
  const version = match?.[1]?.trim() ?? "";
  if (!version) {
    throw new Error("android:versionName is missing from AndroidManifest.xml");
  }
  return version;
}

export const appVersion = appVersionFromManifest(manifest);
