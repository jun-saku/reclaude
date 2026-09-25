// Turns every <section class="slide"> on the page into a swipeable deck.
// Navigation: arrow keys / space, swipe, tap left or right edge, or #3 in the URL.
(function () {
  const slides = Array.from(document.querySelectorAll(".slide"));
  if (!slides.length) return;

  const counter = document.createElement("div");
  counter.className = "deck-counter";
  document.body.appendChild(counter);

  const progress = document.createElement("div");
  progress.className = "deck-progress";
  document.body.appendChild(progress);

  let current = 0;

  function show(i) {
    current = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, n) => s.classList.toggle("active", n === current));
    counter.textContent = current + 1 + " / " + slides.length;
    progress.style.width = ((current + 1) / slides.length) * 100 + "%";
    history.replaceState(null, "", "#" + (current + 1));
  }

  const next = () => show(current + 1);
  const prev = () => show(current - 1);

  document.addEventListener("keydown", (e) => {
    if (["ArrowRight", "ArrowDown", " ", "PageDown"].includes(e.key)) { e.preventDefault(); next(); }
    if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); prev(); }
    if (e.key === "Home") show(0);
    if (e.key === "End") show(slides.length - 1);
  });

  let startX = null, startY = null;
  document.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) (dx < 0 ? next : prev)();
    startX = null;
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("a, button, input, textarea, select")) return;
    (e.clientX > window.innerWidth / 2 ? next : prev)();
  });

  const fromHash = parseInt(location.hash.slice(1), 10);
  show(Number.isFinite(fromHash) ? fromHash - 1 : 0);
})();
