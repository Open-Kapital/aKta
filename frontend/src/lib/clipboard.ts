import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/** The webview denies navigator.clipboard writes, so go through the Tauri clipboard plugin. */
export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
