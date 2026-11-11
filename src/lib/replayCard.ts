/**
 * Replay's share card, drawn on a canvas at story size (1080×1920): your
 * top song's record sliding out of your top album's sleeve, your minutes in
 * big type, your top five songs and artists, over a wash of your top song's
 * colours with a fine grain — the Replay page's look, pressed into one image.
 *
 * Covers load CORS-clean (lib/ambient loadArtworkImage), so the canvas
 * exports; a cover that won't load leaves a quiet tile in its place. Fonts
 * are the app's own, read off the page.
 */
import brandLogo from "../assets/brand/bytune-logo.svg";
import brandText from "../assets/brand/bytune-Text.svg";
import { loadArtworkImage } from "./ambient";

export interface ReplayCardInput {
  /** "November 2026", "This week", "All time" */
  periodLabel: string;
  minutes: number;
  plays: number;
  activeDays: number;
  streak: number;
  songs: { title: string; artist: string; thumb: string }[];
  artists: { name: string; thumb: string; detail: string }[];
  /** the top album's cover; null draws the record alone */
  sleeve: string | null;
  /** the top song's cover, the record's label */
  label: string | null;
  /** the top song's colours, "R G B" */
  colors: [string, string];
}

const W = 1080;
const H = 1920;
const PAD = 84;
const COVER_TIMEOUT_MS = 8000;

type Img = HTMLImageElement | null;

/** A cover, CORS-clean, or null once it fails or takes too long. Cleanups run after the card is drawn. */
async function cover(url: string | null | undefined, cleanups: (() => void)[]): Promise<Img> {
  if (!url) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), COVER_TIMEOUT_MS));
  const loaded = await Promise.race([loadArtworkImage(url), timeout]);
  if (!loaded) return null;
  cleanups.push(loaded.cleanup);
  return loaded.image;
}

/** A bundled same-origin image (the brand marks). */
function asset(src: string): Promise<Img> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** The font family a class resolves to on this page, so the card types like the app. */
function familyOf(className: string): string {
  const probe = document.createElement("span");
  probe.className = className;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const family = getComputedStyle(probe).fontFamily || "system-ui, sans-serif";
  probe.remove();
  return family;
}

const rgb = (triplet: string, alpha = 1): string => `rgb(${triplet} / ${alpha})`;

/** The longest start of `text` that fits `max` pixels, with an ellipsis when cut. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Centre-crop an image into a box. */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}

/** A cover in a rounded box (or a circle), with a quiet tile when it's missing. */
function tile(ctx: CanvasRenderingContext2D, img: Img, x: number, y: number, size: number, radius: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, radius);
  ctx.clip();
  if (img) drawCover(ctx, img, x, y, size, size);
  else {
    ctx.fillStyle = "rgb(255 255 255 / 0.08)";
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

/** A pressed record: grooves, a sheen, the label cover and its spindle hole. */
function drawRecord(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, label: Img, tint: string): void {
  ctx.save();
  ctx.shadowColor = "rgb(0 0 0 / 0.55)";
  ctx.shadowBlur = 70;
  ctx.shadowOffsetY = 30;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#0e0e10";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = rgb(tint, 0.1);
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  for (let rr = r * 0.36, i = 0; rr < r * 0.97; rr += 3.2, i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.strokeStyle = i % 2 ? "rgb(255 255 255 / 0.035)" : "rgb(0 0 0 / 0.3)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  const sheen = ctx.createConicGradient(-0.5, cx, cy);
  sheen.addColorStop(0, "rgb(255 255 255 / 0.16)");
  sheen.addColorStop(0.13, "rgb(255 255 255 / 0)");
  sheen.addColorStop(0.5, "rgb(255 255 255 / 0)");
  sheen.addColorStop(0.63, "rgb(255 255 255 / 0.1)");
  sheen.addColorStop(0.78, "rgb(255 255 255 / 0)");
  sheen.addColorStop(1, "rgb(255 255 255 / 0.16)");
  ctx.fillStyle = sheen;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();

  const lr = r * 0.34;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, lr, 0, Math.PI * 2);
  ctx.clip();
  if (label) {
    ctx.translate(cx, cy);
    ctx.rotate(-0.22);
    drawCover(ctx, label, -lr, -lr, lr * 2, lr * 2);
  } else {
    ctx.fillStyle = rgb(tint, 0.9);
    ctx.fillRect(cx - lr, cy - lr, lr * 2, lr * 2);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, lr, 0, Math.PI * 2);
  ctx.strokeStyle = "rgb(0 0 0 / 0.4)";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.03, 0, Math.PI * 2);
  ctx.fillStyle = "#050505";
  ctx.fill();
}

/** Fine film grain, so the wash reads as print rather than a flat gradient. */
function grain(ctx: CanvasRenderingContext2D): void {
  const g = document.createElement("canvas");
  g.width = 180;
  g.height = 180;
  const gctx = g.getContext("2d");
  if (!gctx) return;
  const noise = gctx.createImageData(180, 180);
  for (let i = 0; i < noise.data.length; i += 4) {
    const v = Math.random() * 255;
    noise.data[i] = v;
    noise.data[i + 1] = v;
    noise.data[i + 2] = v;
    noise.data[i + 3] = 255;
  }
  gctx.putImageData(noise, 0, 0);
  const pattern = ctx.createPattern(g, "repeat");
  if (!pattern) return;
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

export async function renderReplayCard(input: ReplayCardInput): Promise<Blob> {
  const cleanups: (() => void)[] = [];
  try {
    const [label, sleeve, logo, wordmark, songCovers, artistPhotos] = await Promise.all([
      cover(input.label, cleanups),
      cover(input.sleeve, cleanups),
      asset(brandLogo),
      asset(brandText),
      Promise.all(input.songs.slice(0, 5).map((s) => cover(s.thumb, cleanups))),
      Promise.all(input.artists.slice(0, 5).map((a) => cover(a.thumb, cleanups))),
    ]);

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    const display = familyOf("font-display");
    const body = familyOf("font-sans");
    const [a, b] = input.colors;

    // ---- the wash: your top song's colours over near-black, its cover blurred into the top ----
    ctx.fillStyle = "#0b0b0d";
    ctx.fillRect(0, 0, W, H);
    if (label) {
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.filter = "blur(90px) saturate(1.3)";
      drawCover(ctx, label, -260, -260, W + 520, 1240);
      ctx.restore();
    }
    const wash = ctx.createLinearGradient(0, 0, 0, H);
    wash.addColorStop(0, rgb(a, 0.78));
    wash.addColorStop(0.42, rgb(a, 0.3));
    wash.addColorStop(0.78, "rgb(11 11 13 / 0)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W * 0.88, H * 0.1, 0, W * 0.88, H * 0.1, W);
    glow.addColorStop(0, rgb(b, 0.55));
    glow.addColorStop(1, rgb(b, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    const shade = ctx.createLinearGradient(0, H * 0.4, 0, H);
    shade.addColorStop(0, "rgb(8 8 10 / 0)");
    shade.addColorStop(0.45, "rgb(8 8 10 / 0.72)");
    shade.addColorStop(1, "rgb(8 8 10 / 0.94)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
    grain(ctx);

    // ---- header: the ByTune mark, and what this card is ----
    if (logo) ctx.drawImage(logo, PAD, 92, 56 * (1700 / 1994), 56);
    if (wordmark) ctx.drawImage(wordmark, PAD + 64, 100, 40 * (1891 / 493), 40);
    ctx.textAlign = "right";
    ctx.fillStyle = "#fff";
    ctx.font = `800 30px ${display}`;
    ctx.letterSpacing = "8px";
    ctx.fillText("REPLAY", W - PAD + 8, 118);
    ctx.letterSpacing = "0px";
    ctx.font = `500 30px ${body}`;
    ctx.fillStyle = "rgb(255 255 255 / 0.72)";
    ctx.fillText(fit(ctx, input.periodLabel, 420), W - PAD, 160);
    ctx.textAlign = "left";

    // ---- the pressing: the record slides out of the sleeve. The sleeve is
    // your top album, or your top song when there's no album — the record's
    // label is then your top artist ----
    const sleeveImg = sleeve ?? label;
    const labelImg = sleeve ? label : (artistPhotos[0] ?? label);
    const [rx, ry] = sleeveImg ? [PAD + 560, 500] : [W / 2, 500];
    // Sound rings spreading from the record, fading as they go.
    for (let rr = 300, i = 0; rr < 1600; rr += 34, i++) {
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgb(255 255 255 / ${Math.max(0, 0.055 - i * 0.0016)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (sleeveImg) {
      drawRecord(ctx, rx, ry, 252, labelImg, a);
      ctx.save();
      ctx.translate(PAD + 250, 500);
      ctx.rotate(-0.05);
      ctx.shadowColor = "rgb(0 0 0 / 0.6)";
      ctx.shadowBlur = 80;
      ctx.shadowOffsetY = 34;
      ctx.beginPath();
      ctx.roundRect(-250, -250, 500, 500, 14);
      ctx.fillStyle = "#111";
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(PAD + 250, 500);
      ctx.rotate(-0.05);
      tile(ctx, sleeveImg, -250, -250, 500, 14);
      ctx.restore();
    } else {
      drawRecord(ctx, rx, ry, 280, labelImg, a);
    }

    // ---- your minutes ----
    ctx.fillStyle = "#fff";
    ctx.font = `800 196px ${display}`;
    ctx.letterSpacing = "-6px";
    ctx.fillText(fit(ctx, input.minutes.toLocaleString(), W - PAD * 2), PAD - 6, 1000);
    ctx.letterSpacing = "7px";
    ctx.font = `700 28px ${body}`;
    // Your top song's brighter colour, lifted further so the small caps read on the dark.
    ctx.fillStyle = `rgb(${b
      .split(" ")
      .map((v) => Math.min(255, Number(v) + 80))
      .join(" ")})`;
    ctx.fillText("MINUTES LISTENED", PAD, 1050);
    ctx.letterSpacing = "0px";
    const facts = [
      `${input.plays.toLocaleString()} ${input.plays === 1 ? "play" : "plays"}`,
      `${input.activeDays} ${input.activeDays === 1 ? "day" : "days"}`,
      ...(input.streak > 1 ? [`${input.streak}-day streak`] : []),
    ].join("  ·  ");
    ctx.font = `500 34px ${body}`;
    ctx.fillStyle = "rgb(255 255 255 / 0.88)";
    ctx.fillText(fit(ctx, facts, W - PAD * 2), PAD, 1108);

    // ---- your top five songs and artists ----
    const colW = (W - PAD * 2 - 44) / 2;
    const columns: { x: number; title: string; rows: { img: Img; round: boolean; main: string; sub: string }[] }[] = [
      {
        x: PAD,
        title: "TOP SONGS",
        rows: input.songs.slice(0, 5).map((s, i) => ({ img: songCovers[i], round: false, main: s.title, sub: s.artist })),
      },
      {
        x: PAD + colW + 44,
        title: "TOP ARTISTS",
        rows: input.artists.slice(0, 5).map((ar, i) => ({ img: artistPhotos[i], round: true, main: ar.name, sub: ar.detail })),
      },
    ];
    for (const col of columns) {
      if (!col.rows.length) continue;
      ctx.font = `700 25px ${body}`;
      ctx.letterSpacing = "6px";
      ctx.fillStyle = "rgb(255 255 255 / 0.6)";
      ctx.fillText(col.title, col.x, 1196);
      ctx.letterSpacing = "0px";
      col.rows.forEach((row, i) => {
        const y = 1228 + i * 106;
        ctx.font = `800 30px ${display}`;
        ctx.fillStyle = i === 0 ? "#fff" : "rgb(255 255 255 / 0.45)";
        ctx.fillText(String(i + 1), col.x, y + 50);
        const imgX = col.x + 40;
        tile(ctx, row.img, imgX, y + 4, 76, row.round ? 38 : 10);
        const textX = imgX + 94;
        const textW = colW - (textX - col.x);
        ctx.font = `700 29px ${body}`;
        ctx.fillStyle = "#fff";
        ctx.fillText(fit(ctx, row.main, textW), textX, y + 38);
        ctx.font = `500 24px ${body}`;
        ctx.fillStyle = "rgb(255 255 255 / 0.6)";
        ctx.fillText(fit(ctx, row.sub, textW), textX, y + 72);
      });
    }

    // ---- footer ----
    ctx.fillStyle = "rgb(255 255 255 / 0.12)";
    ctx.fillRect(PAD, 1792, W - PAD * 2, 2);
    ctx.font = `500 26px ${body}`;
    ctx.fillStyle = "rgb(255 255 255 / 0.6)";
    ctx.fillText("Your listening, counted by ByTune", PAD, 1850);
    if (logo) ctx.drawImage(logo, W - PAD - 30, 1822, 30, 30 * (1994 / 1700));

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The card couldn't be drawn"))), "image/png")
    );
  } finally {
    for (const done of cleanups) done();
  }
}
