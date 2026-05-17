// Smooth-scroll the run page back to the top. Called after any action
// that advances the engine to a new step (gate approve/reject,
// turn-card submit, IdleRecoveryCard Restart, ProviderErrorModal
// dismiss) so the user lands at the freshly-updated PolyFlow panel
// instead of scrolling back up themselves.
//
// Honors prefers-reduced-motion. Falls back to instant scroll if the
// browser hasn't implemented smooth behavior (older Safari).
export function scrollToTop(): void {
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const doScroll = () => {
    try {
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    } catch {
      window.scrollTo(0, 0);
    }
  };
  // Fire once now, and again after the next two animation frames. This
  // covers two race conditions seen in practice:
  //   1. React just queued a setState that re-renders the page (modal
  //      closing, query invalidating). Smooth-scroll initiated *before*
  //      the re-render lands can be cancelled when the layout shifts
  //      under it. The double-rAF gives layout time to settle.
  //   2. SSE-driven query invalidation can arrive milliseconds after
  //      the action, causing another commit that shifts content. The
  //      second rAF catches that case as well.
  doScroll();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
  }
}
