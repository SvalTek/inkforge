/**
 * Authored links are never opened on click.
 *
 * A project is authored data, and a project can be imported from someone else:
 * an `.inkforge` pack can label a link anything and point it anywhere. The
 * markdown renderer allows only `http:`/`https:`/`mailto:`, which stops script
 * execution but says nothing about where the reader ends up. So every anchor it
 * produces is captured here and its full destination shown first — the label
 * cannot hide the address.
 */

/** Marks the anchors `src/ui/markdown.ts` generates, and nothing else. */
const LINK_SELECTOR = "a.md-link";

/** The one place in the app that opens an external page. */
function openExternally(url: string): void {
  globalThis.open(url, "_blank", "noopener,noreferrer");
}

function dialogButton(label: string, className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

/**
 * Show a link's full destination and resolve once the reader has decided.
 *
 * The label and the URL are authored and untrusted; both are written through
 * `textContent` like any other project value. Only the surrounding copy is ours.
 */
function confirmExternalLink(host: HTMLElement, url: string, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("section");
    overlay.className = "link-guard-overlay";
    overlay.role = "dialog";
    overlay.ariaModal = "true";
    overlay.ariaLabel = "Open external link";

    const panel = document.createElement("div");
    panel.className = "link-guard-window";

    const kicker = document.createElement("span");
    kicker.className = "link-guard-kicker";
    kicker.textContent = "EXTERNAL LINK";

    const title = document.createElement("h2");
    title.textContent = "Open this link?";

    const urlText = document.createElement("code");
    urlText.className = "link-guard-url";
    urlText.textContent = url;

    const warning = document.createElement("p");
    warning.className = "link-guard-warning";
    warning.textContent =
      "This leaves Inkforge for a page we cannot vouch for. Continue only if you recognise the address above.";

    const actions = document.createElement("div");
    actions.className = "link-guard-actions";
    const cancel = dialogButton("Cancel", "link-guard-cancel");
    const open = dialogButton("Open link", "link-guard-open");

    panel.append(kicker, title);
    // A label that already reads as the address does not need quoting twice.
    if (label && label !== url) {
      const quote = document.createElement("p");
      quote.className = "link-guard-label";
      quote.textContent = label;
      panel.append(quote);
    }
    panel.append(urlText, warning, actions);
    actions.append(cancel, open);
    overlay.append(panel);

    const close = (opened: boolean) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(opened);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(false);
    };

    cancel.addEventListener("click", () => close(false));
    open.addEventListener("click", () => {
      openExternally(url);
      close(true);
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);

    host.replaceChildren(overlay);
    // Cancel takes focus: the safe answer is the one a stray key press finds.
    cancel.focus();
  });
}

/**
 * Capture every authored link, wherever it was rendered.
 *
 * Delegated from the document rather than bound per surface: markdown reaches
 * the transcript, item descriptions, titles, UI text and modal bodies, and all
 * of them should behave the same. `auxclick` covers middle-click, which would
 * otherwise open a tab without asking.
 */
export function installLinkGuard(host: HTMLElement): void {
  const intercept = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest(LINK_SELECTOR);
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const url = anchor.dataset.url || anchor.href;
    void confirmExternalLink(host, url, anchor.textContent?.trim() ?? "");
  };
  document.addEventListener("click", intercept);
  document.addEventListener("auxclick", intercept);
}
