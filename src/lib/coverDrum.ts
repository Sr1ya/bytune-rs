/**
 * The onboarding's drum of covers, as data: songs most people know on sight (mostly English,
 * Spanish and phonk, a few Indian), set ring by ring, and which place on a turning ring faces the
 * viewer. components/CoverDrum draws it.
 */

/** Places round one ring. */
export const PER_RING = 12;
/** Degrees between neighbouring places. */
export const STEP = 360 / PER_RING;

export interface DrumCover {
  title: string;
  artist: string;
  kind: "english" | "spanish" | "phonk" | "indian";
  /** The song's album art as YouTube Music serves it, at the size the app shows covers. */
  art: string;
}

/**
 * The drum, top ring first. On every ring, place 0 faces the viewer at the start and the places go
 * round to the right from there; the covers are set so neighbours differ in colour and every ring
 * mixes the four kinds. The art links came from the app's own search for each song (its album art,
 * never a video frame); one that stops loading leaves its place dark.
 */
export const DRUM: ReadonlyArray<ReadonlyArray<DrumCover>> = [
  [
    { title: "Shape of You", artist: "Ed Sheeran", kind: "english", art: "https://yt3.googleusercontent.com/TMbA3LImAL96nFkm5cI1x6LiEMvMbRg4IRxEeABd9qpXsfmwKhZHRD1MucnjG5QIsVEp0Vpn7h7M51FH3Q=w544-h544-l90-rj" },
    { title: "Despacito", artist: "Luis Fonsi & Daddy Yankee", kind: "spanish", art: "https://yt3.googleusercontent.com/1Z53Q5KyKUB8AcpnO9eCoow2iA-y_8yBIQyKW1dT2Y24Ss98JHxE4zGD2mpdRddmO8pFfyIeYUdVmQs45A=w544-h544-l90-rj" },
    { title: "Kesariya", artist: "Arijit Singh", kind: "indian", art: "https://yt3.googleusercontent.com/CH0SThQN0HOk2eV81GGA-Tiftn58G48iy8lEyKNXJjbDSI9ApKKnmt4ncwr5gO_mZoQvFF3HPfHtky1Y=w544-h544-l90-rj" },
    { title: "METAMORPHOSIS", artist: "INTERWORLD", kind: "phonk", art: "https://yt3.googleusercontent.com/v7NytYEezEIqXU8rIuWe6Rvt3CpjWOe70IVqkkVipgp9TZ5Uk4lbA-GpLy-Wn2vimZhPWZ6NdDiNPuHspg=w544-h544-l90-rj" },
    { title: "HUMBLE.", artist: "Kendrick Lamar", kind: "english", art: "https://yt3.googleusercontent.com/B1bVbj-AbBIJxL7RHJ2B7F9fLCv2reqD-9hPQAQf77cbWpf_a0KQM-d2zHoKCXBbjtKYBlc3-18zK4I=w544-h544-l90-rj" },
    { title: "Tusa", artist: "KAROL G & Nicki Minaj", kind: "spanish", art: "https://yt3.googleusercontent.com/me7_JCi3IQsI74Ju4ZsXZ6qHjK0JNzvL0mlP6wvt3fW0tfSiSiv_bMGXoEBkMSkxl96KH899PLgf9dHWjQ=w544-h544-l90-rj" },
    { title: "NEON BLADE", artist: "MoonDeity", kind: "phonk", art: "https://yt3.googleusercontent.com/Q9Nlf2VGG1MuPD3LO8O36BYSeok_u47msSgZca5ZBW1w_vxf6Oa-jz1fb8NGRjFFEpVlzz38gx03MyUTSg=w544-h544-l90-rj" },
    { title: "Anti-Hero", artist: "Taylor Swift", kind: "english", art: "https://yt3.googleusercontent.com/YT8q7RwmbNVf7EcjSii-T5vm7FZI7_mSb_KYvhfKqvKRWdCTB-mzr2jLZCPwYqER3wHFXhuEQKTKmUCJ=w544-h544-l90-rj" },
    { title: "Gasolina", artist: "Daddy Yankee", kind: "spanish", art: "https://yt3.googleusercontent.com/HIGwecpHHZw6BARsFH1exWb6aSCZdCKAa0NzZkcCR47nT18i30o7-Le-qvLjlQKvckMaMNKndH9HXNc=w544-h544-l90-rj" },
    { title: "Heat Waves", artist: "Glass Animals", kind: "english", art: "https://yt3.googleusercontent.com/w9WrUTZckeY-PCYJsytiVyw5tVCtFsirBtnYGRvSIby3oRjYXHaszrbJsyfmZ6mdbE2UB-c7iqjJdR0=w544-h544-l90-rj" },
    { title: "Override", artist: "KSLV Noh", kind: "phonk", art: "https://yt3.googleusercontent.com/MhSoAt2Av3w6tVUkcfOB0_5byd4Q8Tni9IFdtXKpiDqmYakWNSxntBjb7eMr4acS2pfXZ7WqPBj4iOSV=w544-h544-l90-rj" },
    { title: "Starboy", artist: "The Weeknd", kind: "english", art: "https://yt3.googleusercontent.com/dcxXIIlest09vnvKznWM9VWQXu1EL7lKxBzXGzwgmVjmMNBm1dEWT_0qn1xrEZYyKF_qRE1TLq8P_JY_mQ=w544-h544-l90-rj" },
  ],
  [
    { title: "Blinding Lights", artist: "The Weeknd", kind: "english", art: "https://yt3.googleusercontent.com/R_cjQK3wwLPEzri1jerx-79zgzGocoKvwGU3NMONaTsaMM0Idd641pfB8r5jgfpn6I8JAoFtf9RBIcI=w544-h544-l90-rj" },
    { title: "Murder In My Mind", artist: "Kordhell", kind: "phonk", art: "https://yt3.googleusercontent.com/v8-bhoXMHgeO4H1pZc4MsHIh4BrZshY4IJC2AME6KfVEN9VSsMVEjv8CwSDE4kaSkap9jzcx3aEykKrQEA=w544-h544-l90-rj" },
    { title: "Mi Gente", artist: "J Balvin & Willy William", kind: "spanish", art: "https://yt3.googleusercontent.com/go4837lx-jM17uwyGdk3b7ygdlRr44NiUuw-AkYt3_tS1b9PmCkz7hhW4ZNArhIfblYsrxLdXumo1jMO=w544-h544-l90-rj" },
    { title: "Billie Jean", artist: "Michael Jackson", kind: "english", art: "https://yt3.googleusercontent.com/URvHCfI2iyGAlAwqqBFeaFhU9DeKk_iuX40OIIIj8Zp0wIT3BVsJ2JRMwLLbUB9EZS7t7oDlMrI2S3OvGA=w544-h544-l90-rj" },
    { title: "Naatu Naatu", artist: "Rahul Sipligunj & Kaala Bhairava", kind: "indian", art: "https://yt3.googleusercontent.com/BBkzOZptuJhomEubnwEAtqJbQzAiUFvdhbXVYChSdh9kmgT3H-dqnVxmtq0_jeNLoFWWmJEghVvFH-Nq1w=w544-h544-l90-rj" },
    { title: "drivers license", artist: "Olivia Rodrigo", kind: "english", art: "https://yt3.googleusercontent.com/-GF5jStF-HFmg6bWDY0j9vB--4F0GXBwoGgn5Pe0u3TlltUqFISBip0Y4mYbzYPjaFX97TmZVBw03o1h=w544-h544-l90-rj" },
    { title: "Close Eyes", artist: "DVRST", kind: "phonk", art: "https://yt3.googleusercontent.com/usUqlKReOqAj1x-rJdJxlOyckYA57qJUFRCKqlpU_weSmSAwwPoukZIjN2Zm0t4FxFDiNxIAKSHvBc18=w544-h544-l90-rj" },
    { title: "Tití Me Preguntó", artist: "Bad Bunny", kind: "spanish", art: "https://yt3.googleusercontent.com/0Ke36SSY53TQbmpqzKP4hMPoGiWYQiGI0KJ2CzcwjW4ore9vUMUmyzEi7irEU2MR3FCpNPdwIIuNslS6hg=w544-h544-l90-rj" },
    { title: "Believer", artist: "Imagine Dragons", kind: "english", art: "https://yt3.googleusercontent.com/weYQWfEwWNPOuAm34geXN1LkSYPlsJay78NnQgHC3PKsyZcdvBHIsMtqoFh3rioA4XgMdHMQd3h6vH6mbA=w544-h544-l90-rj" },
    { title: "La Bachata", artist: "Manuel Turizo", kind: "spanish", art: "https://yt3.googleusercontent.com/8o3GMnTk_kFkZGnIp6tJEiRy2o6tdHhNPy5k-y0jrh6G-VPmgjODwElWQVMkzj8H9fAnpfYeVIaN2gpD=w544-h544-l90-rj" },
    { title: "In the End", artist: "Linkin Park", kind: "english", art: "https://yt3.googleusercontent.com/lkNJVMp3siDfSw_zVYj3tE6fQS7G6Gj2gzoxrIwS7K4TwqmL_uSBb9-PKACNLIP_7XLQib4tC5XwWbpD=w544-h544-l90-rj" },
    { title: "Con Calma", artist: "Daddy Yankee & Snow", kind: "spanish", art: "https://yt3.googleusercontent.com/qiW8LOnUWmVWzhwOOfAa-GsD2eHfIXAyDy7aUFwPhANsRLxom-zkk1JL4wNiMthxFw4QBTl6_K-e06VARw=w544-h544-l90-rj" },
  ],
  [
    { title: "SICKO MODE", artist: "Travis Scott", kind: "english", art: "https://yt3.googleusercontent.com/PSIZ9cf9hpESZwcSz2ylS5I-zIREqCSagxV-X4CJqefrE0sRCktRtFw-a7PlkLygmg7k1nZREKCaSzY=w544-h544-l90-rj" },
    { title: "Levitating", artist: "Dua Lipa", kind: "english", art: "https://yt3.googleusercontent.com/UpJ_IhBqyhQV9b2UGcDxxWDm14kRQ2eY1o9S96AGsbE7Ol8isbpbPA0Yefvg8S8ZGAX9L1g4xaj21zVJ=w544-h544-l90-rj" },
    { title: "Pepas", artist: "Farruko", kind: "spanish", art: "https://yt3.googleusercontent.com/22J000nZ05UFFDh41LedvZypSJVti20ihhCTmVWQzDOqTjmQEXACHuRXg5i8GSCUeTjdSQcrqSDidScXUw=w544-h544-l90-rj" },
    { title: "RAVE", artist: "Dxrk", kind: "phonk", art: "https://yt3.googleusercontent.com/n0pSY1R8PZ8L00KlZ2K-P0rlkkSQTlBqHeN0pmd_cpGctzNIXi2Yc6x2m1ekjy7r-kZdZccd_kIIhXM=w544-h544-l90-rj" },
    { title: "Smells Like Teen Spirit", artist: "Nirvana", kind: "english", art: "https://yt3.googleusercontent.com/eyKiPBSqEu556sYTd_IyZhfxun5e_hatZ9tAyu8bnmVRgtbM3aW-SXUvhVX-d7s1oU0Yf3a38JOuYMZK5w=w544-h544-l90-rj" },
    { title: "Srivalli", artist: "Javed Ali", kind: "indian", art: "https://yt3.googleusercontent.com/w20kmKC4GQzTTZn76C2iyRSiLmvZNYJTqro5RIcDJ0X13NGplU5wFU9rXUUMJOLgWCb0QyuAFMtXYsQ=w544-h544-l90-rj" },
    { title: "Taki Taki", artist: "DJ Snake, Selena Gomez, Ozuna & Cardi B", kind: "spanish", art: "https://yt3.googleusercontent.com/xBXKkDvlHEGVOggLeU5EZAqKnIHlwXl2ih0x6khXi7YTA9gOZ_3S3RHih0F4aHZbhM_E47J48WN5GRc=w544-h544-l90-rj" },
    { title: "Uptown Funk", artist: "Mark Ronson & Bruno Mars", kind: "english", art: "https://yt3.googleusercontent.com/-NFtUA6dAmZKAy88a0k88UQ4VrYGKORqYBDSzMKCkwLJy5hgfMk3CppWBP61g6PXmJ69Dm41UNFke9k=w544-h544-l90-rj" },
    { title: "PASSO BEM SOLTO", artist: "ATLXS", kind: "phonk", art: "https://yt3.googleusercontent.com/WyM0ZcQFZjHRoKulizXrtm5kzK-SofjJ2I5pGOZLtsaXC5BwAxCibEsMZ0c-ceWfe3SomNurl4wvXVwc=w544-h544-l90-rj" },
    { title: "DÁKITI", artist: "Bad Bunny & Jhayco", kind: "spanish", art: "https://yt3.googleusercontent.com/Iysj4pTBhx_j4Uk2xzUoq6IN9rfnb6GlaZp9g4rvLndsJXLY5IxpIlX3YHC_at2h6lVdMNkoLplmWvhfkQ=w544-h544-l90-rj" },
    { title: "Kill Bill", artist: "SZA", kind: "english", art: "https://yt3.googleusercontent.com/tw5VGXEsehs9OpwnpbubqGp_3Pq9so7QShdyJSlCpXeI2mLRvqRqLNbA7EC4zcNWrFE0_lj9HxpZ23v6=w544-h544-l90-rj" },
    { title: "Sunflower", artist: "Post Malone & Swae Lee", kind: "english", art: "https://yt3.googleusercontent.com/IBwK4LOs4sO-Cd-_5YO4XC2B2N1hvyBvKfr60tT_ljIuwmOuVWWW2NypbcvzKgScVAbRsWEYbmsjfcm2cw=w544-h544-l90-rj" },
  ],
  [
    { title: "bad guy", artist: "Billie Eilish", kind: "english", art: "https://yt3.googleusercontent.com/RG92soY11tCRckJuiLvwUF0YACEyBcC4m-GUre3ffB6afsGiRGJw1n-8CWtHkC7Q049HmyfU4aPGNtQ=w544-h544-l90-rj" },
    { title: "Espresso", artist: "Sabrina Carpenter", kind: "english", art: "https://yt3.googleusercontent.com/bTWlZSenrOAYgH4r6NAzyDraWQR_wLl3OuRexJ_8h3NZUVHEilRSzUmKNa9YMOFSVcF0YtOuzKdXrt2UHg=w544-h544-l90-rj" },
    { title: "Viva La Vida", artist: "Coldplay", kind: "english", art: "https://yt3.googleusercontent.com/I7N7aaBK0qhf1WPucGBsYR3sOTZLeai5YNe9y2pRCMTsu3XQ8ELNRXkynrb_Mi3w8iebfxmsc05uWrjntg=w544-h544-l90-rj" },
    { title: "Memory Reboot", artist: "VØJ & Narvent", kind: "phonk", art: "https://yt3.googleusercontent.com/hTVmW2fQoiMbW2zjP1FyMvNwoMZe0oJffV7Irho1EYhiohEaSgXL5q9TUJ0VNp9EOE5dkXTe1oDWbrg=w544-h544-l90-rj" },
    { title: "As It Was", artist: "Harry Styles", kind: "english", art: "https://yt3.googleusercontent.com/F618Qwn2yRlYhCqlMtEMnFHajg4rGZSGeWOF4ro7l3I9R6y7aGfowqqiNQqj6CgVR0yepTK6T5aRSfAF=w544-h544-l90-rj" },
    { title: "Tum Hi Ho", artist: "Arijit Singh", kind: "indian", art: "https://yt3.googleusercontent.com/3q33amH9hzn1dO8IeAX7TMb1QtEVfvVbqd2eSCaelOXNVmfMjbpDYdqD2HSiXtNP6i5Es7oynkWU2NfOXA=w544-h544-l90-rj" },
    { title: "Hawái", artist: "Maluma", kind: "spanish", art: "https://yt3.googleusercontent.com/ts3k1mXvDKaMXh1EqPyKP7fAsBE3Xr2pgHSW8PRpcTw4954Z4pUyMudcMUAwLOuVlGQGwXUBwp3mB7cz=w544-h544-l90-rj" },
    { title: "Without Me", artist: "Eminem", kind: "english", art: "https://yt3.googleusercontent.com/GJmbTYfaMrWuPSzhOAy7jGCQ70a2UN2-0moTq-uh_Prd73-Au51FDHhGteg543a7iBv1Y9SPm4huMSBS=w544-h544-s-l90-rj" },
    { title: "SLAY!", artist: "Eternxlkz", kind: "phonk", art: "https://yt3.googleusercontent.com/OEDg6sIBOFm-5kKrU2MJ3Df9htKsmHOVaKOs4ZaD5We3ZVrhRKop1kDMnZJsiIr4IbhbtjR4PcFoKmHJ=w544-h544-l90-rj" },
    { title: "Ella Baila Sola", artist: "Eslabon Armado & Peso Pluma", kind: "spanish", art: "https://yt3.googleusercontent.com/GbxpjzUoJrn7r1d-PSH7OXTPfq40ovx4iL4m8WSmQuN4G_5jwx4Ebam23R8c8hDDLXwot8SDog7WfI3arw=w544-h544-l90-rj" },
    { title: "Mr. Brightside", artist: "The Killers", kind: "english", art: "https://yt3.googleusercontent.com/soFyZYOggw-Ae05b91WiVDnq9ahXLOrNJiR4wWiQemfclVliG_BHht1bH6f0cjLB0KzKlyGBTsPrtQEn=w544-h544-l90-rj" },
    { title: "Bzrp Music Sessions, Vol. 53", artist: "Bizarrap & Shakira", kind: "spanish", art: "https://yt3.googleusercontent.com/UkRThQZAN_SN0xXiq4JfKzpEa4Kp0AmRR1ZWUrtrJJJ04qcpgaPExfG0lWBtiO3V2HrHdR3Zq2dZHnhW=w544-h544-l90-rj" },
  ],
  [
    { title: "Flowers", artist: "Miley Cyrus", kind: "english", art: "https://yt3.googleusercontent.com/umJNTu_qH_THEHP4XsOb4bMCjKn1nka4c8iz8Vs791pB5aroCWwq4aHC9ds5kCnONrgNUPgPadWnecak=w544-h544-l90-rj" },
    { title: "Waka Waka", artist: "Shakira", kind: "spanish", art: "https://yt3.googleusercontent.com/12Fsnx6k8JnsAURqcqOHxtuKVmoPBO8vRkEWtt81IuEdkImtnWw29JD1wOTEe_Hcne3kRnrjB6JhAgQ=w544-h544-l90-rj" },
    { title: "God's Plan", artist: "Drake", kind: "english", art: "https://yt3.googleusercontent.com/9Oe4acEXgmAlCKgcgI6JlSXi2Tj30u6anzvfGBrunGO-fLhBTgzy-ei1ugPJpZDD5ArKFod9H4RTA5g0=w544-h544-l90-rj" },
    { title: "Sahara", artist: "Hensonn", kind: "phonk", art: "https://yt3.googleusercontent.com/m1e9qBf-bQ2XNX1DeKb1BE2GC_FhTlTYaBO-tW1KRscw2vubsGsG_1cFNDEGNykY63jT2H_ezatvcoJWng=w544-h544-l90-rj" },
    { title: "APT.", artist: "ROSÉ & Bruno Mars", kind: "english", art: "https://yt3.googleusercontent.com/-MtYkhdYuOvj8YWHA4afh-OUYMYHNpBpkk047QgGAxLJMLE570Pj0-LQjA2PW1ltedqTusKOjzXvuS8=w544-h544-l90-rj" },
    { title: "Jai Ho", artist: "A. R. Rahman", kind: "indian", art: "https://yt3.googleusercontent.com/7QVV9AL18zQfg7-Ak-lAIN7FhImz5VCxR_HFa9XkwS8M29nMmbGOaRSQOIxASTLk0dUaQrR0S3ZVx-Pg=w544-h544-l90-rj" },
    { title: "STAY", artist: "The Kid LAROI & Justin Bieber", kind: "english", art: "https://yt3.googleusercontent.com/_72AYxGc5r6U2SwbDvo8qLTx0wLp1bxRAQTSWNZfeZOdP2zf6yHjIAzTZCFILrbz3AvxHqHJdqde56Y=w544-h544-l90-rj" },
    { title: "Tauba Tauba", artist: "Karan Aujla", kind: "indian", art: "https://yt3.googleusercontent.com/xlZs7zjh277lx98oHLHWOJc9l4abh9-cPtav9vvlRrrEt0XTqmmQYYK6mm0YJrAKWrbebJlKwtw43c4=w544-h544-l90-rj" },
    { title: "Rolling in the Deep", artist: "Adele", kind: "english", art: "https://yt3.googleusercontent.com/jfFesr01zBjJ6NB8pOJb89vQegabAqa49dv-v_vCH8oM41sSM89-u4Gzb0B0DWtCI-25co0hjNVq2Lev=w544-h544-l90-rj" },
    { title: "AURA", artist: "Ogryzek", kind: "phonk", art: "https://yt3.googleusercontent.com/WYxvQkyHVO_x-yc9aqVYiKnBAXwXEwZQdw9ztHgtd6Kh-sw0mu_XOLgTz5-ODbcAFT4CRARgQunmkPY1=w544-h544-l90-rj" },
    { title: "Counting Stars", artist: "OneRepublic", kind: "english", art: "https://yt3.googleusercontent.com/m2pZLjozMvQBj21LgvAIslVPP-T2xQlxbxCTJ98vpPN8HZ0fgR-wisJQ2IzrKS2yLTAYBjs0TpOYnIY=w544-h544-l90-rj" },
    { title: "Brown Munde", artist: "AP Dhillon", kind: "indian", art: "https://yt3.googleusercontent.com/61uwz4Fic91-Ot8PmBTt-Ln5-N1sK4UnANdyVHqaQRsawpDwIXRxd6yEwqxvIxKUVcDnCutrAFQyG5q3=w544-h544-l90-rj" },
  ],
];

/** Rings on the drum. */
export const RINGS = DRUM.length;

/** Which place on a ring faces the viewer when the ring is turned `angle` degrees. */
export function frontTile(angle: number, count = PER_RING): number {
  return ((Math.round(-angle / (360 / count)) % count) + count) % count;
}
