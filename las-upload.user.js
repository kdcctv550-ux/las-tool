// ==UserScript==
// @name         LAS 자동 업로드 (폴더 → 라스)
// @namespace    https://local.lars-auto-filler/
// @version      3.9.0
// @description  폴더 한 번 선택하면 파일명 태그(m1s2 등)대로 라스 장면에 이미지/영상 자동 주입. (로더 — 실제 코드는 GitHub에서 매번 최신으로 불러옴, 페이지 컨텍스트 실행이라 Alpine 그대로 작동)
// @match        https://lucystar.kr/*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/kdcctv550-ux/las-tool/main/las-upload.user.js
// @downloadURL  https://raw.githubusercontent.com/kdcctv550-ux/las-tool/main/las-upload.user.js
// @grant        none
// ==/UserScript==

/*
 * ── 이 파일은 "로더" 입니다 ──────────────────────────────────────────────
 * @name / @updateURL 은 기존 배포본과 동일 → 지인들 템퍼몽키가 이걸로 자동 교체(이중실행 없음).
 * 실제 동작 코드는 GitHub 의 las-core.js. 페이지가 열릴 때마다 최신을 받아 실행합니다.
 *   → GitHub 의 las-core.js 만 고치면 지인들도 다음 접속 때 자동 최신(캐시로 몇 분).
 *   → @grant none 이라 페이지 컨텍스트에서 실행됨 = window.Alpine 접근 가능(업로드 정상).
 *
 * ★ 릴리스 규칙(버전 두 곳 같은 숫자로):
 *    ① 이 파일 @version
 *    ② las-core.js 패널 표기 "v3.9" (파일 내 <span>...v3.9</span>)
 * ─────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var CORE_URL = "https://raw.githubusercontent.com/kdcctv550-ux/las-tool/main/las-core.js";
  var CACHE_KEY = "las_core_cache_v1";

  // 페이지 전역 컨텍스트에서 실행 (window.Alpine 등 접근 위해 간접 eval 사용)
  function runCore(src) {
    try { (0, eval)(src); }
    catch (e) { console.error("[LAS 로더] 코드 실행 오류:", e); }
  }

  function runCached(reason) {
    var cached = "";
    try { cached = localStorage.getItem(CACHE_KEY) || ""; } catch (_) {}
    if (cached) {
      console.warn("[LAS 로더] 최신 못 받음(" + reason + ") → 저장본으로 실행");
      runCore(cached);
    } else {
      console.error("[LAS 로더] 코드를 불러오지 못했어요: " + reason + " (인터넷/주소 확인)");
    }
  }

  fetch(CORE_URL + "?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(function (src) {
      try { localStorage.setItem(CACHE_KEY, src); } catch (_) {}
      runCore(src);
    })
    .catch(function (e) { runCached(e && e.message ? e.message : String(e)); });
})();
