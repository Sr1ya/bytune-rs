/**
 * A Latin-letters reading of a lyric line, worked out on this machine — no
 * network, no dictionaries. Covers Korean (Hangul), Cyrillic, Japanese kana
 * and the Indian scripts that share Unicode's ISCII layout (Devanagari,
 * Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam). The
 * readings are casual, the way people type lyrics, not scholarly
 * transliteration. Lines with Chinese characters (kanji) return null: reading
 * those needs a dictionary. Providers' own romanizations always win over this.
 */

/* ------------------------------- Hangul ------------------------------- */

const HANGUL_L = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const HANGUL_V = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
// Final consonants, and how each sounds when the next syllable starts with a vowel.
const HANGUL_T = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];
const HANGUL_T_LINK = ["", "g", "kk", "ks", "n", "nj", "n", "d", "r", "lg", "lm", "lb", "ls", "lt", "lp", "r", "m", "b", "bs", "s", "ss", "ng", "j", "ch", "k", "t", "p", ""];

function hangul(text: string): string {
  let out = "";
  const chars = [...text];
  chars.forEach((ch, i) => {
    const s = ch.codePointAt(0)! - 0xac00;
    if (s < 0 || s > 11171) {
      out += ch;
      return;
    }
    const l = Math.floor(s / 588);
    const v = Math.floor((s % 588) / 28);
    const t = s % 28;
    const next = (chars[i + 1]?.codePointAt(0) ?? 0) - 0xac00;
    const nextStartsWithVowel = next >= 0 && next <= 11171 && Math.floor(next / 588) === 11;
    out += HANGUL_L[l] + HANGUL_V[v] + (nextStartsWithVowel ? HANGUL_T_LINK[t] : HANGUL_T[t]);
  });
  return out;
}

/* ------------------------------ Cyrillic ------------------------------ */

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "yo", є: "ye", ж: "zh", з: "z", и: "i", і: "i",
  ї: "yi", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ў: "w",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function cyrillic(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const latin = CYRILLIC[lower];
    if (latin === undefined) out += ch;
    else out += ch !== lower && latin ? latin[0].toUpperCase() + latin.slice(1) : latin;
  }
  return out;
}

/* -------------------------------- Kana -------------------------------- */

const KANA_ROWS: [string, string[]][] = [
  ["", ["a", "i", "u", "e", "o"]],
  ["k", ["ka", "ki", "ku", "ke", "ko"]],
  ["g", ["ga", "gi", "gu", "ge", "go"]],
  ["s", ["sa", "shi", "su", "se", "so"]],
  ["z", ["za", "ji", "zu", "ze", "zo"]],
  ["t", ["ta", "chi", "tsu", "te", "to"]],
  ["d", ["da", "ji", "zu", "de", "do"]],
  ["n", ["na", "ni", "nu", "ne", "no"]],
  ["h", ["ha", "hi", "fu", "he", "ho"]],
  ["b", ["ba", "bi", "bu", "be", "bo"]],
  ["p", ["pa", "pi", "pu", "pe", "po"]],
  ["m", ["ma", "mi", "mu", "me", "mo"]],
  ["r", ["ra", "ri", "ru", "re", "ro"]],
];
const HIRAGANA_ROWS = ["あいうえお", "かきくけこ", "がぎぐげご", "さしすせそ", "ざじずぜぞ", "たちつてと", "だぢづでど", "なにぬねの", "はひふへほ", "ばびぶべぼ", "ぱぴぷぺぽ", "まみむめも", "らりるれろ"];
const KANA = new Map<string, string>();
HIRAGANA_ROWS.forEach((row, r) => [...row].forEach((ch, c) => KANA.set(ch, KANA_ROWS[r][1][c])));
for (const [ch, latin] of [["や", "ya"], ["ゆ", "yu"], ["よ", "yo"], ["わ", "wa"], ["を", "o"], ["ん", "n"], ["ゔ", "vu"],
  ["ぁ", "a"], ["ぃ", "i"], ["ぅ", "u"], ["ぇ", "e"], ["ぉ", "o"]] as const) KANA.set(ch, latin);
const SMALL_Y: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o" };
const toHiragana = (ch: string): string => {
  const c = ch.codePointAt(0)!;
  return c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
};

function kana(text: string): string {
  const chars = [...text].map(toHiragana);
  let out = "";
  let doubleNext = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "っ") {
      doubleNext = true;
      continue;
    }
    if (ch === "ー") {
      out += out.match(/[aeiou]$/)?.[0] ?? ""; // long vowel: say it again
      continue;
    }
    let latin = KANA.get(ch);
    if (latin === undefined) {
      out += ch;
      doubleNext = false;
      continue;
    }
    const small = SMALL_Y[chars[i + 1] ?? ""];
    if (small && latin.endsWith("i") && latin.length > 1) {
      // きゃ kya, しゃ sha, ちゃ cha, じゃ ja
      latin = /^(sh|ch|j)i$/.test(latin) ? latin.slice(0, -1) + small : latin.slice(0, -1) + "y" + small;
      i++;
    }
    if (doubleNext) latin = (latin.startsWith("ch") ? "t" : latin[0]) + latin;
    doubleNext = false;
    out += latin;
  }
  return out;
}

/* ------------------------------- Indic -------------------------------- */

// Offsets inside each 128-code-point block, shared across the ISCII-derived scripts.
const INDIC_BLOCKS: [number, string, boolean][] = [
  // start, name, drops the word-final inherent "a" (Hindi-style)
  [0x0900, "deva", true],
  [0x0980, "beng", false],
  [0x0a00, "guru", true],
  [0x0a80, "gujr", true],
  [0x0b00, "orya", false],
  [0x0b80, "taml", false],
  [0x0c00, "telu", false],
  [0x0c80, "knda", false],
  [0x0d00, "mlym", false],
];
const INDIC_VOWELS: Record<number, string> = {
  0x05: "a", 0x06: "aa", 0x07: "i", 0x08: "ee", 0x09: "u", 0x0a: "oo", 0x0b: "ri", 0x0c: "li",
  0x0d: "e", 0x0e: "e", 0x0f: "e", 0x10: "ai", 0x11: "o", 0x12: "o", 0x13: "o", 0x14: "au",
};
const INDIC_CONSONANTS: Record<number, string> = {
  0x15: "k", 0x16: "kh", 0x17: "g", 0x18: "gh", 0x19: "ng",
  0x1a: "ch", 0x1b: "chh", 0x1c: "j", 0x1d: "jh", 0x1e: "ny",
  0x1f: "t", 0x20: "th", 0x21: "d", 0x22: "dh", 0x23: "n",
  0x24: "t", 0x25: "th", 0x26: "d", 0x27: "dh", 0x28: "n", 0x29: "n",
  0x2a: "p", 0x2b: "ph", 0x2c: "b", 0x2d: "bh", 0x2e: "m",
  0x2f: "y", 0x30: "r", 0x31: "r", 0x32: "l", 0x33: "l", 0x34: "zh", 0x35: "v",
  0x36: "sh", 0x37: "sh", 0x38: "s", 0x39: "h",
};
const INDIC_SIGNS: Record<number, string> = {
  0x3e: "a", 0x3f: "i", 0x40: "ee", 0x41: "u", 0x42: "oo", 0x43: "ri", 0x44: "ri",
  0x45: "e", 0x46: "e", 0x47: "e", 0x48: "ai", 0x49: "o", 0x4a: "o", 0x4b: "o", 0x4c: "au",
};
const NUKTA_SOUNDS: Record<string, string> = { j: "z", ph: "f", k: "q", d: "r", dh: "rh" };

function indicBlock(cp: number): [number, string, boolean] | null {
  for (const b of INDIC_BLOCKS) if (cp >= b[0] && cp < b[0] + 0x80) return b;
  return null;
}

function indic(text: string): string {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  let out = "";
  let akshara = 0; // letters so far in this word (a one-letter word keeps its "a")
  for (let i = 0; i < cps.length; i++) {
    const block = indicBlock(cps[i]);
    if (!block) {
      out += String.fromCodePoint(cps[i]);
      akshara = 0;
      continue;
    }
    const [start, , dropsFinalA] = block;
    const off = cps[i] - start;
    const offAt = (j: number): number | null => (j < cps.length && indicBlock(cps[j])?.[0] === start ? cps[j] - start : null);
    if (INDIC_CONSONANTS[off] !== undefined) {
      let c = INDIC_CONSONANTS[off];
      let j = i + 1;
      if (offAt(j) === 0x3c) {
        c = NUKTA_SOUNDS[c] ?? c;
        j++;
      }
      const nxt = offAt(j);
      akshara++;
      if (nxt === 0x4d) {
        out += c; // virama: no vowel
        i = j;
      } else if (nxt !== null && INDIC_SIGNS[nxt] !== undefined) {
        // Long "aa": Hindi lyrics are typed "mera", South Indian ones "naan".
        out += c + (nxt === 0x3e && !dropsFinalA ? "aa" : INDIC_SIGNS[nxt]);
        i = j;
      } else {
        const wordEnds = nxt === null || INDIC_CONSONANTS[nxt] === undefined && INDIC_VOWELS[nxt] === undefined && nxt !== 0x01 && nxt !== 0x02;
        out += c + (dropsFinalA && wordEnds && akshara > 1 ? "" : "a");
        i = j - 1;
      }
    } else if (INDIC_VOWELS[off] !== undefined) {
      out += INDIC_VOWELS[off];
      akshara++;
    } else if (off === 0x01 || off === 0x02) {
      out += "n"; // candrabindu, anusvara
    } else if (off === 0x03) {
      out += "h"; // visarga
    } else if (off === 0x64 || off === 0x65) {
      out += "."; // danda
    } else if (off >= 0x66 && off <= 0x6f) {
      out += String(off - 0x66);
    }
  }
  return out;
}

/* -------------------------------- entry -------------------------------- */

const HAS_HAN = /[㐀-䶿一-鿿豈-﫿]/;
const HAS_HANGUL = /[가-힣]/;
const HAS_CYRILLIC = /[Ѐ-ӿ]/;
const HAS_KANA = /[ぁ-ヿ]/;
const HAS_INDIC = /[ऀ-ൿ]/;

/** The line in Latin letters, or null when it already is, or can't be read without a dictionary. */
export function romanize(line: string): string | null {
  if (!line || HAS_HAN.test(line)) return null;
  let out = line;
  let changed = false;
  if (HAS_HANGUL.test(out)) [out, changed] = [hangul(out), true];
  if (HAS_KANA.test(out)) [out, changed] = [kana(out), true];
  if (HAS_CYRILLIC.test(out)) [out, changed] = [cyrillic(out), true];
  if (HAS_INDIC.test(out)) [out, changed] = [indic(out), true];
  return changed ? out.replace(/\s+/g, " ").trim() : null;
}
