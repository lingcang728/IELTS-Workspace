// OS-level close (Alt+F4, taskbar menu, system shutdown) bypasses the custom
// titlebar X's beforeClose hook. Rust intercepts CloseRequested and emits
// "app-close-requested"; main.tsx answers by awaiting the registered flush and
// then destroying the window. The exam view registers its final save here;
// every other view leaves it null so closing stays instant.
let flush: (() => Promise<void>) | null = null;

export function registerCloseFlush(fn: () => Promise<void>): void {
  flush = fn;
}

export function clearCloseFlush(): void {
  flush = null;
}

export async function flushForClose(): Promise<void> {
  try {
    await flush?.();
  } catch {
    // A failed final save must never trap the window open.
  }
}
