// Runs at document_start, before the chat site's own scripts. ChatGPT moves any keystroke whose target is not a text
// field into its own message box ("type anywhere"), and it listens in the capture phase. From outside the Limenn bar's
// closed shadow root the target is the bar's host element, so typing in the bar ended up in ChatGPT's box instead.
// Registered first, this listener stops such events before any page script sees them. It does not cancel them, so
// the browser still types into the bar; the bar's own key handling is called through the shared hook instead.

const HOST_ID = 'limenn-bar-host';
const EVENTS = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'compositionstart', 'compositionupdate', 'compositionend'];

declare global {
  // Set by overlay.ts: handles the bar's own keys (Enter to send, Escape) and input (grow, search).
  var __limennKeys: ((e: Event) => void) | undefined;
}

const fromBar = (e: Event) => e.composedPath().some((n) => (n as Element).id === HOST_ID);

for (const type of EVENTS) {
  window.addEventListener(
    type,
    (e) => {
      if (!fromBar(e)) return;
      e.stopImmediatePropagation();
      globalThis.__limennKeys?.(e);
    },
    true,
  );
}

export {};
