// ==UserScript==
// @name         LAS 자동 업로드 (폴더 → 라스)
// @namespace    https://local.lars-auto-filler/
// @version      3.9.0
// @description  폴더 한 번 선택하면 파일명 태그(m1s2 등)대로 라스 장면에 이미지/영상 자동 주입. 외부 통신 0건 — 전부 내 브라우저 안에서만 동작.
// @match        https://lucystar.kr/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * ─────────────────────────────────────────────────────────────
 *  v3.2 — 진단 결과 반영판 (기반: 2026-06-12 진단 로그)
 *
 *  ◆ 진단으로 확정된 사실
 *    - URL 구조(2단/롱폼): /episodes/{id}/{board}/m{M}/s{S}
 *    - URL 구조(3단/쇼핑):  /episodes/{id}/{board}/m{M}/s{S}/c{C}
 *    - SPA: 장면 전환 시 새로고침 없이 가운데만 바뀌고 URL만 갱신됨
 *    - 이미지 업로드 입구: input[x-ref="scenePreviewUploadInput"][accept="image/*"]
 *    - "서브장면" 버튼 존재 / mXsY 라벨("M1, S2") 다수
 *    - 영상 드롭존/피커는 이미지보드엔 없음 (비디오보드 전용 — 정상)
 *
 *  ◆ 네비게이션 전략 (★ pushState 폴백 절대 금지 — 가짜 도착→오업로드)
 *    ① 왼쪽 목록의 라벨 텍스트("M1, S2") 클릭 우선. href 없어 전체 새로고침 안 남.
 *    ② 서브장면이 접혀 있으면 "서브장면" 펼침 후 라벨 재시도.
 *    ③ 최후수단으로만 목표 경로 <a> 링크의 "안쪽 자식"을 클릭(전체이동 회피).
 *    → clickUntilArrived 로 앱이 실제로 URL을 바꿨는지 검증. 도착 확인 안 되면
 *      절대 주입하지 않고 그 파일은 실패 처리(오업로드/새로고침 방지).
 *    → 주입 전 previewReady()로 업로드 입구·미리보기 렌더 대기(SPA 렌더 대기).
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
    uploadSettleMs: 1500,    // 주입 후 라스 처리 대기 (워커타이머라 단축)
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
  // 백그라운드 탭에서도 안 느려지는 타이머: Web Worker 의 setTimeout 은 throttle 안 됨.
  let _timerWorker = null, _timerSeq = 0;
  const _timerCbs = {};
  (function initTimerWorker() {
    try {
      const code = "onmessage=function(e){var d=e.data;setTimeout(function(){postMessage(d.id)},d.ms)}";
      const blob = new Blob([code], { type: "application/javascript" });
      _timerWorker = new Worker(URL.createObjectURL(blob));
      _timerWorker.onmessage = (e) => { const cb = _timerCbs[e.data]; if (cb) { delete _timerCbs[e.data]; cb(); } };
    } catch (_) { _timerWorker = null; }
  })();
  const sleep = (ms) => new Promise((r) => {
    if (_timerWorker) { const id = ++_timerSeq; _timerCbs[id] = r; _timerWorker.postMessage({ id, ms }); }
    else { setTimeout(r, ms); }
  });
  const jitter = () => Math.floor(Math.random() * CONFIG.humanJitterMs);
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s,\/]/g, "");

  // 백그라운드 탭 절전 방지: 무음에 가까운 오디오 재생 → 크롬이 탭을 "소리남"으로 보고 안 재움.
  // (gain 너무 작으면 audible 판정 안 돼서 효과 없음 → 들릴락말락 수준으로 약간 키움)
  let _audioCtx = null, _silenceNode = null;
  function keepAwake(on) {
    try {
      if (on) {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (_audioCtx.state === "suspended") _audioCtx.resume();
        if (!_silenceNode) {
          const osc = _audioCtx.createOscillator();
          const gain = _audioCtx.createGain();
          gain.gain.value = 0.003; // 거의 안 들리지만 크롬이 audible 로 인식하는 수준
          osc.frequency.value = 20; // 가청 하한(거의 안 들림)
          osc.connect(gain); gain.connect(_audioCtx.destination);
          osc.start();
          _silenceNode = { osc, gain };
        }
      } else {
        if (_silenceNode) { try { _silenceNode.osc.stop(); } catch (_) {} _silenceNode = null; }
        if (_audioCtx) { try { _audioCtx.suspend(); } catch (_) {} }
      }
    } catch (e) { /* 오디오 차단 환경이면 무시 — 워커 타이머가 주 방어선 */ }
  }

  // 작업 시작 시 로그를 자동으로 펼침(기본 접힘이라 경고를 놓치는 것 방지)
  function openLog() {
    const box = document.getElementById("laf-log");
    const arrow = document.getElementById("laf-log-arrow");
    if (box) box.style.display = "block";
    if (arrow) arrow.textContent = "▼";
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
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter((b) => !b.closest("#laf-panel"));
    for (const box of boxes) {
      // 체크박스에서 위로 최대 10단계 올라가며 라벨(needle)과 "서브" 를 모두 만나는지 확인.
      // ★ 함정: 라벨("M5, S2")과 "서브" 가 다른 가지에 떨어져 있어, needle 이 먼저 나와도
      //   멈추지 말고 "서브" 까지 확인해야 함(스토리보드 bulkSubCheck 와 동일한 10단계 규칙).
      let ctx = box, hasNeedle = false, hasSub = false;
      for (let k = 0; k < 10 && ctx; k++) {
        ctx = ctx.parentElement;
        if (!ctx) break;
        const txt = norm(ctx.textContent);
        if (txt.includes(needle)) hasNeedle = true;
        if (txt.includes("서브")) hasSub = true;
        if (hasNeedle && hasSub) break;
      }
      if (hasNeedle && hasSub) {
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

    const allBoxes = [...document.querySelectorAll('input[type="checkbox"]')].filter((b) => !b.closest("#laf-panel"));
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
          const input = this;
          cleanup(); // setInputFiles 는 input.click() 을 호출하지 않으므로 먼저 원복해도 안전
          // ★ 실제 반영(uploadLanded)까지 확인한 뒤 성공/실패를 정확히 보고 →
          //   미반영이면 false 를 돌려 상위(injectImage)가 다음 방법으로 넘어감
          setInputFiles(input, file)
            .then((ok) => resolve(!!ok))
            .catch(() => resolve(false));
          return; // 실제 파일 선택창 안 띄움
        }
        return orig.apply(this, arguments);
      };
      // 버튼 클릭 → Alpine이 input.click() 호출하도록 유도
      realClick(picker);
      // 타임아웃도 백그라운드 탭에서 안 밀리게 워커 타이머(sleep) 사용
      sleep(1200).then(() => { if (!done) { cleanup(); resolve(false); } });
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
  let _bulkRunning = false;

  async function runFill(parsed, testOne, onlyList) {
    if (RUNNING) return;
    if (_bulkRunning) { log("발음 치환 작업 중에는 업로드를 시작할 수 없어요", "warn"); return; }
    RUNNING = true; ABORT = false;
    openLog(); // 진행/경고 로그가 접혀서 안 보이는 일 방지
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
      "width:340px", "max-height:90vh", "display:flex", "flex-direction:column",
      "background:#0f1117", "color:#e2e8f0",
      "border:1px solid rgba(139,92,246,.4)", "border-radius:12px",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-shadow:0 10px 40px rgba(0,0,0,.5)", "overflow:hidden",
    ].join(";");
    p.innerHTML = `
      <div id="laf-head" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#171a23;cursor:move;border-bottom:1px solid rgba(255,255,255,.06)">
        <span style="font-weight:700;color:#a78bfa">🎬 LAS 자동 업로드</span>
        <span style="margin-left:auto;font-size:11px;color:#64748b">v3.9</span>
        <button id="laf-min" style="background:none;border:0;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1">—</button>
      </div>
      <div id="laf-body" style="padding:12px;display:flex;flex-direction:column;gap:8px;overflow:auto">

        <input id="laf-folder" type="file" webkitdirectory directory multiple style="display:none">
        <button id="laf-pick" style="background:#8b5cf6;color:#fff;border:0;padding:9px;border-radius:8px;font-weight:600;cursor:pointer">📁 폴더 선택</button>
        <div id="laf-summary" style="font-size:12px;color:#94a3b8;min-height:18px"></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer">
          <input id="laf-testone" type="checkbox"> 첫 파일 1개만 (테스트)
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
          <div id="laf-sb-status" style="display:none;text-align:center;font-size:13px;font-weight:700;padding:8px;border-radius:8px"></div>

          <div style="border-top:1px solid rgba(168,139,250,.25);margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:6px">
            <div id="laf-pr-head" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;color:#c4b5fd;font-weight:600">
              <span id="laf-pr-arrow">▶</span><span>🗣️ 발음용(TTS) 단어 치환</span>
            </div>
            <div id="laf-pr-body" style="display:none;flex-direction:column;gap:6px">
              <div style="font-size:11px;color:#94a3b8">① 찾을단어 넣고 <b>🔍 찾기</b>로 장면 이동 → ② 그 장면 <b>라인 편집</b> 펼치고 → ③ <b>치환</b>. 나레이션 원본 불변, 라스가 자동저장.</div>
              <input id="laf-pr-find" type="text" placeholder="찾을단어 (예: 15살)" style="padding:6px 8px;background:#0a0c12;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px">
              <div style="display:flex;gap:6px;align-items:center">
                <button id="laf-pr-find-btn" style="flex:1;background:#2563eb;color:#fff;border:0;padding:7px;border-radius:8px;font-weight:600;cursor:pointer">🔍 찾기 / 다음</button>
                <span id="laf-pr-count" style="font-size:12px;color:#93c5fd;min-width:44px;text-align:center">-</span>
              </div>
              <input id="laf-pr-repl" type="text" placeholder="바꿀단어 (예: 열다섯살)" style="padding:6px 8px;background:#0a0c12;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px">
              <button id="laf-pr-run" style="background:#7c3aed;color:#fff;border:0;padding:8px;border-radius:8px;font-weight:600;cursor:pointer">🗣️ 발음칸 치환 (현재 펼친 것)</button>
              <button id="laf-pr-all" style="background:#dc2626;color:#fff;border:0;padding:8px;border-radius:8px;font-weight:700;cursor:pointer">⚡ 일괄 치환 (자동 펼침)</button>
              <div id="laf-pr-status" style="display:none;align-items:center;justify-content:center;gap:8px;text-align:center;font-size:13px;font-weight:700;padding:8px;border-radius:8px"></div>
              <style>@keyframes lafspin{to{transform:rotate(360deg)}}
                .laf-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:lafspin .8s linear infinite;display:inline-block;flex-shrink:0}</style>
              <div style="font-size:11px;color:#f59e0b">⚡ 일괄은 찾을단어 있는 챕터를 자동으로 펼쳐 치환합니다. 처음엔 테스트 대본에서 확인하세요.</div>
              <button id="laf-pr-closeall" style="background:#475569;color:#fff;border:0;padding:8px;border-radius:8px;font-weight:600;cursor:pointer">📕 일괄 닫기 (천천히 저장 후 접기)</button>
              <div style="font-size:11px;color:#94a3b8">각 챕터를 닫기 전 저장을 넉넉히 기다립니다(느림). 급하면 직접 상단 "닫기"를 쓰세요.</div>
            </div>
          </div>
        </div>

        <div id="laf-log-head" style="display:flex;align-items:center;gap:6px;margin-top:4px;padding:6px 8px;background:#171a23;border-radius:6px;cursor:pointer;user-select:none;font-size:12px;color:#94a3b8">
          <span id="laf-log-arrow">▶</span><span>로그</span>
        </div>
        <div id="laf-log" style="display:none;margin-top:4px;padding:8px;background:#0a0c12;border-radius:8px;height:320px;min-height:320px;overflow:auto;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace"></div>
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
      const all = [...document.querySelectorAll('input[type="checkbox"]')].filter((b) => !b.closest("#laf-panel"));
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
      const setStatus = (msg, kind) => {
        const el = document.getElementById("laf-sb-status");
        if (!el) return;
        const styles = {
          done: "background:rgba(16,185,129,.15);color:#34d399;border:1px solid rgba(16,185,129,.4)",
          working: "background:rgba(124,92,255,.15);color:#c4b5fd;border:1px solid rgba(124,92,255,.4)",
          info: "background:rgba(148,163,184,.12);color:#cbd5e1;border:1px solid rgba(148,163,184,.3)",
        };
        el.style.cssText = "text-align:center;font-size:13px;font-weight:700;padding:8px;border-radius:8px;display:block;" + (styles[kind] || styles.info);
        el.textContent = msg;
      };

      if (!targets.length) {
        // 켤 게 없음 = 이미 다 켜졌다는 뜻 (범위 밖이 아니면 완료로 안내)
        const msg = (fromM != null || toM != null)
          ? "✔ 그 범위엔 켤 서브장면이 없어요 (이미 다 켜짐)"
          : "🎉 모든 서브장면이 이미 켜져 있어요 — 완료!";
        log(msg, "ok");
        setStatus(msg, "done");
        return;
      }
      setStatus(`서브장면 ${targets.length}개 켜는 중…`, "working");
      log(`서브장면 ${targets.length}개 켜는 중…`, "info");
      let ok = 0;
      for (const b of targets) {
        try { b.click(); ok++; await sleep(350); }
        catch (e) { log(`  하나 실패: ${String(e).slice(0, 40)}`, "warn"); }
      }
      log(`✅ ${ok}개 서브장면 체크 완료`, "ok");
      setStatus(`🎉 완료! ${ok}개 서브장면 켰어요`, "done");
    }

    p.querySelector("#laf-sb-all").addEventListener("click", () => bulkSubCheck(null, null));
    p.querySelector("#laf-sb-range").addEventListener("click", () => {
      const f = parseInt(p.querySelector("#laf-sb-from").value, 10);
      const t = parseInt(p.querySelector("#laf-sb-to").value, 10);
      bulkSubCheck(isNaN(f) ? null : f, isNaN(t) ? null : t);
    });

    // ── 스토리보드: 발음용(TTS) 칸에서 특정 단어만 일괄 치환 (안전판) ──
    // 원칙: ① autoSaveDialogueLines 강제 호출 절대 안 함(라스 자체 @input debounce에 맡김)
    //       ② scene 객체 / line.text(나레이션) 절대 안 건드림
    //       ③ 발음칸 textarea DOM 에만 값 세팅 + input 이벤트 → 라스가 알아서 저장
    // 발음칸이 닫혀 있으면 그 라인의 "발음용" 버튼을 실제로 클릭해 라스가 나레이션을 복사해 채우게 함.
    //
    // 발음칸 textarea 판별: Alpine 스코프에 line 이 있고, 그 textarea 가 line.pronunciation_text 바인딩인지
    // (x-model 속성 문자열로 확인). 나레이션 textarea(line.text)는 건드리지 않음.
    function isPronArea(ta) {
      const xm = ta.getAttribute("x-model") || "";
      return /pronunciation_text/.test(xm);
    }
    function isNarrationArea(ta) {
      const xm = ta.getAttribute("x-model") || "";
      // 정확히 line.text 만 (line.pronunciation_text / line.text_xxx 배제)
      return /\bline\.text\b/.test(xm) && !/pronunciation_text/.test(xm);
    }
    // textarea 에 값 넣고 라스(Alpine)가 감지하도록 input 이벤트 발생 (직접 저장 호출 안 함)
    function setAreaValue(ta, val) {
      const proto = Object.getPrototypeOf(ta);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(ta, val); else ta.value = val;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 보이는(펼쳐진) 요소 판별 — x-show 숨김은 DOM에 남으므로 가시성으로 구분 (공용 헬퍼)
    const isVisibleEl = (el) => !!(el && el.offsetParent !== null && el.getClientRects().length);

    // root 를 주면 그 챕터 안만 스캔(일괄 치환의 O(n²) 재스캔 방지). 기본은 문서 전체.
    async function bulkPronReplace(find, repl, root = document) {
      if (!find) { log("찾을단어를 입력하세요", "warn"); return; }

      // 1) 나레이션 textarea 전부 수집 → 찾을단어 있는 라인만 고름
      const narrAreas = [...root.querySelectorAll("textarea")]
        .filter((t) => !t.closest("#laf-panel") && isNarrationArea(t));
      if (!narrAreas.length) { log("나레이션칸을 못 찾았어요 (대본 패널을 열어두세요)", "warn"); return; }

      const targets = narrAreas.filter((t) => String(t.value || "").includes(find));
      if (!targets.length) { log(`"${find}" 가 들어간 나레이션이 없어요`, "warn"); return; }

      log(`대상 ${targets.length}개 — 발음칸 치환 시작 (라스 자동저장에 맡김)`, "info");
      let ok = 0;

      // 발음용 버튼/발음칸 판별 헬퍼 (라스 실제 DOM 기준)
      //  - 발음용 열기 버튼: @click="addPronunciationField(line)"  (x-show="!line.showPronunciation")
      //  - 발음칸 textarea : x-model="line.pronunciation_text"    (x-show="line.showPronunciation")
      const isAddPronBtn = (b) => {
        const c = b.getAttribute("@click") || b.getAttribute("x-on:click") || "";
        return /addPronunciationField/.test(c);
      };

      for (const narr of targets) {
        try {
          // 나레이션 textarea에서 위로 올라가며 "발음용 버튼 또는 발음칸"을 포함하는 조상(=이 라인 카드)을 찾음.
          let card = narr.parentElement;
          for (let k = 0; k < 12 && card; k++) {
            const hasBtn = [...card.querySelectorAll("button")].some(isAddPronBtn);
            const hasPron = [...card.querySelectorAll("textarea")].some(isPronArea);
            if (hasBtn || hasPron) break;
            card = card.parentElement;
          }
          if (!card) card = narr.parentElement;

          // ★ 발음칸은 닫혀 있어도 DOM에 남아있고 x-show 로 숨겨질 뿐 → "보이는" 것만 진짜 열린 것.
          const findVisiblePron = () => [...card.querySelectorAll("textarea")].filter((t) => isPronArea(t) && isVisibleEl(t));
          let pron = findVisiblePron()[0] || null;

          // 보이는 발음칸이 없으면(=닫힘) 발음용 버튼을 눌러 연다
          if (!pron) {
            const btn = [...card.querySelectorAll("button")].find((b) => isAddPronBtn(b) && isVisibleEl(b));
            if (!btn) { log(`  ⚠ 발음용 버튼을 못 찾음 (라인 편집 펼쳤는지 확인)`, "warn"); continue; }
            btn.click();
            const opened = await waitFor(() => findVisiblePron().length > 0, 3000);
            if (!opened) { log(`  ⚠ 발음용 눌렀지만 발음칸이 안 열림 — 건너뜀`, "warn"); continue; }
            pron = findVisiblePron()[0];
          }
          if (!pron) { log("  ⚠ 발음칸을 못 찾음 — 건너뜀", "warn"); continue; }

          // ★ race 방지: 막 연 발음칸은 라스가 나레이션을 복사해 채우는 데 시간차가 있음 →
          //   고정 대기 대신 "값이 채워질 때까지" 폴링(최대 1.5초). 원래 빈 칸이면 타임아웃 후 나레이션 기준.
          await waitFor(() => String(pron.value || "").trim().length > 0, 1500);
          const cur = String(pron.value || "");
          const base = cur.trim() ? cur : String(narr.value || "");
          if (!base.includes(find)) {
            log(`  이미 처리됨/불일치 — 건너뜀 (${base.slice(0, 20)}…)`, "info");
            continue;
          }
          const next = base.split(find).join(repl);
          if (next === cur) { log(`  변화 없음 — 건너뜀`, "info"); continue; }
          setAreaValue(pron, next);                   // 값 세팅 + input 이벤트 (라스가 debounce 저장)
          // ★ 라스의 뒤늦은 복사가 치환값을 덮어쓸 수 있음 → 잠깐 뒤 값 검증, 다르면 1회 재세팅
          await sleep(450);
          if (String(pron.value || "") !== next) {
            setAreaValue(pron, next);
            await sleep(250);
            if (String(pron.value || "") !== next) { log(`  ⚠ 값이 유지 안 됨 — 이 라인 수동 확인 필요`, "warn"); continue; }
          }
          ok++;
          log(`  ✓ "${find}"→"${repl}"  (${String(narr.value).slice(0, 22)}…)`, "ok");
          await sleep(250);
        } catch (e) {
          log(`  하나 실패: ${String(e).slice(0, 40)}`, "warn");
        }
      }
      if (!ok) log(`⚠ 치환된 게 없어요 — 라인 편집을 펼친 상태인지 확인하세요`, "warn");
      else log(`✅ ${ok}개 발음칸 치환 완료 — 라스가 자동저장합니다`, "ok");
      return ok;
    }

    // ── 일괄 치환: 찾을단어가 있는 챕터를 자동으로 펼쳐(startDialogueEdit) 치환하고,
    //    찾을단어가 없던 챕터는 다시 닫음(closeDialogueEdit). 저장은 라스 자동저장에 맡김.
    //    ★ autoSaveDialogueLines 를 직접 부르지 않음(사고 방지) — 오직 라스 버튼 클릭과 input 이벤트만 사용.
    const isEditOpenBtn = (b) => {
      const c = b.getAttribute("@click") || b.getAttribute("x-on:click") || "";
      return /startDialogueEdit/.test(c);
    };
    const isEditCloseBtn = (b) => {
      const c = b.getAttribute("@click") || b.getAttribute("x-on:click") || "";
      return /closeDialogueEdit/.test(c);
    };

    // 일괄 치환 상태 표시 (스피너/완료)
    function setPrStatus(msg, kind) {
      const el = document.getElementById("laf-pr-status");
      if (!el) return;
      if (kind === "hide") { el.style.display = "none"; return; }
      const styles = {
        working: "background:rgba(220,38,38,.15);color:#fca5a5;border:1px solid rgba(220,38,38,.45)",
        done: "background:rgba(16,185,129,.15);color:#34d399;border:1px solid rgba(16,185,129,.45)",
        info: "background:rgba(148,163,184,.12);color:#cbd5e1;border:1px solid rgba(148,163,184,.3)",
      };
      el.style.cssText = "display:flex;align-items:center;justify-content:center;gap:8px;text-align:center;font-size:13px;font-weight:700;padding:8px;border-radius:8px;" + (styles[kind] || styles.info);
      el.innerHTML = (kind === "working" ? '<span class="laf-spin"></span>' : "") + "<span></span>";
      el.lastChild.textContent = msg;
    }

    async function bulkPronReplaceAll(find, repl) {
      if (!find) { log("찾을단어를 입력하세요", "warn"); return; }
      if (_bulkRunning) { log("이미 일괄 처리 중이에요", "warn"); return; }
      _bulkRunning = true;
      const allBtn = document.getElementById("laf-pr-all");
      if (allBtn) { allBtn.disabled = true; allBtn.style.opacity = ".55"; allBtn.style.cursor = "not-allowed"; }
      setPrStatus("작업 중… 챕터 찾는 중", "working");
      try {
        // 1) 화면에 보이는 "라인 편집(펼치기)" 버튼 = 아직 안 펼친 챕터들
        const openBtns = [...document.querySelectorAll("button")].filter((b) => isEditOpenBtn(b) && isVisibleEl(b));

        // 2) ★ 펼치기 전에 각 챕터의 요약 나레이션(x-text="line.text")을 먼저 읽어
        //    찾을단어가 있는 챕터만 골라 펼친다(없는 챕터는 아예 안 건드림 → 닫기 로직 불필요).
        const chaptersToOpen = [];
        for (const openBtn of openBtns) {
          // 이 버튼에서 위로 올라가 요약 나레이션(x-text="line.text")을 품은 챕터 컨테이너를 찾음
          let box = openBtn.parentElement;
          for (let k = 0; k < 15 && box; k++) {
            if (box.querySelector('[x-text="line.text"]')) break;
            box = box.parentElement;
          }
          if (!box) continue;
          const hit = [...box.querySelectorAll('[x-text="line.text"]')]
            .some((el) => (el.textContent || "").includes(find));
          if (hit) chaptersToOpen.push({ openBtn, box }); // ★ box 도 저장 → 그 챕터만 스캔
        }

        log(`찾을단어 있는 챕터 ${chaptersToOpen.length}개만 펼쳐서 치환합니다`, "info");
        if (!chaptersToOpen.length) {
          log(`"${find}" 가 든 챕터가 없어요 (요약 나레이션 기준)`, "warn");
          setPrStatus(`"${find}" 가 든 챕터가 없어요`, "info");
          return;
        }

        // 3) 해당 챕터만 펼쳐서 치환 (펼친 채로 둠)
        let totalOk = 0, touchedChapters = 0;
        for (const { openBtn, box } of chaptersToOpen) {
          if (!isVisibleEl(openBtn)) continue;   // 이미 펼쳐졌으면 스킵
          setPrStatus(`작업 중… ${touchedChapters + 1}/${chaptersToOpen.length} 챕터`, "working");
          openBtn.click();
          // ★ 이 챕터(box) 안에서 나레이션 textarea 가 보일 때까지 대기 → 문서 전체 오탐 방지
          await waitFor(() => box.isConnected && [...box.querySelectorAll("textarea")].some((t) => isNarrationArea(t) && isVisibleEl(t)), 3000);
          await sleep(400);
          // 펼침 재렌더로 box 가 DOM에서 떨어졌으면(드묾) 문서 전체로 폴백 — includes 가드가 있어 안전
          const scanRoot = box.isConnected ? box : document;
          const ok = await bulkPronReplace(find, repl, scanRoot); // ★ 이 챕터만 스캔 (O(n²)·로그도배 해소)
          totalOk += (ok || 0);
          touchedChapters++;
        }
        log(`⚡ 일괄 완료 — ${touchedChapters}개 챕터에서 ${totalOk}개 치환. 펼쳐진 챕터를 눈으로 확인하세요.`, "ok");
        setPrStatus(`🎉 완료! ${touchedChapters}개 챕터 · ${totalOk}개 치환`, "done");
      } catch (e) {
        log(`일괄 처리 오류: ${String(e).slice(0, 50)}`, "err");
        setPrStatus(`⚠ 오류: ${String(e).slice(0, 30)}`, "info");
      } finally {
        _bulkRunning = false;
        if (allBtn) { allBtn.disabled = false; allBtn.style.opacity = "1"; allBtn.style.cursor = "pointer"; }
      }
    }

    // ── 찾기: 요약 화면의 나레이션에서 찾을단어가 있는 장면으로 스크롤 순회 (읽기 전용, 안전) ──
    // 대본이 접힌(요약) 상태에선 나레이션이 textarea 가 아니라 텍스트 요소로만 보임.
    // 그 텍스트 요소들을 찾아 하나씩 스크롤 이동 + 개수 표시. 아무것도 수정하지 않음.
    let _findState = { key: "", idx: -1 }; // list 는 매번 재수집하므로 저장 안 함
    function collectNarrationNodes(find) {
      // 나레이션만 정확히 잡는다. 라스 나레이션 표식은 x-text/x-model="line.text".
      //   요약 상태: <p x-text="line.text">…</p>
      //   펼침 상태: <textarea x-model="line.text">
      // 이미지/모션 프롬프트는 line.text 가 아니라 잡히지 않음(개수 정확).
      const out = [];
      for (const el of document.querySelectorAll('[x-text="line.text"], [x-model="line.text"]')) {
        if (el.closest("#laf-panel")) continue;
        const txt = el.tagName === "TEXTAREA" ? String(el.value || "") : (el.textContent || "");
        if (txt.includes(find)) out.push(el);
      }
      return out;
    }
    function doFind(find) {
      if (!find) { log("찾을단어를 입력하세요", "warn"); return; }
      const cnt = p.querySelector("#laf-pr-count");
      // ★ 매번 새로 수집 (요소가 재생성돼도 항상 현재 DOM 기준). 화면 위→아래 순서로 정렬.
      let list = collectNarrationNodes(find).filter((el) => el.getClientRects().length > 0);
      list.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.top - rb.top) || (ra.left - rb.left);
      });
      if (!list.length) {
        if (cnt) cnt.textContent = "0개";
        log(`"${find}" 못 찾음`, "warn");
        _findState = { key: find, idx: -1 };
        return;
      }
      // 검색어가 바뀌었으면 처음부터, 같으면 다음 순번으로
      let nextIdx = 0;
      if (_findState.key === find) nextIdx = (_findState.idx + 1) % list.length;
      _findState = { key: find, idx: nextIdx };
      const el = list[nextIdx];
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // 잠깐 노란 테두리로 강조 (스타일만, 원복)
      const prev = el.style.outline;
      el.style.outline = "3px solid #fbbf24";
      el.style.outlineOffset = "2px";
      setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = ""; }, 1800);
      if (cnt) cnt.textContent = `${nextIdx + 1}/${list.length}`;
      log(`🔍 "${find}" ${nextIdx + 1}/${list.length} 로 이동 — 라인 편집 펼치고 치환하세요`, "info");
    }
    p.querySelector("#laf-pr-find-btn").addEventListener("click", () => {
      doFind(p.querySelector("#laf-pr-find").value.trim());
    });
    // 치환 버튼(단일/일괄) 활성·비활성.
    //  - 찾을단어: trim 기준으로 비어 있으면 비활성(공백만으론 찾을 대상이 없음).
    //  - 바꿀단어: "완전히 빈 문자열"일 때만 비활성. ★ 스페이스만 입력은 유효(단어를 공백으로 지우는 삭제용).
    function updatePrButtons() {
      const find = p.querySelector("#laf-pr-find").value.trim();
      const repl = p.querySelector("#laf-pr-repl").value;   // trim 하지 않음(공백도 유효)
      const disabled = find.length === 0 || repl.length === 0;
      ["#laf-pr-run", "#laf-pr-all"].forEach((id) => {
        const b = p.querySelector(id);
        if (!b) return;
        b.disabled = disabled;
        b.style.opacity = disabled ? "0.45" : "1";
        b.style.cursor = disabled ? "not-allowed" : "pointer";
      });
    }

    // 찾을단어를 고치면 순회 상태 리셋 + 바꿀단어 칸 초기화(빈칸) + 버튼 상태 갱신
    p.querySelector("#laf-pr-find").addEventListener("input", () => {
      _findState = { key: "", idx: -1 };
      const cnt = p.querySelector("#laf-pr-count"); if (cnt) cnt.textContent = "-";
      const repl = p.querySelector("#laf-pr-repl"); if (repl) repl.value = "";
      updatePrButtons();
    });
    p.querySelector("#laf-pr-repl").addEventListener("input", updatePrButtons);
    updatePrButtons(); // 초기 상태(두 칸 다 빈 칸 → 비활성)

    // ★ find 는 trim(찾기와 동일 기준 — 공백 붙으면 "찾기는 되는데 치환 0개" 미스터리 방지).
    //   repl 은 의도적 공백 치환 가능성 때문에 원문 유지.
    p.querySelector("#laf-pr-run").addEventListener("click", async () => {
      const f = p.querySelector("#laf-pr-find").value.trim();
      const r = p.querySelector("#laf-pr-repl").value;
      if (RUNNING) { log("업로드 실행 중에는 치환할 수 없어요", "warn"); return; }
      if (_bulkRunning) { log("이미 치환 작업 중이에요 — 끝날 때까지 기다려주세요", "warn"); return; }
      _bulkRunning = true;                 // ★ 연타 방지 (단독 치환도 잠금)
      openLog();
      try { await bulkPronReplace(f, r); }
      finally { _bulkRunning = false; }
    });
    p.querySelector("#laf-pr-all").addEventListener("click", () => {
      const f = p.querySelector("#laf-pr-find").value.trim();
      const r = p.querySelector("#laf-pr-repl").value;
      if (RUNNING) { log("업로드 실행 중에는 치환할 수 없어요", "warn"); return; }
      openLog();
      bulkPronReplaceAll(f, r);            // 내부에서 _bulkRunning 잠금
    });
    p.querySelector("#laf-pr-closeall").addEventListener("click", async () => {
      // ★ 라스 자동저장은 debounce 1초. 저장 전에 닫으면 편집분이 날아감 →
      //   닫기 전 넉넉히(2.5초) 기다려 저장이 확실히 끝난 뒤 한 챕터씩 닫는다.
      if (_bulkRunning) { log("치환/닫기 작업 중이에요 — 끝날 때까지 기다려주세요", "warn"); return; }
      _bulkRunning = true;   // ★ 연타 시 병렬 루프가 저장대기를 무력화하는 것 방지
      openLog();
      try {
      let n = 0;
      log("저장 대기 중… (안전하게 천천히 닫습니다)", "info");
      await sleep(2500);
      for (let round = 0; round < 40; round++) {
        const btn = [...document.querySelectorAll("button")].find((b) => isEditCloseBtn(b) && isVisibleEl(b));
        if (!btn) break;
        btn.click();
        n++;
        log(`  📕 ${n}개째 닫음 (저장 대기)`, "info");
        await sleep(2500);
      }
      log(n ? `📕 총 ${n}개 챕터 닫음` : "닫을 펼친 챕터가 없어요", n ? "ok" : "warn");
      } finally { _bulkRunning = false; }
    });

    // 발음용 치환 섹션 접기/펼치기 (기본 접힘)
    p.querySelector("#laf-pr-head").addEventListener("click", () => {
      const body = p.querySelector("#laf-pr-body");
      const arrow = p.querySelector("#laf-pr-arrow");
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "flex" : "none";
      arrow.textContent = hidden ? "▼" : "▶";
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
