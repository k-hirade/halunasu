// ブラウザ内で評価する計測スクリプト（ui-audit.mjs から読み込む）。文字サイズ分布・コントラスト・タップ領域・横あふれを返す。
(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("nextjs-portal"); };
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const layers = []; let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } e = e.parentElement; } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base); return base; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const desc = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
  // text elements
  const textEls = [...document.querySelectorAll("body *")].filter((el) => !el.closest("nextjs-portal") && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(el));
  const sizes = {}; const lhs = {}; const smallest = []; const fails = [];
  for (const el of textEls) {
    const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize);
    const chars = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("").length;
    sizes[fs] = (sizes[fs] || 0) + chars;
    const lh = cs.lineHeight === "normal" ? "normal" : (parseFloat(cs.lineHeight) / fs).toFixed(2);
    lhs[lh] = (lhs[lh] || 0) + 1;
    const txt = el.innerText?.replace(/\s+/g, " ").slice(0, 30) || "";
    if (fs < 13) smallest.push({ fs, sel: desc(el), txt });
    const fg = parse(cs.color); if (!fg) continue; const bg = bgOf(el); const fgB = blend({ ...fg, a: fg.a * (parseFloat(cs.opacity) || 1) }, bg);
    const r = ratio(fgB, bg); const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
    if (r < (large ? 3 : 4.5)) fails.push({ r: +r.toFixed(2), fs, sel: desc(el), txt, fg: cs.color, bg: `rgb(${bg.r|0},${bg.g|0},${bg.b|0})` });
  }
  // placeholders
  const ph = [...document.querySelectorAll("input[placeholder],textarea[placeholder]")].filter(vis).slice(0, 1).map((el) => { const c = parse(getComputedStyle(el, "::placeholder").color); return c ? { ph: el.placeholder, r: +ratio(blend(c, bgOf(el)), bgOf(el)).toFixed(2), color: getComputedStyle(el, "::placeholder").color } : null; });
  const inter = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=tab],summary,[tabindex]:not([tabindex='-1'])")].filter(vis);
  const t = inter.map((el) => { const r = el.getBoundingClientRect(); let w = r.width, h = r.height; if (el.type === "checkbox" || el.type === "radio") { const l = el.closest("label"); if (l) { const lr = l.getBoundingClientRect(); w = lr.width; h = lr.height; } } return { sel: desc(el), type: el.type || "", txt: (el.innerText || el.getAttribute("aria-label") || el.labels?.[0]?.innerText || "").replace(/\s+/g, " ").slice(0, 20), w: Math.round(w), h: Math.round(h), inView: r.top < innerHeight && r.bottom > 0 }; });
  const minDim = (x) => Math.min(x.w, x.h);
  const hist = {}; for (const x of t) { const k = x.h; hist[k] = (hist[k] || 0) + 1; }
  const overflowEls = [...document.querySelectorAll("body *")].filter((el) => !el.closest("nextjs-portal") && vis(el) && el.getBoundingClientRect().right > innerWidth + 1).filter((el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= innerWidth + 1).slice(0, 8).map((el) => desc(el) + " right=" + Math.round(el.getBoundingClientRect().right) + " w=" + Math.round(el.getBoundingClientRect().width));
  return {
    url: location.pathname, innerWidth, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, overflowX: document.documentElement.scrollWidth > innerWidth, overflowEls,
    bodyFont: getComputedStyle(document.body).fontSize, bodyFamily: getComputedStyle(document.body).fontFamily, bodyLH: getComputedStyle(document.body).lineHeight,
    fontSizesByChars: Object.fromEntries(Object.entries(sizes).sort((a, b) => +a[0] - +b[0])), lineHeights: lhs,
    smallestSamples: smallest.sort((a, b) => a.fs - b.fs).slice(0, 15),
    contrastChecked: textEls.length, contrastFails: fails.length, contrastFailSamples: fails.sort((a, b) => a.r - b.r).slice(0, 15), placeholder: ph,
    interactiveTotal: t.length, interactiveInView: t.filter((x) => x.inView).length,
    under24: t.filter((x) => minDim(x) < 24).length, under32: t.filter((x) => minDim(x) < 32).length, under44: t.filter((x) => minDim(x) < 44).length,
    heightHist: hist, smallTargets: t.filter((x) => minDim(x) < 32).slice(0, 25).map((x) => `${x.sel}[${x.type}] "${x.txt}" ${x.w}x${x.h}`)
  };
})()
