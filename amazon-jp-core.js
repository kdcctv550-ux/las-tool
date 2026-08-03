// ==UserScript==
// @name         아마존 재팬 상품 수집 → Lucy JSON (독립/로컬)
// @namespace    https://local.amazonjp.scraper/
// @version      1.9.2
// @description  amazon.co.jp 상품페이지의 상품명·상세·스펙·후기를 긁어 shopping_product_v1 JSON(source:"amazon_jp")으로 뽑고, 라스(lucystar.kr) 숨은 '상품 JSON 데이터' 칸에 자동으로 꽂아줌. 일본어 원문 + 크롬 내장 번역 한국어 병기. 이미지는 파일로 저장해 캐릭터에 업로드.
// @match        https://www.amazon.co.jp/*
// @match        https://amazon.co.jp/*
// @match        https://lucystar.kr/script/studio*
// @match        https://lucystar.kr/script/studio/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @grant        GM_xmlhttpRequest
// @connect      media-amazon.com
// @connect      ssl-images-amazon.com
// @connect      images-amazon.com
// @connect      amazon.co.jp
// ==/UserScript==
// ※ GM_setValue/GM_getValue = 템퍼몽키 로컬 저장소(아마존→라스 값 전달, 외부 아님).
// ※ GM_xmlhttpRequest = 아마존 CDN 이미지를 받아 파일로 저장하기 위함(개발자 서버 안 거침).
// ※ 후기 전체보기는 같은 도메인(amazon.co.jp) fetch — 로그인 세션 그대로 사용.

(function () {
  "use strict";

  /* =========================================================================
   *  아마존 재팬 상품 수집 → Lucy(라스) 붙여넣기용 JSON 생성
   *  - 화면 DOM + 같은 도메인 후기 페이지만 읽음. 외부 서버로 아무것도 안 보냄.
   *  - 출력: 쿠팡/네이버 도구와 동일한 schema_version "shopping_product_v1"
   *          (source:"amazon_jp", currency:"JPY", 가격은 ￥ 표기 그대로)
   *  - 일본어 원문 + 크롬 내장 Translator API(on-device) 한국어 번역 병기
   *      · product.name / name_ko, description / description_ko
   *      · reviews[].content / content_ko, bullets[] / bullets_ko[]
   *  - ⚠️ amazon.co.jp 는 계정 언어를 영어로 두면 경로에 /-/en/ 접두사가 붙고
   *       후기 DOM 텍스트도 영어로 바뀐다. 그래서 날짜·별점·재고 판정은
   *       일본어/영어 두 가지를 모두 받아들이도록 만들었다.
   * ========================================================================= */

  const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
  // ★ 릴리스 규칙: 아래 "1.9.2" 을 올릴 때 amazon-jp-loader.user.js 의 @version 도 같은 숫자로.
  const VERSION = "v" + ((typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.9.2");

  const CFG = {
    reviewMaxPages: 12,    // 후기 요청 총 횟수 상한(페이지 넘김 + 별점 변형 합계)
    reviewTarget: 30,      // 목표 후기 개수(채우면 조기 종료)
    reviewPageWaitMs: 900, // 후기 페이지 사이 대기(과속 차단 방지)
    imageCount: 3,         // 기본 선택 이미지 수
    candidateMax: 20,
    imgSaveSize: 1000,     // '이미지 파일 저장' 시 최대 픽셀
    imgQuality: 0.88,
    lazyScrollWaitMs: 320,
    translate: true,       // 한국어 번역 병기(패널에서 토글)
    larsReviewLimit: 10,   // 라스용 JSON에 넣을 후기 개수 (0=전체). 과부하 원인 분리용
    jpOnly: false,         // 라스용에 일본 후기만 넣기 (해외 후기 제외)
    uiMode: "auto",        // 아마존 화면 언어: "auto"(자동감지) | "ja" | "en" | "ko" (패널에서 토글)
    larsDescMax: 1500,     // 라스용 description 최대 길이 (쿠팡엔 아예 없는 필드라 짧게)
    trChunk: 1400,         // 긴 글 번역 시 자르는 길이
    trReviewMax: 30,       // 번역할 후기 최대 개수
    descMax: 6000,         // description 최대 길이(라스 입력칸 10만자 제한 대비)
  };

  /* ---- 공용 유틸 --------------------------------------------------------- */
  function txt(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "")
      .replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return [...(root || document).querySelectorAll(sel)]; }
  function firstText(sels, root) {
    for (const s of sels) { const t = txt(q(s, root)); if (t) return t; }
    return "";
  }
  function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  // ⚠️ amazon.co.jp 는 계정 표시언어가 영어면 모든 내부 링크에 /-/en/ 이 붙는다.
  //    (캡처 확인: 일본어 UI → /portal/customer-reviews/…, 영어 UI → /-/en/portal/customer-reviews/…)
  //    폴백 주소를 만들 때 이 접두사를 그대로 이어붙여야 로그인 세션이 유지된다.
  function langPrefix() {
    // /-/en/ , /-/ko/ 등. 지원은 日/英/한 3종이지만 접두사 자체는 넉넉히 받는다.
    const m = location.pathname.match(/^(\/-\/[a-z]{2}(?:_[A-Za-z]{2})?)\//);
    return m ? m[1] : "";
  }
  // 화면 언어 자동감지 — <html lang="ja-JP"> 가 가장 정확(경로 접두사가 없어도 잡힘)
  function detectLang() {
    const l = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (l) return l.split("-")[0].split("_")[0];
    const p = langPrefix();
    return p ? p.replace("/-/", "").split("_")[0].toLowerCase() : "ja";
  }
  // 실제로 쓸 언어 — 패널에서 수동 지정했으면 그것, 아니면 자동감지
  function uiLang() {
    if (CFG.uiMode && CFG.uiMode !== "auto") return CFG.uiMode;
    const d = detectLang();
    return SUPPORTED.indexOf(d) >= 0 ? d : "ja";   // 지원 밖 언어(中 등)는 일본어로 취급
  }
  function isJaUI() { return uiLang() === "ja"; }

  // 크롬(및 타 브라우저) 페이지 번역이 켜져 있는지.
  //   크롬은 번역한 문서의 <html> 에 translated-ltr / translated-rtl 클래스를 넣는다.
  //   ⚠️ 이 상태에서 긁으면 화면의 후기·상품명·상세설명이 전부 번역문이라
  //      일본어 원문을 잃는다. (후기 전체보기는 fetch 라 원문이지만 섞여버림)
  function pageTranslated() {
    const h = document.documentElement;
    const cls = String((h && h.className) || "");
    if (/(^|\s)translated-(ltr|rtl)(\s|$)/.test(cls)) return "크롬 페이지 번역";
    if (q("font[_msttexthash]") || q("[_msttexthash]")) return "Edge/Microsoft 번역";
    if (q("[x-bergamot-translated]")) return "Firefox 번역";
    if (q("ya-tr-span")) return "Yandex 번역";
    return "";
  }

  // ── 지원 언어 3종 (日/英/한) 패턴표 ─────────────────────────────────
  // ja/en 은 Ryu 캡처로 실물 확인. ko 는 미확인 추정치이므로 여기부터 의심할 것.
  const SUPPORTED = ["ja", "en", "ko"];
  const PAT = {
    // 별점 텍스트: ja "5つ星のうち4.0" / en "4.0 out of 5 stars" / ko "별 5개 중 4.0"
    star: {
      ja: /5つ星のうち\s*([\d.]+)/,
      en: /([\d.]+)\s*out of\s*5/i,
      ko: /(?:별\s*5\s*개\s*중|5\s*점\s*만점에)\s*([\d.]+)/,
    },
    // 날짜: ja "2026年7月20日" / en "July 20, 2026" / ko "2026년 7월 20일"
    date: {
      ja: /(\d{4}年\s*\d{1,2}月\s*\d{1,2}日)/,
      en: /([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/,
      ko: /(\d{4}년\s*\d{1,2}월\s*\d{1,2}일)/,
    },
    // 국가: ja "…日に日本でレビュー" / en "Reviewed in Japan on …" / ko "…일에 일본에서 리뷰함"
    country: {
      ja: /日に(.+?)でレビュー/,
      en: /Reviewed in\s+(.+?)\s+on\s+/i,
      ko: /일에\s*(.+?)에서\s*(?:리뷰|작성)/,
    },
  };
  // ⭐ 고른 언어를 먼저, 실패하면 나머지 언어로 폴백.
  //    지인이 언어를 잘못 골라도 값이 통째로 비지 않게 하는 안전장치.
  function langOrder() {
    const first = uiLang();
    return [first].concat(SUPPORTED.filter((l) => l !== first));
  }
  function matchByLang(kind, text) {
    const t = String(text || "");
    for (const l of langOrder()) {
      const re = PAT[kind][l];
      if (!re) continue;
      const m = t.match(re);
      if (m) return m;
    }
    return null;
  }

  // 아마존 별 아이콘 클래스에서 점수를 읽는다. a-star-4-5 → "4.5", a-star-5 → "5".
  // ⭐ 클래스는 번역되지 않으므로 어떤 UI 언어에서도 동작한다. 텍스트보다 우선.
  function starFromClass(root) {
    if (!root) return "";
    const cand = (root.className && /a-star-/.test(root.className)) ? root : q('[class*="a-star-"]', root);
    if (!cand) return "";
    const m = (cand.className || "").match(/a-star-(?:mini-|small-|medium-)?(\d)(?:-(\d))?/);
    if (!m) return "";
    return m[2] ? m[1] + "." + m[2] : m[1];
  }
  // 별점 텍스트 폴백 (1순위는 아이콘 클래스). 언어 폴백은 matchByLang 이 처리.
  function starFromText(t) {
    const m = matchByLang("star", clean(t));
    return m ? m[1] : "";
  }

  async function autoScroll() {
    const y0 = window.scrollY;
    for (let i = 0; i < 10; i++) { window.scrollBy(0, 900); await SLEEP(CFG.lazyScrollWaitMs); }
    window.scrollTo(0, y0);
    await SLEEP(200);
  }

  /* ---- 기본 정보 --------------------------------------------------------- */
  function getTitle() {
    // JP도 <h1 id="title"> 안에 <span id="productTitle"> 구조. 둘 다 대비.
    // ※ 타이틀은 절대 줄이지 않는다(캐릭터 이름이 길어져도 라스에서 직접 수정).
    return clean(txt(q("#productTitle")) || txt(q("#titleSection h1")) || txt(q("#title")) ||
      (q('meta[name="title"]') || {}).content || document.title.replace(/\s*[:|-]\s*Amazon.*$/i, ""));
  }

  // 가격: ￥ 표기 그대로. .a-offscreen(스크린리더용 완성 문자열)이 가장 정확.
  //   캡처 확인: <span class="a-price-symbol">￥</span><span class="a-price-whole">6,380</span>
  //   엔화는 소수점이 없다 → 호주판의 "소수 2자리 강제"를 그대로 두면 ￥6,380.00 이 된다.
  // ⚠️ 절대 document 전체에서 .a-price 를 훑지 말 것 — 오른쪽 스폰서 광고 가격,
  //    "Similar brands" 캐러셀 가격, 사이즈 스와치의 "3 options from $20.65" 를 집어옴.
  //    반드시 센터컬럼(#centerCol)/바이박스 안으로 범위를 좁힌다.
  function priceRoot() {
    return q("#corePriceDisplay_desktop_feature_div") || q("#corePrice_feature_div") ||
      q("#apex_desktop") || q("#buybox") || q("#centerCol") || null;
  }
  function getPrice() {
    const root = priceRoot();
    if (!root) return "";
    const sels = [
      "#corePriceDisplay_desktop_feature_div .a-price[data-a-color='base'] .a-offscreen",
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
      "#corePrice_feature_div .a-price .a-offscreen",
      "#price_inside_buybox",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      ".a-price[data-a-color='price'] .a-offscreen",
      ".a-price .a-offscreen",
    ];
    for (const s of sels) {
      // 셀렉터가 #으로 시작하면 문서 기준, 아니면 root 안에서만
      const el = s.startsWith("#") ? q(s) : q(s, root);
      if (!el) continue;
      // 스와치/광고 안에 있는 가격은 배제
      if (el.closest("#twister, .dimension-values-list, [data-csa-c-content-id*='sponsored'], #similarities_feature_div, #rightCol")) continue;
      const raw = clean(el.textContent);
      const m = raw.match(/([\d,]+\.?\d*)/);
      if (m) {
        // 기호는 .a-offscreen 문자열 앞부분에서, 없으면 형제 .a-price-symbol 에서
        const d = detectCurrency(raw);
        if (d.sym) { curState.sym = d.sym; curState.code = d.code; }
        else {
          const symEl = q(".a-price-symbol", el.closest(".a-price") || root);
          if (symEl) { curState.sym = clean(txt(symEl)); curState.code = ""; }
        }
        return normPrice(m[1]);
      }
    }
    const symEl0 = q(".a-price-symbol", root);
    if (symEl0) { curState.sym = clean(txt(symEl0)); curState.code = ""; }
    const whole = txt(q(".a-price-whole", root)), frac = txt(q(".a-price-fraction", root));
    if (whole) return normPrice(whole.replace(/[^\d,]/g, "") + (frac ? "." + frac.replace(/\D/g, "") : ""));
    return "";
  }
  // 재고 상태 — 품절이면 가격이 아예 없으므로 대본에서 구분 필요
  function getAvailability() {
    const t = clean(txt(q("#availability")) || txt(q("#outOfStock")) ||
      txt(q("#twisterAvailability")) || txt(q("#exports_desktop_outOfStock_buybox_message")));
    const center = clean(txt(q("#centerCol"))) + " " + clean(txt(q("#buybox")));
    // ⭐ 1순위: 요소 존재 여부 — 번역돼도 id 는 안 바뀐다.
    const oosEl = !!(q("#outOfStock") || q("#exports_desktop_outOfStock_buybox_message"));
    const hasCart = !!(q("#add-to-cart-button") || q("#buy-now-button") || q("#submit.buy-now"));
    // 2순위: 다국어 문구 (ja/en 은 캡처로 확인, ko 는 추정)
    const RE_OOS = /在庫切れ|現在お取り扱いできません|一時的に在庫切れ|入荷未定|お取り扱いできません|品切れ|Temporarily out of stock|Currently unavailable|No featured offers available|out of stock|품절|일시\s*품절|현재\s*구매할\s*수\s*없|재고\s*없/i;
    const hay = t + " " + center;
    let oos;
    if (oosEl) oos = true;               // 품절 전용 블록이 떠 있으면 확정
    else if (hasCart) oos = false;       // 장바구니/바로구매 버튼이 있으면 재고 있음
    else oos = RE_OOS.test(hay);         // 둘 다 없을 때만 문구로 판정
    return { in_stock: !oos, text: t || (oos ? "在庫切れ" : "") };
  }
  // ⚠️⚠️ amazon.co.jp 는 계정 배송지/통화 설정에 따라 가격을 **환산해서** 보여준다.
  //    배송지가 한국이면 "KRW 58,609", 일본이면 "\uFFE5 6,380" 처럼 나온다(실제 캡처로 확인).
  //    통화기호를 \uFFE5 로 고정하면 원화 금액에 엔화 기호를 붙여 대본이 통째로 틀어진다.
  //    → 화면에 찍힌 기호를 그대로 읽어서 쓰고, 엔화가 아니면 상태줄에 경고를 띄운다.
  const curState = { sym: "", code: "" };
  function detectCurrency(rawText) {
    const t = clean(rawText);
    // "\uFFE56,380" / "KRW58,609" / "$29.99" / "JPY 6,380"
    const m = t.match(/^\s*(?:([A-Z]{3})|([^\d\s,.]+))\s*[\d,]/);
    const code = m && m[1] ? m[1] : "";
    const sym = code || (m && m[2] ? m[2] : "");
    return { sym, code };
  }
  const CUR_CODE = { "\uFFE5": "JPY", "\u00a5": "JPY", "\u20a9": "KRW", "$": "USD", "\u20ac": "EUR" };
  function normPrice(numStr) {
    const n = Number(String(numStr).replace(/,/g, ""));
    if (!isFinite(n) || n <= 0) return "";
    const sym = curState.sym || "\uFFE5";
    const code = curState.code || CUR_CODE[sym] || "JPY";
    // 엔화·원화는 소수점 없음. 그 외(USD 등)는 두 자리 유지.
    const noFrac = code === "JPY" || code === "KRW";
    const num = noFrac
      ? Math.round(n).toLocaleString("ja-JP")
      : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym + num;
  }
  // 실제 통화가 엔화인지 (아니면 배송지 설정 때문에 환산된 것 → 경고 대상)
  function currencyCode() { return curState.code || CUR_CODE[curState.sym] || "JPY"; }
  function getListPrice() {
    const root = priceRoot();
    if (!root) return "";
    const el = q(".a-text-price .a-offscreen", root) || q(".basisPrice .a-offscreen", root);
    if (!el || el.closest("#twister, .dimension-values-list")) return "";
    const m = clean(el.textContent).match(/([\d,]+\.?\d*)/);
    return m ? normPrice(m[1]) : "";
  }

  function getAsin() {
    // /-/en/dp/… 처럼 언어 접두사가 붙어도 잡히도록 경로 어디서나 매칭
    const byUrl = (location.pathname.match(/\/(?:dp|gp\/product|product-reviews|customer-reviews)\/([A-Z0-9]{10})/) || [])[1];
    if (byUrl) return byUrl;
    // 아마존 JP도 주요 위젯에 data-csa-c-asin 을 달아둠(캡처에서 B0H1KP4B3Z 확인)
    const csa = q("#title_feature_div[data-csa-c-asin], [data-csa-c-asin]:not([data-csa-c-asin=''])");
    const v = csa && csa.getAttribute("data-csa-c-asin");
    if (v && /^[A-Z0-9]{10}$/.test(v)) return v;
    const inp = q("#ASIN") || q('input[name="ASIN"]') || q('input[name="ASIN.0"]');
    if (inp && inp.value) return inp.value.trim();
    return "";
  }

  function getBrand() {
    // JP: "BANDAIのストアを表示" / "ブランド: BANDAI" / EN: "Visit the BANDAI Store"
    const by = clean(txt(q("#bylineInfo")));
    if (by) {
      return by
        .replace(/^(Visit the|Brand:|ブランド[:：])\s*/i, "")
        .replace(/\s*(Store|のストアを表示|のストアを訪問|ストア)$/i, "")
        .trim();
    }
    const tbl = specPairs().find((p) => /^(brand|ブランド|ブランド名|メーカー名?)$/i.test(p[0]));
    return tbl ? tbl[1] : "";
  }
  // 판매자: 브랜드가 아니라 실제 셀러(merchant)
  function getSeller() {
    // JP 바이박스는 "出荷元 / 販売元  Amazon.co.jp" 표 형태 (캡처 확인)
    const s = clean(txt(q("#sellerProfileTriggerId"))) ||
      clean(txt(q("#merchant-info a"))) ||
      clean(txt(q("#tabular-buybox .tabular-buybox-text[tabular-attribute-name='Sold by']"))) ||
      clean(txt(q("#tabular-buybox .tabular-buybox-text[tabular-attribute-name='販売元']")));
    if (s && !/^(amazon\.co\.jp|amazon jp|アマゾンジャパン)$/i.test(s)) return s;
    const mi = clean(txt(q("#merchant-info"))) + " " + clean(txt(q("#tabular-buybox")));
    if (/Amazon\.co\.jp|Amazon JP/i.test(mi)) return "Amazon.co.jp";
    return s || getBrand() || "";
  }

  function getRating() {
    const el = q("#acrPopover");
    // ⭐ 1순위: 별 아이콘 클래스(a-star-4-5) — 언어 무관
    let score = starFromClass(q("#averageCustomerReviews") || el);
    if (!score) {
      // 2순위: 텍스트. ⚠️ 일본어 "5つ星のうち4.5" 는 앞의 5를 먼저 집으면 전부 5점이 된다.
      const t = (el && (el.getAttribute("title") || txt(el))) || txt(q('[data-hook="rating-out-of-text"]'));
      score = starFromText(t);
    }
    // 개수는 숫자만 뽑으면 되므로 언어 무관: "1,480件の評価" / "1,480 ratings" / "평가 1,480개"
    const cnt = clean(txt(q("#acrCustomerReviewText"))).match(/([\d,]+)/);
    return { score, count: cnt ? cnt[1].replace(/,/g, "") : "" };
  }

  function getCategoryPath() {
    return qa("#wayfinding-breadcrumbs_feature_div ul li a").map((a) => clean(txt(a))).filter(Boolean);
  }

  function getDelivery() {
    const blocks = ["#mir-layout-DELIVERY_BLOCK", "#deliveryBlockMessage", "#primeDeliveryMessage",
      "#fast-track-message", "#delivery-message"];
    const lines = blocks.map((s) => clean(txt(q(s)))).filter(Boolean);
    const all = lines.join(" | ");
    // 캡처 예: "無料配送 8月11日 火曜日にお届け" / "最も早い配送 8月6日 木曜日にお届け"
    const badges = [];
    if (q("#isPrimeBadge") || q(".a-icon-prime") || /\bPrime\b|プライム/.test(all)) badges.push("Prime");
    // ⚠️ 배지 값은 항상 일본어로 고정한다(대본 재료라 UI 언어를 따라가면 안 됨).
    //    판정용 정규식만 다국어. ja/en 은 캡처로 확인, ko 는 추정.
    if (/無料配送|配送料無料|FREE\s+(Delivery|Shipping)|Free\s+delivery|무료\s*배송|배송비\s*무료/i.test(all)) badges.push("無料配送");
    if (/最も早い配送|お急ぎ便|当日お届け|翌日配送|Fastest delivery|Get it (as soon as )?tomorrow|Same-Day|가장\s*빠른\s*배송|당일\s*배송|익일\s*배송/i.test(all)) badges.push("お急ぎ便");
    // 도착 문구는 "…にお届け" 에서 끊는다. 뒤로 더 가져가면 "対象となる注文で¥9000以上 配送先"
    // 같은 조건문·배송지 안내가 붙어 대본 재료로 지저분해진다(실제로 그렇게 나왔음).
    const arrival = ((all.match(/[^|。]{0,28}?(?:\d{1,2}月\d{1,2}日[^|。]{0,12})?にお届け/) ||   // ja
                      all.match(/[^|]{0,28}?\d{1,2}월\s*\d{1,2}일[^|]{0,14}(?:도착|배송)/) ||        // ko
                      all.match(/(?:delivery|Delivered|Get it)[^|]{0,60}/i) || [""])[0])            // en
                    .replace(/^[\s・|]+/, "").trim().slice(0, 60);
    return {
      badges,
      is_rocket: false,                 // 쿠팡 전용 필드 — 스키마 호환용
      is_prime: badges.includes("Prime"),
      is_free_shipping: badges.includes("無料配送"),
      arrival_text: arrival,
      rocket_delivery: "該当なし",   // 쿠팡 전용 필드 — 스키마 호환용 자리채움
    };
  }

  /* ---- 스펙 / 옵션 ------------------------------------------------------- */
  // 접혀 있는 "機能と仕様 / サイズ / スタイル / 商品詳細" (EN: Features & Specs / Item details)
  // 확장 섹션을 먼저 펼침. 캡처에서 #productDetails_expanderTables_depthLeftSections 확인.
  function expandDetailSections() {
    qa("#productDetailsWithModules_feature_div .a-expander-header, " +
       "#productDetails_expanderSectionTables .a-expander-header, " +
       "#productDetails_expanderTables_depthLeftSections .a-expander-header").forEach((h) => {
      if (h.getAttribute("aria-expanded") === "false" && visible(h)) { try { h.click(); } catch (_) {} }
    });
  }

  function specPairs() {
    const out = [];
    const push = (k, v) => {
      k = clean(k).replace(/[\u200e\u200f]/g, "").replace(/\s*:\s*$/, "");
      v = clean(v).replace(/[\u200e\u200f]/g, "").replace(/^:\s*/, "");
      if (k && v && k.length < 60 && v.length < 300) out.push([k, v]);
    };
    // 1) 商品概要(Product overview) 표
    qa("#productOverview_feature_div tr").forEach((tr) => {
      const c = qa("td,th", tr); if (c.length >= 2) push(txt(c[0]), txt(c[1]));
    });
    // 2) 신형 商品情報(Product information) — 확장 섹션 안의 표들
    qa("#productDetailsWithModules_feature_div tr, #productDetails_expanderSectionTables tr, " +
       "#productDetails_expanderTables_depthLeftSections tr").forEach((tr) => {
      const c = qa("td,th", tr); if (c.length >= 2) push(txt(c[0]), txt(c[1]));
    });
    // 3) 구형 登録情報 / 詳細情報(Technical details) 표
    qa("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #technicalSpecifications_section_1 tr")
      .forEach((tr) => { const th = q("th", tr), td = q("td", tr); if (th && td) push(txt(th), txt(td)); });
    // 4) 登録情報 불릿 — <span class="a-text-bold">키 :</span><span>값</span> 구조
    //    ⚠️ 키 안에 RTL 제어문자(\u200e/\u200f)가 섞여 있어 push()에서 제거한다
    qa("#detailBullets_feature_div li span.a-list-item, #detailBulletsWrapper_feature_div li span.a-list-item").forEach((li) => {
      const bold = q(".a-text-bold", li);
      if (bold) {
        const key = txt(bold);
        const val = clean(txt(li).slice(txt(bold).length));   // 볼드 뒤쪽 전체가 값
        if (val) { push(key, val); return; }
      }
      const parts = txt(li).split(/\s*:\s*/);
      if (parts.length >= 2) push(parts[0], parts.slice(1).join(" : "));
    });
    return out;
  }
  function getSpec() {
    const o = {};
    for (const [k, v] of specPairs()) if (!o[k]) o[k] = v;
    return o;
  }
  function getBullets() {
    return qa("#feature-bullets ul li span.a-list-item")
      .map((s) => clean(txt(s)))
      .filter((t) => t && t.length > 3 && !/see more product details|商品の説明をもっと見る|続きを読む|제품\s*상세정보\s*더\s*보기|더\s*보기/i.test(t))
      .slice(0, 12);
  }
  // 변형 옵션(색상/사이즈 등). JP도 신형 inline-twister 스와치 구조.
  //   캡처 확인: #inline-twister-row-color_name / #inline-twister-row-size_name,
  //             표시는 "色: Orange Tropics", "サイズ: 通常版"
  //   ⚠️ 호주판은 라벨을 "Size Name"으로 하드코딩했는데, JP는 색/사이즈가 섞여
  //      전부 사이즈로 찍히므로 행에서 실제 라벨을 읽어온다.
  function getOptions() {
    const out = [];
    const seen = new Set();
    const add = (name, value, extra) => {
      const k = name + "|" + value;
      if (!value || seen.has(k)) return;
      seen.add(k);
      const o = { name: clean(name).replace(/\s*:\s*$/, ""), value: clean(value) };
      if (extra) o.note = clean(extra);
      out.push(o);
    };
    // ⭐ 라벨은 화면 텍스트가 아니라 **id 에서** 뽑는다.
    //    id(inline-twister-row-color_name)는 번역되지 않으므로 UI 언어가 뭐든 같고,
    //    출력이 항상 일본어로 고정돼 대본 재료가 오염되지 않는다.
    const DIM_JA = {
      color: "色", size: "サイズ", style: "スタイル", pattern: "パターン",
      flavor: "フレーバー", material: "素材", capacity: "容量", edition: "エディション",
      model: "モデル", length: "長さ", scent: "香り", count: "個数", configuration: "構成",
    };
    const dimFromId = (id) => {
      const key = String(id || "").replace(/^(inline-twister-row-|variation_|twister_)/, "").replace(/_name$/, "");
      if (DIM_JA[key]) return DIM_JA[key];
      for (const k in DIM_JA) if (new RegExp(k, "i").test(id || "")) return DIM_JA[k];
      return "";
    };
    // 현재 선택값
    qa('#twister .a-row, #twisterContainer .a-row, [id^="inline-twister-row-"]').forEach((row) => {
      const val = clean(txt(q(".selection", row)));
      if (!val) return;
      const byId = dimFromId(row.id) || dimFromId((row.closest('[id^="inline-twister-row-"], [id^="variation_"]') || {}).id);
      const label = byId || clean(txt(q(".a-form-label, .a-text-bold", row))).split(/[:：]/)[0].trim() || "バリエーション";
      add(label, val);
    });
    const rowLabel = (li) => {
      const row = li.closest('[id^="inline-twister-row-"], [id^="variation_"], .inline-twister-row, #twister');
      if (!row) return "バリエーション";
      return dimFromId(row.id) || "バリエーション";
    };
    // 신형 스와치 목록 — 선택된 것 + 나머지 변형들(각각 가격/품절 문구가 붙어있음)
    qa("#twister .dimension-values-list li, #twister ul.a-button-list li, " +
       '[id^="inline-twister-row-"] .dimension-values-list li').forEach((li) => {
      const val = clean(txt(q(".swatch-title-text-display, .swatch-title-text", li)));
      if (!val) return;
      const info = clean(txt(q(".dimension-slot-info, #twisterAvailability, .inline-twister-swatch-price", li)));
      const selected = !!q(".a-button-selected", li) || li.getAttribute("data-initiallyselected") === "true";
      add(rowLabel(li) + (selected ? " (選択中)" : ""), val, info);
    });
    return out;
  }

  /* ---- 상세설명 ---------------------------------------------------------- */
  async function scrapeDescription() {
    // A+ 콘텐츠는 lazy → 스크롤로 로드 유도, 접힌 스펙 섹션은 펼침
    await autoScroll();
    expandDetailSections();
    await SLEEP(400);
    const parts = [];
    const bullets = getBullets();
    if (bullets.length) parts.push(bullets.map((b) => "• " + b).join("\n"));
    const pd = txt(q("#productDescription"));
    if (pd) parts.push(pd);
    // A+ (aplus) 이미지 alt/텍스트
    const aplus = q("#aplus") || q("#aplus_feature_div") || q("#aplusBrandStory_feature_div");
    if (aplus) {
      const t = txt(aplus).replace(/^From the (manufacturer|brand)\s*/i, "")
        .replace(/^(メーカーより|ブランド紹介|商品紹介)\s*/, "").trim();
      if (t && t.length > 30) parts.push(t);
    }
    let out = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (out.length > CFG.descMax) out = out.slice(0, CFG.descMax) + "\n…(以下省略)";
    return out;
  }

  // 重要な情報(Important information) — 安全情報 / 成分 / 使用方法
  // 건강·식품 카테고리에서 대본 소재로 값어치가 큼(성분·복용법·알레르기)
  function getImportantInfo() {
    const root = q("#importantInformation_feature_div") || q("#important-information");
    if (!root) return "";
    const t = txt(root).replace(/^Important information\s*/i, "").replace(/^重要な?情報\s*/, "").trim();
    return t.length > 20 ? t.slice(0, 2500) : "";
  }

  // AI 후기 요약(일본은 Rufus 요약 문단) + 별점 분포
  //   캡처 확인: "星5つ 75% / 星4つ 13% …" (EN: "5 star 75%")
  function getReviewInsights() {
    const sum = clean(txt(q('[data-testid="overall-summary"]')) ||
                      txt(q('[data-hook="cr-insights-widget-summary"]')));
    const hist = {};
    qa("#histogramTable tr, [data-hook='cr-summarization-attributes-list'] tr").forEach((tr) => {
      const star = clean(txt(q("td:first-child, .a-text-left", tr)));
      const pct = clean(txt(q("td:last-child, .a-text-right", tr)));
      if (!/%$/.test(pct)) return;
      const m = star.match(/^星\s*(\d)\s*つ$/) || star.match(/^(\d)\s*star$/i);
      if (m) hist[m[1] + "star"] = pct;
    });
    return { customers_say: sum && sum.length > 20 ? sum : "", histogram: hist };
  }

  /* ---- 후기 -------------------------------------------------------------- */
  // 후기 본문에서 아마존 UI 부스러기 제거
  function cleanReviewBody(s) {
    return clean(s)
      // 영어 UI
      .replace(/Brief content visible,?\s*double tap to read full content\.?/gi, "")
      .replace(/Full content visible,?\s*double tap to read brief content\.?/gi, "")
      // 일본어 UI (캡처: 参考になった / 報告する / レビューを翻訳する)
      .replace(/一部のコンテンツが表示されています。?\s*ダブルタップすると全文が表示されます。?/g, "")
      .replace(/全文が表示されています。?\s*ダブルタップすると一部のコンテンツが表示されます。?/g, "")
      .replace(/\s*(この)?レビューを(日本語に)?翻訳する\s*/g, "")
      .replace(/\s*(Translate review to English|Translate all reviews to English)\s*/gi, "")
      .replace(/\s*(Read more|Read less|더 보기|간략히|続きを読む|もっと読む)\s*$/i, "")
      .replace(/\s*Helpful\s*(\|\s*)?Report\s*$/i, "")
      .replace(/\s*参考になった\s*(\|\s*)?報告する\s*$/i, "")
      .replace(/\s*도움이\s*됨\s*(\|\s*)?신고\s*$/i, "")
      // 끝의 "N명이 도움이 됐다" 류 — 日/英/한을 한 패턴으로.
      //   ja "3人のユーザーが役に立ったと感じています" / en "3 people found this helpful"
      //   ko "3명의 사용자가 도움이 되었다고 하셨습니다"
      .replace(/\s*\d+\s*(?:人|명|people|person)[^\n]{0,40}?(?:役に立った|도움이|helpful)[^\n]*$/i, "")
      .trim();
  }

  function parseReviewNodes(root) {
    const out = [];
    const SEL = '[data-hook="review"], [data-hook="reviewContainer"], .review[id^="R"]';
    // ⚠️ reviewContainer 안에 review 가 또 들어있는 중첩 구조 → 바깥 껍데기는 버리고 안쪽만 사용
    const nodes = qa(SEL, root).filter((n) => !q(SEL, n));
    nodes.forEach((n) => {
      // ⚠️ 아마존은 같은 후기를 [접힌 미리보기 / 펼친 전문] 두 벌로 넣어둠.
      //    앞엣것을 집으면 "…it does the jo" 처럼 단어 중간에서 잘린다 → 가장 긴 놈을 채택.
      const bodyCands = qa('[data-hook="review-body"], [data-hook="reviewText"], ' +
        '[data-hook="review-collapsed"], [data-hook="reviewRichContentContainer"], ' +
        '.review-text-content, .reviewText', n);
      let content = "";
      for (const el of bodyCands) {
        if (el.closest(".a-teaser-describedby-collapsed, .a-teaser-describedby-expanded")) continue;
        const t = cleanReviewBody(txt(el));
        if (t.length > content.length) content = t;
      }
      if (!content || content.length < 5) return;

      // 제목
      const titleEl = q('[data-hook="review-title"] span:not(.a-icon-alt):last-child, ' +
        '[data-hook="review-title"], .review-title-content span, .review-title', n);
      const rawTitle = clean(txt(titleEl));

      // 별점 — 반드시 "후기 안의 별점 위젯 또는 제목 링크" 범위에서만 찾는다.
      // (범위를 안 잡으면 상품 전체 평점이나 광고 별점을 집어와 4점짜리가 5점이 됨)
      const starBox = q('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], ' +
        '.review-rating, [class*="review-star-rating"]', n) || titleEl;
      // ⭐ 1순위: 별 아이콘 클래스(a-star-4-5) — 번역과 무관. UI 언어가 바뀌어도 안 깨진다.
      // 2순위: .a-icon-alt 텍스트(다국어). 일본어 "5つ星のうち4.0" 은 앞의 5를 집으면 안 됨.
      let star = starFromClass(starBox) || starFromText(txt(q(".a-icon-alt", starBox || n)));

      const dateRaw = clean(txt(q('[data-hook="review-date"]', n)));
      // 날짜줄은 UI 언어를 따라간다(日/英/한). 고른 언어 우선 → 나머지 폴백.
      //   ja "2026年7月20日に日本でレビュー済み"
      //   en "Reviewed in Japan on July 20, 2026"
      //   ko "2026년 7월 20일에 일본에서 리뷰함"
      const dm = matchByLang("date", dateRaw);
      const cm = matchByLang("country", dateRaw);
      const country = cm ? clean(cm[1]) : "";
      // ⚠️ 해외 후기 판정은 텍스트가 아니라 컨테이너로. 화면 언어와 무관하게 동작한다.
      //    캡처 확인: #localTopReviews(일본) vs #internationalTopReviews(타국)
      // ⭐ 해외 후기 판정의 1순위는 컨테이너 id — 번역과 무관해서 가장 믿을 만하다.
      //    (캡처 확인: #localTopReviews = 일본, #internationalTopReviews = 타국)
      //    국가명 비교는 보조. 일본을 뜻하는 표기는 언어별로 다르다.
      const JP_NAME = /^(日本|日本国|Japan|일본|일본국)$/i;   // 日/英/한 3종
      const overseas = !!(n.closest && n.closest('#internationalTopReviews, #internationalTopReviewsList, #cm_cr-global-review-list')) ||
        (!!country && !JP_NAME.test(country));
      // 쿠팡 후기엔 "어떤 옵션을 산 사람인지"가 product 필드로 들어감 → 아마존 variation으로 대응
      //   캡처 확인: data-hook="product-variation-attributes" → "色: White Glacier | サイズ: 通常版"
      const variant = clean(txt(q('[data-hook="product-variation-attributes"], ' +
        '[data-hook="format-strip"], .review-format-strip', n)));
      out.push({
        title: rawTitle
          .replace(/^\d+(\.\d+)?\s*out of\s*5\s*stars?\s*/i, "")   // en
          .replace(/^5つ星のうち\s*[\d.]+\s*/, "")                     // ja
          .replace(/^(?:별\s*5\s*개\s*중|5\s*점\s*만점에)\s*[\d.]+\s*점?\s*/, "").trim(),   // ko
        content,
        author: clean(txt(q(".a-profile-name", n))),
        rating: (() => {   // "4.0 out of 5 stars" → "4",  "4.5" → "4.5" 로 표기 통일
          const v = parseFloat((star.match(/([\d.]+)/) || [, ""])[1]);
          return isFinite(v) ? String(v) : "";
        })(),
        date: dm ? dm[1] : ((dateRaw.match(/on\s+(.+)$/i) || [, dateRaw])[1] || dateRaw),
        country,
        overseas,
        variant,
        // "Amazonで購入" / "Verified Purchase"
        verified: !!q('[data-hook="avp-badge"]', n),
      });
    });
    return out;
  }

  function dedupeReviews(list) {
    const seen = new Set(), out = [];
    for (const r of list) {
      const k = r.content.slice(0, 60).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); out.push(r);
    }
    return out;
  }

  // 후기 전체보기 주소 — 추측하지 말고 페이지에 박힌 "レビューをすべて見る" 링크를 그대로 쓴다.
  //   캡처 확인(일본어 UI): #cm_cr_top_reviews_to_arp_button
  //     → /portal/customer-reviews/B0H1KP4B3Z/ref=cm_cr_dp_d_show_all_top?ie=UTF8&reviewerType=all_reviews
  //   캡처 확인(영어 UI):   → /-/en/portal/customer-reviews/B0H1KP4B3Z/ref=…
  //   즉 JP도 호주와 같은 /portal/customer-reviews/ 이고, 영어 모드면 /-/en/ 이 앞에 붙는다.
  //   경로를 하드코딩하면 조용히 0건이 되므로 링크 우선, 폴백은 접두사를 이어붙인다.
  function reviewPageBases(asin) {
    const bases = [];
    const link = q("#cm_cr_top_reviews_to_arp_button") ||
      q('[data-hook="see-all-reviews-link-foot"]') ||
      q('a[href*="customer-reviews"], a[href*="product-reviews"]');
    const href = link && link.getAttribute("href");
    if (href) { try { bases.push(new URL(href, location.origin).href); } catch (_) {} }
    if (asin) {
      const p = location.origin + langPrefix();
      bases.push(p + "/portal/customer-reviews/" + asin + "/?reviewerType=all_reviews");
      bases.push(p + "/product-reviews/" + asin + "/?reviewerType=all_reviews&sortBy=recent");
      // 언어 접두사 없이도 한 번 더 (계정 설정과 실제 링크가 어긋나는 경우 대비)
      if (langPrefix()) {
        bases.push(location.origin + "/portal/customer-reviews/" + asin + "/?reviewerType=all_reviews");
      }
    }
    return bases;
  }
  function pagedUrl(base, p) {
    const u = new URL(base);
    u.searchParams.set("pageNumber", String(p));
    if (!u.searchParams.has("reviewerType")) u.searchParams.set("reviewerType", "all_reviews");
    return u.href;
  }
  async function fetchReviewPage(url) {
    const info = { url, status: 0, htmlLen: 0, hasHook: false, gotN: 0 };
    const res = await fetch(url, { credentials: "same-origin", headers: { Accept: "text/html" } });
    info.status = res.status;
    info.finalUrl = res.url || "";
    info.redirected = !!res.redirected;
    // ⚠️ 아마존은 후기 전체보기가 로그인 필수 → 302로 /ap/signin 으로 튕긴다.
    //    fetch는 리다이렉트를 자동으로 따라가 200을 돌려주므로, 최종 주소를 봐야 안다.
    if (/\/ap\/signin/i.test(info.finalUrl)) {
      return { err: "로그인 필요 (amazon.co.jp 에 로그인하면 후기 더 가져옴)", info };
    }
    if (!res.ok) return { err: "응답 " + res.status, info };
    const html = await res.text();
    info.htmlLen = html.length;
    info.hasHook = /data-hook="review"/.test(html);          // 서버가 후기를 HTML로 줬는지
    info.signin = /ap\/signin|Sign-In|email or mobile phone number|Eメール(アドレス)?または携帯電話番号|サインイン|로그인|이메일\s*또는\s*휴대폰\s*번호/i.test(html);
    info.captcha = /Enter the characters you see below|以下の文字を入力してください|아래에?\s*보이는\s*문자를\s*입력/i.test(html);
    if ((info.signin || info.captcha) && !info.hasHook) {
      return { err: info.captcha ? "봇 확인 페이지" : "로그인 필요 (amazon.co.jp 에 로그인하면 후기 더 가져옴)", info };
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const got = parseReviewNodes(doc);
    info.gotN = got.length;
    // 다음 페이지 주소는 만들지 말고 페이지에 있는 링크를 그대로 쓴다
    // (pageNumber 파라미터를 무시하는 주소가 있어서 직접 만들면 같은 페이지가 반복됨)
    const nextEl = doc.querySelector('li.a-last:not(.a-disabled) a[href], ' +
      '[data-hook="pagination-bar"] li.a-last a[href], a.a-last[href]');
    const nextHref = nextEl && nextEl.getAttribute("href");
    if (nextHref) { try { info.next = new URL(nextHref, location.origin).href; } catch (_) {} }
    return { got, info, next: info.next || "" };
  }

  // 같은 주소에 정렬/별점 필터만 바꿔 붙인 변형 목록을 만든다.
  // ⚠️ 기본 주소는 "도움돼요 순"이라 5점 후기만 잔뜩 나온다(5★17 2★1 1★1 같은 분포).
  //    별점별로 나눠 요청하면 낮은 별점 후기도 골고루 들어와 대본이 균형 잡힌다.
  function reviewVariants(base) {
    const mk = (params) => {
      try {
        const u = new URL(base);
        Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
        return u.href;
      } catch (_) { return ""; }
    };
    // 쇼핑 채널용이라 낮은 별점은 안 긁는다. 기본 주소가 pageNumber 를 무시해
    // 같은 10개만 주므로, 정렬·별점 묶음을 바꿔가며 다른 후기를 확보한다.
    return [
      { url: mk({ sortBy: "recent", reviewerType: "all_reviews" }), tag: "최신순" },
      { url: mk({ filterByStar: "five_star" }), tag: "5점" },
      { url: mk({ filterByStar: "five_star", sortBy: "recent" }), tag: "5점·최신" },
      { url: mk({ filterByStar: "four_star" }), tag: "4점" },
      { url: mk({ filterByStar: "positive", sortBy: "recent" }), tag: "높은별점·최신" },
    ].filter((v) => v.url);
  }

  // 후기 수집.
  // ⚠️ 페이지네이션 함정: pageNumber 를 무시하고 매번 같은 후기를 주는 주소가 있다
  //    ("3페이지 읽었는데 10개"의 정체). 그래서 페이지 넘김은 반드시 페이지 안의
  //    "다음" 링크를 따라가고, 그마저 없으면 정렬/별점 변형으로 다른 묶음을 긁는다.
  async function scrapeReviews(asin, onStatus) {
    const onPage = parseReviewNodes(document);
    let all = dedupeReviews(onPage.slice());
    let totalSeen = onPage.length;
    let pagesRead = 0, fromPages = 0, blocked = "";
    const attempts = [];
    let budget = CFG.reviewMaxPages;    // 총 요청 횟수 상한

    const bases = reviewPageBases(asin);
    if (!bases.length) {
      return { reviews: all, totalSeen, pagesRead, fromPages, attempts,
               source: "product_page", blocked: "후기 전체보기 링크를 못 찾음" };
    }

    // 주소 하나를 받아 "다음" 링크를 따라가며 긁는다. 새로 안 늘면 즉시 중단.
    async function crawl(startUrl, tag) {
      let url = startUrl;
      for (let p = 1; url && budget > 0; p++) {
        budget--;
        onStatus && onStatus(`후기 수집 중… ${tag} ${p}페이지 (모은 개수 ${all.length})`);
        let r;
        try { r = await fetchReviewPage(url); }
        catch (e) { attempts.push({ url, tag, page: p, err: "예외: " + (e && e.message) }); return; }
        if (r.info) attempts.push({ ...r.info, tag, page: p, err: r.err || "" });
        if (r.err) { blocked = "후기 전체보기 " + r.err; return; }
        if (!r.got.length) return;

        const before = all.length;
        all = dedupeReviews(all.concat(r.got));
        const added = all.length - before;
        totalSeen += r.got.length;
        attempts[attempts.length - 1].added = added;
        if (added > 0) { pagesRead++; fromPages += added; }
        if (all.length >= CFG.reviewTarget) return;
        if (added === 0 && p > 1) return;      // 같은 것만 반복 → 이 갈래는 끝
        url = r.next || "";                    // 다음 링크가 없으면 종료
        if (url) await SLEEP(CFG.reviewPageWaitMs);
      }
    }

    for (const b of bases) {
      if (all.length >= CFG.reviewTarget || budget <= 0) break;
      if (fromPages > 0) break;   // 이미 통한 주소가 있으면 나머지 주소는 같은 내용 — 요청 아낌
      await crawl(pagedUrl(b, 1), "기본");
      if (all.length >= CFG.reviewTarget || budget <= 0) break;
      // 페이지 넘김이 안 먹었으면 정렬·별점 변형으로 다른 묶음을 가져온다
      for (const v of reviewVariants(b)) {
        if (all.length >= CFG.reviewTarget || budget <= 0) break;
        const before = all.length;
        await crawl(v.url, v.tag);
        if (all.length === before) continue;
      }
    }

    if (!fromPages) {
      const a = attempts[0] || {};
      const allSignin = attempts.length && attempts.every((x) => /로그인 필요/.test(x.err || ""));
      const why = allSignin ? "아마존에 로그인하면 후기를 더 가져올 수 있어요"
        : a.err ? a.err
        : (a.htmlLen && !a.hasHook ? `HTML ${a.htmlLen}자 받았지만 후기가 안 들어있음(자바스크립트로 그리는 페이지)`
        : "원인 불명");
      console.warn("[아마존JP긁기] 후기 전체보기 실패 상세:", attempts);
      return { reviews: all, totalSeen, pagesRead, fromPages, attempts,
               source: "product_page", blocked: "후기 전체보기 실패 — " + why };
    }

    console.info("[아마존JP긁기] 후기 수집 기록:", attempts);
    return {
      reviews: all.slice(0, CFG.reviewTarget * 2),
      totalSeen, pagesRead, fromPages, attempts,
      source: "product_reviews_pages",
      blocked,
    };
  }

  /* ---- 이미지 ------------------------------------------------------------ */
  // 아마존 이미지 URL의 크기 수식어(._AC_SX466_.)를 떼면 원본 대용량이 나옴
  function hiRes(url) {
    if (!url) return "";
    return url.split("?")[0].replace(/\._[^./]*_\./, ".");
  }
  function getImageCandidates() {
    const set = new Map();   // hiRes → 원본(썸네일) 주소
    const add = (u) => {
      if (!u || !/^https?:/.test(u)) return;
      if (/sprite|transparent-pixel|grey-pixel|play-button|icon/i.test(u)) return;
      const h = hiRes(u);
      if (!set.has(h)) set.set(h, u);
    };
    // 1) 메인 이미지의 data-a-dynamic-image (여러 해상도 JSON)
    const land = q("#landingImage") || q("#imgBlkFront") || q("#main-image");
    if (land) {
      add(land.getAttribute("data-old-hires") || "");
      try {
        const dyn = JSON.parse(land.getAttribute("data-a-dynamic-image") || "{}");
        Object.keys(dyn).forEach(add);
      } catch (_) {}
      add(land.src);
    }
    // 2) 썸네일 목록
    qa("#altImages li.imageThumbnail img, #altImages li img, #imageBlockThumbs img").forEach((im) => add(im.src));
    // 3) 폴백: 이미지 블록 전체
    if (set.size < 2) qa("#imageBlock img, #main-image-container img").forEach((im) => add(im.src));
    return [...set.keys()].slice(0, CFG.candidateMax);
  }
  function defaultSelected(cands) { return cands.slice(0, CFG.imageCount); }

  const b64cache = new Map();
  function xhrBlob(url) {
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: "GET", url, responseType: "blob", timeout: 20000,
          onload(res) { resolve(res.status >= 200 && res.status < 300 ? res.response : null); },
          onerror() { resolve(null); }, ontimeout() { resolve(null); },
        });
      } catch (_) { resolve(null); }
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
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);   // 투명 PNG 대비 흰 배경
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(objurl);
        try { resolve(c.toDataURL("image/jpeg", CFG.imgQuality)); } catch (_) { resolve(null); }
      };
      img.onerror = () => { URL.revokeObjectURL(objurl); resolve(null); };
      img.src = objurl;
    });
  }
  async function toDataURL(url) {
    if (b64cache.has(url)) return b64cache.get(url);
    let data = null;
    for (const u of [url, url.replace(/\.jpg$/i, "._AC_SL1500_.jpg")]) {  // 원본 → 큰사이즈 폴백
      const blob = await xhrBlob(u);
      if (blob) { data = await blobToDataURL(blob); if (data) break; }
    }
    b64cache.set(url, data);
    return data;
  }

  /* ---- 번역 (크롬 내장 on-device Translator API) -------------------------- */
  const trState = { warned: false, reason: "", cache: new Map() };
  let _translator = { key: null, promise: null };

  async function getTranslator() {
    const T = (typeof self !== "undefined" && self.Translator) ? self.Translator : null;
    if (!T || !T.create) {
      return { unavailable: true, details: "self.Translator 없음 (크롬 138+ 필요 / chrome://flags 확인)" };
    }
    const key = "ja-ko";
    if (_translator.key !== key || !_translator.promise) {
      _translator.key = key;
      _translator.promise = (async () => {
        // ⚠️ create() 를 **가장 먼저** 부른다. 앞에 await 를 하나라도 두면
        //    (예전엔 availability() 를 먼저 await 했다) 사용자 제스처 활성화가
        //    만료돼 "Requires a user gesture when availability is
        //    downloading/downloadable" 로 실패한다. 실제로 그 오류를 겪었다.
        try {
          return await T.create({
            sourceLanguage: "ja", targetLanguage: "ko",
            monitor(m) {
              m.addEventListener("downloadprogress", (e) => {
                const pct = Math.round((e.loaded || 0) * 100);
                setStatus(`번역 모델 내려받는 중… ${pct}% (처음 한 번만)`);
              });
            },
          });
        } catch (e) {
          const msg = (e && e.message ? e.message : String(e));
          let why = "";
          try { if (T.availability) why = await T.availability({ sourceLanguage: "ja", targetLanguage: "ko" }); } catch (_) {}
          const gesture = /user gesture|user activation/i.test(msg);
          return {
            unavailable: true,
            details: gesture
              ? "번역 모델을 아직 안 받았어요. 패널의 '한국어 번역 병기' 체크를 껐다 켜면 그 자리에서 내려받기가 시작됩니다(처음 한 번만)."
              : "Translator.create 실패: " + msg + (why ? ` (모델 상태: ${why})` : ""),
          };
        }
      })();
    }
    const r = await _translator.promise;
    if (r && r.unavailable) _translator = { key: null, promise: null };   // 다음 시도 재도전 가능
    return r;
  }

  async function translateText(text) {
    if (!CFG.translate) return "";
    const src = clean(text);
    if (!src) return "";
    if (trState.cache.has(src)) return trState.cache.get(src);
    const t = await getTranslator();
    if (!t || t.unavailable) {
      trState.warned = true; trState.reason = (t && t.details) || "원인 불명";
      return "";
    }
    try {
      // 긴 글은 문단 단위로 잘라서 순차 번역(모델 입력 한계·속도 대비)
      const chunks = [];
      let buf = "";
      for (const para of String(text).split(/\n+/)) {
        if ((buf + "\n" + para).length > CFG.trChunk && buf) { chunks.push(buf); buf = para; }
        else buf = buf ? buf + "\n" + para : para;
      }
      if (buf) chunks.push(buf);
      const outs = [];
      for (const c of chunks) outs.push(await t.translate(c));
      const out = outs.join("\n").trim();
      if (trState.cache.size > 600) trState.cache.clear();
      trState.cache.set(src, out);
      return out;
    } catch (e) {
      trState.warned = true;
      trState.reason = "translate() 실패: " + (e && e.message ? e.message : String(e));
      return "";
    }
  }

  async function translateAll(base, onStatus) {
    if (!CFG.translate) return { available: false, reason: "번역 끄기 상태" };
    onStatus && onStatus("④ 한국어 번역 중… (처음엔 모델 다운로드로 오래 걸려요)");
    base.title_ko = await translateText(base.title);
    if (trState.warned && !base.title_ko) return { available: false, reason: trState.reason };

    base.desc_ko = await translateText(base.desc);
    base.important_ko = await translateText(base.important);
    base.bullets_ko = [];
    for (const b of base.bullets) base.bullets_ko.push(await translateText(b));

    const rs = base.reviewData.reviews;
    for (let i = 0; i < rs.length && i < CFG.trReviewMax; i++) {
      onStatus && onStatus(`④ 후기 번역 중… (${i + 1}/${Math.min(rs.length, CFG.trReviewMax)})`);
      rs[i].content_ko = await translateText(rs[i].content);
      if (rs[i].title) rs[i].title_ko = await translateText(rs[i].title);
    }
    return { available: !trState.warned, reason: trState.warned ? trState.reason : "" };
  }

  /* ---- JSON 조립 --------------------------------------------------------- */
  // 기본칸(라스가 읽는 name/description/content)에 어느 언어를 넣을지 결정.
  // primary가 "ko"여도 번역이 없으면 원문으로 안전 폴백.
  // 병기본은 **항상 일본어 원문이 위, 한국어 번역이 _ko 로 아래**.
  // (예전엔 위칸 언어를 고르는 토글이 있었지만, '번역만 복사/다운'이 생기면서
  //  하는 일이 필드 자리 뒤집기뿐이라 헷갈리기만 해서 없앴다.)
  function koReady(ko) { return CFG.translate && !!clean(ko); }
  function langPick(orig, ko) {
    return { main: orig, altKey: "_ko", alt: koReady(ko) ? ko : "" };
  }
  function langPickArr(orig, ko) {
    const has = CFG.translate && Array.isArray(ko) && ko.some((t) => clean(t));
    return { main: orig, altKey: "_ko", alt: has ? ko : [] };
  }

  function buildJson(d) {
    const nm = langPick(d.title, d.title_ko);
    const ds = langPick(d.desc, d.desc_ko);
    const bl = langPickArr(d.bullets, d.bullets_ko);

    const product = {
      name: nm.main,
      ["name" + nm.altKey]: nm.alt,      // 원문 바로 아래에 번역이 오도록
      price: d.price,
      list_price: d.listPrice || "",
      currency: currencyCode(),   // 배송지 설정에 따라 KRW 등이 될 수 있음(그대로 기록)
      rating: d.rating.score,
      rating_count: d.rating.count,
      in_stock: d.availability.in_stock,
      availability: d.availability.text,
      ids: { asin: d.asin, store: d.seller },
      spec: d.spec,
    };

    // 후기도 같은 규칙으로 기본칸/보조칸 배치 (원문 바로 밑에 번역)
    const reviews = d.reviewData.reviews.map((r) => {
      const c = langPick(r.content, r.content_ko);
      const t = langPick(r.title || "", r.title_ko || "");
      return {
        title: t.main,
        ["title" + t.altKey]: t.alt,
        content: c.main,
        ["content" + c.altKey]: c.alt,
        author: r.author, rating: r.rating, date: r.date, verified: r.verified,
      };
    });

    const json = {
      schema_version: "shopping_product_v1",
      source: "amazon_jp",
      collected_at: new Date().toISOString(),
      url: location.href,
      language: {
        primary: "ja",                                       // 병기본 위칸은 항상 일본어 원문
        original: "ja", translated: "ko", both: !!CFG.translate,
      },
      product,
      delivery: d.delivery,
      images: d.images,
      options: d.options,
      bullets: bl.main,
      ["bullets" + bl.altKey]: bl.alt,
      description: ds.main,
      ["description" + ds.altKey]: ds.alt,
      important_information: d.important || "",
      ["important_information" + (ds.altKey === "_ja" ? "_ja" : "_ko")]: d.important_ko || "",
      review_summary: {
        total_input_reviews: d.reviewData.totalSeen,
        deduped_reviews: d.reviewData.reviews.length,
        pages_read: d.reviewData.pagesRead,
        from_review_pages: d.reviewData.fromPages || 0,
        collected_from: d.reviewData.source,
        attempts: d.reviewData.attempts || [],
        by_rating: d.reviewData.reviews.reduce((o, r) => {
          const k = r.rating || "?"; o[k] = (o[k] || 0) + 1; return o;
        }, {}),
        customers_say: d.insights.customers_say,
        star_histogram: d.insights.histogram,
        note: d.reviewData.blocked || "",
      },
      reviews,
      seller: { name: d.seller, brand: d.brand },
      category: { path: d.category },
      translation: d.translation || { available: false, reason: "" },
      url_info: {
        canonical: location.origin + location.pathname,
        query: Object.fromEntries(new URLSearchParams(location.search)),
      },
    };
    return json;
  }

  // 라스로 보낼 최종본 — 쿠팡 도구가 뱉는 shopping_product_v1 형태를 그대로 재현한다.
  // ⚠️ 쿠팡 JSON에는 spec / bullets / important_information / rating / currency 가 아예 없다.
  //    라스는 사실상 "후기 + 상품명 + 카테고리"로 대본을 쓰기 때문에, 아마존 고유 정보를
  //    잔뜩 실어 보내면 프로젝트 전송 단계에서 모델이 과부하로 죽는다. 그래서 여기서 걷어낸다.
  //    (전부 버리진 않고 description 만 짧게 남김 — 상품 설명은 대본 소재로 값어치가 있음)
  function uuid4() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  // 문장 경계에서 잘라 어색한 중간 끊김 방지
  function cutText(s, max) {
    s = (s || "").trim();
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf("• "));
    return (cut > max * 0.5 ? head.slice(0, cut + 1) : head).trim();
  }

  function buildLarsText(d, images) {
    // ⚠️ 라스로 가는 건 **항상 일본어 원문**. 패널의 '참고용 언어' 토글을 여기 끌어오지 말 것.
    //    (과거 사고: 토글이 여기까지 적용돼 상품명·설명만 한국어, 후기는 일본어인
    //     짬뽕 JSON이 라스로 갔다. 일본어 대본 재료로는 최악이다.)
    const nm = { main: d.title };
    const ds = { main: d.desc };
    const limit = CFG.larsReviewLimit;
    let src = d.reviewData.reviews;
    // 일본 후기만 — 해외 후기(캐나다·미국 등)는 영어/스페인어가 섞이고 현지 정서와도 안 맞음.
    //   캡처 예: "他の国からのトップレビュー" 아래에 Victoria(캐나다), Kian(미국) …
    // 단, 걸러서 하나도 안 남으면 채널이 빈손이 되니 전체로 되돌린다.
    if (CFG.jpOnly) {
      const jp = src.filter((r) => !r.overseas);
      src = jp.length ? jp : src;
    }
    const picked = limit > 0 ? src.slice(0, limit) : src;
    // 현재 선택된 옵션 — 후기에 변형 정보가 없을 때 product 필드 대체값으로 씀
    const curOpt = (d.options.find((o) => /選択中/.test(o.name)) || d.options[0] || {}).value || "";

    const out = {
      schema_version: "shopping_product_v1",
      source: "amazon_jp",
      collected_at: new Date().toISOString(),
      url: location.href,
      product: {
        name: nm.main,
        price: d.price,
        ids: { productId: d.asin, asin: d.asin, store: d.seller },
      },
      delivery: d.delivery,
      images: images,
      options: d.options.map((o) => ({ name: o.name, value: o.value })),
      description: cutText(ds.main, CFG.larsDescMax),
      review_summary: {
        total_input_reviews: d.reviewData.totalSeen,
        deduped_reviews: picked.length,
      },
      reviews: picked.map((r) => ({
        content: r.content,
        author: r.author,
        product: r.variant || curOpt || nm.main,   // 쿠팡의 "구매 옵션" 자리
        date: r.date,
      })),
      lucy_collect_uuid: uuid4(),
      seller: { name: d.seller },
      category: { path: d.category },
      url_info: {
        canonical: location.origin + location.pathname,
        query: Object.fromEntries(new URLSearchParams(location.search)),
      },
    };
    return JSON.stringify(out, null, 2);
  }

  /* ---- 참고용 한국어 출력 ------------------------------------------------- */
  // Ryu가 상품을 눈으로 파악하려고 보는 것. 라스로는 절대 안 간다.
  //   · 복사 → 읽기 좋은 글
  //   · 다운 → 한국어만 채운 JSON
  function koOrJa(ko, ja) { const k = clean(ko); return k || (ja || ""); }

  function buildKoText(d) {
    const L = [];
    L.push("[상품명] " + koOrJa(d.title_ko, d.title));
    if (clean(d.title_ko)) L.push("[원제]   " + d.title);
    if (d.price) L.push("[가격]   " + d.price + (d.listPrice ? "  (정가 " + d.listPrice + ")" : ""));
    if (d.rating.score) L.push("[평점]   " + d.rating.score + "  (" + (d.rating.count || "?") + "건)");
    if (!d.availability.in_stock) L.push("[재고]   품절");
    if (d.category.length) L.push("[분류]   " + d.category.join(" > "));
    if (d.seller) L.push("[판매자] " + d.seller);

    const bl = (d.bullets_ko && d.bullets_ko.some((t) => clean(t))) ? d.bullets_ko : d.bullets;
    if (bl && bl.length) { L.push("", "[요점]"); bl.forEach((b) => { if (clean(b)) L.push("  · " + clean(b)); }); }

    const desc = koOrJa(d.desc_ko, d.desc);
    if (desc) L.push("", "[상품 설명]", desc);

    const rs = d.reviewData.reviews;
    if (rs.length) {
      L.push("", `[후기 ${rs.length}개]`);
      rs.forEach((r, i) => {
        const head = `후기 ${i + 1}` +
          (r.rating ? ` · ★${r.rating}` : "") +
          (r.author ? ` · ${r.author}` : "") +
          (r.date ? ` · ${r.date}` : "") +
          (r.overseas ? " · 해외" : "") +
          (r.variant ? ` · ${r.variant}` : "");
        L.push("", "── " + head);
        const t = koOrJa(r.title_ko, r.title);
        if (t) L.push("  《" + t + "》");
        L.push("  " + koOrJa(r.content_ko, r.content));
      });
    }
    // 번역이 하나도 없으면 원문만 나오므로 그 사실을 알려준다(빈손인 줄 알고 헤매지 않게)
    if (!CFG.translate || !clean(d.title_ko)) {
      L.unshift("※ 번역이 없어 원문 그대로입니다 (패널의 '한국어 번역 병기'를 켜세요)", "");
    }
    return L.join("\n");
  }

  function buildKoJson(d) {
    const rs = d.reviewData.reviews;
    return JSON.stringify({
      schema_version: "amazon_jp_ko_v1",   // 참고용 전용 — 라스에 넣는 형식이 아님
      source: "amazon_jp",
      collected_at: new Date().toISOString(),
      url: location.href,
      translated: !!(CFG.translate && clean(d.title_ko)),
      product: {
        name: koOrJa(d.title_ko, d.title),
        name_ja: d.title,
        price: d.price,
        list_price: d.listPrice || "",
        rating: d.rating.score,
        rating_count: d.rating.count,
        in_stock: d.availability.in_stock,
        ids: { asin: d.asin },
      },
      category: d.category,
      seller: d.seller,
      bullets: (d.bullets_ko && d.bullets_ko.some((t) => clean(t))) ? d.bullets_ko : d.bullets,
      description: koOrJa(d.desc_ko, d.desc),
      reviews: rs.map((r) => ({
        title: koOrJa(r.title_ko, r.title),
        content: koOrJa(r.content_ko, r.content),
        content_ja: r.content,
        author: r.author, rating: r.rating, date: r.date,
        country: r.country, overseas: !!r.overseas, option: r.variant,
      })),
    }, null, 2);
  }

  /* ---- 출력 -------------------------------------------------------------- */
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
    const blob = new Blob(["\ufeff" + text], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  // 상태칸은 두 가지를 번갈아 보여준다:
  //   · 요약(setStatusRows)  — 수집 완료 결과. 계속 남아 있어야 한다.
  //   · 일시 메시지(setStatusTemp) — 복사/저장 알림. 잠깐 뜨고 요약으로 되돌아간다.
  // _statusToken: 그 사이 새 수집이 시작되면 옛 요약이 되살아나지 않게 하는 잠금장치.
  let _statusSummary = null, _statusToken = 0;
  function setStatus(m) {
    _statusToken++;
    const el = document.getElementById("azjp-scr-status");
    if (el) el.textContent = m;
  }
  function clearStatusSummary() { _statusSummary = null; }
  function setStatusTemp(m, ms) {
    const mine = ++_statusToken;
    const el = document.getElementById("azjp-scr-status");
    if (el) el.textContent = m;
    if (!_statusSummary) return;
    setTimeout(() => {
      // 그동안 다른 상태 변경이 없었을 때만 요약으로 복귀
      if (_statusToken === mine && _statusSummary) renderStatusSummary();
    }, ms || 2600);
  }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  // 완료 요약을 라벨+줄 블록으로. 한 줄로 이어 붙이면 눈에 안 들어온다(Ryu 지적).
  //   rows  : [["후기", "27개 · 5★18 …"], …]  값이 비면 그 줄은 생략
  //   notes : 경고 문구 배열 — 눈에 띄게 박스로 분리
  function setStatusRows(title, rows, notes) {
    _statusToken++;
    _statusSummary = { title, rows, notes };   // 복사/저장 후 되돌아올 내용
    renderStatusSummary();
  }
  function renderStatusSummary() {
    if (!_statusSummary) return;
    const { title, rows, notes } = _statusSummary;
    const el = document.getElementById("azjp-scr-status");
    if (!el) return;
    const body = (rows || []).filter((r) => r && r[1]).map(([k, v]) =>
      `<div style="display:flex;gap:7px;margin-top:3px;">` +
      `<span style="flex:0 0 42px;opacity:.5;font-size:10.5px;line-height:1.55;">${escHtml(k)}</span>` +
      `<span style="flex:1;min-width:0;">${escHtml(v)}</span></div>`).join("");
    const note = (notes || []).filter(Boolean).map((n) =>
      `<div style="margin-top:6px;padding:6px 8px;border-radius:7px;` +
      `background:rgba(245,158,11,.16);border-left:3px solid #f59e0b;color:#ffd79a;">${escHtml(n)}</div>`).join("");
    el.innerHTML = `<div style="font-weight:800;color:#7ee2a8;margin-bottom:2px;">${escHtml(title)}</div>${body}${note}`;
  }
  function showOutput(text) {
    const ta = document.getElementById("azjp-scr-out");
    if (ta) { ta.value = text; ta.style.display = "block"; }
    const row = document.getElementById("azjp-scr-btnrow");
    if (row) row.style.display = "flex";
    const larsBtn = document.getElementById("azjp-scr-lars");
    if (larsBtn) larsBtn.style.display = "block";
    const rvRow = document.getElementById("azjp-scr-rvrow");
    if (rvRow) rvRow.style.display = "block";
    const imgBtn = document.getElementById("azjp-scr-imgsave");
    if (imgBtn) imgBtn.style.display = "block";
  }

  const state = { base: null, candidates: [], selected: [], lastText: "", slimText: "", koText: "", koJson: "" };

  async function applySelection() {
    if (!state.base) return;
    const obj = buildJson({ ...state.base, images: state.selected.slice() });
    const text = JSON.stringify(obj, null, 2);   // 병기본(화면·파일용, 후기 전부)
    const slim = buildLarsText({ ...state.base, images: state.selected.slice() }, state.selected.slice());
    state.lastText = text;
    state.slimText = slim;
    state.koText = buildKoText(state.base);     // 참고용 — 읽기 좋은 글
    state.koJson = buildKoJson(state.base);     // 참고용 — 한국어 JSON
    showOutput(text);
    const copied = await copyClipboard(slim);   // 기본 클립보드는 라스용 — 바로 붙여넣기 쓰라고
    try {
      GM_setValue("azjp_lucy_json", slim);          // 라스 자동전달도 슬림본
      GM_setValue("azjp_lucy_json_at", Date.now());
      GM_setValue("azjp_lucy_json_name", state.base.title);
    } catch (_) {}
    paintReviewButtons();
    const rd = state.base.reviewData;
    const trOk = state.base.translation && state.base.translation.available;
    const trVal = trOk ? "✅ 됨"
      : (CFG.translate ? "❌ " + ((state.base.translation && state.base.translation.reason) || "실패") : "끔 (원문만)");
    const jpCnt = rd.reviews.filter((r) => !r.overseas).length;
    const byStar = rd.reviews.reduce((o, r) => { const k = r.rating || "?"; o[k] = (o[k] || 0) + 1; return o; }, {});
    const starMsg = Object.keys(byStar).sort().reverse().map((k) => `${k}★${byStar[k]}`).join(" ");
    const sentN = (JSON.parse(slim).reviews || []).length;
    const jpMsg = CFG.jpOnly
      ? (jpCnt ? `일본 후기만(${jpCnt}/${rd.reviews.length})` : "⚠️ 일본 후기 0개라 전체 사용")
      : `일본 ${jpCnt}/${rd.reviews.length}`;
    const srcMsg = rd.fromPages > 0 ? `${rd.pagesRead}p+상품페이지` : "상품페이지만";
    // 지인이 UI 언어를 바꿔 쓰므로, 문제 보고 때 원인을 바로 알 수 있게 표시해 둔다.
    // (동작은 언어와 무관하게 되도록 만들었지만, ko 패턴은 미검증이라 단서가 필요)
    const uiMsg = `언어 ${uiLang()} ${CFG.uiMode === "auto" ? "(자동감지)" : "(수동지정)"}`;
    // 배송지가 일본이 아니면 가격이 환산돼 나온다 → 일본 시청자용 대본에 그대로 쓰면 안 됨
    const curMsg = (state.base.price && currencyCode() !== "JPY")
      ? `⚠️ 가격이 ${currencyCode()}로 환산됐어요 — 배송지를 일본으로 바꾸고 다시 수집하세요`
      : "";
    setStatusRows("수집 완료 ✅", [
      ["후기", `${rd.reviews.length}개  ·  ${starMsg}  ·  ${jpMsg}`],
      ["출처", srcMsg],
      ["라스용", `후기 ${sentN}개(설정 ${CFG.larsReviewLimit || "전체"})  ·  ${slim.length.toLocaleString()}자` +
                 (copied ? "  ·  클립보드 복사됨 ✅" : "")],
      ["번역", trVal],
      ["화면", uiMsg],
    ], [
      copied ? "" : "자동 복사에 실패했어요 — 아래 '📋 라스용 복사' 버튼을 눌러주세요.",
      curMsg,
      rd.blocked || "",
    ]);
  }
  function saveFile() {
    if (!state.base || !state.lastText) { setStatusTemp("아직 수집한 데이터가 없어요. 먼저 '상품 수집 → JSON'을 누르세요."); return; }
    const btn = document.getElementById("azjp-scr-save");
    if (btn && btn.disabled) return;                    // 연타로 같은 파일 여러 개 받는 것 방지
    const safe = (state.base.title || "amazon_jp_product").replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
    const name = `${safe}.json`;
    downloadFile(state.lastText, name);
    setStatusTemp(`다운 완료 ✅ ${name} (다운로드 폴더 확인)`);
    toastAt(btn, "✅ 파일로 저장됨", true);
    if (btn) {
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "받는 중…"; btn.style.opacity = ".6";
      setTimeout(() => { btn.disabled = false; btn.textContent = label; btn.style.opacity = "1"; }, 1200);
    }
  }
  async function saveImages() {
    if (!state.selected.length) { setStatusTemp("선택된 이미지가 없어요."); return; }
    const btn = document.getElementById("azjp-scr-imgsave");
    if (btn && btn.disabled) return;
    const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
    const safe = ((state.base && state.base.title) || "product").replace(/[\\/:*?"<>|]/g, "_").slice(0, 30);
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
    if (btn) { btn.disabled = false; btn.textContent = label; btn.style.opacity = "1"; }
    setStatusTemp(ok ? `다운 완료 ✅ 이미지 ${ok}장 (${safe}_1.jpg …) · 캐릭터 카드에 업로드 또는 Ctrl+V`
                     : "이미지 저장 실패 — 아마존 CDN 응답 없음. 다른 이미지를 골라보세요.");
    toastAt(btn, ok ? `✅ 이미지 ${ok}장 저장됨` : "❌ 이미지 저장 실패", !!ok);
  }
  // 버튼 위로 떠오르는 알림. 상태줄은 패널 위쪽이라 아래쪽 버튼을 눌러도 안 보인다.
  // ⚠️ 버튼 글씨는 건드리지 않는다 — 2열 버튼이 좁아 글자 수가 바뀌면 폭이 흔들린다.
  function toastAt(el, text, ok) {
    if (!el) return;
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText = [
      "position:fixed", "z-index:2147483647", "pointer-events:none",
      "padding:7px 12px", "border-radius:9px", "white-space:nowrap",
      `background:${ok ? "#22c55e" : "#ef4444"}`, "color:#08130a",
      "font:800 12.5px/1 -apple-system,'Malgun Gothic',sans-serif",
      "box-shadow:0 8px 22px rgba(0,0,0,.45)",
      "opacity:0", "transform:translateY(6px)",
      "transition:opacity .14s ease, transform .14s ease",
    ].join(";");
    document.body.appendChild(t);
    const r = el.getBoundingClientRect();
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    let top = r.top - h - 8;                       // 버튼 위쪽
    if (top < 6) top = r.bottom + 8;               // 위가 막히면 아래로
    t.style.left = left + "px";
    t.style.top = top + "px";
    requestAnimationFrame(() => { t.style.opacity = "1"; t.style.transform = "translateY(0)"; });
    setTimeout(() => {
      t.style.opacity = "0"; t.style.transform = "translateY(-6px)";
      setTimeout(() => t.remove(), 220);
    }, 1100);
  }

  function flashBtn(btn, ok, okText, ngText) {
    // 과거 사고: async 핸들러에서 e.currentTarget 이 null 이 돼 조용히 아무 표시도 안 됐다.
    // 다시 그러면 즉시 알아채도록 로그를 남긴다(조용한 실패 금지).
    if (!btn) { console.warn("[아마존JP긁기] flashBtn: 버튼 참조가 없음 — async 핸들러에서 await 뒤에 e.currentTarget 을 쓴 건 아닌지 확인"); return; }
    toastAt(btn, ok ? (okText || "✅ 복사됨") : (ngText || "❌ 실패"), ok);
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1";
    const bg = btn.style.background, col = btn.style.color;
    btn.style.background = ok ? "#22c55e" : "#ef4444";   // 배경만 잠깐 — 글씨는 그대로
    btn.style.color = "#08130a";
    setTimeout(() => {
      btn.style.background = bg; btn.style.color = col;
      delete btn.dataset.busy;
    }, 900);
  }

  function paintReviewButtons() {
    const sel = document.getElementById("azjp-scr-rvsel");
    if (!sel) return;
    const total = (state.base && state.base.reviewData && state.base.reviewData.reviews.length) || 0;
    const jpTotal = (state.base && state.base.reviewData)
      ? state.base.reviewData.reviews.filter((r) => !r.overseas).length : 0;
    const avail = CFG.jpOnly && jpTotal ? jpTotal : total;   // 실제로 보낼 수 있는 최대치
    if (!sel.dataset.built) {
      let html = "";
      for (let i = 1; i <= 15; i++) html += `<option value="${i}">${i}개</option>`;
      html += `<option value="0">전체</option>`;
      sel.innerHTML = html;
      sel.dataset.built = "1";
    }
    // 수집된 개수보다 큰 값은 "(15개뿐)" 처럼 표시해 헛기대 방지
    [...sel.options].forEach((o) => {
      const v = Number(o.value);
      o.textContent = v === 0 ? `전체 (${avail}개)`
        : (avail && v > avail ? `${v}개 — ${avail}개뿐` : `${v}개`);
    });
    sel.value = String(CFG.larsReviewLimit);
    const label = document.getElementById("azjp-scr-rvlabel");
    if (label) label.textContent = `라스로 보낼 후기 (수집 ${total}개${CFG.jpOnly ? `, 일본 ${jpTotal}개` : ""})`;
  }
  function paintUiButtons() {
    document.querySelectorAll(".azjp-ui-btn").forEach((b) => {
      const on = b.getAttribute("data-ui") === CFG.uiMode;
      b.style.background = on ? "#ff9900" : "#243040";
      b.style.color = on ? "#131921" : "rgba(255,255,255,.75)";
    });
    const hint = document.getElementById("azjp-scr-uihint");
    if (hint) {
      const NM = { ja: "日本語", en: "English", ko: "한국어" };
      hint.textContent = CFG.uiMode === "auto"
        ? `자동감지: ${NM[detectLang()] || detectLang()} (틀리면 직접 고르세요)`
        : `수동 지정: ${NM[CFG.uiMode]} · 안 맞으면 다른 언어로 자동 재시도`;
    }
  }
  // 큰 미리보기 창(하나만 만들어 재사용). 패널 밖 화면에 띄운다.
  const PREV_W = 360, PREV_H = 360;
  function ensurePreview() {
    let p = document.getElementById("azjp-imgprev");
    if (p) return p;
    p = document.createElement("div");
    p.id = "azjp-imgprev";
    p.style.cssText = [
      "position:fixed", "display:none", "z-index:2147483647",
      `width:${PREV_W}px`, `height:${PREV_H}px`,
      "background:#fff", "border:3px solid #ff9900", "border-radius:12px",
      "box-shadow:0 12px 36px rgba(0,0,0,.55)", "overflow:hidden",
      "pointer-events:none",            // 마우스를 가로채면 썸네일 hover 가 끊긴다
      "align-items:center", "justify-content:center",
    ].join(";");
    p.innerHTML = `<img alt="" style="width:100%;height:100%;object-fit:contain;background:#fff;">
      <div id="azjp-imgprev-cap" style="position:absolute;left:0;right:0;bottom:0;padding:5px 8px;
        background:rgba(19,25,33,.82);color:#fff;font:600 11px/1.3 -apple-system,'Malgun Gothic',sans-serif;
        text-align:center;"></div>`;
    document.body.appendChild(p);
    return p;
  }
  function showPreview(url, el, caption) {
    const p = ensurePreview();
    const img = p.querySelector("img");
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    p.querySelector("#azjp-imgprev-cap").textContent = caption || "";
    p.style.display = "flex";
    // 패널이 오른쪽 아래에 있으니 기본은 썸네일 왼쪽. 공간이 없으면 오른쪽으로 넘긴다.
    const r = el.getBoundingClientRect();
    let left = r.left - PREV_W - 14;
    if (left < 8) left = r.right + 14;
    left = Math.max(8, Math.min(left, window.innerWidth - PREV_W - 8));
    let top = r.top + r.height / 2 - PREV_H / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - PREV_H - 8));
    p.style.left = left + "px";
    p.style.top = top + "px";
  }
  function hidePreview() {
    const p = document.getElementById("azjp-imgprev");
    if (p) p.style.display = "none";
  }

  function renderImagePicker() {
    const wrap = document.getElementById("azjp-scr-imgs");
    if (!wrap) return;
    wrap.style.display = "block";
    const thumbs = state.candidates.map((u) => {
      const sel = state.selected.includes(u);
      const safe = u.replace(/"/g, "&quot;");
      return `<img data-url="${safe}" data-idx="${state.candidates.indexOf(u) + 1}" src="${safe}" title="클릭해서 선택/해제 · 올리면 크게 보기"
        style="width:46px;height:46px;object-fit:contain;background:#fff;border-radius:6px;cursor:pointer;
        border:2px solid ${sel ? "#ff9900" : "transparent"};opacity:${sel ? 1 : .5};">`;
    }).join("");
    wrap.innerHTML = `<div style="font-size:11px;opacity:.85;margin:12px 0 6px;">상품 이미지 선택 (클릭=토글, 올리면 크게) · ${state.selected.length}장</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${thumbs}</div>`;
    wrap.querySelectorAll("img[data-url]").forEach((im) => {
      im.addEventListener("click", () => {
        const u = im.getAttribute("data-url");
        const idx = state.selected.indexOf(u);
        if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(u);
        hidePreview();            // 다시 그리면 이 노드가 사라져 mouseleave 가 안 온다
        renderImagePicker();
        applySelection();
      });
    });
    // 큰 미리보기 — 올리면 표시, 나가면 숨김
    wrap.querySelectorAll("img[data-url]").forEach((im) => {
      im.addEventListener("mouseenter", () => {
        const u = im.getAttribute("data-url");
        const n = im.getAttribute("data-idx");
        const sel = state.selected.includes(u);
        showPreview(u, im, `${n}번 이미지${sel ? " · 선택됨 ✅" : ""} — 클릭해서 ${sel ? "해제" : "선택"}`);
      });
      im.addEventListener("mouseleave", hidePreview);
    });
    // 패널을 끌어 옮기거나 스크롤하면 미리보기가 엉뚱한 곳에 남는다 → 숨김
    wrap.addEventListener("mouseleave", hidePreview);
  }

  async function run() {
    const btn = document.getElementById("azjp-scr-go");
    if (btn) btn.disabled = true;
    trState.warned = false; trState.reason = "";
    // ⚠️ 번역기는 **여기서** 미리 만든다. 수집이 끝난 뒤(수십 초 후)에 만들면
    //    사용자 제스처가 만료돼 모델 다운로드가 거부된다. await 하지 않고 예열만.
    if (CFG.translate) { try { getTranslator(); } catch (_) {} }
    clearStatusSummary();   // 새로 수집하니 이전 결과 요약은 버린다
    try {
      const asin = getAsin();
      if (!asin && !q("#productTitle")) {
        setStatus("상품 상세페이지가 아닌 것 같아요 (/dp/… 주소에서 눌러주세요)");
        return;
      }
      // ── 페이지 번역 사전 점검 ────────────────────────────────────────
      // 번역된 화면을 긁으면 후기·상품설명이 한국어(또는 영어) 번역문으로 들어간다.
      // 일본 시청자용 대본 재료가 통째로 오염되므로 여기서 멈춘다.
      const tr = pageTranslated();
      if (tr) {
        setStatus(`⛔ 수집 중단 — ${tr}이 켜져 있어요. 이 상태로 긁으면 후기와 상품설명이 ` +
          `번역문으로 들어가서 일본어 원문을 잃습니다. 주소창 오른쪽 번역 아이콘을 눌러 ` +
          `'원본 표시(원문 보기)'로 되돌린 뒤 다시 눌러주세요.`);
        return;
      }

      // ── 통화 사전 점검 ──────────────────────────────────────────────
      // amazon.co.jp 는 계정 배송지가 일본이 아니면 가격을 환산해서 보여준다
      // (배송지 한국 → "KRW 58,609"). 페이지 어디에도 원래 엔화 금액이 남지 않아
      // 되돌릴 방법이 없으므로, 잘못된 가격으로 대본이 나가기 전에 여기서 멈춘다.
      const probe = getPrice();
      if (probe && currencyCode() !== "JPY") {
        setStatus(`⛔ 수집 중단 — 가격이 ${currencyCode()}(${probe})로 환산돼 있어요. ` +
          `아마존 화면 왼쪽 위 'お届け先 / Deliver to' 를 눌러 배송지를 일본으로 바꾼 뒤 ` +
          `페이지를 새로고침하고 다시 눌러주세요. (엔화 ￥ 로 표시돼야 정상)`);
        return;
      }

      setStatus("① 상세설명·A+ 콘텐츠 불러오는 중…");
      const desc = await scrapeDescription();

      setStatus("② 후기 모으는 중… (전체보기 페이지 넘김)");
      const reviewData = await scrapeReviews(asin, setStatus);

      setStatus("③ 상품정보 정리 중…");
      state.base = {
        title: getTitle(), price: getPrice(), listPrice: getListPrice(), asin,
        availability: getAvailability(),
        rating: getRating(), spec: getSpec(), bullets: getBullets(), options: getOptions(),
        category: getCategoryPath(), seller: getSeller(), brand: getBrand(),
        delivery: getDelivery(), desc, important: getImportantInfo(),
        insights: getReviewInsights(), reviewData,
      };
      if (!state.base.price && state.base.availability.in_stock) {
        console.warn("[아마존JP긁기] 가격을 못 읽음 — 센터컬럼 구조 변경 가능성");
      }

      state.base.translation = await translateAll(state.base, setStatus);

      state.candidates = getImageCandidates();
      state.selected = defaultSelected(state.candidates);
      renderImagePicker();
      await applySelection();
    } catch (e) {
      console.error("[아마존JP긁기]", e);
      setStatus("오류: " + (e && e.message ? e.message : e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---- UI ---------------------------------------------------------------- */
  function buildPanel() {
    if (document.getElementById("azjp-scraper-panel")) return;
    const box = document.createElement("div");
    box.id = "azjp-scraper-panel";
    box.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "width:290px", "border-radius:14px", "overflow:hidden",
      "background:#131921", "color:#fff",
      "font:600 13px/1.35 -apple-system,'Malgun Gothic',sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.45)", "user-select:none",
      // 화면 밖으로 넘치지 않게 묶고, 헤더 고정 + 본문 스크롤 구조로
      "max-height:calc(100vh - 32px)", "display:flex", "flex-direction:column",
    ].join(";");
    // 본문 스크롤바를 패널 색에 맞춤(인라인 스타일로는 못 하는 부분)
    if (!document.getElementById("azjp-scr-style")) {
      const st = document.createElement("style");
      st.id = "azjp-scr-style";
      st.textContent =
        "#azjp-scr-body::-webkit-scrollbar{width:9px}" +
        "#azjp-scr-body::-webkit-scrollbar-track{background:transparent}" +
        "#azjp-scr-body::-webkit-scrollbar-thumb{background:#3a4a5e;border-radius:5px}" +
        "#azjp-scr-body::-webkit-scrollbar-thumb:hover{background:#4d6180}" +
        "#azjp-scr-body{scrollbar-width:thin;scrollbar-color:#3a4a5e transparent}";
      document.head.appendChild(st);
    }
    box.innerHTML = `
      <div id="azjp-scr-head" style="display:flex;align-items:center;justify-content:space-between;
           flex:0 0 auto;padding:11px 14px;background:#ff9900;color:#131921;cursor:move;">
        <span style="font-size:14px;">Amazon JP → Lucy JSON <span style="opacity:.7;font-size:10px;">${VERSION}</span></span>
        <span style="display:flex;gap:2px;">
          <span id="azjp-scr-min" title="최소화" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">–</span>
          <span id="azjp-scr-close" title="닫기" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">×</span>
        </span>
      </div>
      <div id="azjp-scr-body" style="padding:14px;flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;">
        <div style="font-size:11px;opacity:.75;margin-bottom:10px;">화면만 읽음 · 외부 서버 안 거침 · 위 주황띠 잡고 이동</div>
        <div style="margin-bottom:10px;">
          <div style="font-size:10.5px;opacity:.7;margin-bottom:5px;">아마존 화면 언어 (별점·날짜 읽는 기준)</div>
          <div style="display:flex;gap:4px;">
            <button data-ui="auto" class="azjp-ui-btn" style="flex:1.2;border:0;border-radius:7px;padding:7px 4px;font:700 11px inherit;cursor:pointer;">자동</button>
            <button data-ui="ja" class="azjp-ui-btn" style="flex:1;border:0;border-radius:7px;padding:7px 4px;font:700 11px inherit;cursor:pointer;">日本語</button>
            <button data-ui="en" class="azjp-ui-btn" style="flex:1;border:0;border-radius:7px;padding:7px 4px;font:700 11px inherit;cursor:pointer;">English</button>
            <button data-ui="ko" class="azjp-ui-btn" style="flex:1;border:0;border-radius:7px;padding:7px 4px;font:700 11px inherit;cursor:pointer;">한국어</button>
          </div>
          <div id="azjp-scr-uihint" style="font-size:10px;opacity:.6;margin-top:4px;"></div>
        </div>
        <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;opacity:.9;margin-bottom:9px;cursor:pointer;">
          <input type="checkbox" id="azjp-scr-tr" ${CFG.translate ? "checked" : ""} style="accent-color:#ff9900;">
          한국어 번역 병기 (크롬 내장 번역 · 처음엔 느림)
        </label>
        <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;opacity:.9;margin-bottom:9px;cursor:pointer;">
          <input type="checkbox" id="azjp-scr-jp" style="accent-color:#ff9900;">
          라스용은 일본 후기만 (해외 후기 제외)
        </label>
        <button id="azjp-scr-go" style="width:100%;border:0;border-radius:9px;padding:12px;
                background:#ff9900;color:#131921;font:700 14px inherit;cursor:pointer;">상품 수집 → JSON</button>
        <div id="azjp-scr-status" style="margin-top:10px;font-weight:500;font-size:11.5px;opacity:.95;
             word-break:keep-all;line-height:1.5;">준비됨 · amazon.co.jp 상품 상세페이지(/dp/…)에서 눌러주세요</div>
        <div id="azjp-scr-imgs" style="display:none;"></div>
        <button id="azjp-scr-imgsave" style="display:none;width:100%;margin-top:7px;border:0;border-radius:8px;padding:9px;background:#f59e0b;color:#1a1200;font:700 11.5px inherit;cursor:pointer;">📷 선택한 이미지 파일로 저장</button>
        <textarea id="azjp-scr-out" readonly spellcheck="false" style="display:none;width:100%;height:110px;
             margin-top:10px;box-sizing:border-box;border:1px solid rgba(255,255,255,.25);border-radius:8px;
             background:#0b1017;color:#ffd79a;font:400 11px/1.4 ui-monospace,Consolas,monospace;
             padding:8px;resize:vertical;user-select:text;-webkit-user-select:text;" placeholder="수집 결과 JSON"></textarea>
        <div id="azjp-scr-rvrow" style="display:none;margin-top:9px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="azjp-scr-rvlabel" style="font-size:11px;opacity:.75;white-space:nowrap;">라스로 보낼 후기</span>
            <select id="azjp-scr-rvsel" style="flex:1;border:0;border-radius:7px;padding:8px;background:#243040;
                    color:#fff;font:700 12px inherit;cursor:pointer;"></select>
          </div>
        </div>
        <button id="azjp-scr-lars" style="display:none;width:100%;margin-top:9px;border:0;border-radius:9px;padding:11px;background:#ff9900;color:#131921;font:700 13px inherit;cursor:pointer;">📋 라스용 복사 (쿠팡 형식)</button>
        <div id="azjp-scr-btnrow" style="display:none;flex-direction:column;gap:6px;margin-top:8px;">
          <div style="font-size:10px;opacity:.6;">참고용 (라스엔 안 감)</div>
          <div style="display:flex;gap:6px;">
            <button id="azjp-scr-copy" style="flex:1;border:0;border-radius:8px;padding:8px 4px;background:#334155;color:#fff;font:700 11.5px inherit;cursor:pointer;">전체 복사</button>
            <button id="azjp-scr-save" style="flex:1;border:0;border-radius:8px;padding:8px 4px;background:#334155;color:#fff;font:700 11.5px inherit;cursor:pointer;">전체 다운</button>
          </div>
          <div style="display:flex;gap:6px;">
            <button id="azjp-scr-kocopy" style="flex:1;border:0;border-radius:8px;padding:8px 4px;background:#2b3a4d;color:#cfe4ff;font:700 11.5px inherit;cursor:pointer;">번역만 복사</button>
            <button id="azjp-scr-kosave" style="flex:1;border:0;border-radius:8px;padding:8px 4px;background:#2b3a4d;color:#cfe4ff;font:700 11.5px inherit;cursor:pointer;">번역만 다운</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(box);

    box.querySelector("#azjp-scr-go").addEventListener("click", run);
    const jpBox = box.querySelector("#azjp-scr-jp");
    jpBox.checked = CFG.jpOnly;
    jpBox.addEventListener("change", (e) => {
      CFG.jpOnly = e.target.checked;
      try { GM_setValue("azjp_jp_only", CFG.jpOnly); } catch (_) {}
      if (state.base) applySelection();   // 재수집 없이 라스용만 다시 조립
    });
    box.querySelector("#azjp-scr-tr").addEventListener("change", (e) => {
      CFG.translate = e.target.checked;
      try { GM_setValue("azjp_translate", CFG.translate); } catch (_) {}
      // 체크 동작도 사용자 제스처다 → 이 자리에서 모델 내려받기를 시작시킨다.
      if (CFG.translate) {
        _translator = { key: null, promise: null };
        getTranslator().then((t) => {
          if (t && t.unavailable) setStatus("번역 준비 실패 — " + t.details);
          else setStatus("번역 준비 완료 ✅ 이제 '상품 수집 → JSON'을 누르세요.");
        });
      }
      if (state.base) applySelection();   // 이미 수집했으면 즉시 반영
    });
    // 화면언어 토글 — 이미 수집했으면 다시 조립까진 안 되고(파싱 시점 값이라) 안내만.
    box.querySelectorAll(".azjp-ui-btn").forEach((b) => {
      b.addEventListener("click", () => {
        CFG.uiMode = b.getAttribute("data-ui");
        try { GM_setValue("azjp_ui_lang", CFG.uiMode); } catch (_) {}
        paintUiButtons();
        if (state.base) setStatusTemp("화면 언어를 바꿨어요. '상품 수집 → JSON'을 다시 눌러야 반영됩니다.", 3600);
      });
    });
    paintUiButtons();
    // 라스용 후기 개수 — 재수집 없이 라스용 JSON만 다시 만들고 클립보드 갱신
    box.querySelector("#azjp-scr-rvsel").addEventListener("change", (e) => {
      CFG.larsReviewLimit = Number(e.target.value) || 0;
      try { GM_setValue("azjp_lars_review_limit", CFG.larsReviewLimit); } catch (_) {}
      if (state.base) applySelection();
    });
    paintReviewButtons();
    box.querySelector("#azjp-scr-lars").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!state.slimText) { setStatusTemp("먼저 '상품 수집 → JSON'을 누르세요."); return; }
      const ok = await copyClipboard(state.slimText);
      const n = (JSON.parse(state.slimText).reviews || []).length;
      setStatusTemp(ok
        ? `복사 완료 ✅ 라스용 ${state.slimText.length.toLocaleString()}자 · 후기 ${n}개 · 라스에서 Ctrl+V`
        : "복사 실패 — 아래 상자에서 Ctrl+A → Ctrl+C 하세요");
      flashBtn(btn, ok, "✅ 라스용 복사됨", "❌ 복사 실패");
    });
    box.querySelector("#azjp-scr-copy").addEventListener("click", async (e) => {
      const btn = e.currentTarget;          // ⚠️ await 전에 잡아둘 것 (뒤에선 null)
      const ta = box.querySelector("#azjp-scr-out");
      ta.focus(); ta.select();
      const ok = await copyClipboard(ta.value);
      setStatusTemp(ok ? `전체 복사됨 ✅ ${ta.value.length.toLocaleString()}자 · 아마존JP 전체정보(참고용)`
                       : "복사 실패 — 상자 안에서 Ctrl+A → Ctrl+C 하세요");
      flashBtn(btn, ok, "✅ 전체 복사됨", "❌ 복사 실패");
    });
    box.querySelector("#azjp-scr-save").addEventListener("click", saveFile);
    // 번역만 복사 — 읽기 좋은 글
    box.querySelector("#azjp-scr-kocopy").addEventListener("click", async (e) => {
      const btn = e.currentTarget;          // ⚠️ await 전에 잡아둘 것 (뒤에선 null)
      if (!state.koText) { setStatusTemp("먼저 '상품 수집 → JSON'을 누르세요."); return; }
      const ok = await copyClipboard(state.koText);
      setStatusTemp(ok ? `번역만 복사됨 ✅ ${state.koText.length.toLocaleString()}자 · 읽기용 글 (라스엔 안 감)`
                       : "복사 실패 — 다시 시도해 주세요");
      flashBtn(btn, ok, "✅ 번역만 복사됨", "❌ 복사 실패");
    });
    // 번역만 다운 — 한국어 JSON
    box.querySelector("#azjp-scr-kosave").addEventListener("click", (e) => {
      if (!state.koJson) { setStatusTemp("먼저 '상품 수집 → JSON'을 누르세요."); return; }
      const safe = ((state.base && (state.base.title_ko || state.base.title)) || "amazon_jp_product")
        .replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
      downloadFile(state.koJson, `${safe}_ko.json`);
      setStatusTemp(`다운 완료 ✅ ${safe}_ko.json (한국어 참고용 JSON)`);
      flashBtn(e.currentTarget, true, "✅ 파일로 저장됨", "");
    });
    box.querySelector("#azjp-scr-imgsave").addEventListener("click", saveImages);
    makeDraggable(box, box.querySelector("#azjp-scr-head"), box.querySelector("#azjp-scr-min"), box.querySelector("#azjp-scr-body"));
    box.querySelector("#azjp-scr-close").addEventListener("mousedown", (e) => e.stopPropagation());
    box.querySelector("#azjp-scr-close").addEventListener("click", (e) => { e.stopPropagation(); hidePreview(); box.remove(); });
  }

  /* =========================================================================
   *  라스(lucystar.kr) 주입기 — 숨은 '상품 JSON 데이터' 칸에 꽂기
   *  ※ 네이버 도구에서 검증된 로직 그대로. 네이버 패널과 안 겹치게 위치만 다름.
   * ========================================================================= */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function larsStatus(m) { const el = document.getElementById("azjp-lars-status"); if (el) el.textContent = m; }
  function unhideJsonTab() {
    const tab = document.getElementById("shoppingProductJsonTab");
    const panel = document.getElementById("shoppingProductJsonPanel");
    if (tab) { tab.classList.remove("hidden"); tab.removeAttribute("hidden"); }
    if (panel) { panel.classList.remove("hidden"); panel.removeAttribute("hidden"); }
    if (tab) tab.click();
    return { tab, panel };
  }
  function injectToLars() {
    let json = "";
    const inEl = document.getElementById("azjp-lars-in");
    if (inEl && inEl.value.trim()) json = inEl.value.trim();
    if (!json) { try { json = GM_getValue("azjp_lucy_json", ""); } catch (_) {} }
    if (!json) { larsStatus("붙여넣을 JSON이 없어요. 아마존 재팬에서 복사한 JSON을 위 칸에 붙여넣거나, 아마존 재팬에서 먼저 '상품 수집'을 하세요."); return; }
    try { JSON.parse(json); } catch (_) { larsStatus("⚠️ JSON 형식이 아니에요. 아마존JP 상자에서 복사한 내용을 그대로 붙여넣어 주세요."); return; }

    unhideJsonTab();
    const ta = document.getElementById("shoppingProductJson");
    if (!ta) { larsStatus("입력칸(#shoppingProductJson)을 못 찾음 — 라스 대본 화면인지 확인. 대신 Ctrl+V로 붙여넣기 해보세요."); return; }
    if (ta.maxLength > 0 && json.length > ta.maxLength) {
      larsStatus(`⚠️ JSON이 너무 김(${json.length}자 / 한도 ${ta.maxLength}). 후기·이미지 수를 줄여서 다시 수집하세요.`); return;
    }
    setNativeValue(ta, json);
    setTimeout(() => { unhideJsonTab(); const t = document.getElementById("shoppingProductJson"); if (t && !t.value) setNativeValue(t, json); }, 400);

    const name = (() => { try { return GM_getValue("azjp_lucy_json_name", ""); } catch (_) { return ""; } })();
    larsStatus(`넣었어요 ✅ ${name ? "[" + name.slice(0, 18) + "…] " : ""}'상품 JSON 데이터' 탭 확인 후 대본 생성`);
  }
  // 라스 패널 초기화 — 상품 바꿀 때 이전 JSON이 남아 엉뚱한 대본이 나오는 걸 막음
  function clearLarsAll() {
    const done = [];
    // 1) 패널 붙여넣기 칸
    const inEl = document.getElementById("azjp-lars-in");
    if (inEl && inEl.value) { inEl.value = ""; done.push("붙여넣기 칸"); }
    // 2) 라스 실제 입력칸(#shoppingProductJson)
    unhideJsonTab();
    const ta = document.getElementById("shoppingProductJson");
    if (ta && ta.value) { setNativeValue(ta, ""); done.push("라스 상품 JSON 칸"); }
    // 3) 아마존에서 자동전달돼 대기 중인 저장값
    try {
      if (GM_getValue("azjp_lucy_json", "")) {
        GM_setValue("azjp_lucy_json", "");
        GM_setValue("azjp_lucy_json_name", "");
        GM_setValue("azjp_lucy_json_at", 0);
        done.push("자동전달 대기값");
      }
    } catch (_) {}
    larsStatus(done.length ? `초기화 완료 ✅ ${done.join(" · ")} 비웠어요` : "이미 다 비어 있어요.");
  }

  function buildLarsPanel() {
    if (document.getElementById("azjp-lars-panel")) return;
    const box = document.createElement("div");
    box.id = "azjp-lars-panel";
    // 라스 화면엔 네이버(right:20px)·아마존호주(right:310px) 패널이 이미 있다.
    // 셋이 겹치지 않게 한 칸 더 왼쪽. (도구를 더 늘리면 여기 숫자만 밀면 됨)
    box.style.cssText = [
      "position:fixed", "right:600px", "bottom:20px", "z-index:2147483647",
      "width:270px", "border-radius:14px", "overflow:hidden",
      "max-height:calc(100vh - 32px)", "display:flex", "flex-direction:column",
      "background:#131921", "color:#fff",
      "font:600 13px/1.35 -apple-system,'Malgun Gothic',sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.4)", "user-select:none",
    ].join(";");
    let saved = ""; try { saved = GM_getValue("azjp_lucy_json_name", ""); } catch (_) {}
    box.innerHTML = `
      <div id="azjp-lars-head" style="display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;padding:11px 14px;background:#ff9900;color:#131921;cursor:move;">
        <span style="font-size:14px;">Amazon JP JSON → 라스 <span style="opacity:.7;font-size:10px;">${VERSION}</span></span>
        <span style="display:flex;gap:2px;">
          <span id="azjp-lars-min" title="최소화" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">–</span>
          <span id="azjp-lars-close" title="닫기" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">×</span>
        </span>
      </div>
      <div id="azjp-lars-body" style="padding:14px;flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;">
        <div style="font-size:11px;opacity:.8;margin-bottom:8px;word-break:keep-all;">아마존 재팬에서 복사한 JSON을 아래 칸에 붙여넣고 버튼을 누르면, 숨은 '상품 JSON 데이터' 칸에 꽂아줍니다.</div>
        <textarea id="azjp-lars-in" spellcheck="false" style="width:100%;height:120px;box-sizing:border-box;
             border:1px solid rgba(255,255,255,.25);border-radius:8px;background:#0b1017;color:#ffd79a;
             font:400 11px/1.4 ui-monospace,Consolas,monospace;padding:8px;resize:vertical;margin-bottom:8px;
             user-select:text;-webkit-user-select:text;" placeholder="여기에 아마존JP JSON 붙여넣기 (Ctrl+V) — 비워두면 자동전달된 값 사용"></textarea>
        <button id="azjp-lars-go" style="width:100%;border:0;border-radius:9px;padding:12px;background:#ff9900;color:#131921;font:700 14px inherit;cursor:pointer;">라스 칸에 넣기</button>
        <button id="azjp-lars-clear" style="width:100%;margin-top:7px;border:0;border-radius:9px;padding:9px;background:#3a2323;color:#ffb4b4;font:700 12px inherit;cursor:pointer;">🗑 모두 지우기 (칸·대기값 초기화)</button>
        <div id="azjp-lars-status" style="margin-top:10px;font-weight:500;font-size:11.5px;opacity:.95;word-break:keep-all;line-height:1.5;">${saved ? "자동전달 대기: " + saved.slice(0, 18) + "… (붙여넣기 없이 눌러도 됨)" : "아마존 JSON을 붙여넣으세요."}</div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector("#azjp-lars-go").addEventListener("click", injectToLars);
    box.querySelector("#azjp-lars-clear").addEventListener("click", clearLarsAll);
    const closeEl = box.querySelector("#azjp-lars-close");
    closeEl.addEventListener("mousedown", (e) => e.stopPropagation());
    closeEl.addEventListener("click", (e) => { e.stopPropagation(); box.remove(); });
    makeDraggable(box, box.querySelector("#azjp-lars-head"), box.querySelector("#azjp-lars-min"), box.querySelector("#azjp-lars-body"));
  }

  // 패널이 화면 아래로 삐져나가지 않게 현재 위치 기준으로 높이를 다시 잡는다.
  // (드래그로 top 이 정해지면 bottom 기준 max-height 가 무의미해진다)
  function fitToViewport(box) {
    if (!box) return;
    const top = parseFloat(box.style.top);
    if (!isFinite(top)) { box.style.maxHeight = "calc(100vh - 32px)"; return; }
    box.style.maxHeight = Math.max(180, window.innerHeight - top - 16) + "px";
  }
  window.addEventListener("resize", () => {
    ["azjp-scraper-panel", "azjp-lars-panel"].forEach((id) => fitToViewport(document.getElementById(id)));
  });

  // 공용 드래그/접기
  function makeDraggable(box, head, minBtn, bodyEl) {
    if (minBtn) {
      minBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      minBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const hidden = bodyEl.style.display === "none";
        bodyEl.style.display = hidden ? "" : "none";   // flex 자식이라 "" 로 되돌린다
        e.target.textContent = hidden ? "–" : "+";
      });
    }
    let drag = false, ox = 0, oy = 0;
    head.addEventListener("mousedown", (e) => {
      if (typeof hidePreview === "function") hidePreview();   // 끌기 시작하면 미리보기 정리
      drag = true;
      const r = box.getBoundingClientRect();
      box.style.left = r.left + "px"; box.style.top = r.top + "px";
      box.style.right = "auto"; box.style.bottom = "auto";
      ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy));
      box.style.left = x + "px"; box.style.top = y + "px";
      fitToViewport(box);
    });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  /* ---- 부팅 -------------------------------------------------------------- */
  try { CFG.translate = GM_getValue("azjp_translate", true); } catch (_) {}
  try { CFG.larsReviewLimit = Number(GM_getValue("azjp_lars_review_limit", 10)) || 0; } catch (_) {}
  try { CFG.jpOnly = !!GM_getValue("azjp_jp_only", false); } catch (_) {}
  try {
    const m = String(GM_getValue("azjp_ui_lang", "auto"));
    CFG.uiMode = (m === "ja" || m === "en" || m === "ko") ? m : "auto";
  } catch (_) {}

  const IS_LARS = location.hostname.includes("lucystar.kr");
  function openPanel() { if (IS_LARS) buildLarsPanel(); else buildPanel(); }

  const boot = setInterval(() => {
    if (!document.body) return;
    clearInterval(boot);
    openPanel();
  }, 300);

  try { GM_registerMenuCommand("아마존JP 패널 다시 열기", openPanel); } catch (_) {}
})();
