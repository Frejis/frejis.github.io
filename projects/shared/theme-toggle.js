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
 *
 * That redraw must be SYNCHRONOUS. Pressing the toggle switches inside
 * document.startViewTransition where the API is available, and the snapshot
 * of the new state is taken as soon as the callback returns: a listener that
 * defers its redraw to a timer or an await gets its old canvas cross-faded in
 * as the new one.
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

  // ---- cross-fade -------------------------------------------------------
  // Three paths, in priority order: instant under reduced motion, the View
  // Transitions API where it exists, a CSS class elsewhere. Whichever runs,
  // `change` is called exactly once and synchronously, so `themechange` still
  // fires once per change, after the attribute is set.

  const reducedMotion = () =>
    !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let running = null; // the in-flight ViewTransition, if any
  let fadeToken = 0;  // guards the fallback class against an interrupting switch
  let fadeListener = null; // the transitionend handler owned by the in-flight fade, if any

  // theme.css owns the duration; read it rather than restating it here, so the
  // two cannot drift. Read at switch time, not at load: this script runs during
  // head parsing and on file:// the stylesheet may not have applied yet.
  const fadeMs = () => {
    const v = getComputedStyle(root).getPropertyValue("--theme-fade").trim();
    const n = parseFloat(v);
    if (!isFinite(n)) return 250; // theme.css missing or not yet applied
    return v.endsWith("ms") ? n : n * 1000;
  };

  function fade(change) {
    // Checked per switch, not once at load: a reader can change the setting
    // mid-session, and WCAG 2.3.3 says the next switch must honour it.
    if (reducedMotion()) {
      change();
      return;
    }

    if (typeof document.startViewTransition === "function") {
      // Starting one while another runs is what fast toggling does. Skip the
      // old one to its end state first; the API rejects promises rather than
      // throwing, so swallow those too.
      if (running) {
        try {
          running.skipTransition();
        } catch {
          /* already finished */
        }
      }
      let t;
      try {
        t = document.startViewTransition(change);
      } catch {
        change(); // nothing may stop the switch itself from happening
        return;
      }
      // `ready` rejects with AbortError whenever skipTransition() cuts a
      // transition short - which the block above does on every fast toggle.
      // Attach both guards right here, before either promise has a chance to
      // settle, so no interleaving of toggles can produce an unhandled
      // rejection.
      t.ready.catch(() => {});
      running = t;
      t.finished.catch(() => {}).then(() => {
        if (running === t) running = null;
      });
      return;
    }

    // Firefox today: transition the themed colour properties named in
    // theme.css. Canvases flip instantly here, because a canvas is pixels and
    // only the snapshot the View Transitions API takes can fade them.
    // An interrupting press abandons whatever fade was in flight. Detach its
    // listener now rather than leaving it attached forever - the `token`
    // check below would keep it a harmless no-op, but it would never come off.
    if (fadeListener) {
      root.removeEventListener("transitionend", fadeListener);
      fadeListener = null;
    }

    const token = ++fadeToken;
    // Toggling fast means an element that started fading on the PREVIOUS press
    // finishes in the middle of this one and reports transitionend. Removing
    // the class then would cut the current fade short, so the earliest the
    // class may go is one full duration from this press.
    const ms = fadeMs();
    const deadline = Date.now() + ms;
    root.classList.add("theme-fading");
    change();

    let timer;
    const done = () => {
      if (token !== fadeToken) return; // a later switch owns the class now
      clearTimeout(timer);
      const left = deadline - Date.now();
      if (left > 0) {
        timer = setTimeout(done, left);
        return;
      }
      root.removeEventListener("transitionend", done);
      fadeListener = null;
      root.classList.remove("theme-fading");
    };
    fadeListener = done;
    root.addEventListener("transitionend", done);
    // A page where nothing transitions fires no transitionend at all, and the
    // class would otherwise stay on forever.
    timer = setTimeout(done, ms + 350);
  }

  function mount() {
    if (document.querySelector(".theme-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    paintButton(btn);
    btn.addEventListener("click", () => {
      const next = current() === "dark" ? "light" : "dark";
      fade(() => apply(next, btn));
    });
    document.body.appendChild(btn);

    // Follow the OS while the reader has not chosen for themselves. This one
    // is deliberately NOT faded: it fires unattended, typically when the OS
    // crosses into night mode, and a cross-fade is a statement that something
    // the reader just did is taking effect. Freezing the page on a snapshot
    // for a quarter of a second is also worse when nobody asked for it.
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
