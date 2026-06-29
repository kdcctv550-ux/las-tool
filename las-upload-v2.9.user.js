// ==UserScript==
// @name         LAS 자동 업로드 (폴더 → 라스)
// @namespace    https://local.lars-auto-filler/
// @version      2.9.0
// @description  폴더 한 번 선택하면 파일명 태그(m1s2 등)대로 라스 장면에 이미지/영상 자동 주입. 외부 통신 0건 — 전부 내 브라우저 안에서만 동작.
// @match        https://lucystar.kr/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * ─────────────────────────────────────────────────────────────
 *  v0.3 — 진단 결과 반영판 (2026-06-12 진단 로그 기준)
 *
 *  ◆ 진단으로 확정된 사실
 *    - URL 구조: /episodes/{id}/{board}/m{M}/s{S}  (예: /episodes/16532/imageboard/m1/s1)
 *    - SPA: 장면 전환 시 새로고침 없이 가운데만 바뀌고 URL이 /m1/s2 식으로 갱신됨
 *    - 이미지 업로드 입구: input[x-ref="scenePreviewUploadInput"][accept="image/*"] ✓
 *    - "서브장면" 버튼 존재 ✓ / mXsY 라벨("M1, S2") 다수 ✓
 *    - 장면으로 가는 실제 <a href="/episodes/16532/imageboard/m1/s1"> 링크 존재 ✓
 *    - 영상 드롭존/피커는 이미지보드엔 없음 (비디오보드 전용 — 정상)
 *
 *  ◆ v0.3 네비게이션 전략 (추측 셀렉터 제거)
 *    ① 목표 경로의 <a> 링크가 있으면 그걸 클릭 (가장 확실)
 *    ② 없으면: 메인 장면(m{M}/s1) 링크 클릭 → "서브장면" 펼침 → 라벨 텍스트로 서브 클릭
 *    ③ 그래도 안 되면: history.pushState + popstate 폴백
 *    각 단계 후 URL 폴링으로 "정말 도착했는지" 검증하고,
 *    주입 전에 업로드 입구가 나타날 때까지 기다림 (SPA 렌더 대기)
 *
 *  ◆ 프라이버시 원칙 (불변)
 *    - fetch / XHR / GM_xmlhttpRequest 없음. @grant none.
 *    - 모든 기능은 페이지를 읽고(querySelector) 패널에 출력만 함.
 *    - 서버로 가는 트래픽은 라스 자신의 업로드뿐 (수동 업로드와 동일).
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  // ════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════
  const CONFIG = {
    // m1s1, m1s1c1, m1/s1/c1, "M1, S1, C1" 등 — c(컷)는 선택
    tagRegex: /m\s*(\d+)\s*[\/\-_,\s]?\s*s\s*(\d+)\s*(?:[\/\-_,\s]?\s*c\s*(\d+))?/i,
    imageExts: ["png", "jpg", "jpeg", "webp", "gif"],
    videoExts: ["mp4", "webm", "mov"],
    navPollMs: 150,          // URL 도착 확인 폴링 간격
    navTimeoutMs: 5000,      // 한 단계 네비 최대 대기
    renderTimeoutMs: 5000,   // 업로드 입구 렌더 최대 대기
    uploadSettleMs: 3000,    // 주입 후 라스 처리 대기
    humanJitterMs: 700,      // 무작위 추가 대기
  };

  const KNOWN = {
    imageUploadInput: 'input[x-ref="scenePreviewUploadInput"]',
    anyImageInput: 'input[type="file"][accept*="image"]',
    anyVideoInput: 'input[type="file"][accept*="video"]',
    dropHandlerNeedle: "handleScenePreviewDrop",
    // 서브장면 자리는 change 이벤트만으론 안 붙음 → Alpine 핸들러 직접 호출 필요
    uploadHandlerName: "handleScenePreviewUpload",
  };

  // 주어진 요소의 Alpine 컴포넌트 데이터 가져오기
  function getAlpine(el) {
    try { return (window.Alpine && el) ? Alpine.$data(el) : null; } catch (_) { return null; }
  }

  // ════════════════════════════════════════════════════════════
  // 유틸
  // ════════════════════════════════════════════════════════════
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => Math.floor(Math.random() * CONFIG.humanJitterMs);
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s,\/]/g, "");

  // 백그라운드 탭 절전 방지: 무음 오디오를 재생하면 크롬이 탭을 안 재움.
  let _audioCtx = null, _silenceNode = null;
  function keepAwake(on) {
    try {
      if (on) {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (_audioCtx.state === "suspended") _audioCtx.resume();
        if (!_silenceNode) {
          const osc = _audioCtx.createOscillator();
          const gain = _audioCtx.createGain();
          gain.gain.value = 0.0001; // 사실상 무음
          osc.frequency.value = 30;
          osc.connect(gain); gain.connect(_audioCtx.destination);
          osc.start();
          _silenceNode = { osc, gain };
        }
      } else {
        if (_silenceNode) { try { _silenceNode.osc.stop(); } catch (_) {} _silenceNode = null; }
        if (_audioCtx) { try { _audioCtx.suspend(); } catch (_) {} }
      }
    } catch (e) { /* 오디오 차단 환경이면 무시 — 그냥 기존대로 동작 */ }
  }

  function log(msg, type = "info") {
    const box = document.getElementById("laf-log");
    if (!box) return;
    const colors = { info: "#cbd5e1", ok: "#34d399", warn: "#fbbf24", err: "#f87171" };
    const line = document.createElement("div");
    line.style.cssText = `color:${colors[type] || colors.info};margin:2px 0;word-break:break-all;`;
    line.textContent = `[${new Date().toLocaleTimeString("ko-KR", { hour12: false })}] ${msg}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function hasAlpineHandler(el, needle) {
    const attrs = ["@click", "x-on:click", "@drop.prevent", "x-on:drop.prevent", "x-on:drop", "@change", "x-on:change"];
    return attrs.some((a) => (el.getAttribute(a) || "").includes(needle));
  }

  function realClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  }

  function findClickableByText(needleNorm) {
    // 라벨 span 등에서 텍스트를 찾고, 클릭 가능한 조상으로 승격
    const el = [...document.querySelectorAll("button, a, span, div")].find((n) => {
      const t = norm(n.textContent);
      return t.includes(needleNorm) && t.length < 40;
    });
    if (!el) return null;
    return el.closest("button, a, [role='button']") || el;
  }

  // ════════════════════════════════════════════════════════════
  // URL 해석
  // ════════════════════════════════════════════════════════════
  function parseBoardUrl(href = location.href) {
    // 2단(롱폼) /m1/s1  또는 3단(쇼핑) /m1/s1/c1  모두 인식
    const m = href.match(/\/episodes\/(\d+)\/([a-z]+board)(?:\/m(\d+)\/s(\d+)(?:\/c(\d+))?)?/i);
    if (!m) return null;
    return {
      episode: m[1], board: m[2],
      m: m[3] ? +m[3] : null,
      s: m[4] ? +m[4] : null,
      c: m[5] ? +m[5] : null,
    };
  }
  // cc 가 주어지면 3단 경로, 아니면 2단 경로
  function scenePath(info, mm, ss, cc) {
    const base = `/episodes/${info.episode}/${info.board}/m${mm}/s${ss}`;
    return cc != null ? `${base}/c${cc}` : base;
  }
  // cc 가 null 이면 m,s 만 비교(롱폼). cc 가 있으면 c까지 일치해야 도착(쇼핑).
  function atScene(mm, ss, cc) {
    const u = parseBoardUrl();
    if (!u || u.m !== mm || u.s !== ss) return false;
    if (cc == null) return true;
    return u.c === cc;
  }

  // 조건이 참이 될 때까지 폴링
  async function waitFor(fn, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (fn()) return true;
      await sleep(CONFIG.navPollMs);
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════
  // 파일 파싱
  // ════════════════════════════════════════════════════════════
  function parseFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const kind = CONFIG.imageExts.includes(ext) ? "image"
               : CONFIG.videoExts.includes(ext) ? "video" : "other";
    const m = file.name.match(CONFIG.tagRegex);
    const c = m && m[3] ? +m[3] : null; // 컷 (쇼핑 보드). 없으면 null
    return {
      file, name: file.name, kind,
      m: m ? +m[1] : null,
      s: m ? +m[2] : null,
      c,
      tag: m ? `m${+m[1]}s${+m[2]}${c != null ? `c${c}` : ""}` : null,
    };
  }

  // ════════════════════════════════════════════════════════════
  // 장면 이동 (v0.5 — 검증 우선)
  //
  // ⚠ v0.4의 치명적 버그: pushState 폴백이 "내가 바꾼 URL"을 보고
  //   도착했다고 착각 → 화면은 그대로인데 주입 → 엉뚱한 장면(열려있던
  //   장면)에 업로드됨. 그래서 v0.5 원칙:
  //   "앱 스스로 URL을 바꾼 것"만 도착으로 인정.
  //   검증 안 되면 절대 주입하지 않고 그 파일은 실패 처리.
  // ════════════════════════════════════════════════════════════

  // 텍스트가 일치하는 클릭 후보를 전부 수집 (첫 번째 하나가 아니라)
  function findClickCandidates(needleNorm) {
    const seen = new Set();
    const out = [];
    for (const n of document.querySelectorAll("button, a, span, div")) {
      const t = norm(n.textContent);
      if (!t.includes(needleNorm) || t.length >= 40) continue;
      const clickable = n.closest("button, a, [role='button']") || n;
      if (seen.has(clickable)) continue;
      seen.add(clickable);
      out.push(clickable);
    }
    return out;
  }

  // 후보들을 하나씩 클릭해보고, 앱이 실제로 URL을 바꿨는지 확인
  async function clickUntilArrived(candidates, mm, ss, cc, waitMs) {
    for (const el of candidates) {
      const beforeHref = location.href;
      realClick(el);
      const arrived = await waitFor(() => atScene(mm, ss, cc), waitMs);
      if (arrived && location.href !== beforeHref) return true; // 앱 라우터가 반응한 것만 인정
      if (arrived) return true; // 이미 목표였던 경우
    }
    return false;
  }

  // 라벨 텍스트 만들기: 쇼핑이면 "m{M}s{S}c{C}", 롱폼이면 "m{M}s{S}"
  function labelNeedle(mm, ss, cc) {
    return cc != null ? norm(`m${mm}s${ss}c${cc}`) : norm(`m${mm}s${ss}`);
  }

  // 라벨(왼쪽 목록 행)로 서브 체크박스를 찾아 켠다 — 이동 *전에* 호출해야 함.
  // 꺼진 서브는 이동 자체가 안 되므로, 켜야 navigable 해짐.
  async function enableSubByLabel(mm, ss, cc) {
    if (!AUTO_SUB_CHECK) return;
    const needle = labelNeedle(mm, ss, cc);
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
    for (const box of boxes) {
      // 체크박스의 위쪽 4단계 조상 텍스트에 라벨 + "서브" 가 있는지
      let ctx = box, txt = "";
      for (let k = 0; k < 4 && ctx; k++) {
        ctx = ctx.parentElement;
        if (ctx) { txt = norm(ctx.textContent); if (txt.includes(needle)) break; }
      }
      if (txt.includes(needle) && txt.includes("서브")) {
        if (box.checked) return; // 이미 켜짐
        box.click();
        log("  서브 체크 자동 켜기 → 서버 반영 대기…", "info");
        const ok = await waitFor(() => {
          const d = getAlpine(box);
          if (d && d.dlg && d.dlg.generate_sub_scene === true) return true;
          return box.checked && box.offsetParent !== null;
        }, 9000);
        if (ok) log("  ✓ 서브 켜짐", "ok");
        else log("  ⚠ 서브 켜기 반영 지연 — 그래도 진행", "warn");
        await sleep(1400);
        return;
      }
    }
    log(`  (서브 체크박스 라벨 매칭 못 찾음 — 메인이거나 이미 활성)`, "info");
  }

  async function navigateTo(mm, ss, cc) {
    if (atScene(mm, ss, cc)) return true;
    const info = parseBoardUrl();
    if (!info) { log("  ⚠ URL에서 보드를 못 읽음 — 프로젝트 보드 페이지인지 확인", "err"); return false; }

    const targetPath = scenePath(info, mm, ss, cc);
    const label = cc != null ? `m${mm}/s${ss}/c${cc}` : `m${mm}/s${ss}`;
    const perTry = 1800;

    // ★ 서브 타깃(s2 이상)이면 이동 전에 먼저 체크 켜기 (꺼진 서브는 이동 불가)
    const isSubTarget = ss > 1 || (cc != null && cc > 1);
    if (isSubTarget) await enableSubByLabel(mm, ss, cc);

    // ① 라벨 텍스트로 클릭 (왼쪽 목록의 "M1, S2" 등). href 없는 요소라 새로고침 안 남.
    let labelCands = findClickCandidates(labelNeedle(mm, ss, cc));
    if (labelCands.length && (await clickUntilArrived(labelCands, mm, ss, cc, perTry))) {
      log(`  → ${label} (라벨 클릭)`, "info");
      return true;
    }

    // ② 서브장면이 접혀 있으면 "서브장면" 펼침 후 라벨 재시도
    const expandBtns = [...document.querySelectorAll("button")]
      .filter((b) => norm(b.textContent).includes("서브장면"));
    for (const ex of expandBtns) {
      realClick(ex);
      await sleep(450);
      labelCands = findClickCandidates(labelNeedle(mm, ss, cc));
      if (labelCands.length && (await clickUntilArrived(labelCands, mm, ss, cc, perTry))) {
        log(`  → ${label} (펼침 후 라벨)`, "info");
        return true;
      }
    }

    // ③ 마지막 수단: 목표 경로 <a> 링크. 단, 안쪽 자식 요소를 클릭해 전체이동(새로고침) 회피 시도
    let cands = [...document.querySelectorAll(`a[href$="${targetPath}"], a[href="${targetPath}"]`)];
    const innerCands = cands.map((a) => a.querySelector("*") || a); // 자식이 있으면 자식 클릭
    if (innerCands.length && (await clickUntilArrived(innerCands, mm, ss, cc, perTry))) {
      log(`  → ${label} (링크 내부)`, "info");
      return true;
    }

    // 도착 확인 실패 → 주입 안 함 (오업로드/새로고침 방지)
    log(`  ⚠ ${label} 도착 확인 실패 → 건너뜀`, "err");
    return false;
  }

  // ════════════════════════════════════════════════════════════
  // 주입
  // ════════════════════════════════════════════════════════════
  function makeDT(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }

  // 화면에 보이는(가려지지 않은) 요소인지
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  // picker 버튼이 클릭 시 여는 input을 추적: 버튼을 클릭하면 숨은 input.click()이 호출됨.
  // 그 직전에 input의 click을 가로채 우리가 파일을 꽂는다.
  function findPickerButton() {
    const btns = [...document.querySelectorAll("button, div")]
      .filter((el) => hasAlpineHandler(el, "openScenePreviewUploadPicker") ||
                       hasAlpineHandler(el, KNOWN.dropHandlerNeedle));
    return btns.find(isVisible) || btns[0] || null;
  }

  // 주입이 실제로 반영됐는지 확인: 업로드 로딩이 끝나고 대상 미리보기에 url이 생겼는지
  async function uploadLanded(input, wasSubTarget, beforeSubUrl, beforeMainUrl) {
    // 업로드 로딩 스피너가 끝날 때까지 대기 (최대 renderTimeout)
    const s = getAlpine(input);
    await waitFor(() => !(s && s.previewImageUpload && s.previewImageUpload.loading), CONFIG.renderTimeoutMs);
    await sleep(300);
    const now = getAlpine(input);
    if (!now) return true; // 확인 불가 시 성공으로 간주(롱폼 등)
    if (wasSubTarget) {
      const url = now.selectedSubPreview && now.selectedSubPreview.url;
      return !!url && url !== beforeSubUrl;
    }
    const url = now.selectedScene && now.selectedScene.preview_image_url;
    return !!url && url !== beforeMainUrl;
  }

  async function setInputFiles(input, file) {
    const s0 = getAlpine(input);
    const wasSubTarget = !!(s0 && s0.selectedSubDialogue);
    const beforeSubUrl = s0 && s0.selectedSubPreview ? s0.selectedSubPreview.url : null;
    const beforeMainUrl = s0 && s0.selectedScene ? s0.selectedScene.preview_image_url : null;

    // ★ 서브 대사 타깃인데 아직 selectedSubDialogue가 안 잡혔으면 잠깐 더 대기
    if (s0 && "selectedSubDialogue" in s0) {
      await waitFor(() => { const x = getAlpine(input); return x && (x.selectedSubDialogue || x.selectedScene); }, 1500);
    }

    const doInject = async () => {
      input.files = makeDT(file).files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const s = getAlpine(input);
      if (s && typeof s[KNOWN.uploadHandlerName] === "function") {
        try { await s[KNOWN.uploadHandlerName]({ target: input }); }
        catch (e) { log(`  핸들러 경고: ${String(e).slice(0, 50)}`, "warn"); }
      }
    };

    await doInject();
    // 검증 + 1회 재시도 (타이밍으로 흘린 경우 복구)
    const landed = await uploadLanded(input, wasSubTarget, beforeSubUrl, beforeMainUrl);
    if (!landed) {
      log("  ↻ 반영 안 됨 → 재시도", "warn");
      await sleep(500);
      await doInject();
      const landed2 = await uploadLanded(input, wasSubTarget, beforeSubUrl, beforeMainUrl);
      if (!landed2) { log("  ⚠ 재시도 후에도 미반영 (이 자리 수동 확인 필요)", "err"); return false; }
      log("  ✓ 재시도 성공", "ok");
    }
    return true;
  }

  // 서브 자리인데 "서브 생성" 체크가 꺼져 있으면 켜준다.
  async function ensureSubEnabled(input, mm, ss, cc) {
    if (!AUTO_SUB_CHECK) return;
    const s = getAlpine(input);
    if (!s || !s.selectedSubDialogue) return;            // 서브 타깃 아님
    if (s.selectedSubDialogue.generate_sub_scene) return; // 이미 켜짐
    const targetId = s.selectedSubDialogue.id;

    const allBoxes = [...document.querySelectorAll('input[type="checkbox"]')];
    let box = null;

    // 방법1: Alpine 스코프 dlg.id 매칭
    for (const b of allBoxes) {
      const sc = getAlpine(b);
      if (sc && sc.dlg && sc.dlg.id === targetId) { box = b; break; }
    }
    // 방법2: 왼쪽 목록 행 텍스트(라벨)로 찾기 — 그 행 안의 체크박스
    if (!box && mm != null) {
      const needle = labelNeedle(mm, ss, cc);
      const rowLabel = [...document.querySelectorAll("div, li, label, span")]
        .find((el) => norm(el.textContent).includes(needle) && norm(el.textContent).includes("서브") && el.textContent.length < 120);
      if (rowLabel) {
        const row = rowLabel.closest("div, li") || rowLabel;
        box = row.querySelector('input[type="checkbox"]');
      }
    }
    // 방법3: "서브" 글자 옆 체크박스 중 안 켜진 것 (최후)
    if (!box) {
      box = allBoxes.find((b) => {
        const lbl = b.closest("label, div, li");
        return lbl && norm(lbl.textContent).includes("서브") && !b.checked;
      }) || null;
    }

    if (!box) { log(`  ⚠ 서브 체크박스 못 찾음 (체크박스 ${allBoxes.length}개 중) — 수동 체크 필요`, "warn"); return; }
    if (box.checked) return;

    box.click();
    log("  서브 체크 자동 켜기 → 서버 반영 대기…", "info");
    const ok = await waitFor(() => {
      const d = getAlpine(box);
      if (d && d.dlg && d.dlg.generate_sub_scene === true) return true;
      return box.checked && !!document.querySelector(KNOWN.imageUploadInput); // 폴백 확인
    }, 9000);
    if (!ok) log("  ⚠ 서브 켜기 반영 지연 — 그래도 진행", "warn");
    else log("  ✓ 서브 켜짐", "ok");
    await sleep(1300);
  }

  // 주입 직전, 라스 내부 상태가 이 장면으로 세팅됐는지 확인:
  // "이미지 추가" 버튼(빈 자리) 또는 미리보기 img 가 화면에 보이면 준비된 것.
  function previewReady() {
    // 빈 자리: handleScenePreviewDrop 핸들러를 가진 보이는 버튼
    const emptyBox = [...document.querySelectorAll("button")]
      .find((el) => hasAlpineHandler(el, KNOWN.dropHandlerNeedle) && isVisible(el));
    if (emptyBox) return true;
    // 채워진 자리: 미리보기 영역의 큰 이미지가 보임
    const previewImg = [...document.querySelectorAll("img")]
      .find((el) => isVisible(el) && el.getBoundingClientRect().height > 120);
    return !!previewImg;
  }

  async function injectImage(file, mm, ss, cc) {
    await waitFor(
      () => document.querySelector(KNOWN.imageUploadInput) ||
            document.querySelector(KNOWN.anyImageInput) ||
            findPickerButton(),
      CONFIG.renderTimeoutMs
    );
    // ★ 상태 안정 대기: 미리보기 영역이 이 장면으로 실제로 렌더될 때까지
    await waitFor(previewReady, CONFIG.renderTimeoutMs);
    await sleep(350); // Alpine 상태 반영 여유

    // ★ 서브 자리인데 체크가 꺼져 있으면 켜기
    const xref = document.querySelector(KNOWN.imageUploadInput);
    if (xref) { await ensureSubEnabled(xref, mm, ss, cc); await waitFor(previewReady, CONFIG.renderTimeoutMs); }

    // ─ 방법 A: scenePreviewUploadInput (x-ref) 에 직접 (숨김이어도 OK) ─
    let input = document.querySelector(KNOWN.imageUploadInput);
    if (input) {
      log("  (A: scenePreviewUploadInput 직접)", "info");
      const ok = await setInputFiles(input, file);
      await sleep(400);
      return ok;
    }

    // ─ 방법 B: picker 버튼이 여는 input을 가로채기 ─
    // HTMLInputElement.click 을 잠깐 후킹 → 버튼 클릭 시 열리는 input을 붙잡아 파일 주입
    const picker = findPickerButton();
    if (picker) {
      const captured = await captureInputViaPicker(picker, file);
      if (captured) { log("  (B: picker로 input 포착)", "info"); return true; }
    }

    // ─ 방법 C: 화면의 image input 아무거나 ─
    input = [...document.querySelectorAll(KNOWN.anyImageInput)].find(Boolean);
    if (input) {
      await setInputFiles(input, file);
      log("  (C: image input 직접)", "info");
      return true;
    }

    // ─ 방법 D: 합성 드롭 (최후) ─
    if (picker) {
      const dt = makeDT(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        picker.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      log("  (D: 합성 드롭·최후수단)", "warn");
      return true;
    }
    log("  ⚠ 이미지 주입 입구를 못 찾음", "err");
    return false;
  }

  // picker 버튼을 누르면 내부적으로 input.click()이 호출됨.
  // 그 click을 가로채 실제 파일 선택창을 띄우지 않고 우리가 파일을 주입한다.
  function captureInputViaPicker(picker, file) {
    return new Promise((resolve) => {
      const proto = HTMLInputElement.prototype;
      const orig = proto.click;
      let done = false;
      const cleanup = () => { proto.click = orig; };
      proto.click = function () {
        if (!done && this.type === "file") {
          done = true;
          try { setInputFiles(this, file); } catch (_) {}
          cleanup();
          resolve(true);
          return; // 실제 파일 선택창 안 띄움
        }
        return orig.apply(this, arguments);
      };
      // 버튼 클릭 → Alpine이 input.click() 호출하도록 유도
      realClick(picker);
      setTimeout(() => { if (!done) { cleanup(); resolve(false); } }, 1200);
    });
  }

  async function injectVideo(file) {
    await waitFor(() => findPickerButton() || document.querySelector(KNOWN.anyVideoInput), CONFIG.renderTimeoutMs);
    const vInput = document.querySelector(KNOWN.anyVideoInput);
    if (vInput) { await setInputFiles(vInput, file); log("  (영상 input 직접)", "info"); return true; }
    const picker = findPickerButton();
    if (picker) {
      const captured = await captureInputViaPicker(picker, file);
      if (captured) { log("  (영상 picker로 input 포착)", "info"); return true; }
      const dt = makeDT(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        picker.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      log("  (영상 합성 드롭·최후)", "warn");
      return true;
    }
    log("  ⚠ 영상 주입 입구 없음 (비디오보드인지 확인)", "err");
    return false;
  }

  // ════════════════════════════════════════════════════════════
  // 메인 루프
  // ════════════════════════════════════════════════════════════
  let RUNNING = false, ABORT = false, LAST_FAILED = [], AUTO_SUB_CHECK = true;

  async function runFill(parsed, testOne, onlyList) {
    if (RUNNING) return;
    RUNNING = true; ABORT = false;
    keepAwake(true); // 백그라운드 탭에서도 안 멈추게

    const info = parseBoardUrl();
    if (!info) {
      log("⚠ 프로젝트 보드 페이지가 아님 — 이미지/비디오 탭을 연 상태에서 실행하세요", "err");
      RUNNING = false; keepAwake(false); return;
    }
    const wantKind = info.board.startsWith("video") ? "video" : "image";

    let targets = (onlyList && onlyList.length ? onlyList : parsed)
      .filter((f) => f.tag && f.kind === wantKind)
      .sort((a, b) => (a.m - b.m) || (a.s - b.s) || ((a.c || 0) - (b.c || 0)));
    const held = parsed.filter((f) => f.tag && f.kind !== wantKind && f.kind !== "other").length;
    const skipped = parsed.filter((f) => !f.tag || f.kind === "other").length;
    if (testOne && !onlyList) targets = targets.slice(0, 1);

    log(`보드=${info.board} → ${wantKind === "image" ? "이미지" : "영상"} ${targets.length}개 처리${testOne ? " (테스트 1개)" : ""}`, "warn");
    if (held) log(`다른 종류 ${held}개는 해당 탭에서 다시 ▶ 누르면 처리`, "info");
    if (skipped) log(`태그 없음/미지원 ${skipped}개 건너뜀`, "warn");

    let done = 0, fail = 0;
    const failedFiles = [];
    const total = targets.length;
    setProgress(0, total, "", "준비");
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (ABORT) { log("⏹ 중지됨", "warn"); setProgress(i, total, "", "중지됨"); break; }
      setProgress(i, total, t.name, "업로드 중");
      log(`▶ ${t.name} → ${t.tag}`, "info");
      // 쇼핑(3단) 보드인데 파일명에 c가 없으면 첫 컷(c1)으로 간주
      const isShopBoard = /shopping|shorts|shop/i.test(info.board) || info.c != null;
      const cc = t.c != null ? t.c : (isShopBoard ? 1 : null);
      if (!(await navigateTo(t.m, t.s, cc))) { fail++; failedFiles.push(t); setProgress(i + 1, total, t.name, "실패"); continue; }
      const ok = t.kind === "image" ? await injectImage(t.file, t.m, t.s, cc) : await injectVideo(t.file);
      if (ok) { done++; log("  ✓ 주입 완료", "ok"); } else { fail++; failedFiles.push(t); }
      setProgress(i + 1, total, t.name, ok ? "완료" : "실패");
      await sleep(CONFIG.uploadSettleMs + jitter());
    }
    log(`──── 끝: 성공 ${done} / 실패 ${fail} ────`, done && !fail ? "ok" : "warn");
    if (!ABORT) setProgress(total, total, "", `끝 — 성공 ${done} / 실패 ${fail}`);

    // 실패분 보관 + 재시도 버튼 노출 + 파일로 저장
    LAST_FAILED = failedFiles;
    const retryBtn = document.getElementById("laf-retry");
    if (retryBtn) {
      if (failedFiles.length) {
        retryBtn.style.display = "block";
        retryBtn.textContent = `❗ 실패 ${failedFiles.length}개 재시도`;
        log(`실패 ${failedFiles.length}개: ${failedFiles.map((f) => f.tag).join(", ")}`, "warn");
        saveFailedList(failedFiles, done, fail); // 새로고침돼도 남도록 파일 저장
      } else {
        retryBtn.style.display = "none";
      }
    }
    RUNNING = false; keepAwake(false);
  }

  // 실패 목록을 .txt 로 다운로드 (새로고침으로 로그 사라져도 확인 가능)
  function saveFailedList(failed, done, fail) {
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
      const lines = [
        `라스 업로드 실패 목록`,
        `시각: ${now.toLocaleString()}`,
        `결과: 성공 ${done} / 실패 ${fail}`,
        `URL: ${location.href}`,
        ``,
        `── 실패한 파일 ──`,
        ...failed.map((f) => `${f.tag}\t${f.name}`),
      ];
      const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `라스실패목록_${stamp}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 6000);
      log(`  💾 실패 목록 저장: 라스실패목록_${stamp}.txt`, "info");
    } catch (e) {
      log(`  실패 목록 저장 오류: ${String(e).slice(0, 40)}`, "warn");
    }
  }

  // 진행 표시: "3/12 · m2s1.png 업로드 중" + 진행바
  function setProgress(cur, total, name, state) {
    const wrap = document.getElementById("laf-prog-wrap");
    const text = document.getElementById("laf-prog-text");
    const bar = document.getElementById("laf-prog-bar");
    if (!wrap || !text || !bar) return;
    wrap.style.display = "block";
    const remain = Math.max(total - cur, 0);
    text.textContent = total
      ? `${cur}/${total} · 남은 ${remain}개${name ? ` · ${name}` : ""} · ${state}`
      : state;
    bar.style.width = total ? `${Math.round((cur / total) * 100)}%` : "0%";
  }

  // ════════════════════════════════════════════════════════════
  // 진단 (읽기 전용)
  // ════════════════════════════════════════════════════════════
  function runDiagnostics() {
    log("──── 진단 (읽기 전용, 외부 전송 없음) ────", "warn");
    const u = parseBoardUrl();
    log(u ? `URL ✓ ep=${u.episode} board=${u.board} 장면=${u.m ?? "?"}/${u.s ?? "?"}` : `URL 패턴 없음: ${location.pathname}`, u ? "ok" : "warn");

    const inputs = [...document.querySelectorAll('input[type="file"]')];
    log(`input[type=file]: ${inputs.length}개`, inputs.length ? "ok" : "warn");
    inputs.forEach((inp, i) =>
      log(`  · #${i} x-ref=${inp.getAttribute("x-ref") || "-"} accept=${inp.getAttribute("accept") || "-"}`, "info"));

    const zone = [...document.querySelectorAll("button, div")].find((el) => hasAlpineHandler(el, KNOWN.dropHandlerNeedle));
    log(`영상 드롭존: ${zone ? "찾음 ✓" : "없음 (이미지보드면 정상)"}`, zone ? "ok" : "info");

    if (u) {
      const sample = scenePath(u, u.m || 1, 1);
      const links = [...document.querySelectorAll(`a[href*="/${u.board}/m"]`)];
      log(`장면 링크(a[href*=${u.board}/m]): ${links.length}개`, links.length ? "ok" : "warn");
      links.slice(0, 6).forEach((a) => log(`  · ${a.getAttribute("href")}`, "info"));
      log(`(예시 목표 경로: ${sample})`, "info");
    }
    log("──── 진단 끝 ────", "warn");
  }

  // ════════════════════════════════════════════════════════════
  // UI 패널
  // ════════════════════════════════════════════════════════════
  let parsedCache = [];

  function buildPanel() {
    if (document.getElementById("laf-panel")) return;
    const p = document.createElement("div");
    p.id = "laf-panel";
    p.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:2147483600",
      "width:340px", "max-height:72vh", "display:flex", "flex-direction:column",
      "background:#0f1117", "color:#e2e8f0",
      "border:1px solid rgba(139,92,246,.4)", "border-radius:12px",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-shadow:0 10px 40px rgba(0,0,0,.5)", "overflow:hidden",
    ].join(";");
    p.innerHTML = `
      <div id="laf-head" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#171a23;cursor:move;border-bottom:1px solid rgba(255,255,255,.06)">
        <span style="font-weight:700;color:#a78bfa">🎬 LAS 자동 업로드</span>
        <span style="margin-left:auto;font-size:11px;color:#64748b">v2.9</span>
        <button id="laf-min" style="background:none;border:0;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1">—</button>
      </div>
      <div id="laf-body" style="padding:12px;display:flex;flex-direction:column;gap:8px;overflow:auto">

        <input id="laf-folder" type="file" webkitdirectory directory multiple style="display:none">
        <button id="laf-pick" style="background:#8b5cf6;color:#fff;border:0;padding:9px;border-radius:8px;font-weight:600;cursor:pointer">📁 폴더 선택</button>
        <div id="laf-summary" style="font-size:12px;color:#94a3b8;min-height:18px"></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer">
          <input id="laf-testone" type="checkbox" checked> 첫 파일 1개만 (테스트)
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer">
          <input id="laf-autosub" type="checkbox" checked> 서브 체크 자동 켜기
        </label>
        <div style="display:flex;gap:6px">
          <button id="laf-run" disabled style="flex:1;background:#10b981;color:#fff;border:0;padding:9px;border-radius:8px;font-weight:600;cursor:pointer;opacity:.5">▶ 시작</button>
          <button id="laf-stop" style="background:#ef4444;color:#fff;border:0;padding:9px 12px;border-radius:8px;font-weight:600;cursor:pointer">⏹</button>
        </div>
        <button id="laf-retry" style="display:none;background:#f59e0b;color:#1a1a1a;border:0;padding:9px;border-radius:8px;font-weight:700;cursor:pointer">❗ 실패 재시도</button>
        <div id="laf-prog-wrap" style="display:none">
          <div id="laf-prog-text" style="font-size:12px;color:#e2e8f0;margin-bottom:4px;min-height:16px"></div>
          <div style="background:#1e293b;border-radius:6px;height:8px;overflow:hidden">
            <div id="laf-prog-bar" style="height:100%;width:0%;background:#10b981;transition:width .3s"></div>
          </div>
        </div>
        <button id="laf-diag" style="background:#334155;color:#e2e8f0;border:0;padding:8px;border-radius:8px;cursor:pointer">🔍 진단</button>

        <div id="laf-sb" style="display:none;flex-direction:column;gap:6px;padding:10px;background:#1a1430;border:1px solid rgba(168,139,250,.35);border-radius:8px;margin-top:4px">
          <div style="font-size:12px;color:#c4b5fd;font-weight:600">🎬 스토리보드 — 서브장면 일괄 체크</div>
          <div style="font-size:11px;color:#94a3b8">화면에 보이는 서브장면 체크를 한꺼번에 켭니다 (끄지는 않음).</div>
          <button id="laf-sb-all" style="background:#7c3aed;color:#fff;border:0;padding:8px;border-radius:8px;font-weight:600;cursor:pointer">✅ 전체 서브 켜기</button>
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8">
            <span>범위 m</span>
            <input id="laf-sb-from" type="number" min="1" placeholder="1" style="width:52px;padding:4px;background:#0a0c12;border:1px solid #334155;border-radius:4px;color:#e2e8f0">
            <span>~ m</span>
            <input id="laf-sb-to" type="number" min="1" placeholder="3" style="width:52px;padding:4px;background:#0a0c12;border:1px solid #334155;border-radius:4px;color:#e2e8f0">
            <button id="laf-sb-range" style="flex:1;background:#5b21b6;color:#fff;border:0;padding:7px;border-radius:8px;font-weight:600;cursor:pointer">범위만 켜기</button>
          </div>
        </div>

        <div id="laf-log-head" style="display:flex;align-items:center;gap:6px;margin-top:4px;padding:6px 8px;background:#171a23;border-radius:6px;cursor:pointer;user-select:none;font-size:12px;color:#94a3b8">
          <span id="laf-log-arrow">▼</span><span>로그</span>
        </div>
        <div id="laf-log" style="margin-top:4px;padding:8px;background:#0a0c12;border-radius:8px;height:200px;overflow:auto;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace"></div>
      </div>`;
    document.body.appendChild(p);

    (() => {
      const head = p.querySelector("#laf-head");
      let sx, sy, ox, oy, on = false;
      head.addEventListener("mousedown", (e) => {
        if (e.target.id === "laf-min") return;
        on = true; sx = e.clientX; sy = e.clientY;
        const r = p.getBoundingClientRect(); ox = r.left; oy = r.top;
        Object.assign(p.style, { right: "auto", bottom: "auto", left: ox + "px", top: oy + "px" });
      });
      window.addEventListener("mousemove", (e) => {
        if (!on) return;
        p.style.left = ox + (e.clientX - sx) + "px";
        p.style.top = oy + (e.clientY - sy) + "px";
      });
      window.addEventListener("mouseup", () => (on = false));
    })();

    p.querySelector("#laf-min").addEventListener("click", () => {
      const b = p.querySelector("#laf-body");
      b.style.display = b.style.display === "none" ? "flex" : "none";
    });

    // ── 스토리보드 페이지면 업로드 UI 숨기고 일괄 서브체크 UI 표시 ──
    function applyPageMode() {
      const info = parseBoardUrl();
      const isStory = info && /storyboard/i.test(info.board);
      const sbBox = p.querySelector("#laf-sb");
      // 업로드 관련 컨트롤들
      const upIds = ["#laf-pick", "#laf-summary", "#laf-run", "#laf-stop"];
      const upLabels = p.querySelectorAll("#laf-body > label");
      if (isStory) {
        sbBox.style.display = "flex";
        upIds.forEach((id) => { const el = p.querySelector(id); if (el) el.style.display = "none"; });
        upLabels.forEach((l) => (l.style.display = "none"));
        p.querySelector("#laf-folder").disabled = true;
      } else {
        sbBox.style.display = "none";
        upIds.forEach((id) => { const el = p.querySelector(id); if (el) el.style.display = ""; });
        upLabels.forEach((l) => (l.style.display = "flex"));
      }
    }
    applyPageMode();
    // SPA로 탭 바뀔 수 있으니 URL 변화 감지해서 모드 갱신
    setInterval(() => { if (p.__lastHref !== location.href) { p.__lastHref = location.href; applyPageMode(); } }, 1000);

    // 스토리보드: 안 켜진 "서브" 체크박스 일괄 켜기 (끄지 않음). 라벨 m 범위 필터 옵션.
    async function bulkSubCheck(fromM, toM) {
      const all = [...document.querySelectorAll('input[type="checkbox"]')];
      const needM = (fromM != null || toM != null);
      const targets = all.filter((b) => {
        if (b.checked) return false;
        // 조상을 위로 훑음. "서브"는 가까이, "M5,S4" 라벨은 더 위에 있으므로 멈추지 않고 올라감.
        let ctx = b, hasSub = false, mNum = null;
        for (let k = 0; k < 10 && ctx; k++) {
          ctx = ctx.parentElement;
          if (!ctx) break;
          const txt = norm(ctx.textContent);
          if (txt.includes("서브")) hasSub = true;
          const mm = (txt.match(/m\s*,?\s*(\d+)/) || [])[1];
          if (mm) mNum = +mm;
          if (hasSub && (!needM || mNum != null)) break; // 필요한 정보 다 모으면 멈춤
        }
        if (!hasSub) return false;
        if (needM) {
          if (mNum == null) return false;
          if (fromM != null && mNum < fromM) return false;
          if (toM != null && mNum > toM) return false;
        }
        return true;
      });
      if (!targets.length) { log("켤 서브장면이 없어요 (이미 다 켜졌거나 범위 밖)", "warn"); return; }
      log(`서브장면 ${targets.length}개 켜는 중…`, "info");
      let ok = 0;
      for (const b of targets) {
        try { b.click(); ok++; await sleep(350); }
        catch (e) { log(`  하나 실패: ${String(e).slice(0, 40)}`, "warn"); }
      }
      log(`✅ ${ok}개 서브장면 체크 완료`, "ok");
    }

    p.querySelector("#laf-sb-all").addEventListener("click", () => bulkSubCheck(null, null));
    p.querySelector("#laf-sb-range").addEventListener("click", () => {
      const f = parseInt(p.querySelector("#laf-sb-from").value, 10);
      const t = parseInt(p.querySelector("#laf-sb-to").value, 10);
      bulkSubCheck(isNaN(f) ? null : f, isNaN(t) ? null : t);
    });

    const folderInput = p.querySelector("#laf-folder");
    p.querySelector("#laf-pick").addEventListener("click", () => folderInput.click());
    folderInput.addEventListener("change", () => {
      parsedCache = [...folderInput.files].map(parseFile);
      const tagged = parsedCache.filter((f) => f.tag && f.kind !== "other");
      const imgs = tagged.filter((f) => f.kind === "image").length;
      const vids = tagged.filter((f) => f.kind === "video").length;
      p.querySelector("#laf-summary").innerHTML =
        `파일 ${parsedCache.length}개 중 태그 인식 <b style="color:#34d399">${tagged.length}</b> (이미지 ${imgs} / 영상 ${vids})`;
      const runBtn = p.querySelector("#laf-run");
      runBtn.disabled = !tagged.length;
      runBtn.style.opacity = tagged.length ? "1" : ".5";
      document.getElementById("laf-log").innerHTML = "";
      log(`폴더 읽음: ${parsedCache.length}개`, "ok");
      tagged.slice(0, 12).forEach((f) => log(`  ${f.tag} ← ${f.name}`, "info"));
      const noTag = parsedCache.filter((f) => !f.tag && f.kind !== "other").length;
      if (noTag) log(`태그 없는 파일 ${noTag}개 건너뜀 (파일명에 m1s1 형태 필요)`, "warn");
    });

    p.querySelector("#laf-run").addEventListener("click", () =>
      runFill(parsedCache, p.querySelector("#laf-testone").checked));
    p.querySelector("#laf-stop").addEventListener("click", () => (ABORT = true));
    p.querySelector("#laf-autosub").addEventListener("change", (e) => { AUTO_SUB_CHECK = e.target.checked; });
    p.querySelector("#laf-retry").addEventListener("click", () => {
      const list = LAST_FAILED.slice();
      if (list.length) runFill(parsedCache, false, list);
    });
    p.querySelector("#laf-diag").addEventListener("click", runDiagnostics);

    // 로그 접기/펼치기
    p.querySelector("#laf-log-head").addEventListener("click", () => {
      const logBox = p.querySelector("#laf-log");
      const arrow = p.querySelector("#laf-log-arrow");
      const hidden = logBox.style.display === "none";
      logBox.style.display = hidden ? "block" : "none";
      arrow.textContent = hidden ? "▼" : "▶";
    });
  }

  function boot() {
    if (!/lucystar\.kr/.test(location.host)) return;
    buildPanel();
  }
  document.body ? boot() : window.addEventListener("DOMContentLoaded", boot);
})();
