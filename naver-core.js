// ==UserScript==
// @name         네이버 상품 수집 → Lucy JSON (독립/로컬)
// @namespace    https://local.naver.scraper/
// @version      2.9.5
// @description  네이버 상품설명·후기를 긁어 쿠팡 도구와 동일한 shopping_product_v1 JSON으로 뽑고, 라스(lucystar.kr) 숨은 '상품 JSON 데이터' 칸에 자동으로 꽂아줌. 이미지는 파일로 저장해 캐릭터에 업로드. 화면 DOM만 다룸.
// @match        https://smartstore.naver.com/*
// @match        https://brand.naver.com/*
// @match        https://shopping.naver.com/*
// @match        https://lucystar.kr/script/studio*
// @match        https://lucystar.kr/script/studio/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @grant        GM_xmlhttpRequest
// @connect      pstatic.net
// @connect      naver.net
// @connect      naver.com
// ==/UserScript==
// ※ GM_setValue/GM_getValue = 템퍼몽키 로컬 저장소(네이버→라스 값 전달, 외부 아님).
// ※ GM_xmlhttpRequest = 네이버 상품 이미지를 받아 base64로 변환하기 위함(네이버 CDN에서만
//    받아옴, 개발자 서버 안 거침). @connect도 네이버 도메인만 허용.

(function () {
  "use strict";

  /* =========================================================================
   *  네이버 상품 수집 → Lucy(라스) 붙여넣기용 JSON 생성
   *  - 화면 DOM만 읽음. lucystar.kr/외부 서버로 아무것도 안 보냄.
   *  - 출력: 쿠팡 도구와 동일한 schema_version "shopping_product_v1" (source:"naver")
   *  - 네이버는 클래스명이 해시라서 "이름"이 아니라 "구조"로 긁음:
   *      · 후기 = <div id="REVIEW"> 안에서 날짜(YY.MM.DD) 들어간 항목들
   *      · 상세 = "상세정보 펼쳐보기" 눌러 펼친 뒤 .se-main-container
   * ========================================================================= */

  const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
  // ★ 릴리스 규칙: 아래 "2.9.5" 를 올릴 때 naver-loader.user.js 의 @version 도 같은 숫자로 맞추세요.
  const VERSION = "v" + ((typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "2.9.5");

  const CFG = {
    reviewMaxPages: 8,    // 후기 페이지 최대 몇 장 넘길지
    reviewTarget: 20,     // 목표 후기 개수
    imageCount: 2,        // 기본 선택 이미지 수
    candidateMax: 20,     // 선택 후보로 보여줄 이미지 최대 수
    imgMinPx: 60,         // 이 픽셀 미만은 아이콘으로 보고 제외 (캐러셀 못 찾은 폴백에서만)
    imgSaveSize: 900,     // '이미지 파일 저장' 시 최대 픽셀
    imgQuality: 0.85,     // '이미지 파일 저장' JPEG 품질
    pageWaitMs: 1100,
    lazyScrollWaitMs: 300,
  };

  function txt(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "")
      .replace(/ /g, " ").replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function metaContent(prop) {
    const m = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
    return m && m.content ? m.content.trim() : "";
  }
  // 텍스트로 버튼/탭 클릭
  function clickByText(sel, test) {
    for (const n of document.querySelectorAll(sel)) {
      const t = (n.innerText || n.textContent || "").trim();
      if (t && test(t) && visible(n)) { n.click(); return n; }
    }
    return null;
  }
  async function scrollElementIntoLoad(el) {
    if (el) el.scrollIntoView({ block: "center" });
    for (let i = 0; i < 8; i++) { window.scrollBy(0, 700); await SLEEP(CFG.lazyScrollWaitMs); }
  }

  // ---- 기본 정보 --------------------------------------------------------
  function getTitle() {
    return metaContent("og:title") || txt(document.querySelector("h3,h1,h2")) || document.title;
  }
  function wonFrom(n) { const d = String(n).replace(/[^\d]/g, ""); return d ? Number(d).toLocaleString() + "원" : ""; }
  // 가격: 메타태그/구조화데이터 우선(정확). 실패 시에만 화면에서 추정.
  function getPrice() {
    // 1) 메타태그
    const meta = metaContent("product:price:amount") || metaContent("og:product:price:amount") || metaContent("product:sale_price:amount");
    if (meta) { const w = wonFrom(meta); if (w) return w; }
    // 2) JSON-LD offers.price
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const list = [].concat(JSON.parse(s.textContent));
        for (const o of list) {
          const off = o && o.offers;
          const p = off && (off.price || (Array.isArray(off) && off[0] && off[0].price) || off.lowPrice);
          if (p) { const w = wonFrom(p); if (w) return w; }
        }
      } catch (_) {}
    }
    // 3) 화면 폴백: '숫자원' 한 덩어리 중 취소선 아닌 큰 폰트
    let best = "", bestSize = 0;
    for (const e of document.querySelectorAll("strong, em, span, div")) {
      if (!visible(e)) continue;
      const m = (e.innerText || "").replace(/\s/g, "").match(/^(\d[\d,]{3,})원$/);  // 최소 4자리(적립금 등 소액 배제 성향)
      if (!m) continue;
      if ((getComputedStyle(e).textDecorationLine || "").includes("line-through")) continue;
      const size = parseFloat(getComputedStyle(e).fontSize) || 0;
      if (size > bestSize) { bestSize = size; best = m[1] + "원"; }
    }
    return best;
  }
  function getIds() {
    const productId = (location.pathname.match(/\/products\/(\d+)/) || [])[1] || "";
    const store = (location.pathname.match(/^\/([^/]+)\//) || [])[1] || "";
    return { productId, store };
  }
  // 상단 좌측 갤러리 영역의 상품 이미지 후보(썸네일 포함).
  // 같은 사진(base 동일)은 하나로 합치되, 가장 큰 버전의 URL을 유지.
  function getImageCandidates() {
    const byBase = new Map();
    const consider = (url, area) => {
      if (!url) return;
      const base = url.split("?")[0];
      const cur = byBase.get(base);
      if (!cur || area > cur.area) byBase.set(base, { url, area });
    };
    const og = metaContent("og:image");
    if (og) consider(og, 1e12);   // 대표 이미지 최우선
    // 갤러리 썸네일 스트립(Flicking 캐러셀) — 크기 상관없이 전부(40×40 썸네일 포함)
    document.querySelectorAll(".flicking-camera img, .flicking-viewport img").forEach((im) => {
      const src = im.getAttribute("data-src") || im.currentSrc || im.src;
      if (src && /pstatic|phinf/.test(src)) consider(src, (im.naturalWidth || im.width) * (im.naturalHeight || im.height));
    });
    // 폴백: 캐러셀을 못 찾으면 상단 좌측 영역의 큰 이미지들
    if (byBase.size <= 1) {
      document.querySelectorAll('img[src*="pstatic"], img[src*="phinf"]').forEach((im) => {
        const r = im.getBoundingClientRect();
        const top = r.top + window.scrollY, left = r.left + window.scrollX;
        if (top < 0 || top >= 1300 || left >= 820) return;
        const nw = im.naturalWidth || im.width, nh = im.naturalHeight || im.height;
        if (nw < CFG.imgMinPx || nh < CFG.imgMinPx) return;
        consider(im.src, nw * nh);
      });
    }
    return [...byBase.values()].map((x) => x.url).slice(0, CFG.candidateMax);
  }

  // ── 이미지 → base64 데이터URI (네이버 CDN에서 직접 받아 축소) ─────────────
  const b64cache = new Map();
  function xhrBlob(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET", url, responseType: "blob",
        headers: { Referer: location.origin + "/" },
        onload(r) { (r.status >= 200 && r.status < 300 && r.response) ? resolve(r.response) : resolve(null); },
        onerror() { resolve(null); }, ontimeout() { resolve(null); },
      });
    });
  }
  function blobToDataURL(blob) {
    return new Promise((resolve) => {
      const objurl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const max = CFG.imgSaveSize;
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, max / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        const c = document.createElement("canvas"); c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(objurl);
        try { resolve(c.toDataURL("image/jpeg", CFG.imgQuality)); } catch (_) { resolve(null); }
      };
      img.onerror = () => { URL.revokeObjectURL(objurl); resolve(null); };
      img.src = objurl;
    });
  }
  async function toDataURL(url) {
    if (b64cache.has(url)) return b64cache.get(url);
    const base = url.split("?")[0];
    let data = null;
    for (const u of [base, base + "?type=w800", url]) {   // 원본(풀사이즈) 우선, 폴백
      const blob = await xhrBlob(u);
      if (blob) { data = await blobToDataURL(blob); if (data) break; }
    }
    b64cache.set(url, data);
    return data;
  }
  // 로고/배너로 추정되는 이미지(기본 선택에서 제외). 파일명 '로고'(EUC-KR %B7%CE%B0%ED) 또는 초대형 type
  function isLikelyLogo(url) {
    return /logo|%B7%CE%B0%ED/i.test(url) || /type=m?1?0000/i.test(url);
  }
  function defaultSelected(candidates) {
    const real = candidates.filter((u) => !isLikelyLogo(u));
    const pick = (real.length ? real : candidates).slice(0, CFG.imageCount);
    return pick;
  }
  function getImages() { return defaultSelected(getImageCandidates()); }
  function getCategoryPath() {
    const bc = document.querySelector('[class*="breadcrumb"], nav[aria-label*="경로"]');
    if (bc) return [...bc.querySelectorAll("a,span,li")].map(txt).filter((t) => t && t.length < 30);
    return [];
  }
  function getSeller() {
    // ⚠️ 계정 메뉴("qud 내정보 보기")를 판매자로 오인하지 않도록 방어
    let s = (metaContent("og:site_name") || "").split("\n")[0].trim();
    if (/내정보|로그인|로그아웃|마이페이지|장바구니|관심상품/.test(s)) s = "";
    if (!s) s = getIds().store;   // URL 스토어 슬러그(예: jugend)
    return s;
  }
  function getDeliveryBadges() {
    const body = document.body.innerText || "";
    const badges = [];
    ["네이버도착보장", "도착보장", "오늘출발", "무료배송", "빠른배송", "당일발송"]
      .forEach((k) => { if (body.includes(k) && !badges.includes(k)) badges.push(k); });
    const arrival = (body.match(/[^\n]{0,20}도착[^\n]{0,15}/) || [""])[0].trim().slice(0, 40);
    return {
      badges,
      is_rocket: false,
      is_free_shipping: badges.some((b) => b.includes("무료")) || body.includes("배송비 무료"),
      arrival_text: arrival,
      rocket_delivery: "해당없음",
    };
  }
  function getOptions() {
    const opts = [];
    document.querySelectorAll("select option").forEach((o) => {
      const t = txt(o);
      if (t && !/선택|옵션 선택|^-{2,}$/.test(t)) opts.push(t);
    });
    return [...new Set(opts)].slice(0, 60);
  }
  // 상품정보 스펙표(상품번호/제조사/브랜드/모델명/품번/원산지/제조일자/화면크기/인증정보)
  function getSpec() {
    const KEYS = ["상품번호", "제조사", "브랜드", "모델명", "품번", "원산지", "제조일자", "제조연월", "화면크기", "인증정보", "출시년월"];
    const spec = {};
    document.querySelectorAll("li").forEach((li) => {
      const divs = [...li.children].filter((c) => c.tagName === "DIV");
      if (divs.length >= 2) {
        const k = txt(divs[0]).replace(/\s+/g, ""), v = txt(divs[1]);
        if (KEYS.includes(k) && v && !spec[k]) spec[k] = v.replace(/복사$/, "").trim();
      }
    });
    return spec;
  }

  // ---- 상세설명 ---------------------------------------------------------
  async function scrapeDescription() {
    clickByText("a,button,li,span", (t) => /^상세정보$|^상품정보$/.test(t));
    await SLEEP(700);
    // "상세정보 펼쳐보기" 펼치기 (여러 번 나올 수 있어 모두 시도)
    for (let i = 0; i < 3; i++) {
      const b = clickByText("button,a", (t) => t.includes("펼쳐보기"));
      if (!b) break; await SLEEP(500);
    }
    await scrollElementIntoLoad(document.getElementById("INTRODUCE"));
    const boxes = [...document.querySelectorAll(".se-main-container")];
    let out = boxes.map(txt).filter(Boolean).join("\n\n");
    if (!out) {
      const d = document.getElementById("INTRODUCE") ||
        document.querySelector('[class*="detail"] .se-main-container');
      out = txt(d);
    }
    // 이미지만 있는 상세 대비
    if (!out) {
      const imgs = document.querySelectorAll(".se-main-container img, #INTRODUCE img");
      if (imgs.length) out = `(이미지 ${imgs.length}장으로 된 상세설명 — 텍스트 없음)`;
    }
    return out;
  }

  // ---- 후기 (구조 기반: #REVIEW 안의 날짜 있는 항목) --------------------
  function openReviewTab() {
    // 탭 버튼 텍스트가 "리뷰 2,758" 형태
    return clickByText("a,button,li,span", (t) => /^리뷰\s*[\d,]+/.test(t));
  }
  function reviewContainer() {
    return document.getElementById("REVIEW") ||
      document.querySelector('[id*="REVIEW"], [class*="review" i]') || document.body;
  }
  // 리뷰 li 하나에서 본문/작성자/날짜 뽑기
  function parseReviewLi(li) {
    const full = txt(li);
    const date = (full.match(/\d{2}\.\d{2}\.\d{2}\.?/) || [""])[0];
    const author = (full.match(/[가-힣A-Za-z0-9]+\*+[가-힣A-Za-z0-9]*/) || [""])[0];
    // 본문 = li 안에서 '자식 중 긴 텍스트가 없는' 잎 요소 중 가장 긴 한글 문장
    let body = "";
    for (const e of li.querySelectorAll("div,span,p")) {
      const hasLongChild = [...e.children].some((c) => txt(c).length > 25);
      if (hasLongChild) continue;
      const et = txt(e);
      if (et.length > body.length && et.length >= 25 && /[가-힣]/.test(et) &&
          !/^\d{2}\./.test(et) && !/좋아요$|보통이에요$/.test(et)) body = et;
    }
    if (!body) return null;
    return { content: body, author, date };
  }
  function grabReviewsOnPage(container, out, seen) {
    for (const li of container.querySelectorAll("li")) {
      const t = txt(li);
      if (!/\d{2}\.\d{2}\.\d{2}/.test(t)) continue;   // 날짜 없는 li는 후기 아님
      const r = parseReviewLi(li);
      if (!r || seen.has(r.content)) continue;
      seen.add(r.content);
      out.push({ content: r.content, author: r.author, product: getTitle(), date: r.date });
    }
  }
  // 후기 페이지네이션: #REVIEW 안 숫자 버튼/다음화살표
  function goReviewPage(container, n) {
    const nums = [...container.querySelectorAll("a,button")]
      .filter((e) => txt(e) === String(n) && visible(e));
    if (nums.length) { nums[nums.length - 1].click(); return true; }
    // 다음 화살표 폴백
    const next = [...container.querySelectorAll("a,button")]
      .find((e) => /다음|next/i.test((e.getAttribute("aria-label") || "") + " " + (e.className || "")) && visible(e));
    if (next) { next.click(); return true; }
    return false;
  }
  async function scrapeReviews() {
    openReviewTab();
    await SLEEP(1000);
    const cont = reviewContainer();
    await scrollElementIntoLoad(cont);
    await SLEEP(500);

    const out = [], seen = new Set();
    grabReviewsOnPage(cont, out, seen);

    for (let page = 2; page <= CFG.reviewMaxPages && out.length < CFG.reviewTarget; page++) {
      if (!goReviewPage(cont, page)) break;
      await SLEEP(CFG.pageWaitMs);
      const before = out.length;
      grabReviewsOnPage(cont, out, seen);
      if (out.length === before) break;   // 더 안 늘면 종료
    }
    return { reviews: out.slice(0, CFG.reviewTarget), totalSeen: seen.size };
  }

  // ---- JSON 조립 --------------------------------------------------------
  function buildJson(d) {
    return {
      schema_version: "shopping_product_v1",
      source: "naver",
      collected_at: new Date().toISOString(),
      url: location.href,
      product: {
        name: d.title,
        price: d.price,
        ids: { productId: d.ids.productId, store: d.ids.store },
        spec: d.spec,
      },
      delivery: d.delivery,
      images: d.images,
      options: d.options,
      description: d.desc,
      review_summary: { total_input_reviews: d.reviewData.totalSeen, deduped_reviews: d.reviewData.reviews.length },
      reviews: d.reviewData.reviews,
      seller: { name: d.seller },
      category: { path: d.category },
      url_info: {
        canonical: location.origin + location.pathname,
        query: Object.fromEntries(new URLSearchParams(location.search)),
      },
    };
  }

  // ---- 출력 -------------------------------------------------------------
  async function copyClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (_) {}
      ta.remove(); return ok;
    }
  }
  function downloadFile(text, name) {
    const blob = new Blob(["﻿" + text], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function setStatus(m) { const el = document.getElementById("nv-scr-status"); if (el) el.textContent = m; }
  function showOutput(text) {
    const ta = document.getElementById("nv-scr-out");
    if (ta) { ta.value = text; ta.style.display = "block"; }
    const row = document.getElementById("nv-scr-btnrow");
    if (row) row.style.display = "flex";
    const imgBtn = document.getElementById("nv-scr-imgsave");
    if (imgBtn) imgBtn.style.display = "block";
  }

  const state = { base: null, candidates: [], selected: [], lastText: "" };

  async function applySelection() {
    if (!state.base) return;
    const images = state.selected.slice();   // JSON엔 주소만(깔끔). 실제 이미지는 파일로 저장해 업로드.
    const text = JSON.stringify(buildJson({ ...state.base, images }), null, 2);
    state.lastText = text;
    showOutput(text);
    await copyClipboard(text);
    try {
      GM_setValue("nv_lucy_json", text);
      GM_setValue("nv_lucy_json_at", Date.now());
      GM_setValue("nv_lucy_json_name", state.base.title);
    } catch (_) {}
    setStatus(`완료 ✅ 후기 ${state.base.reviewData.reviews.length}개 · 이미지 ${images.length}장 선택 · 복사됨. 이미지는 아래 '📷 이미지 파일로 저장' 눌러 캐릭터에 올리세요`);
  }
  function saveFile() {
    if (!state.base || !state.lastText) return;
    const safe = (state.base.title || "네이버상품").replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
    downloadFile(state.lastText, `${safe}.json`);
  }
  // 선택 이미지를 각각 .jpg 파일로 저장(캐릭터에 업로드/붙여넣기용)
  async function saveImages() {
    if (!state.selected.length) { setStatus("선택된 이미지가 없어요."); return; }
    const safe = (state.base && state.base.title || "상품").replace(/[\\/:*?"<>|]/g, "_").slice(0, 30);
    let i = 0, ok = 0;
    for (const u of state.selected) {
      i++;
      setStatus(`이미지 저장 중… (${i}/${state.selected.length})`);
      const data = await toDataURL(u);
      if (!data) continue;
      try {
        const blob = await (await fetch(data)).blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${safe}_${i}.jpg`;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
        ok++;
        await SLEEP(400);
      } catch (_) {}
    }
    setStatus(`이미지 ${ok}장 파일로 저장됨 ✅ 캐릭터 카드에 업로드(클릭) 또는 붙여넣기(Ctrl+V)`);
  }
  function renderImagePicker() {
    const wrap = document.getElementById("nv-scr-imgs");
    if (!wrap) return;
    wrap.style.display = "block";
    const thumbs = state.candidates.map((u) => {
      const sel = state.selected.includes(u);
      const safe = u.replace(/"/g, "&quot;");
      return `<img data-url="${safe}" src="${safe}" title="클릭해서 선택/해제"
        style="width:46px;height:46px;object-fit:cover;border-radius:6px;cursor:pointer;
        border:2px solid ${sel ? "#5eead4" : "transparent"};opacity:${sel ? 1 : .5};">`;
    }).join("");
    wrap.innerHTML = `<div style="font-size:11px;opacity:.85;margin:12px 0 6px;">상품 이미지 선택 (클릭=토글, 초록테=선택) · ${state.selected.length}장</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${thumbs}</div>`;
    wrap.querySelectorAll("img[data-url]").forEach((im) => {
      im.addEventListener("click", () => {
        const u = im.getAttribute("data-url");
        const idx = state.selected.indexOf(u);
        if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(u);
        renderImagePicker();
        applySelection();
      });
    });
  }

  async function run() {
    const btn = document.getElementById("nv-scr-go");
    if (btn) btn.disabled = true;
    try {
      setStatus("① 상세설명 펼쳐서 긁는 중…");
      const desc = await scrapeDescription();
      setStatus("② 후기 모으는 중… (페이지 넘김)");
      const reviewData = await scrapeReviews();

      state.base = {
        title: getTitle(), price: getPrice(), ids: getIds(),
        options: getOptions(), spec: getSpec(), category: getCategoryPath(),
        seller: getSeller(), delivery: getDeliveryBadges(), desc, reviewData,
      };
      state.candidates = getImageCandidates();
      state.selected = defaultSelected(state.candidates);  // 기본 선택(로고 자동 제외)
      renderImagePicker();
      await applySelection();
    } catch (e) {
      console.error("[네이버긁기]", e);
      setStatus("오류: " + (e && e.message ? e.message : e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- UI (드래그 이동 + 접기) ------------------------------------------
  function buildPanel() {
    if (document.getElementById("nv-scraper-panel")) return;
    const box = document.createElement("div");
    box.id = "nv-scraper-panel";
    box.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "width:280px", "border-radius:14px", "overflow:hidden",
      "background:#0a2e1c", "color:#fff",
      "font:600 13px/1.35 -apple-system,'Malgun Gothic',sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.35)",
      "user-select:none",
    ].join(";");
    box.innerHTML = `
      <div id="nv-scr-head" style="display:flex;align-items:center;justify-content:space-between;
           padding:11px 14px;background:#03c75a;cursor:move;">
        <span style="font-size:14px;">네이버 → Lucy JSON <span style="opacity:.8;font-size:10px;">${VERSION}</span></span>
        <span style="display:flex;gap:2px;">
          <span id="nv-scr-min" title="최소화" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">–</span>
          <span id="nv-scr-close" title="닫기" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">×</span>
        </span>
      </div>
      <div id="nv-scr-body" style="padding:14px;">
        <div style="font-size:11px;opacity:.8;margin-bottom:10px;">화면만 읽음 · 외부 서버 안 거침 · 창은 위 초록띠 잡고 이동</div>
        <button id="nv-scr-go" style="width:100%;border:0;border-radius:9px;padding:12px;
                background:#03c75a;color:#fff;font:700 14px inherit;cursor:pointer;">상품 수집 → JSON</button>
        <div id="nv-scr-status" style="margin-top:10px;font-weight:500;font-size:11.5px;opacity:.95;
             word-break:keep-all;line-height:1.5;">준비됨 · 상품 상세페이지에서 눌러주세요</div>
        <div id="nv-scr-imgs" style="display:none;"></div>
        <textarea id="nv-scr-out" readonly spellcheck="false" style="display:none;width:100%;height:150px;
             margin-top:10px;box-sizing:border-box;border:1px solid rgba(255,255,255,.25);border-radius:8px;
             background:#062015;color:#d5f5e3;font:400 11px/1.4 ui-monospace,Consolas,monospace;
             padding:8px;resize:vertical;user-select:text;-webkit-user-select:text;" placeholder="수집 결과 JSON"></textarea>
        <div id="nv-scr-btnrow" style="display:none;gap:8px;margin-top:8px;">
          <button id="nv-scr-copy" style="flex:1;border:0;border-radius:8px;padding:10px;background:#5eead4;color:#042c25;font:700 13px inherit;cursor:pointer;">전체 복사</button>
          <button id="nv-scr-save" style="flex:1;border:0;border-radius:8px;padding:10px;background:#334155;color:#fff;font:700 13px inherit;cursor:pointer;">JSON 파일</button>
        </div>
        <button id="nv-scr-imgsave" style="display:none;width:100%;margin-top:8px;border:0;border-radius:8px;padding:10px;background:#f59e0b;color:#1a1200;font:700 12.5px inherit;cursor:pointer;">📷 이미지 파일로 저장 (캐릭터에 올리기용)</button>
      </div>
    `;
    document.body.appendChild(box);

    box.querySelector("#nv-scr-go").addEventListener("click", run);
    box.querySelector("#nv-scr-copy").addEventListener("click", async () => {
      const ta = box.querySelector("#nv-scr-out");
      ta.focus(); ta.select();
      const ok = await copyClipboard(ta.value);
      setStatus(ok ? "전체 복사됨 ✅ 라스로 가서 붙여넣기(Ctrl+V)" : "복사 실패 — 상자 안에서 Ctrl+A → Ctrl+C 하세요");
    });
    box.querySelector("#nv-scr-save").addEventListener("click", saveFile);
    box.querySelector("#nv-scr-imgsave").addEventListener("click", saveImages);

    // 접기/펼치기
    const bodyEl = box.querySelector("#nv-scr-body");
    box.querySelector("#nv-scr-min").addEventListener("mousedown", (e) => e.stopPropagation());
    box.querySelector("#nv-scr-min").addEventListener("click", (e) => {
      e.stopPropagation();
      const hidden = bodyEl.style.display === "none";
      bodyEl.style.display = hidden ? "block" : "none";
      e.target.textContent = hidden ? "–" : "+";
    });
    // 닫기(제거) — 템퍼몽키 메뉴로 다시 열 수 있음
    box.querySelector("#nv-scr-close").addEventListener("mousedown", (e) => e.stopPropagation());
    box.querySelector("#nv-scr-close").addEventListener("click", (e) => { e.stopPropagation(); box.remove(); });

    // 드래그 이동
    const head = box.querySelector("#nv-scr-head");
    let drag = false, ox = 0, oy = 0;
    head.addEventListener("mousedown", (e) => {
      drag = true;
      const r = box.getBoundingClientRect();
      box.style.left = r.left + "px"; box.style.top = r.top + "px";
      box.style.right = "auto"; box.style.bottom = "auto";
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      let x = e.clientX - ox, y = e.clientY - oy;
      x = Math.max(0, Math.min(window.innerWidth - 60, x));
      y = Math.max(0, Math.min(window.innerHeight - 30, y));
      box.style.left = x + "px"; box.style.top = y + "px";
    });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  /* =========================================================================
   *  라스(lucystar.kr) 주입기 — 숨은 '상품 JSON 데이터' 칸에 네이버 JSON 꽂기
   * ========================================================================= */
  // React/제어형 textarea에 값 넣기(네이티브 setter + input 이벤트)
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function larsStatus(m) { const el = document.getElementById("nv-lars-status"); if (el) el.textContent = m; }

  function unhideJsonTab() {
    const tab = document.getElementById("shoppingProductJsonTab");
    const panel = document.getElementById("shoppingProductJsonPanel");
    if (tab) { tab.classList.remove("hidden"); tab.removeAttribute("hidden"); }
    if (panel) { panel.classList.remove("hidden"); panel.removeAttribute("hidden"); }
    if (tab) tab.click();
    return { tab, panel };
  }

  function injectToLars() {
    // 1순위: 패널 붙여넣기 칸, 2순위: 템퍼몽키 저장소(자동전달)
    let json = "";
    const inEl = document.getElementById("nv-lars-in");
    if (inEl && inEl.value.trim()) json = inEl.value.trim();
    if (!json) { try { json = GM_getValue("nv_lucy_json", ""); } catch (_) {} }
    if (!json) { larsStatus("붙여넣을 JSON이 없어요. 네이버에서 복사한 JSON을 위 칸에 붙여넣거나, 네이버에서 먼저 '상품 수집'을 하세요."); return; }
    // 유효성 간단 체크
    try { JSON.parse(json); } catch (_) { larsStatus("⚠️ JSON 형식이 아니에요. 네이버 상자에서 '전체 복사'한 내용을 그대로 붙여넣어 주세요."); return; }

    unhideJsonTab();
    const ta = document.getElementById("shoppingProductJson");
    if (!ta) { larsStatus("입력칸(#shoppingProductJson)을 못 찾음 — 라스 대본 화면인지/버전 확인. 대신 Ctrl+V로 붙여넣기 해보세요."); return; }

    setNativeValue(ta, json);
    // React 재렌더로 탭이 다시 숨을 수 있어 한 번 더 꺼내줌
    setTimeout(() => { unhideJsonTab(); const t = document.getElementById("shoppingProductJson"); if (t && !t.value) setNativeValue(t, json); }, 400);

    const name = (() => { try { return GM_getValue("nv_lucy_json_name", ""); } catch (_) { return ""; } })();
    larsStatus(`넣었어요 ✅ ${name ? "[" + name.slice(0, 18) + "…] " : ""}'상품 JSON 데이터' 탭 확인 후 대본 생성`);
  }

  function buildLarsPanel() {
    if (document.getElementById("nv-lars-panel")) return;
    const box = document.createElement("div");
    box.id = "nv-lars-panel";
    box.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "width:270px", "border-radius:14px", "overflow:hidden",
      "background:#0a2e1c", "color:#fff",
      "font:600 13px/1.35 -apple-system,'Malgun Gothic',sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.4)", "user-select:none",
    ].join(";");
    let saved = ""; try { saved = GM_getValue("nv_lucy_json_name", ""); } catch (_) {}
    box.innerHTML = `
      <div id="nv-lars-head" style="display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:#03c75a;cursor:move;">
        <span style="font-size:14px;">네이버 JSON → 라스 <span style="opacity:.8;font-size:10px;">${VERSION}</span></span>
        <span style="display:flex;gap:2px;">
          <span id="nv-lars-min" title="최소화" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">–</span>
          <span id="nv-lars-close" title="닫기" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">×</span>
        </span>
      </div>
      <div id="nv-lars-body" style="padding:14px;">
        <div style="font-size:11px;opacity:.85;margin-bottom:8px;word-break:keep-all;">네이버에서 복사한 JSON을 아래 칸에 붙여넣고 버튼을 누르면, 숨은 '상품 JSON 데이터' 칸에 꽂아줍니다.</div>
        <textarea id="nv-lars-in" spellcheck="false" style="width:100%;height:120px;box-sizing:border-box;
             border:1px solid rgba(255,255,255,.25);border-radius:8px;background:#062015;color:#d5f5e3;
             font:400 11px/1.4 ui-monospace,Consolas,monospace;padding:8px;resize:vertical;margin-bottom:8px;
             user-select:text;-webkit-user-select:text;" placeholder="여기에 네이버 JSON 붙여넣기 (Ctrl+V) — 비워두면 자동전달된 값 사용"></textarea>
        <button id="nv-lars-go" style="width:100%;border:0;border-radius:9px;padding:12px;background:#03c75a;color:#fff;font:700 14px inherit;cursor:pointer;">라스 칸에 넣기</button>
        <div id="nv-lars-status" style="margin-top:10px;font-weight:500;font-size:11.5px;opacity:.95;word-break:keep-all;line-height:1.5;">${saved ? "자동전달 대기: " + saved.slice(0, 18) + "… (붙여넣기 없이 눌러도 됨)" : "네이버 JSON을 붙여넣으세요."}</div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector("#nv-lars-go").addEventListener("click", injectToLars);
    const closeEl = box.querySelector("#nv-lars-close");
    closeEl.addEventListener("mousedown", (e) => e.stopPropagation());
    closeEl.addEventListener("click", (e) => { e.stopPropagation(); box.remove(); });
    makeDraggable(box, box.querySelector("#nv-lars-head"), box.querySelector("#nv-lars-min"), box.querySelector("#nv-lars-body"));
  }

  // 공용 드래그/접기
  function makeDraggable(box, head, minBtn, bodyEl) {
    if (minBtn) {
      minBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      minBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const hidden = bodyEl.style.display === "none";
        bodyEl.style.display = hidden ? "block" : "none";
        e.target.textContent = hidden ? "–" : "+";
      });
    }
    let drag = false, ox = 0, oy = 0;
    head.addEventListener("mousedown", (e) => {
      drag = true;
      const r = box.getBoundingClientRect();
      box.style.left = r.left + "px"; box.style.top = r.top + "px";
      box.style.right = "auto"; box.style.bottom = "auto";
      ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      let x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox));
      let y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy));
      box.style.left = x + "px"; box.style.top = y + "px";
    });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  // ---- 부팅: 호스트에 따라 스크래퍼/주입기 ------------------------------
  const IS_LARS = location.hostname.includes("lucystar.kr");
  function openPanel() { if (IS_LARS) buildLarsPanel(); else buildPanel(); }

  const boot = setInterval(() => {
    if (!document.body) return;
    clearInterval(boot);
    openPanel();
  }, 300);

  // 템퍼몽키 메뉴에서 다시 열기(닫아도 복구)
  try { GM_registerMenuCommand("패널 다시 열기", openPanel); } catch (_) {}
})();
