// ─────────────────────────────────────────────────────────────
//  pkgtour-core.js — 여행커넥트(pkgtour) 수집 "서버 코드" (v0.2.2)
//  pkgtour-loader.user.js(로더)가 GitHub에서 받아 new Function 으로 실행합니다.
//  단독 설치용 유저스크립트가 아니라서 ==UserScript== 헤더는 두지 않습니다.
//  ★ 버전 표기는 아래 VERSION 폴백("0.2.2") 한 곳. 릴리스 시 로더 @version 과 같은 숫자로 맞추세요.
// ─────────────────────────────────────────────────────────────

(function () {
  "use strict";

  const VERSION = "v" + ((typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "0.2.2");
  const CFG = { imgMaxCand: 40, imgSaveSize: 900, imgQuality: 0.85 };
  const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 유틸 ────────────────────────────────────────────────────────────
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  // CSS-module 클래스는 "이름__해시" 구조 → 앞부분(prefix)만으로 잡음
  const pOne = (prefix, r = document) => r.querySelector(`[class*="${prefix}"]`);
  const pAll = (prefix, r = document) => [...r.querySelectorAll(`[class*="${prefix}"]`)];
  function txt(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function metaContent(prop) {
    const m = q(`meta[property="${prop}"], meta[name="${prop}"]`);
    return m && m.content ? m.content.trim() : "";
  }
  function clickByText(sel, needles) {
    for (const n of qa(sel)) {
      const t = (n.innerText || n.textContent || "").trim();
      if (t && needles.some((k) => t.includes(k)) && visible(n)) { n.click(); return n; }
    }
    return null;
  }
  const sanitize = (s) => String(s || "").replace(/[\\/:*?"<>|\n\r]/g, "_").replace(/\s+/g, " ").trim().slice(0, 40);

  // ── 기본 정보 ───────────────────────────────────────────────────────
  function getTitle() { return txt(pOne("DetailInfo_name")) || txt(q("h1")) || metaContent("og:title") || document.title; }
  function wonOf(el) { if (!el) return ""; const d = txt(el).replace(/[^\d]/g, ""); return d ? Number(d).toLocaleString() + "원" : ""; }
  function getPriceInfo() {
    // 할인가는 'DetailPrice_final' 블록 안의 amount (정가 블록에도 amount가 있어 스코프 필요)
    const finalBox = pOne("DetailPrice_final");
    let final = wonOf(finalBox ? pOne("DetailPrice_amount", finalBox) : pOne("DetailPrice_amount"));
    if (!final) { const m = metaContent("product:price:amount").replace(/[^\d]/g, ""); if (m) final = Number(m).toLocaleString() + "원"; }
    const original = wonOf(pOne("DetailPrice_deleted")); // 정가(취소선)
    return {
      final,                                                  // 할인 적용된 실제 판매가
      original: (original && original !== final) ? original : "",
      discount_percent: txt(pOne("DetailPrice_percentage")),  // 예: "3%"
    };
  }
  function getBasics() {
    const texts = pAll("DetailInfo_text").map(txt).filter(Boolean);
    const summary = txt(pOne("TravelSummary"));
    return { info_texts: [...new Set(texts)], summary };
  }
  function getCategoryPath() {
    const bc = q('[class*="breadcrumb"], nav[aria-label*="경로"]');
    if (bc) return qa("a,span,li", bc).map(txt).filter((t) => t && t.length < 30);
    // 여행커넥트: 지역/태그
    const region = txt(pOne("DetailInfo_agent")) || "";
    const tags = pAll("DetailInfo_tags").map(txt).filter(Boolean);
    return [region, ...tags].filter(Boolean);
  }

  // ── 펼치기(상세설명 더보기 / 일정 전체 열기) ─────────────────────────
  async function expandAll() {
    // 상세정보 더보기 — 여행커넥트 상품의 그 버튼만 콕 집어 클릭(네이버 전역 메뉴 건드리지 않음)
    const more = q('[data-event-area-code="sin.viewdetails"]') || pOne("DetailDescription_expand");
    if (more && visible(more)) {
      const btn = (more.tagName === "BUTTON") ? more : (q("button", more) || more);
      try { btn.click(); } catch (_) {}
      await SLEEP(400);
    }
    // 일정 일차: 클릭 대신 <details>를 직접 열기(토글 사고 방지)
    qa("details").forEach((d) => { try { d.open = true; } catch (_) {} });
    await SLEEP(200);
    // 지연 이미지 로드 위해 스크롤
    let last = -1;
    for (let i = 0; i < 40; i++) { window.scrollBy(0, 900); await SLEEP(120); const h = document.body.scrollHeight; if (h === last) break; last = h; }
    window.scrollTo(0, 0); await SLEEP(200);
  }

  // ── 상세설명(여행포인트/포함·불포함/금액) ────────────────────────────
  function scrapeDescription() {
    // 유의사항(otherInformation)은 상품마다 같은 boilerplate → 일부러 제외.
    const kp = pOne("DetailDescription_Keypoints");
    const info = pOne("DetailDescription_DetailInfo");
    let full = [kp, info].map(txt).filter(Boolean).join("\n\n");
    if (!full) { const it = q('[data-tab-id="info"]'); full = txt(it); }
    // "상품 금액"부터 시작
    const s = full.search(/상품\s*금액/);
    if (s >= 0) full = full.slice(s);
    // "참고사항"까지만 → 그 뒤(예약상태/예약·결제/환불 규정)는 잘라냄
    for (const cut of ["예약상태", "예약 및 결제", "예약및결제", "예약/결제", "환불 규정", "취소 및 환불", "취소 수수료"]) {
      const i = full.indexOf(cut);
      if (i > 0) { full = full.slice(0, i).trim(); break; }
    }
    return full;
  }

  // ── 일정(itinerary) ──────────────────────────────────────────────────
  function scrapeItinerary() {
    const days = [];
    // 하루 단위: summary(DetailSchedule_toggle "1일차 …") 별로 묶기
    const dayBlocks = pAll("DetailSchedule_Collapse");
    if (dayBlocks.length) {
      dayBlocks.forEach((blk) => {
        const dayLabel = txt(pOne("DetailSchedule_toggle", blk)) || "";
        const steps = pAll("DetailSchedule_step", blk).map((li) => ({
          title: txt(pOne("DetailSchedule_title", li)),
          desc: pAll("DetailSchedule_desc", li).map(txt).filter(Boolean).join("\n"),
        })).filter((s) => s.title || s.desc);
        days.push({ day: dayLabel, steps });
      });
    } else {
      const steps = pAll("DetailSchedule_step").map((li) => ({
        title: txt(pOne("DetailSchedule_title", li)),
        desc: pAll("DetailSchedule_desc", li).map(txt).filter(Boolean).join("\n"),
      }));
      if (steps.length) days.push({ day: "", steps });
    }
    return days;
  }
  function itineraryToText(days) {
    return days.map((d) => {
      const head = d.day ? `\n[${d.day}]` : "";
      const body = d.steps.map((s) => `- ${s.title}${s.desc ? "\n  " + s.desc.replace(/\n/g, "\n  ") : ""}`).join("\n");
      return `${head}\n${body}`.trim();
    }).join("\n\n");
  }

  // ── 이미지 후보 (캡션/제목별 이름 부여) ───────────────────────────────
  const b64cache = new Map();
  function normImgUrl(url) { return url; }  // pkgtour 원본은 이미 큰 편(900x…). 그대로 사용.
  function pushImg(list, seen, url, name) {
    if (!url) return;
    const base = url.split("?")[0];
    if (seen.has(base)) return;
    seen.add(base);
    list.push({ url, name: name || "" });
  }
  // 스케줄 figure의 캡션 찾기: 이전 형제 중 "[xxx] - yyy" 형태, 없으면 스텝 제목
  function figureCaption(fig, stepTitle) {
    let el = fig;
    for (let i = 0; i < 12 && (el = el.previousElementSibling); i++) {
      const t = txt(el).split("\n")[0].trim();
      if (/^\[[^\]]+\]/.test(t)) return t;      // "[관광지] - 스누피차야"
    }
    // 부모의 이전 형제도 탐색
    let par = fig.parentElement;
    for (let up = 0; up < 3 && par; up++, par = par.parentElement) {
      let s = par;
      for (let i = 0; i < 8 && (s = s.previousElementSibling); i++) {
        const t = txt(s).split("\n")[0].trim();
        if (/^\[[^\]]+\]/.test(t)) return t;
      }
    }
    return stepTitle || "";
  }
  function getImageCandidates() {
    const list = [], seen = new Set();
    const title = getTitle();
    // 1) 대표 사진 슬라이더
    pAll("DetailPhotoSlider_img").forEach((im) => {
      const src = im.getAttribute("data-src") || im.currentSrc || im.src;
      if (src && /pstatic|phinf/.test(src)) pushImg(list, seen, src, title.slice(0, 20) || "대표");
    });
    // 2) 일정 스텝 사진 (캡션별 이름)
    pAll("DetailSchedule_step").forEach((li) => {
      const stepTitle = txt(pOne("DetailSchedule_title", li));
      pAll("DetailSchedule_thumb", li).forEach((fig) => {
        const im = pOne("DetailSchedule_img", fig) || q("img", fig);
        if (!im) return;
        const src = im.getAttribute("data-src") || im.currentSrc || im.src;
        if (src && /pstatic|phinf/.test(src)) pushImg(list, seen, src, figureCaption(fig, stepTitle));
      });
    });
    // 3) 리뷰 사진(사진리뷰) → 파일명 "리뷰_1, 리뷰_2 …"
    pAll("MediaList_image").forEach((im) => {
      const src = im.getAttribute("data-src") || im.currentSrc || im.src;
      if (src && /pstatic|phinf/.test(src)) pushImg(list, seen, src, "리뷰");
    });
    // 4) 상세설명 안 이미지(있으면)
    const dd = pOne("DetailDescription_panel") || q('[data-tab-id="info"]');
    if (dd) pAll("img", dd).forEach((im) => {
      const src = im.currentSrc || im.src;
      if (src && /pstatic|phinf/.test(src) && (im.naturalWidth || im.width) >= 200) pushImg(list, seen, src, title.slice(0, 20) || "상세");
    });
    return list.slice(0, CFG.imgMaxCand);
  }

  // ── 이미지 → dataURL (원본 받아 축소) ─────────────────────────────────
  function xhrBlob(url) {
    return new Promise((res) => {
      GM_xmlhttpRequest({
        method: "GET", url, responseType: "blob", headers: { Referer: location.origin + "/" },
        onload: (r) => res(r.status >= 200 && r.status < 300 && r.response ? r.response : null),
        onerror: () => res(null), ontimeout: () => res(null),
      });
    });
  }
  function blobToDataURL(blob) {
    return new Promise((res) => {
      const u = URL.createObjectURL(blob), img = new Image();
      img.onload = () => {
        const max = CFG.imgSaveSize, w = img.naturalWidth, h = img.naturalHeight;
        const sc = Math.min(1, max / Math.max(w, h)), cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
        const c = document.createElement("canvas"); c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, 0, 0, cw, ch); URL.revokeObjectURL(u);
        try { res(c.toDataURL("image/jpeg", CFG.imgQuality)); } catch (_) { res(null); }
      };
      img.onerror = () => { URL.revokeObjectURL(u); res(null); };
      img.src = u;
    });
  }
  async function toDataURL(url) {
    if (b64cache.has(url)) return b64cache.get(url);
    let data = null;
    for (const u of [url.split("?")[0], url]) { const b = await xhrBlob(u); if (b) { data = await blobToDataURL(b); if (data) break; } }
    b64cache.set(url, data); return data;
  }

  // ── 폴더 기억(IndexedDB) ─────────────────────────────────────────────
  function _idb() { return new Promise((res, rej) => { const r = indexedDB.open("pkg_fs", 1); r.onupgradeneeded = () => r.result.createObjectStore("h"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function _saveHandle(h) { try { const db = await _idb(); await new Promise((res, rej) => { const t = db.transaction("h", "readwrite"); t.objectStore("h").put(h, "dir"); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (_) {} }
  async function _loadHandle() { try { const db = await _idb(); return await new Promise((res) => { const t = db.transaction("h", "readonly"); const rq = t.objectStore("h").get("dir"); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); }); } catch (_) { return null; } }
  async function _clearHandle() { try { const db = await _idb(); await new Promise((res) => { const t = db.transaction("h", "readwrite"); t.objectStore("h").delete("dir"); t.oncomplete = res; t.onerror = res; }); } catch (_) {} }

  // ── 상태 ────────────────────────────────────────────────────────────
  const state = { base: null, candidates: [], selected: [], lastText: "" };
  function setStatus(m) { const el = document.getElementById("pk-status"); if (el) el.textContent = m; }

  function buildJson() {
    const b = state.base;
    return {
      schema_version: "shopping_product_v1",
      source: "naver_pkgtour",
      collected_at: new Date().toISOString(),
      url: location.href,
      product: { name: b.title, price: b.price.final, price_original: b.price.original, discount_percent: b.price.discount_percent, ids: { productId: (location.pathname.match(/\/products\/[^/]+\/([^/?#]+)/) || [])[1] || "" } },
      travel: { info_texts: b.basics.info_texts, summary: b.basics.summary },
      images: state.selected.map((x) => x.url),
      itinerary: b.itinerary,
      itinerary_text: itineraryToText(b.itinerary),
      description: b.desc,
      seller: { name: metaContent("og:site_name") || "" },
      category: { path: b.category },
      url_info: { canonical: location.origin + location.pathname, query: Object.fromEntries(new URLSearchParams(location.search)) },
    };
  }
  async function copyClipboard(text) { try { await navigator.clipboard.writeText(text); return true; } catch (_) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (_) {} ta.remove(); return ok; } }

  async function applySelection() {
    if (!state.base) return;
    const text = JSON.stringify(buildJson(), null, 2);
    state.lastText = text;
    const out = document.getElementById("pk-out"); if (out) { out.value = text; out.style.display = "block"; }
    const row = document.getElementById("pk-btnrow"); if (row) row.style.display = "flex";
    const ib = document.getElementById("pk-imgsave"); if (ib) ib.style.display = "block";
    await copyClipboard(text);
    try { GM_setValue("pk_json", text); GM_setValue("pk_json_name", state.base.title); } catch (_) {}
    setStatus(`완료 ✅ 일정 ${state.base.itinerary.length}일 · 이미지 ${state.selected.length}장 선택 · 복사됨`);
  }

  // ── 이미지 저장 (캡션별 파일명 + 날짜폴더) ────────────────────────────
  function fileNames() {
    const counts = {};
    return state.selected.map((x, i) => {
      const nm = sanitize(x.name) || sanitize(state.base && state.base.title) || "사진";
      counts[nm] = (counts[nm] || 0) + 1;
      return { url: x.url, file: `${nm}_${counts[nm]}.jpg` };
    });
  }
  async function saveImages() {
    if (!state.selected.length) { setStatus("선택된 이미지가 없어요."); return; }
    const safe = sanitize(state.base && state.base.title) || "여행상품";
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    const folder = `${String(d.getFullYear()).slice(-2)}${p(d.getMonth() + 1)}${p(d.getDate())}_${safe}`;
    const plan = fileNames();

    if (window.showDirectoryPicker) {
      let root = null, aborted = false;
      try {
        root = await _loadHandle();
        if (root) { let pm = await root.queryPermission({ mode: "readwrite" }); if (pm !== "granted") pm = await root.requestPermission({ mode: "readwrite" }); if (pm !== "granted") root = null; }
        if (!root) { setStatus("저장할 폴더를 한 번만 선택하세요 (다운로드 안에 폴더 하나 만들어 고르면 됨)…"); root = await window.showDirectoryPicker({ mode: "readwrite" }); await _saveHandle(root); }
      } catch (e) { if (e && e.name === "AbortError") aborted = true; root = null; }
      if (root) {
        try {
          const dir = await root.getDirectoryHandle(folder, { create: true });
          let n = 0, ok = 0;
          for (const it of plan) { n++; setStatus(`저장 중… (${n}/${plan.length})`); const data = await toDataURL(it.url); if (!data) continue; const blob = await (await fetch(data)).blob(); const fh = await dir.getFileHandle(it.file, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); ok++; }
          setStatus(`✅ ${root.name}/"${folder}" 에 ${ok}장 저장 (다음부턴 폴더선택 없이 자동)`); return;
        } catch (e) { console.warn("[여행커넥트] 폴더 쓰기 실패", e); }
      }
      if (!confirm("폴더 없이 개별 파일로 (다운로드 폴더에) 저장할까요?\n\n[확인]=개별저장  [취소]=저장 안 함")) { setStatus(aborted ? "폴더 선택 취소됨." : "저장 안 함."); return; }
    } else {
      if (!confirm("이 브라우저는 폴더 저장을 지원하지 않아요.\n개별 파일로 저장할까요?\n\n[확인]=개별저장  [취소]=안 함")) { setStatus("저장 안 함."); return; }
    }
    // 개별 저장
    let n = 0, ok = 0;
    for (const it of plan) { n++; setStatus(`저장 중… (${n}/${plan.length})`); const data = await toDataURL(it.url); if (!data) continue; try { const blob = await (await fetch(data)).blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = it.file; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800); ok++; await SLEEP(350); } catch (_) {} }
    setStatus(`✅ 개별 파일 ${ok}장 다운로드 폴더에 저장됨`);
  }

  // ── 마우스 올리면 확대 ────────────────────────────────────────────────
  function zoomBox() {
    let z = document.getElementById("pk-zoom");
    if (!z) { z = document.createElement("div"); z.id = "pk-zoom"; z.style.cssText = "position:fixed;z-index:2147483647;display:none;padding:4px;background:#fff;border:2px solid #1e40af;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.4);pointer-events:none;"; z.innerHTML = '<img style="display:block;width:280px;height:280px;object-fit:contain;background:#fff;">'; document.body.appendChild(z); }
    return z;
  }
  function renderPicker() {
    const wrap = document.getElementById("pk-imgs"); if (!wrap) return;
    wrap.style.display = "block";
    const thumbs = state.candidates.map((x, i) => {
      const sel = state.selected.includes(x);
      const safe = x.url.replace(/"/g, "&quot;");
      const cap = (x.name || "").replace(/"/g, "&quot;");
      return `<img data-i="${i}" src="${safe}" title="${cap}&#10;클릭=선택/해제 · 올리면 확대"
        style="width:48px;height:48px;object-fit:contain;background:#fff;border-radius:6px;cursor:pointer;border:2px solid ${sel ? "#60a5fa" : "transparent"};opacity:${sel ? 1 : .55};">`;
    }).join("");
    wrap.innerHTML = `<div style="font-size:11px;opacity:.85;margin:12px 0 6px;">사진 선택 (클릭=토글, 올리면 확대) · ${state.selected.length}장 · 캡션별로 저장됨</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${thumbs}</div>`;
    qa("img[data-i]", wrap).forEach((im) => {
      const x = state.candidates[+im.dataset.i];
      im.addEventListener("click", () => { const k = state.selected.indexOf(x); if (k >= 0) state.selected.splice(k, 1); else state.selected.push(x); renderPicker(); applySelection(); });
      im.addEventListener("mouseenter", () => { const z = zoomBox(), zi = z.querySelector("img"); const big = x.url.split("?")[0]; zi.onerror = () => { zi.onerror = null; zi.src = x.url; }; zi.src = big; z.style.display = "block"; });
      im.addEventListener("mousemove", (ev) => { const z = zoomBox(), bw = 292, bh = 292; let px = ev.clientX - bw - 18; if (px < 8) px = ev.clientX + 18; const py = Math.max(8, Math.min(window.innerHeight - bh - 8, ev.clientY - bh / 2)); z.style.left = px + "px"; z.style.top = py + "px"; });
      im.addEventListener("mouseleave", () => { const z = document.getElementById("pk-zoom"); if (z) z.style.display = "none"; });
    });
  }

  async function run() {
    const btn = document.getElementById("pk-go"); if (btn) btn.disabled = true;
    try {
      setStatus("① 상세·일정 펼치는 중…");
      await expandAll();
      setStatus("② 정보 정리 중…");
      state.base = { title: getTitle(), price: getPriceInfo(), basics: getBasics(), category: getCategoryPath(), desc: scrapeDescription(), itinerary: scrapeItinerary() };
      state.candidates = getImageCandidates();
      state.selected = state.candidates.slice();   // 기본 전체 선택
      renderPicker();
      await applySelection();
    } catch (e) { console.error("[여행커넥트]", e); setStatus("오류: " + (e && e.message ? e.message : e)); }
    finally { if (btn) btn.disabled = false; }
  }

  // ── UI ──────────────────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById("pk-panel")) return;
    const box = document.createElement("div");
    box.id = "pk-panel";
    box.style.cssText = ["position:fixed", "right:20px", "bottom:20px", "z-index:2147483647", "width:290px", "border-radius:14px", "overflow:hidden", "background:#0a1e3c", "color:#fff", "font:600 13px/1.35 -apple-system,'Malgun Gothic',sans-serif", "box-shadow:0 10px 30px rgba(0,0,0,.4)", "user-select:none"].join(";");
    box.innerHTML = `
      <div id="pk-head" style="display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:#1e40af;cursor:move;">
        <span style="font-size:14px;">여행커넥트 → Lucy JSON <span style="opacity:.8;font-size:10px;">${VERSION}</span></span>
        <span style="display:flex;gap:2px;"><span id="pk-min" title="최소화" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">–</span><span id="pk-close" title="닫기" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">×</span></span>
      </div>
      <div id="pk-body" style="padding:14px;">
        <div style="font-size:11px;opacity:.85;margin-bottom:8px;">패키지여행 상세페이지에서 눌러주세요 (제목·가격·일정·상세·사진)</div>
        <button id="pk-go" style="width:100%;border:0;border-radius:9px;padding:12px;background:#3b82f6;color:#fff;font:700 14px inherit;cursor:pointer;">상품 수집 → JSON</button>
        <div id="pk-status" style="margin-top:10px;font-weight:500;font-size:11.5px;opacity:.95;word-break:keep-all;line-height:1.5;">준비됨</div>
        <div id="pk-imgs" style="display:none;"></div>
        <textarea id="pk-out" readonly spellcheck="false" style="display:none;width:100%;height:150px;margin-top:10px;box-sizing:border-box;border:1px solid rgba(255,255,255,.25);border-radius:8px;background:#06122a;color:#cfe3ff;font:400 11px/1.4 ui-monospace,Consolas,monospace;padding:8px;resize:vertical;user-select:text;"></textarea>
        <div id="pk-btnrow" style="display:none;gap:8px;margin-top:8px;">
          <button id="pk-copy" style="flex:1;border:0;border-radius:8px;padding:10px;background:#60a5fa;color:#06122a;font:700 13px inherit;cursor:pointer;">전체 복사</button>
          <button id="pk-save" style="flex:1;border:0;border-radius:8px;padding:10px;background:#334155;color:#fff;font:700 13px inherit;cursor:pointer;">JSON 파일</button>
        </div>
        <button id="pk-imgsave" style="display:none;width:100%;margin-top:8px;border:0;border-radius:8px;padding:10px;background:#f59e0b;color:#1a1200;font:700 12.5px inherit;cursor:pointer;">📷 사진 파일로 저장 (캡션별 이름)</button>
      </div>`;
    document.body.appendChild(box);
    q("#pk-go", box).addEventListener("click", run);
    q("#pk-copy", box).addEventListener("click", async () => { const ta = q("#pk-out", box); ta.focus(); ta.select(); const ok = await copyClipboard(ta.value); setStatus(ok ? "전체 복사됨 ✅" : "복사 실패 — 상자에서 Ctrl+A→Ctrl+C"); });
    q("#pk-save", box).addEventListener("click", () => { if (!state.lastText) return; const blob = new Blob(["﻿" + state.lastText], { type: "application/json;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = sanitize(state.base && state.base.title || "여행상품") + ".json"; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); });
    q("#pk-imgsave", box).addEventListener("click", saveImages);
    // 접기/닫기/드래그
    const bodyEl = q("#pk-body", box);
    q("#pk-min", box).addEventListener("click", (e) => { e.stopPropagation(); const h = bodyEl.style.display === "none"; bodyEl.style.display = h ? "block" : "none"; e.target.textContent = h ? "–" : "+"; });
    q("#pk-close", box).addEventListener("click", (e) => { e.stopPropagation(); box.remove(); });
    const head = q("#pk-head", box); let drag = false, ox = 0, oy = 0;
    head.addEventListener("mousedown", (e) => { drag = true; const r = box.getBoundingClientRect(); box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.right = "auto"; box.style.bottom = "auto"; ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault(); });
    document.addEventListener("mousemove", (e) => { if (!drag) return; box.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox)) + "px"; box.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy)) + "px"; });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  const boot = setInterval(() => { if (document.body) { clearInterval(boot); buildPanel(); } }, 400);
  try { GM_registerMenuCommand("패널 다시 열기", buildPanel); } catch (_) {}
  try { GM_registerMenuCommand("사진 저장 폴더 바꾸기(초기화)", async () => { await _clearHandle(); alert("초기화됨 — 다음 저장 때 폴더를 다시 선택합니다."); }); } catch (_) {}
})();
