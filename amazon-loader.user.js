// ==UserScript==
// @name         아마존 호주 상품 수집 → Lucy (로더)
// @namespace    https://local.amazon.scraper/
// @version      1.14.0
// ★ 릴리스 규칙: 이 @version 과 amazon-core.js 의 VERSION("1.14.0")을 항상 같은 숫자로 맞추세요.
// @description  amazon.com.au 상품 수집 도구 로더. 실제 코드는 GitHub 서버에서 매번 최신으로 불러옴(중앙 자동업데이트). 지인 배포용.
// @author       ryu
// @match        https://www.amazon.com.au/*
// @match        https://amazon.com.au/*
// @match        https://lucystar.kr/script/studio*
// @match        https://lucystar.kr/script/studio/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      media-amazon.com
// @connect      ssl-images-amazon.com
// @connect      images-amazon.com
// @connect      amazon.com.au
// @connect      raw.githubusercontent.com
// @connect      githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/kdcctv550-ux/las-tool/main/amazon-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/kdcctv550-ux/las-tool/main/amazon-loader.user.js
// ==/UserScript==

/*
 * ── 이 파일은 "로더" 입니다 ──────────────────────────────────────────────
 * 지인은 이 로더만 설치합니다. 실제 동작 코드(amazon-core.js)는 GitHub에 있고,
 * 페이지가 열릴 때마다 최신 버전을 받아 실행합니다.
 *   → GitHub의 amazon-core.js 만 고치면 지인들도 다음 접속 때 자동 최신.
 *     (GitHub 캐시로 반영까지 몇 분 걸릴 수 있음)
 *   → 로더(이 파일) 자체를 바꿨을 때만 @version 을 올리세요.
 * ※ 네이버 도구(naver-loader)와 별개 파일이라 둘 다 설치해도 서로 간섭 없음.
 * ─────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  // GitHub raw 주소 (저장소/파일명 바꾸면 여기 두 줄만 수정)
  var CORE_URL = "https://raw.githubusercontent.com/kdcctv550-ux/las-tool/main/amazon-core.js";
  var CACHE_KEY = "az_core_cache_v1";

  // core 는 GM_* 를 전역처럼 사용 → new Function 으로 주입해 실행
  function runCore(src) {
    try {
      var fn = new Function(
        "GM_setValue", "GM_getValue", "GM_registerMenuCommand", "GM_xmlhttpRequest",
        src
      );
      fn(GM_setValue, GM_getValue, GM_registerMenuCommand, GM_xmlhttpRequest);
      return true;
    } catch (e) {
      console.error("[아마존로더] 코드 실행 오류:", e);
      return false;
    }
  }

  function runCached(reason) {
    var cached = "";
    try { cached = GM_getValue(CACHE_KEY, ""); } catch (_) {}
    if (cached) {
      console.warn("[아마존로더] 최신 못 받음(" + reason + ") → 저장본으로 실행");
      runCore(cached);
    } else {
      console.error("[아마존로더] 코드를 불러오지 못했어요: " + reason + " (인터넷/주소 확인)");
    }
  }

  function fetchCore() {
    GM_xmlhttpRequest({
      method: "GET",
      url: CORE_URL + "?t=" + Date.now(),   // 캐시 우회 → 항상 최신 시도
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
      onload: function (res) {
        if (res.status >= 200 && res.status < 300 && res.responseText) {
          try { GM_setValue(CACHE_KEY, res.responseText); } catch (_) {}
          runCore(res.responseText);
        } else {
          runCached("서버 응답 " + res.status);
        }
      },
      onerror: function () { runCached("네트워크 오류"); },
      ontimeout: function () { runCached("시간 초과"); },
    });
  }

  // 템퍼몽키 메뉴: 강제로 다시 불러오기(디버그용)
  try { GM_registerMenuCommand("아마존 도구 새로 불러오기", fetchCore); } catch (_) {}

  fetchCore();
})();
