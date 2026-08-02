// ==UserScript==
// @name         아마존 호주 상품 수집 → Lucy JSON (독립/로컬)
// @namespace    https://local.amazon.scraper/
// @version      1.14.0
// @description  amazon.com.au 상품페이지의 상품명·상세·스펙·후기를 긁어 shopping_product_v1 JSON(source:"amazon_au")으로 뽑고, 라스(lucystar.kr) 숨은 '상품 JSON 데이터' 칸에 자동으로 꽂아줌. 영어 원문 + 크롬 내장 번역 한국어 병기. 이미지는 파일로 저장해 캐릭터에 업로드.
// @match        https://www.amazon.com.au/*
// @match        https://amazon.com.au/*
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
// @connect      amazon.com.au
// ==/UserScript==
// ※ GM_setValue/GM_getValue = 템퍼몽키 로컬 저장소(아마존→라스 값 전달, 외부 아님).
// ※ GM_xmlhttpRequest = 아마존 CDN 이미지를 받아 파일로 저장하기 위함(개발자 서버 안 거침).
// ※ 후기 전체보기는 같은 도메인(amazon.com.au) fetch — 로그인 세션 그대로 사용.

(function () {
  "use strict";

  /* =========================================================================
   *  아마존 호주 상품 수집 → Lucy(라스) 붙여넣기용 JSON 생성
   *  - 화면 DOM + 같은 도메인 후기 페이지만 읽음. 외부 서버로 아무것도 안 보냄.
   *  - 출력: 쿠팡/네이버 도구와 동일한 schema_version "shopping_product_v1"
   *          (source:"amazon_au", currency:"AUD", 가격은 A$ 표기 그대로)
   *  - 영어 원문 + 크롬 내장 Translator API(on-device) 한국어 번역 병기
   *      · product.name / name_ko, description / description_ko
   *      · reviews[].content / content_ko, bullets[] / bullets_ko[]
   *  - 네이버와 달리 아마존은 고정 ID(#productTitle, #feature-bullets 등)가 안정적
   * ========================================================================= */

  const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
  // ★ 릴리스 규칙: 아래 "1.14.0" 을 올릴 때 amazon-loader.user.js 의 @version 도 같은 숫자로.
  const VERSION = "v" + ((typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.14.0");

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
    primary: "en",         // 라스가 읽는 기본칸에 넣을 언어: "en" | "ko" (패널에서 토글)
    larsReviewLimit: 10,   // 라스용 JSON에 넣을 후기 개수 (0=전체). 과부하 원인 분리용
    auOnly: false,         // 라스용에 호주 후기만 넣기 (해외 후기 제외)
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
  async function autoScroll() {
    const y0 = window.scrollY;
    for (let i = 0; i < 10; i++) { window.scrollBy(0, 900); await SLEEP(CFG.lazyScrollWaitMs); }
    window.scrollTo(0, y0);
    await SLEEP(200);
  }

  /* ---- 기본 정보 --------------------------------------------------------- */
  function getTitle() {
    // AU는 <h1 id="title"> 안에 <span id="productTitle"> 구조. 둘 다 대비.
    return clean(txt(q("#productTitle")) || txt(q("#titleSection h1")) || txt(q("#title")) ||
      (q('meta[name="title"]') || {}).content || document.title.replace(/\s*[:|-]\s*Amazon.*$/i, ""));
  }

  // 가격: A$ 표기 그대로. .a-offscreen(스크린리더용 완성 문자열)이 가장 정확.
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
      const m = clean(el.textContent).match(/([\d,]+\.?\d*)/);
      if (m) return normPrice(m[1]);
    }
    const whole = txt(q(".a-price-whole", root)), frac = txt(q(".a-price-fraction", root));
    if (whole) return normPrice(whole.replace(/[^\d,]/g, "") + (frac ? "." + frac.replace(/\D/g, "") : ""));
    return "";
  }
  // 재고 상태 — 품절이면 가격이 아예 없으므로 대본에서 구분 필요
  function getAvailability() {
    const t = clean(txt(q("#availability")) || txt(q("#outOfStock")) ||
      txt(q("#twisterAvailability")) || txt(q("#exports_desktop_outOfStock_buybox_message")));
    const center = clean(txt(q("#centerCol"))) + " " + clean(txt(q("#buybox")));
    const oos = /Temporarily out of stock|Currently unavailable|No featured offers available|out of stock/i.test(t + " " + center);
    return { in_stock: !oos, text: t || (oos ? "Temporarily out of stock" : "") };
  }
  function normPrice(numStr) {
    const n = Number(String(numStr).replace(/,/g, ""));
    if (!isFinite(n) || n <= 0) return "";
    return "A$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function getListPrice() {
    const root = priceRoot();
    if (!root) return "";
    const el = q(".a-text-price .a-offscreen", root) || q(".basisPrice .a-offscreen", root);
    if (!el || el.closest("#twister, .dimension-values-list")) return "";
    const m = clean(el.textContent).match(/([\d,]+\.?\d*)/);
    return m ? normPrice(m[1]) : "";
  }

  function getAsin() {
    const byUrl = (location.pathname.match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})/) || [])[1];
    if (byUrl) return byUrl;
    // 아마존 AU는 주요 위젯에 data-csa-c-asin 을 달아둠(가장 안정적)
    const csa = q("#title_feature_div[data-csa-c-asin], [data-csa-c-asin]:not([data-csa-c-asin=''])");
    const v = csa && csa.getAttribute("data-csa-c-asin");
    if (v && /^[A-Z0-9]{10}$/.test(v)) return v;
    const inp = q("#ASIN") || q('input[name="ASIN"]') || q('input[name="ASIN.0"]');
    if (inp && inp.value) return inp.value.trim();
    return "";
  }

  function getBrand() {
    const by = clean(txt(q("#bylineInfo")));
    if (by) return by.replace(/^(Visit the|Brand:)\s*/i, "").replace(/\s*Store$/i, "").trim();
    const tbl = specPairs().find((p) => /^brand$/i.test(p[0]));
    return tbl ? tbl[1] : "";
  }
  // 판매자: 브랜드가 아니라 실제 셀러(merchant)
  function getSeller() {
    const s = clean(txt(q("#sellerProfileTriggerId"))) ||
      clean(txt(q("#merchant-info a"))) ||
      clean(txt(q("#tabular-buybox .tabular-buybox-text[tabular-attribute-name='Sold by']")));
    if (s && !/^(amazon\.com\.au|amazon au)$/i.test(s)) return s;
    const mi = clean(txt(q("#merchant-info")));
    if (/Amazon AU|Amazon\.com\.au/i.test(mi)) return "Amazon.com.au";
    return s || getBrand() || "";
  }

  function getRating() {
    const el = q("#acrPopover");
    const t = (el && (el.getAttribute("title") || txt(el))) || txt(q('[data-hook="rating-out-of-text"]'));
    const m = clean(t).match(/([\d.]+)\s*out of\s*5/i);
    const cnt = clean(txt(q("#acrCustomerReviewText"))).match(/([\d,]+)/);
    return { score: m ? m[1] : "", count: cnt ? cnt[1].replace(/,/g, "") : "" };
  }

  function getCategoryPath() {
    return qa("#wayfinding-breadcrumbs_feature_div ul li a").map((a) => clean(txt(a))).filter(Boolean);
  }

  function getDelivery() {
    const blocks = ["#mir-layout-DELIVERY_BLOCK", "#deliveryBlockMessage", "#primeDeliveryMessage",
      "#fast-track-message", "#delivery-message"];
    const lines = blocks.map((s) => clean(txt(q(s)))).filter(Boolean);
    const all = lines.join(" | ");
    const badges = [];
    if (q("#isPrimeBadge") || q(".a-icon-prime") || /\bPrime\b/.test(all)) badges.push("Prime");
    if (/FREE\s+(Delivery|Shipping)/i.test(all) || /Free\s+delivery/i.test(all)) badges.push("Free Delivery");
    if (/Fastest delivery|Get it (as soon as )?tomorrow|Same-Day/i.test(all)) badges.push("Fast Delivery");
    const arrival = (all.match(/(?:delivery|Delivered|Get it)[^|]{0,60}/i) || [""])[0].trim().slice(0, 80);
    return {
      badges,
      is_rocket: false,                 // 쿠팡 전용 필드 — 스키마 호환용
      is_prime: badges.includes("Prime"),
      is_free_shipping: badges.includes("Free Delivery"),
      arrival_text: arrival,
      rocket_delivery: "해당없음",
    };
  }

  /* ---- 스펙 / 옵션 ------------------------------------------------------- */
  // 접혀 있는 "Item details / Measurements / User guide" 확장 섹션을 먼저 펼침
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
    // 1) Product overview 표 (제목 옆 Brand/Item form 표)
    qa("#productOverview_feature_div tr").forEach((tr) => {
      const c = qa("td,th", tr); if (c.length >= 2) push(txt(c[0]), txt(c[1]));
    });
    // 2) 신형 Product information — 확장 섹션 안의 표들 (Item details/Measurements/User guide)
    qa("#productDetailsWithModules_feature_div tr, #productDetails_expanderSectionTables tr, " +
       "#productDetails_expanderTables_depthLeftSections tr").forEach((tr) => {
      const c = qa("td,th", tr); if (c.length >= 2) push(txt(c[0]), txt(c[1]));
    });
    // 3) 구형 Technical details / Additional information 표
    qa("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #technicalSpecifications_section_1 tr")
      .forEach((tr) => { const th = q("th", tr), td = q("td", tr); if (th && td) push(txt(th), txt(td)); });
    // 4) Product details 불릿 — <span class="a-text-bold">키 :</span><span>값</span> 구조
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
      .filter((t) => t && t.length > 3 && !/see more product details/i.test(t))
      .slice(0, 12);
  }
  // 변형 옵션(사이즈/색상 등). 신형 AU는 .dimension-values-list 스와치 구조.
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
    // 현재 선택값 ("Size Name: 1 l (Pack of 1)")
    qa("#twister .a-row, #twisterContainer .a-row").forEach((row) => {
      const label = clean(txt(q(".a-form-label, .a-text-bold", row)));
      const val = clean(txt(q(".selection", row)));
      if (label && val) add(label, val);
    });
    // 신형 스와치 목록 — 선택된 것 + 나머지 변형들(각각 가격/품절 문구가 붙어있음)
    qa("#twister .dimension-values-list li, #twister ul.a-button-list li").forEach((li) => {
      const val = clean(txt(q(".swatch-title-text-display, .swatch-title-text", li)));
      if (!val) return;
      const info = clean(txt(q(".dimension-slot-info, #twisterAvailability, .inline-twister-swatch-price", li)));
      const selected = !!q(".a-button-selected", li) || li.getAttribute("data-initiallyselected") === "true";
      add("Size Name" + (selected ? " (선택됨)" : ""), val, info);
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
      const t = txt(aplus).replace(/^From the (manufacturer|brand)\s*/i, "").trim();
      if (t && t.length > 30) parts.push(t);
    }
    let out = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (out.length > CFG.descMax) out = out.slice(0, CFG.descMax) + "\n…(생략)";
    return out;
  }

  // Important information — Safety Information / Ingredients / Directions
  // 건강·식품 카테고리에서 대본 소재로 값어치가 큼(성분·복용법·알레르기)
  function getImportantInfo() {
    const root = q("#importantInformation_feature_div") || q("#important-information");
    if (!root) return "";
    const t = txt(root).replace(/^Important information\s*/i, "").trim();
    return t.length > 20 ? t.slice(0, 2500) : "";
  }

  // "Customers say" — 아마존이 후기들을 요약해 준 AI 문단 + 별점 분포
  function getReviewInsights() {
    const sum = clean(txt(q('[data-testid="overall-summary"]')));
    const hist = {};
    qa("#histogramTable tr, [data-hook='cr-summarization-attributes-list'] tr").forEach((tr) => {
      const star = clean(txt(q("td:first-child, .a-text-left", tr)));
      const pct = clean(txt(q("td:last-child, .a-text-right", tr)));
      if (/^\d\s*star$/i.test(star) && /%$/.test(pct)) hist[star.replace(/\s+/g, "")] = pct;
    });
    return { customers_say: sum && sum.length > 20 ? sum : "", histogram: hist };
  }

  /* ---- 후기 -------------------------------------------------------------- */
  // 후기 본문에서 아마존 UI 부스러기 제거
  function cleanReviewBody(s) {
    return clean(s)
      .replace(/Brief content visible,?\s*double tap to read full content\.?/gi, "")
      .replace(/Full content visible,?\s*double tap to read brief content\.?/gi, "")
      .replace(/\s*(Read more|Read less|더 보기)\s*$/i, "")
      .replace(/\s*Helpful\s*(\|\s*)?Report\s*$/i, "")
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
      let star = clean(txt(q(".a-icon-alt", starBox || n)));
      if (!star && starBox) {
        const ic = q('[class*="a-star-"]', starBox) || starBox;
        star = ((ic.className || "").match(/a-star-(?:mini-|small-|medium-)?(\d)/) || [, ""])[1];
      }

      const dateRaw = clean(txt(q('[data-hook="review-date"]', n)));
      // "Reviewed in Australia on 8 June 2026" → 국가와 날짜를 분리 보관
      const country = (dateRaw.match(/Reviewed in\s+(.+?)\s+on\s+/i) || [, ""])[1] || "";
      // 쿠팡 후기엔 "어떤 옵션을 산 사람인지"가 product 필드로 들어감 → 아마존 variation으로 대응
      const variant = clean(txt(q('[data-hook="product-variation-attributes"], ' +
        '[data-hook="format-strip"], .review-format-strip', n)));
      out.push({
        title: rawTitle.replace(/^\d+(\.\d+)?\s*out of\s*5\s*stars?\s*/i, "").trim(),
        content,
        author: clean(txt(q(".a-profile-name", n))),
        rating: (() => {   // "4.0 out of 5 stars" → "4",  "4.5" → "4.5" 로 표기 통일
          const v = parseFloat((star.match(/([\d.]+)/) || [, ""])[1]);
          return isFinite(v) ? String(v) : "";
        })(),
        date: (dateRaw.match(/on\s+(.+)$/i) || [, dateRaw])[1] || dateRaw,
        country,
        variant,
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

  // 후기 전체보기 주소 — 추측하지 말고 페이지에 박힌 "See more reviews" 링크를 그대로 쓴다.
  // 아마존이 /product-reviews/ → /portal/customer-reviews/ 로 옮겨서 하드코딩하면 조용히 0건이 된다.
  function reviewPageBases(asin) {
    const bases = [];
    const link = q("#cm_cr_top_reviews_to_arp_button") ||
      q('[data-hook="see-all-reviews-link-foot"]') ||
      q('a[href*="customer-reviews"], a[href*="product-reviews"]');
    const href = link && link.getAttribute("href");
    if (href) { try { bases.push(new URL(href, location.origin).href); } catch (_) {} }
    if (asin) {
      bases.push(location.origin + "/portal/customer-reviews/" + asin + "/?reviewerType=all_reviews");
      bases.push(location.origin + "/product-reviews/" + asin + "/?reviewerType=all_reviews&sortBy=recent");
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
    // ⚠️ 아마존 호주는 후기 전체보기가 로그인 필수 → 302로 /ap/signin 으로 튕긴다.
    //    fetch는 리다이렉트를 자동으로 따라가 200을 돌려주므로, 최종 주소를 봐야 안다.
    if (/\/ap\/signin/i.test(info.finalUrl)) {
      return { err: "로그인 필요 (아마존에 로그인하면 후기 더 가져옴)", info };
    }
    if (!res.ok) return { err: "응답 " + res.status, info };
    const html = await res.text();
    info.htmlLen = html.length;
    info.hasHook = /data-hook="review"/.test(html);          // 서버가 후기를 HTML로 줬는지
    info.signin = /ap\/signin|Sign-In|email or mobile phone number/i.test(html);
    info.captcha = /Enter the characters you see below/i.test(html);
    if ((info.signin || info.captcha) && !info.hasHook) {
      return { err: info.captcha ? "봇 확인 페이지" : "로그인 필요 (아마존에 로그인하면 후기 더 가져옴)", info };
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
      console.warn("[아마존긁기] 후기 전체보기 실패 상세:", attempts);
      return { reviews: all, totalSeen, pagesRead, fromPages, attempts,
               source: "product_page", blocked: "후기 전체보기 실패 — " + why };
    }

    console.info("[아마존긁기] 후기 수집 기록:", attempts);
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
    const key = "en-ko";
    if (_translator.key !== key || !_translator.promise) {
      _translator.key = key;
      _translator.promise = (async () => {
        try {
          const avail = T.availability ? await T.availability({ sourceLanguage: "en", targetLanguage: "ko" }) : "available";
          if (avail === "unavailable") return { unavailable: true, details: "en→ko 모델 미지원" };
          return await T.create({
            sourceLanguage: "en", targetLanguage: "ko",
            monitor(m) {
              m.addEventListener("downloadprogress", (e) => {
                const pct = Math.round((e.loaded || 0) * 100);
                setStatus(`번역 모델 내려받는 중… ${pct}% (처음 한 번만)`);
              });
            },
          });
        } catch (e) {
          return { unavailable: true, details: "Translator.create 실패: " + (e && e.message ? e.message : String(e)) };
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
  function koReady(ko) { return CFG.translate && !!clean(ko); }
  function langPick(orig, ko) {
    return koReady(ko)
      ? (CFG.primary === "ko" ? { main: ko, altKey: "_en", alt: orig } : { main: orig, altKey: "_ko", alt: ko })
      : { main: orig, altKey: "_ko", alt: "" };
  }
  function langPickArr(orig, ko) {
    const has = CFG.translate && Array.isArray(ko) && ko.some((t) => clean(t));
    return has && CFG.primary === "ko"
      ? { main: ko, altKey: "_en", alt: orig }
      : { main: orig, altKey: "_ko", alt: has ? ko : [] };
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
      currency: "AUD",
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
      source: "amazon_au",
      collected_at: new Date().toISOString(),
      url: location.href,
      language: {
        primary: koReady(d.title_ko) ? CFG.primary : "en",   // 실제로 기본칸에 들어간 언어
        original: "en", translated: "ko", both: !!CFG.translate,
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
      ["important_information" + (ds.altKey === "_en" ? "_en" : "_ko")]: d.important_ko || "",
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
    const nm = langPick(d.title, d.title_ko);
    const ds = langPick(d.desc, d.desc_ko);
    const limit = CFG.larsReviewLimit;
    let src = d.reviewData.reviews;
    // 호주 후기만 — 해외 후기(사우디 등)는 기계번역이 섞이고 현지 정서와도 안 맞음.
    // 단, 걸러서 하나도 안 남으면 채널이 빈손이 되니 전체로 되돌린다.
    if (CFG.auOnly) {
      const au = src.filter((r) => /Australia/i.test(r.country || ""));
      src = au.length ? au : src;
    }
    const picked = limit > 0 ? src.slice(0, limit) : src;
    // 현재 선택된 옵션 — 후기에 변형 정보가 없을 때 product 필드 대체값으로 씀
    const curOpt = (d.options.find((o) => /선택됨/.test(o.name)) || d.options[0] || {}).value || "";

    const out = {
      schema_version: "shopping_product_v1",
      source: "amazon_au",
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
  function setStatus(m) { const el = document.getElementById("az-scr-status"); if (el) el.textContent = m; }
  function showOutput(text) {
    const ta = document.getElementById("az-scr-out");
    if (ta) { ta.value = text; ta.style.display = "block"; }
    const row = document.getElementById("az-scr-btnrow");
    if (row) row.style.display = "flex";
    const larsBtn = document.getElementById("az-scr-lars");
    if (larsBtn) larsBtn.style.display = "block";
    const rvRow = document.getElementById("az-scr-rvrow");
    if (rvRow) rvRow.style.display = "block";
    const imgBtn = document.getElementById("az-scr-imgsave");
    if (imgBtn) imgBtn.style.display = "block";
  }

  const state = { base: null, candidates: [], selected: [], lastText: "", slimText: "" };

  async function applySelection() {
    if (!state.base) return;
    const obj = buildJson({ ...state.base, images: state.selected.slice() });
    const text = JSON.stringify(obj, null, 2);   // 병기본(화면·파일용, 후기 전부)
    const slim = buildLarsText({ ...state.base, images: state.selected.slice() }, state.selected.slice());
    state.lastText = text;
    state.slimText = slim;
    showOutput(text);
    const copied = await copyClipboard(slim);   // 기본 클립보드는 라스용 — 바로 붙여넣기 쓰라고
    try {
      GM_setValue("az_lucy_json", slim);          // 라스 자동전달도 슬림본
      GM_setValue("az_lucy_json_at", Date.now());
      GM_setValue("az_lucy_json_name", state.base.title);
    } catch (_) {}
    paintReviewButtons();
    const rd = state.base.reviewData;
    const trOk = state.base.translation && state.base.translation.available;
    const trMsg = trOk ? "번역 ✅"
      : (CFG.translate ? "번역 ❌ " + ((state.base.translation && state.base.translation.reason) || "") : "번역 끔");
    // 한국어를 기본칸으로 골랐는데 번역이 없으면 원문으로 폴백된 상태를 알려줌
    const langMsg = (CFG.translate && CFG.primary === "ko")
      ? (trOk ? "기본칸=한국어" : "기본칸=영어(번역 실패 폴백)")
      : "기본칸=영어";
    const auCnt = rd.reviews.filter((r) => /Australia/i.test(r.country || "")).length;
    const byStar = rd.reviews.reduce((o, r) => { const k = r.rating || "?"; o[k] = (o[k] || 0) + 1; return o; }, {});
    const starMsg = Object.keys(byStar).sort().reverse().map((k) => `${k}★${byStar[k]}`).join(" ");
    const sentN = (JSON.parse(slim).reviews || []).length;
    const auMsg = CFG.auOnly
      ? (auCnt ? `호주 후기만(${auCnt}/${rd.reviews.length})` : "⚠️ 호주 후기 0개라 전체 사용")
      : `호주 ${auCnt}/${rd.reviews.length}`;
    const srcMsg = rd.fromPages > 0 ? `${rd.pagesRead}p+상품페이지` : "상품페이지만";
    setStatus(`완료 ✅ 후기 ${rd.reviews.length}개 수집(${srcMsg}) · 이미지 ${state.selected.length}장 · ${trMsg} · ${langMsg}` +
      ` · ${starMsg} · ${auMsg} · 라스용 후기 ${sentN}개(설정 ${CFG.larsReviewLimit || "전체"}) / ${slim.length.toLocaleString()}자 ${copied ? "복사됨" : "⚠️ 자동복사 실패(아래 버튼으로 복사)"}` + (rd.blocked ? ` · ⚠️ ${rd.blocked}` : ""));
  }
  function saveFile() {
    if (!state.base || !state.lastText) { setStatus("아직 수집한 데이터가 없어요. 먼저 '상품 수집 → JSON'을 누르세요."); return; }
    const btn = document.getElementById("az-scr-save");
    if (btn && btn.disabled) return;                    // 연타로 같은 파일 여러 개 받는 것 방지
    const safe = (state.base.title || "amazon_product").replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
    const name = `${safe}.json`;
    downloadFile(state.lastText, name);
    setStatus(`다운 완료 ✅ ${name} (다운로드 폴더 확인)`);
    if (btn) {
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "받는 중…"; btn.style.opacity = ".6";
      setTimeout(() => { btn.disabled = false; btn.textContent = label; btn.style.opacity = "1"; }, 1200);
    }
  }
  async function saveImages() {
    if (!state.selected.length) { setStatus("선택된 이미지가 없어요."); return; }
    const btn = document.getElementById("az-scr-imgsave");
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
    setStatus(ok ? `다운 완료 ✅ 이미지 ${ok}장 (${safe}_1.jpg …) · 캐릭터 카드에 업로드 또는 Ctrl+V`
                 : "이미지 저장 실패 — 아마존 CDN 응답 없음. 다른 이미지를 골라보세요.");
  }
  function paintReviewButtons() {
    const sel = document.getElementById("az-scr-rvsel");
    if (!sel) return;
    const total = (state.base && state.base.reviewData && state.base.reviewData.reviews.length) || 0;
    const auTotal = (state.base && state.base.reviewData)
      ? state.base.reviewData.reviews.filter((r) => /Australia/i.test(r.country || "")).length : 0;
    const avail = CFG.auOnly && auTotal ? auTotal : total;   // 실제로 보낼 수 있는 최대치
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
    const label = document.getElementById("az-scr-rvlabel");
    if (label) label.textContent = `라스로 보낼 후기 (수집 ${total}개${CFG.auOnly ? `, 호주 ${auTotal}개` : ""})`;
  }
  function paintLangButtons() {
    document.querySelectorAll(".az-lang-btn").forEach((b) => {
      const on = b.getAttribute("data-lang") === CFG.primary;
      b.style.background = on ? "#ff9900" : "#243040";
      b.style.color = on ? "#131921" : "rgba(255,255,255,.75)";
    });
  }
  function renderImagePicker() {
    const wrap = document.getElementById("az-scr-imgs");
    if (!wrap) return;
    wrap.style.display = "block";
    const thumbs = state.candidates.map((u) => {
      const sel = state.selected.includes(u);
      const safe = u.replace(/"/g, "&quot;");
      return `<img data-url="${safe}" src="${safe}" title="클릭해서 선택/해제"
        style="width:46px;height:46px;object-fit:contain;background:#fff;border-radius:6px;cursor:pointer;
        border:2px solid ${sel ? "#ff9900" : "transparent"};opacity:${sel ? 1 : .5};">`;
    }).join("");
    wrap.innerHTML = `<div style="font-size:11px;opacity:.85;margin:12px 0 6px;">상품 이미지 선택 (클릭=토글, 주황테=선택) · ${state.selected.length}장</div>
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
    const btn = document.getElementById("az-scr-go");
    if (btn) btn.disabled = true;
    trState.warned = false; trState.reason = "";
    try {
      const asin = getAsin();
      if (!asin && !q("#productTitle")) {
        setStatus("상품 상세페이지가 아닌 것 같아요 (/dp/… 주소에서 눌러주세요)");
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
        console.warn("[아마존긁기] 가격을 못 읽음 — 센터컬럼 구조 변경 가능성");
      }

      state.base.translation = await translateAll(state.base, setStatus);

      state.candidates = getImageCandidates();
      state.selected = defaultSelected(state.candidates);
      renderImagePicker();
      await applySelection();
    } catch (e) {
      console.error("[아마존긁기]", e);
      setStatus("오류: " + (e && e.message ? e.message : e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---- UI ---------------------------------------------------------------- */
  function buildPanel() {
    if (document.getElementById("az-scraper-panel")) return;
    const box = document.createElement("div");
    box.id = "az-scraper-panel";
    box.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "width:290px", "border-radius:14px", "overflow:hidden",
      "background:#131921", "color:#fff",
      "font:600 13px/1.35 -apple-system,'Malgun Gothic',sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.45)", "user-select:none",
    ].join(";");
    box.innerHTML = `
      <div id="az-scr-head" style="display:flex;align-items:center;justify-content:space-between;
           padding:11px 14px;background:#ff9900;color:#131921;cursor:move;">
        <span style="font-size:14px;">Amazon AU → Lucy JSON <span style="opacity:.7;font-size:10px;">${VERSION}</span></span>
        <span style="display:flex;gap:2px;">
          <span id="az-scr-min" title="최소화" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">–</span>
          <span id="az-scr-close" title="닫기" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">×</span>
        </span>
      </div>
      <div id="az-scr-body" style="padding:14px;">
        <div style="font-size:11px;opacity:.75;margin-bottom:10px;">화면만 읽음 · 외부 서버 안 거침 · 위 주황띠 잡고 이동</div>
        <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;opacity:.9;margin-bottom:9px;cursor:pointer;">
          <input type="checkbox" id="az-scr-tr" ${CFG.translate ? "checked" : ""} style="accent-color:#ff9900;">
          한국어 번역 병기 (크롬 내장 번역 · 처음엔 느림)
        </label>
        <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;opacity:.9;margin-bottom:9px;cursor:pointer;">
          <input type="checkbox" id="az-scr-au" style="accent-color:#ff9900;">
          라스용은 호주 후기만 (해외 후기 제외)
        </label>
        <div id="az-scr-langrow" style="margin-bottom:10px;${CFG.translate ? "" : "display:none;"}">
          <div style="font-size:10.5px;opacity:.7;margin-bottom:5px;">라스가 읽는 기본칸에 넣을 언어</div>
          <div style="display:flex;gap:6px;">
            <button data-lang="en" class="az-lang-btn" style="flex:1;border:0;border-radius:7px;padding:8px;font:700 12px inherit;cursor:pointer;">영어 원문</button>
            <button data-lang="ko" class="az-lang-btn" style="flex:1;border:0;border-radius:7px;padding:8px;font:700 12px inherit;cursor:pointer;">한국어</button>
          </div>
        </div>
        <button id="az-scr-go" style="width:100%;border:0;border-radius:9px;padding:12px;
                background:#ff9900;color:#131921;font:700 14px inherit;cursor:pointer;">상품 수집 → JSON</button>
        <div id="az-scr-status" style="margin-top:10px;font-weight:500;font-size:11.5px;opacity:.95;
             word-break:keep-all;line-height:1.5;">준비됨 · 상품 상세페이지(/dp/…)에서 눌러주세요</div>
        <div id="az-scr-imgs" style="display:none;"></div>
        <textarea id="az-scr-out" readonly spellcheck="false" style="display:none;width:100%;height:150px;
             margin-top:10px;box-sizing:border-box;border:1px solid rgba(255,255,255,.25);border-radius:8px;
             background:#0b1017;color:#ffd79a;font:400 11px/1.4 ui-monospace,Consolas,monospace;
             padding:8px;resize:vertical;user-select:text;-webkit-user-select:text;" placeholder="수집 결과 JSON"></textarea>
        <div id="az-scr-rvrow" style="display:none;margin-top:9px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="az-scr-rvlabel" style="font-size:11px;opacity:.75;white-space:nowrap;">라스로 보낼 후기</span>
            <select id="az-scr-rvsel" style="flex:1;border:0;border-radius:7px;padding:8px;background:#243040;
                    color:#fff;font:700 12px inherit;cursor:pointer;"></select>
          </div>
        </div>
        <button id="az-scr-lars" style="display:none;width:100%;margin-top:9px;border:0;border-radius:9px;padding:11px;background:#ff9900;color:#131921;font:700 13px inherit;cursor:pointer;">📋 라스용 복사 (쿠팡 형식)</button>
        <div id="az-scr-btnrow" style="display:none;gap:8px;margin-top:8px;">
          <button id="az-scr-copy" style="flex:1;border:0;border-radius:8px;padding:10px;background:#334155;color:#fff;font:700 12px inherit;cursor:pointer;">전체 복사 (병기)</button>
          <button id="az-scr-save" style="flex:1;border:0;border-radius:8px;padding:10px;background:#334155;color:#fff;font:700 12px inherit;cursor:pointer;">JSON 파일</button>
        </div>
        <button id="az-scr-imgsave" style="display:none;width:100%;margin-top:8px;border:0;border-radius:8px;padding:10px;background:#f59e0b;color:#1a1200;font:700 12.5px inherit;cursor:pointer;">📷 이미지 파일로 저장 (캐릭터에 올리기용)</button>
      </div>`;
    document.body.appendChild(box);

    box.querySelector("#az-scr-go").addEventListener("click", run);
    const auBox = box.querySelector("#az-scr-au");
    auBox.checked = CFG.auOnly;
    auBox.addEventListener("change", (e) => {
      CFG.auOnly = e.target.checked;
      try { GM_setValue("az_au_only", CFG.auOnly); } catch (_) {}
      if (state.base) applySelection();   // 재수집 없이 라스용만 다시 조립
    });
    box.querySelector("#az-scr-tr").addEventListener("change", (e) => {
      CFG.translate = e.target.checked;
      try { GM_setValue("az_translate", CFG.translate); } catch (_) {}
      const row = document.getElementById("az-scr-langrow");
      if (row) row.style.display = CFG.translate ? "block" : "none";
      if (state.base) applySelection();   // 이미 수집했으면 즉시 반영
    });
    // 기본칸 언어 토글 — 이미 수집한 데이터로 JSON만 다시 조립(재수집 없음)
    box.querySelectorAll(".az-lang-btn").forEach((b) => {
      b.addEventListener("click", () => {
        CFG.primary = b.getAttribute("data-lang");
        try { GM_setValue("az_primary_lang", CFG.primary); } catch (_) {}
        paintLangButtons();
        if (state.base) applySelection();
      });
    });
    paintLangButtons();
    // 라스용 후기 개수 — 재수집 없이 라스용 JSON만 다시 만들고 클립보드 갱신
    box.querySelector("#az-scr-rvsel").addEventListener("change", (e) => {
      CFG.larsReviewLimit = Number(e.target.value) || 0;
      try { GM_setValue("az_lars_review_limit", CFG.larsReviewLimit); } catch (_) {}
      if (state.base) applySelection();
    });
    paintReviewButtons();
    box.querySelector("#az-scr-lars").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!state.slimText) { setStatus("먼저 '상품 수집 → JSON'을 누르세요."); return; }
      const ok = await copyClipboard(state.slimText);
      const n = (JSON.parse(state.slimText).reviews || []).length;
      setStatus(ok
        ? `복사 완료 ✅ 라스용 ${state.slimText.length.toLocaleString()}자 · 후기 ${n}개 · 라스에서 Ctrl+V`
        : "복사 실패 — 아래 상자에서 Ctrl+A → Ctrl+C 하세요");
      // 버튼 자체에도 표시(상태줄만 바뀌면 눈치채기 어려움)
      if (btn.dataset.busy) return;
      btn.dataset.busy = "1";
      const label = btn.textContent, bg = btn.style.background;
      btn.textContent = ok ? "✅ 복사 완료!" : "❌ 복사 실패";
      btn.style.background = ok ? "#22c55e" : "#ef4444";
      setTimeout(() => {
        btn.textContent = label; btn.style.background = bg; delete btn.dataset.busy;
      }, 1400);
    });
    box.querySelector("#az-scr-copy").addEventListener("click", async () => {
      const ta = box.querySelector("#az-scr-out");
      ta.focus(); ta.select();
      const ok = await copyClipboard(ta.value);
      setStatus(ok ? `전체 복사됨 ✅ ${ta.value.length.toLocaleString()}자 · 아마존 전체정보(참고용) · 라스엔 위 버튼 사용`
                   : "복사 실패 — 상자 안에서 Ctrl+A → Ctrl+C 하세요");
    });
    box.querySelector("#az-scr-save").addEventListener("click", saveFile);
    box.querySelector("#az-scr-imgsave").addEventListener("click", saveImages);
    makeDraggable(box, box.querySelector("#az-scr-head"), box.querySelector("#az-scr-min"), box.querySelector("#az-scr-body"));
    box.querySelector("#az-scr-close").addEventListener("mousedown", (e) => e.stopPropagation());
    box.querySelector("#az-scr-close").addEventListener("click", (e) => { e.stopPropagation(); box.remove(); });
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
  function larsStatus(m) { const el = document.getElementById("az-lars-status"); if (el) el.textContent = m; }
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
    const inEl = document.getElementById("az-lars-in");
    if (inEl && inEl.value.trim()) json = inEl.value.trim();
    if (!json) { try { json = GM_getValue("az_lucy_json", ""); } catch (_) {} }
    if (!json) { larsStatus("붙여넣을 JSON이 없어요. 아마존에서 복사한 JSON을 위 칸에 붙여넣거나, 아마존에서 먼저 '상품 수집'을 하세요."); return; }
    try { JSON.parse(json); } catch (_) { larsStatus("⚠️ JSON 형식이 아니에요. 아마존 상자에서 '전체 복사'한 내용을 그대로 붙여넣어 주세요."); return; }

    unhideJsonTab();
    const ta = document.getElementById("shoppingProductJson");
    if (!ta) { larsStatus("입력칸(#shoppingProductJson)을 못 찾음 — 라스 대본 화면인지 확인. 대신 Ctrl+V로 붙여넣기 해보세요."); return; }
    if (ta.maxLength > 0 && json.length > ta.maxLength) {
      larsStatus(`⚠️ JSON이 너무 김(${json.length}자 / 한도 ${ta.maxLength}). 후기·이미지 수를 줄여서 다시 수집하세요.`); return;
    }
    setNativeValue(ta, json);
    setTimeout(() => { unhideJsonTab(); const t = document.getElementById("shoppingProductJson"); if (t && !t.value) setNativeValue(t, json); }, 400);

    const name = (() => { try { return GM_getValue("az_lucy_json_name", ""); } catch (_) { return ""; } })();
    larsStatus(`넣었어요 ✅ ${name ? "[" + name.slice(0, 18) + "…] " : ""}'상품 JSON 데이터' 탭 확인 후 대본 생성`);
  }
  // 라스 패널 초기화 — 상품 바꿀 때 이전 JSON이 남아 엉뚱한 대본이 나오는 걸 막음
  function clearLarsAll() {
    const done = [];
    // 1) 패널 붙여넣기 칸
    const inEl = document.getElementById("az-lars-in");
    if (inEl && inEl.value) { inEl.value = ""; done.push("붙여넣기 칸"); }
    // 2) 라스 실제 입력칸(#shoppingProductJson)
    unhideJsonTab();
    const ta = document.getElementById("shoppingProductJson");
    if (ta && ta.value) { setNativeValue(ta, ""); done.push("라스 상품 JSON 칸"); }
    // 3) 아마존에서 자동전달돼 대기 중인 저장값
    try {
      if (GM_getValue("az_lucy_json", "")) {
        GM_setValue("az_lucy_json", "");
        GM_setValue("az_lucy_json_name", "");
        GM_setValue("az_lucy_json_at", 0);
        done.push("자동전달 대기값");
      }
    } catch (_) {}
    larsStatus(done.length ? `초기화 완료 ✅ ${done.join(" · ")} 비웠어요` : "이미 다 비어 있어요.");
  }

  function buildLarsPanel() {
    if (document.getElementById("az-lars-panel")) return;
    const box = document.createElement("div");
    box.id = "az-lars-panel";
    // 네이버 패널(right:20px)과 겹치지 않게 왼쪽으로 비켜 배치
    box.style.cssText = [
      "position:fixed", "right:310px", "bottom:20px", "z-index:2147483647",
      "width:270px", "border-radius:14px", "overflow:hidden",
      "background:#131921", "color:#fff",
      "font:600 13px/1.35 -apple-system,'Malgun Gothic',sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.4)", "user-select:none",
    ].join(";");
    let saved = ""; try { saved = GM_getValue("az_lucy_json_name", ""); } catch (_) {}
    box.innerHTML = `
      <div id="az-lars-head" style="display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:#ff9900;color:#131921;cursor:move;">
        <span style="font-size:14px;">Amazon JSON → 라스 <span style="opacity:.7;font-size:10px;">${VERSION}</span></span>
        <span style="display:flex;gap:2px;">
          <span id="az-lars-min" title="최소화" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">–</span>
          <span id="az-lars-close" title="닫기" style="cursor:pointer;font-size:16px;padding:0 6px;line-height:1;">×</span>
        </span>
      </div>
      <div id="az-lars-body" style="padding:14px;">
        <div style="font-size:11px;opacity:.8;margin-bottom:8px;word-break:keep-all;">아마존에서 복사한 JSON을 아래 칸에 붙여넣고 버튼을 누르면, 숨은 '상품 JSON 데이터' 칸에 꽂아줍니다.</div>
        <textarea id="az-lars-in" spellcheck="false" style="width:100%;height:120px;box-sizing:border-box;
             border:1px solid rgba(255,255,255,.25);border-radius:8px;background:#0b1017;color:#ffd79a;
             font:400 11px/1.4 ui-monospace,Consolas,monospace;padding:8px;resize:vertical;margin-bottom:8px;
             user-select:text;-webkit-user-select:text;" placeholder="여기에 아마존 JSON 붙여넣기 (Ctrl+V) — 비워두면 자동전달된 값 사용"></textarea>
        <button id="az-lars-go" style="width:100%;border:0;border-radius:9px;padding:12px;background:#ff9900;color:#131921;font:700 14px inherit;cursor:pointer;">라스 칸에 넣기</button>
        <button id="az-lars-clear" style="width:100%;margin-top:7px;border:0;border-radius:9px;padding:9px;background:#3a2323;color:#ffb4b4;font:700 12px inherit;cursor:pointer;">🗑 모두 지우기 (칸·대기값 초기화)</button>
        <div id="az-lars-status" style="margin-top:10px;font-weight:500;font-size:11.5px;opacity:.95;word-break:keep-all;line-height:1.5;">${saved ? "자동전달 대기: " + saved.slice(0, 18) + "… (붙여넣기 없이 눌러도 됨)" : "아마존 JSON을 붙여넣으세요."}</div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector("#az-lars-go").addEventListener("click", injectToLars);
    box.querySelector("#az-lars-clear").addEventListener("click", clearLarsAll);
    const closeEl = box.querySelector("#az-lars-close");
    closeEl.addEventListener("mousedown", (e) => e.stopPropagation());
    closeEl.addEventListener("click", (e) => { e.stopPropagation(); box.remove(); });
    makeDraggable(box, box.querySelector("#az-lars-head"), box.querySelector("#az-lars-min"), box.querySelector("#az-lars-body"));
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
      const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy));
      box.style.left = x + "px"; box.style.top = y + "px";
    });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  /* ---- 부팅 -------------------------------------------------------------- */
  try { CFG.translate = GM_getValue("az_translate", true); } catch (_) {}
  try { CFG.primary = GM_getValue("az_primary_lang", "en") === "ko" ? "ko" : "en"; } catch (_) {}
  try { CFG.larsReviewLimit = Number(GM_getValue("az_lars_review_limit", 10)) || 0; } catch (_) {}
  try { CFG.auOnly = !!GM_getValue("az_au_only", false); } catch (_) {}

  const IS_LARS = location.hostname.includes("lucystar.kr");
  function openPanel() { if (IS_LARS) buildLarsPanel(); else buildPanel(); }

  const boot = setInterval(() => {
    if (!document.body) return;
    clearInterval(boot);
    openPanel();
  }, 300);

  try { GM_registerMenuCommand("아마존 패널 다시 열기", openPanel); } catch (_) {}
})();
