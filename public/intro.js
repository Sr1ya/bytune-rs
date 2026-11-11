/*
 * Turns on ByTune's launch intro before anything paints: index.html's #intro, drawn by src/intro.css and
 * public/intro-light.js, ended by src/intro.ts. After Arkemis Cut's, which follows ZCode's startup loader
 * (packages/desktop/src/renderer/index.html), © ZCode, licensed under the Apache License, Version 2.0:
 * http://www.apache.org/licenses/LICENSE-2.0
 * A script rather than a class written into the page, as theirs is: the miniplayer's window
 * (?window=pip) loads the same page and never shows it, and ByTune's page allows no inline scripts.
 */
(function () {
  "use strict";
  if (new URLSearchParams(window.location.search).get("window") === "pip") return;
  var html = document.documentElement;
  // intro: the intro shows. intro-wait: the app stays hidden under it until src/intro.ts hands over.
  // intro-glass: the page is see-through, for the window's glass, until the intro has played.
  html.classList.add("intro", "intro-wait", "intro-glass");

  // The mark's light show runs in a worker (public/intro-light.js) on the intro's canvas, so the app starting
  // up on this thread can't stall it. intro-lit hides the SVG mark meanwhile; with reduced motion, without
  // workers, or if the light hasn't started within 1.5s, the SVG mark shows the finished logo instead.
  var worker = null;
  function light(canvas) {
    if (!canvas || !canvas.transferControlToOffscreen || typeof Worker !== "function") return;
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var lit = false;
    var unlit = function () {
      if (!lit) html.classList.remove("intro-lit");
    };
    try {
      var ratio = window.devicePixelRatio || 1;
      canvas.width = canvas.height = Math.round(Number(canvas.dataset.size) * ratio);
      var offscreen = canvas.transferControlToOffscreen();
      worker = new Worker("./intro-light.js");
      worker.onmessage = function () {
        lit = true;
      };
      worker.onerror = unlit;
      html.classList.add("intro-lit");
      setTimeout(unlit, 1500);
      worker.postMessage({ canvas: offscreen, ratio: ratio, start: performance.timeOrigin + performance.now() }, [offscreen]);
    } catch (err) {
      html.classList.remove("intro-lit");
      return;
    }
    // Then the moment the intro's animations really began, once they have one, for the light to keep time with.
    var intro = canvas.closest("#intro");
    var began = function (tries) {
      var a = intro.getAnimations({ subtree: true }).find(function (x) {
        return x.startTime !== null;
      });
      if (a && worker) worker.postMessage({ start: performance.timeOrigin + a.startTime });
      else if (tries) requestAnimationFrame(began.bind(null, tries - 1));
    };
    requestAnimationFrame(began.bind(null, 10));
  }
  light.stop = function () {
    if (worker) worker.terminate();
    worker = null;
  };
  // src/intro.ts stops it when the intro is gone, and lights the intro again when it replays one.
  window.bytuneIntroLight = light;
  // The page is parsed (the canvas is there) and the app's scripts haven't run yet.
  document.addEventListener("readystatechange", function () {
    if (document.readyState === "interactive") light(document.querySelector("#intro .intro-light"));
  });
})();
