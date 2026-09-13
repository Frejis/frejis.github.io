/* Shared light/dark toggle. Include on every page with:
 *
 *   <script src="../shared/theme-toggle.js"></script>
 *   (from a blog post, one level deeper: ../../shared/theme-toggle.js)
 *
 * It injects its own button, so a page needs no markup for it.
 *
 * Two things any page with a <canvas> must do, because canvas pixels do not
 * inherit CSS and will keep their old colours when the palette changes:
 *
 *   1. read colours through getComputedStyle(document.body) at DRAW time,
 *      never from a value cached at module load;
 *   2. listen for the `themechange` event on document and redraw.
 *
 *   document.addEventListener("themechange", () => redrawEverything());
 */

(() => {
  const KEY = "portfolio-theme";
  const root = document.documentElement;

  const stored = (() => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch {
      return null; // private mode, file:// with storage blocked - fall through to the OS
    }
  })();

  // An explicit choice wins; otherwise leave data-theme unset so the
  // prefers-color-scheme block in theme.css decides.
  if (stored) root.setAttribute("data-theme", stored);

  const systemPrefersLight = () =>
    window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;

  const current = () =>
    root.getAttribute("data-theme") || (systemPrefersLight() ? "light" : "dark");

  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function paintButton(btn) {
    // The button advertises what pressing it will DO, not what is on now.
    const goingTo = current() === "dark" ? "light" : "dark";
    btn.innerHTML =
      (goingTo === "light" ? SUN : MOON) +
      '<span class="theme-toggle-label">' + goingTo + "</span>";
    btn.setAttribute("aria-label", "Switch to " + goingTo + " theme");
    btn.title = "Switch to " + goingTo + " theme";
  }

  function apply(theme, btn) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* not fatal: the theme still applies for this page view */
    }
    paintButton(btn);
    // Canvas charts cannot see a CSS change. Tell them.
    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
  }

  function mount() {
    if (document.querySelector(".theme-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    paintButton(btn);
    btn.addEventListener("click", () =>
      apply(current() === "dark" ? "light" : "dark", btn)
    );
    document.body.appendChild(btn);

    // Follow the OS while the reader has not chosen for themselves.
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        if (!root.hasAttribute("data-theme")) {
          paintButton(btn);
          document.dispatchEvent(
            new CustomEvent("themechange", { detail: { theme: current() } })
          );
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
