// ブラウザ内で評価する計測スクリプト（ui-audit.mjs から読み込む）。文字サイズ分布・コントラスト・タップ領域・横あふれを返す。
// responsive: はみ出し・切れ・スクロールできない枠・隠れた操作・小さいタップ領域/文字・文字の重なりを要素ごとに返す
// （各項目は { sel, rect: [x, y, w, h], reason, txt, ... }）。隠れた操作の確認で画面をスクロールするので、撮影の後に呼ぶ。
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
  const responsive = responsiveIssues();
  return {
    responsive,
    url: location.pathname, innerWidth, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, overflowX: document.documentElement.scrollWidth > innerWidth, overflowEls,
    bodyFont: getComputedStyle(document.body).fontSize, bodyFamily: getComputedStyle(document.body).fontFamily, bodyLH: getComputedStyle(document.body).lineHeight,
    fontSizesByChars: Object.fromEntries(Object.entries(sizes).sort((a, b) => +a[0] - +b[0])), lineHeights: lhs,
    smallestSamples: smallest.sort((a, b) => a.fs - b.fs).slice(0, 15),
    contrastChecked: textEls.length, contrastFails: fails.length, contrastFailSamples: fails.sort((a, b) => a.r - b.r).slice(0, 15), placeholder: ph,
    interactiveTotal: t.length, interactiveInView: t.filter((x) => x.inView).length,
    under24: t.filter((x) => minDim(x) < 24).length, under32: t.filter((x) => minDim(x) < 32).length, under44: t.filter((x) => minDim(x) < 44).length,
    heightHist: hist, smallTargets: t.filter((x) => minDim(x) < 32).slice(0, 25).map((x) => `${x.sel}[${x.type}] "${x.txt}" ${x.w}x${x.h}`)
  };

  function responsiveIssues() {
    const W = innerWidth, H = innerHeight;
    const out = { docOverflowX: 0, docOverflowY: 0, offViewport: [], clipped: [], ellipsisNoTitle: [], bleed: [], unscrollable: [], covered: [], coveredByOverlay: 0, scrollLock: null, tinyTargets: [], tinyText: [], textOverlap: [], checkedInteractive: 0 };
    const cssOf = (el) => getComputedStyle(el);
    const R = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    const text = (el) => (el.getAttribute?.("aria-label") || el.innerText || el.value || el.getAttribute?.("title") || "").replace(/\s+/g, " ").trim().slice(0, 40);
    // 選択子の 1 段: タグ + id か クラス 2 つ（is-/has- の状態クラスは除く）+ 同じ形の兄弟があれば何番目か
    const seg = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id && !/^[«:]|^radix/u.test(el.id)) return `${s}#${el.id}`;
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter((c) => c && !/^(is-|has-)/u.test(c)).slice(0, 2) : [];
      if (cls.length) s += `.${cls.join(".")}`;
      const role = el.getAttribute("role");
      if (role && !cls.length) s += `[role=${role}]`;
      const label = el.getAttribute("aria-label");
      if (label && label.length < 24) s += `[aria-label="${label}"]`;
      const p = el.parentElement;
      if (p && !el.id) {
        const sameTag = [...p.children].filter((c) => c.tagName === el.tagName);
        if (sameTag.filter((c) => c.className === el.className).length > 1) s += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
      }
      return s;
    };
    const path = (el) => { const parts = []; let e = el; while (e && e !== document.body && e.nodeType === 1 && parts.length < 5) { parts.unshift(seg(e)); if (e.id) break; e = e.parentElement; } return parts.join(" > "); };
    const shown = (el) => {
      if (el.closest("nextjs-portal")) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
    };
    const srOnly = (el) => { const r = el.getBoundingClientRect(); const cs = cssOf(el); return (r.width <= 2 && r.height <= 2) || cs.clip === "rect(0px, 0px, 0px, 0px)" || cs.clipPath === "inset(50%)" || el.classList?.contains("sr-only"); };
    const isGraphic = (el) => Boolean(el.closest("svg")) || ["IMG", "CANVAS", "VIDEO", "PICTURE", "IFRAME"].includes(el.tagName);
    const all = [...document.querySelectorAll("body *")].filter((el) => !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "LINK", "META", "BR", "OPTION", "OPTGROUP", "DATALIST"].includes(el.tagName));
    const visible = all.filter(shown);
    const visSet = new Set(visible);
    const add = (list, el, reason, extra = {}, limit = 40) => { if (out[list].length < limit) out[list].push({ sel: path(el), rect: R(el.getBoundingClientRect()), reason, txt: text(el), ...extra }); };
    // 最も近い、はみ出しを切り取る（またはスクロールする）祖先。fixed の箱を越えては探さない
    const clipAncestor = (el, axis) => {
      let e = el.parentElement;
      while (e && e !== document.body && e !== document.documentElement) {
        const cs = cssOf(e);
        if ((axis === "x" ? cs.overflowX : cs.overflowY) !== "visible") return e;
        if (cs.position === "fixed") return null;
        e = e.parentElement;
      }
      return null;
    };
    // 箱のうち、祖先の切り取り（overflow が visible 以外）と画面の内側に見えている部分。見えなければ null
    const visiblePart = (el, box) => {
      let b = { ...box };
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = cssOf(e);
        const er = e.getBoundingClientRect();
        if (cs.overflowX !== "visible") { b.left = Math.max(b.left, er.left); b.right = Math.min(b.right, er.right); }
        if (cs.overflowY !== "visible") { b.top = Math.max(b.top, er.top); b.bottom = Math.min(b.bottom, er.bottom); }
        if (cs.position === "fixed") break;
      }
      b = { left: Math.max(b.left, 0), top: Math.max(b.top, 0), right: Math.min(b.right, W), bottom: Math.min(b.bottom, H) };
      return b.right - b.left > 1 && b.bottom - b.top > 1 ? b : null;
    };
    // el から祖先 stop までの間に absolute/fixed の箱があるか（浮いた層の中の要素）
    const floatsWithin = (el, stop) => { for (let e = el; e && e !== stop; e = e.parentElement) { const p = cssOf(e).position; if (p === "absolute" || p === "fixed") return true; } return false; };
    const fixedAncestor = (el) => { let e = el; while (e && e !== document.body) { if (cssOf(e).position === "fixed") return e; e = e.parentElement; } return null; };
    const docEl = document.documentElement;
    out.docOverflowX = Math.max(0, docEl.scrollWidth - W);
    out.docOverflowY = Math.max(0, docEl.scrollHeight - H);

    // 1. 画面の右端（左端）より外へ出ている要素。切り取る祖先の内側で、その祖先が画面内にあれば問題にしない。親も出ていれば親だけ出す
    for (const el of visible) {
      if (srOnly(el) || isGraphic(el)) continue;
      const r = el.getBoundingClientRect();
      const off = r.right > W + 1 ? "right" : r.left < -1 ? "left" : "";
      if (!off) continue;
      const clip = clipAncestor(el, "x");
      if (clip) { const cr = clip.getBoundingClientRect(); if (cr.right <= W + 1 && cr.left >= -1) continue; }
      const p = el.parentElement;
      if (p && visSet.has(p)) { const pr = p.getBoundingClientRect(); if ((off === "right" && pr.right > W + 1) || (off === "left" && pr.left < -1)) continue; }
      add("offViewport", el, off === "right" ? `右端が画面外 (right=${Math.round(r.right)} > ${W})` : `左端が画面外 (left=${Math.round(r.left)})`, { fixed: Boolean(fixedAncestor(el)) });
    }

    // 2. 切れ: overflow hidden/clip で中身が箱より大きい。1 行の省略記号（…）は title・aria-label があれば意図どおり
    for (const el of visible) {
      if (isGraphic(el) || srOnly(el) || ["INPUT", "TEXTAREA", "SELECT", "HTML", "BODY"].includes(el.tagName)) continue;
      const cs = cssOf(el);
      const hx = cs.overflowX === "hidden" || cs.overflowX === "clip";
      const hy = cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (!hx && !hy) continue;
      if (el.clientWidth === 0 || el.clientHeight === 0) continue;
      const dx = hx ? el.scrollWidth - el.clientWidth : 0;
      const dy = hy ? el.scrollHeight - el.clientHeight : 0;
      if (dx <= 2 && dy <= 2) continue;
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
      if (cs.textOverflow === "ellipsis" || clamp) {
        const titled = el.title || el.closest("[title]") || (el.closest("[aria-label]")?.getAttribute("aria-label") || "").length > 8;
        if (!titled) add("ellipsisNoTitle", el, `${clamp ? "行数の省略" : "省略記号（…）"}で切れ、全文を見る手段（title）がない (+${dx}px 横 / +${dy}px 縦)`, {}, 30);
        if (clamp || dy <= 2) continue;
      }
      // 中に見える文字・操作が箱の外にあるか（装飾の枠を除くため）
      const r = el.getBoundingClientRect();
      const kids = [...el.querySelectorAll("*")].filter((k) => visSet.has(k) && !srOnly(k) && !isGraphic(k) && ([...k.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || k.matches("button,a[href],input,select,textarea")));
      const outside = kids.filter((k) => { const kr = k.getBoundingClientRect(); return (hx && (kr.right > r.right + 2 || kr.left < r.left - 2)) || (hy && (kr.bottom > r.bottom + 2 || kr.top < r.top - 2)); });
      if (!outside.length && dx + dy < 24) continue;
      add("clipped", el, `overflow:${cs.overflowX}/${cs.overflowY} で中身が切れる (+${dx}px 横 / +${dy}px 縦, 箱の外の要素 ${outside.length})`, {
        size: { client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight] },
        hidden: outside.slice(0, 3).map((k) => `${seg(k)} "${text(k)}"`)
      });
    }

    // 3. はみ出しが隣へ重なる: overflow visible の箱から子がはみ出し、兄弟の箱に重なる
    for (const el of visible) {
      // 表の行（rowspan のセルは行の外へ伸びる）と、浮いた層の中は除く
      if (isGraphic(el) || srOnly(el) || ["HTML", "BODY", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "TR", "TBODY", "THEAD", "TFOOT", "TABLE"].includes(el.tagName)) continue;
      const cs = cssOf(el);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible" || cs.display === "inline" || cs.display === "contents" || cs.position === "fixed") continue;
      const dx = el.scrollWidth - el.clientWidth, dy = el.scrollHeight - el.clientHeight;
      if (dx <= 2 && dy <= 2) continue;
      const sibs = el.parentElement ? [...el.parentElement.children].filter((s) => s !== el && visSet.has(s) && !["absolute", "fixed"].includes(cssOf(s).position)) : [];
      if (!sibs.length) continue;
      const r = el.getBoundingClientRect();
      const kids = [...el.querySelectorAll("*")].filter((k) => visSet.has(k) && !isGraphic(k) && !srOnly(k) && !floatsWithin(k, el));
      let hit = null;
      for (const k of kids) {
        const kr = k.getBoundingClientRect();
        if (kr.right <= r.right + 2 && kr.bottom <= r.bottom + 2 && kr.left >= r.left - 2 && kr.top >= r.top - 2) continue;
        for (const s of sibs) {
          if (s.contains(k)) continue;
          const sr = s.getBoundingClientRect();
          const ix = Math.min(kr.right, sr.right) - Math.max(kr.left, sr.left), iy = Math.min(kr.bottom, sr.bottom) - Math.max(kr.top, sr.top);
          if (ix > 3 && iy > 3) { hit = { k, s }; break; }
        }
        if (hit) break;
      }
      if (hit) add("bleed", el, `子が箱の外へはみ出し、隣の要素に重なる (+${dx}px 横 / +${dy}px 縦)`, { child: `${seg(hit.k)} "${text(hit.k)}"`, neighbour: `${path(hit.s)} "${text(hit.s).slice(0, 20)}"` }, 30);
    }

    // 4. スクロールできない枠: fixed/sticky/ダイアログ/メニューの中身が画面（または max-height）を超えているのにスクロールしない
    const openModal = [...document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")].filter(shown);
    const scrollsY = (cs) => cs.overflowY === "auto" || cs.overflowY === "scroll";
    // fixed の層の中で、el より外側（fixed の箱まで）にあるスクロール枠。あれば el はその枠で届くので、枠の側で判断する
    const scrollParentInLayer = (el) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const cs = cssOf(e);
        if (scrollsY(cs) && e.scrollHeight > e.clientHeight + 2) return e;
        if (cs.position === "fixed") return null;
      }
      return null;
    };
    const panes = visible.filter((el) => {
      const cs = cssOf(el);
      return cs.position === "fixed" || cs.position === "sticky" || (cs.position === "absolute" && parseInt(cs.zIndex || "0", 10) > 0)
        || el.matches("dialog[open],[role=dialog],[role=alertdialog],[role=menu],[role=listbox],details[open] > :not(summary)")
        || (scrollsY(cs) && fixedAncestor(el));
    });
    for (const el of panes) {
      if (srOnly(el) || isGraphic(el)) continue;
      const cs = cssOf(el);
      const r = el.getBoundingClientRect();
      if (r.height < 24) continue;
      const scrolls = scrollsY(cs);
      const fixedLike = cs.position === "fixed" || Boolean(fixedAncestor(el));
      if (fixedLike && scrollParentInLayer(el)) continue;
      const inner = [...el.querySelectorAll("*")].some((k) => scrollsY(cssOf(k)) && k.scrollHeight > k.clientHeight + 2);
      // 箱の下端（overflow visible なら、はみ出した中身の下端）
      const bottom = !scrolls && cs.overflowY === "visible" ? r.top + Math.max(el.scrollHeight, r.height) : r.bottom;
      const maxH = parseFloat(cs.maxHeight);
      if (!scrolls && cs.overflowY !== "visible" && el.scrollHeight > el.clientHeight + 2 && !inner) add("unscrollable", el, `中身 ${el.scrollHeight}px が枠 ${el.clientHeight}px を超えるのに overflow-y:${cs.overflowY}`, { position: cs.position });
      else if (!scrolls && Number.isFinite(maxH) && el.scrollHeight > maxH + 2 && !inner) add("unscrollable", el, `中身 ${el.scrollHeight}px が max-height ${maxH}px を超えるのにスクロールしない`, { position: cs.position });
      else if (fixedLike && bottom > H + 2) add("unscrollable", el, `${cs.position}${cs.position === "fixed" ? "" : "（fixed の層の中）"} の${scrolls ? "スクロール枠" : "枠"}の下端 ${Math.round(bottom)}px が画面の高さ ${H}px より下（スクロールで届かない）`, { position: cs.position, scrollable: scrolls });
      else if (fixedLike && r.top < -2) add("unscrollable", el, `${cs.position} の枠の上端 ${Math.round(r.top)}px が画面より上（届かない）`, { position: cs.position });
      else if (cs.position === "sticky") {
        let sc = el.parentElement; while (sc && sc !== document.body && !scrollsY(cssOf(sc))) sc = sc.parentElement;
        const viewH = sc && sc !== document.body ? sc.clientHeight : H;
        // 横に並ぶ側の枠（左右のペイン）は除き、幅の広い上下の帯だけを見る
        if (r.height > viewH * 0.6 && viewH > 0 && r.width > W * 0.6) add("unscrollable", el, `sticky の枠がスクロール領域の高さの ${Math.round((r.height / viewH) * 100)}% を占め、下の中身が読めない`, { position: cs.position });
      }
    }
    // 本文のスクロールが止められたまま、画面より下に中身がある（ダイアログが開いていないとき）
    const lock = ["hidden", "clip"].includes(cssOf(docEl).overflowY) || ["hidden", "clip"].includes(cssOf(document.body).overflowY);
    if (lock && out.docOverflowY > 2 && !openModal.length) out.scrollLock = `html/body が overflow hidden のまま、${out.docOverflowY}px の中身が画面外`;

    // 5. 小さいタップ領域（幅 1024px 以下）・小さい文字・文字の重なり
    const interactive = visible.filter((el) => el.matches("a[href],button,input:not([type=hidden]),select,textarea,[role=tab],[role=button],summary") && !srOnly(el));
    if (W <= 1024) {
      for (const el of interactive) {
        let r = el.getBoundingClientRect();
        if ((el.type === "checkbox" || el.type === "radio") && el.closest("label")) r = el.closest("label").getBoundingClientRect();
        if (Math.min(r.width, r.height) < 32) add("tinyTargets", el, `タップ領域 ${Math.round(r.width)}×${Math.round(r.height)}px (<32)`, {}, 80);
      }
    }
    const textEls = visible.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !srOnly(el));
    for (const el of textEls) { const fs = parseFloat(cssOf(el).fontSize); if (fs < 11) add("tinyText", el, `文字 ${fs}px (<11)`, {}, 30); }
    // 文字そのものの範囲（Range）同士が重なるか。同じ重ね合わせの層（最も近い fixed/absolute/sticky の祖先）どうしだけ比べる
    const textBox = (el) => {
      const range = document.createRange();
      let box = null;
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        range.selectNodeContents(n);
        const b = range.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        box = box ? { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) } : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      }
      return box ? visiblePart(el, box) : null;
    };
    const layerOf = (el) => { let e = el.parentElement; while (e && e !== document.body) { const p = cssOf(e).position; if (p === "fixed" || p === "absolute" || p === "sticky") return e; e = e.parentElement; } return document.body; };
    const boxes = textEls.map((el) => ({ el, b: textBox(el), layer: layerOf(el) })).filter((x) => x.b);
    for (let i = 0; i < boxes.length && out.textOverlap.length < 30; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i], c = boxes[j];
        if (a.layer !== c.layer || a.el.contains(c.el) || c.el.contains(a.el)) continue;
        const ix = Math.min(a.b.right, c.b.right) - Math.max(a.b.left, c.b.left), iy = Math.min(a.b.bottom, c.b.bottom) - Math.max(a.b.top, c.b.top);
        if (ix <= 2 || iy <= 3) continue;
        out.textOverlap.push({ sel: path(a.el), other: path(c.el), rect: [Math.round(Math.max(a.b.left, c.b.left)), Math.round(Math.max(a.b.top, c.b.top)), Math.round(ix), Math.round(iy)], reason: `文字が ${Math.round(ix)}×${Math.round(iy)}px 重なる`, txt: `"${text(a.el).slice(0, 20)}" / "${text(c.el).slice(0, 20)}"` });
        if (out.textOverlap.length >= 30) break;
      }
    }

    // 6. 隠れた操作: 中央へスクロールして、中心の点の要素が自分（子・ラベル）か。モーダルが開いていればその中だけ。
    //    開いたメニュー・ポップオーバーの下になった操作は数だけ数える（coveredByOverlay）
    const scope = openModal.length ? openModal[openModal.length - 1] : null;
    const saved = [docEl, ...visible].filter((el) => el.scrollTop || el.scrollLeft).map((el) => [el, el.scrollTop, el.scrollLeft]);
    const floatingLayer = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const p = cssOf(e).position; if (p === "absolute" || p === "fixed" || p === "sticky") return e; } return null; };
    const overlayOf = (el) => el.closest("[role=dialog],[role=menu],[role=listbox],[role=tooltip],dialog,details[open],[popover],.drawer-backdrop,.dialog-backdrop");
    const backdrop = visible.find((el) => { if (cssOf(el).position !== "fixed") return false; const r = el.getBoundingClientRect(); return r.width >= W * 0.9 && r.height >= H * 0.75 && !el.querySelector("a[href],input,select,textarea,[role=tab]"); });
    const targets = interactive.filter((el) => (!scope || scope.contains(el)) && !el.disabled).slice(0, 500);
    out.checkedInteractive = targets.length;
    const scrolled = new Set();
    for (const el of targets) {
      const ecs = cssOf(el);
      const probe = (parseFloat(ecs.opacity) === 0 || ecs.pointerEvents === "none") && el.labels?.[0] ? el.labels[0] : el;
      for (let e = probe.parentElement; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth) scrolled.add(e);
      try { probe.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch { probe.scrollIntoView(); }
      const r = probe.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), W - 1), cy = r.top + r.height / 2;
      if (cy < 0 || cy >= H || r.left + r.width / 2 >= W || r.right < 0) { add("covered", el, `スクロールしても画面内に入らない (中心 ${Math.round(r.left + r.width / 2)},${Math.round(cy)})`, {}, 40); continue; }
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || hit === el || el.contains(hit) || probe.contains(hit) || (el.labels && [...el.labels].some((l) => l.contains(hit)))) continue;
      if (hit.closest("nextjs-portal")) continue;
      // 開いたメニュー・ポップオーバー・テンキー（フォーカスのある欄のすぐ隣の浮いた層）の下になったものは数だけ
      const layer = floatingLayer(hit);
      const active = document.activeElement;
      const nearActive = (() => { if (!layer || !layer.parentElement || !active || active === document.body || layer.contains(el)) return false; let depth = 0; for (let e = active; e && depth <= 3; e = e.parentElement, depth += 1) if (e === layer.parentElement) return true; return false; })();
      // 引き出し（背景の幕つきの fixed の層）が開いているとき、その下の本文は覆われて当然
      const underDrawer = backdrop && layer && !layer.contains(el) && floatingLayer(el) !== layer;
      if ((!scope && overlayOf(hit) && !overlayOf(el)) || nearActive || underDrawer) { out.coveredByOverlay += 1; continue; }
      add("covered", el, `中央 (${Math.round(cx)},${Math.round(cy)}) が別の要素に覆われる`, { by: path(hit), byText: text(hit).slice(0, 20), byLayer: layer ? cssOf(layer).position : "flow" }, 40);
    }
    for (const el of scrolled) { el.scrollTop = 0; el.scrollLeft = 0; }
    window.scrollTo(0, 0);
    for (const [el, top, left] of saved) { el.scrollTop = top; el.scrollLeft = left; }
    return out;
  }
})()
