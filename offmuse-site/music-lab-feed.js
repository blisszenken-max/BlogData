/* OFFMUSE public-music-sheet reader. No Apps Script, OAuth, redeployment, or API key required.
   This file fetches only the separately shared public spreadsheet of song titles, versions and Suno URLs.
   The administrator's private votes workbook is never queried or exposed. */
(function () {
  "use strict";
  const SOURCE_ID = "1uadQq-jlwisxFfoaNIzcl8-ERe0aAMj3mcPRM0l67VU";
  const TAB_ID = "684744840";
  const ROOT_ID = "music-lab-fallback";
  const CALL = "OFFMUSE_MUSIC_SHEET_RECEIVE";
  const TIMEOUT_MS = 12000;
  const POLL_MS = 60000;
  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  let lastSig = "";
  let requestedAt = 0;
  let loaded = false;
  let lastSongs = [];
  let waitTimer = null;
  let pendingScript = null;

  function cleanText(input, max) {
    return String(input == null ? "" : input).trim().slice(0, max);
  }
  function songUrl(raw) {
    const str = cleanText(raw, 500);
    try {
      const u = new URL(str);
      if (u.protocol !== "https:" || !["suno.com", "www.suno.com"].includes(u.hostname)) return "";
      if (!/^\/(?:s|song)\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname)) return "";
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (_) { return ""; }
  }
  function cell(row, i) {
    const x = (row && row.c) || [];
    const v = x[i];
    return v && v.v !== undefined && v.v !== null ? v.v : "";
  }
  function listFromSheet(data) {
    if (!data || data.status !== "ok" || !data.table || !Array.isArray(data.table.rows)) {
      throw new Error("Invalid Google Sheet data");
    }
    const bySong = new Map();
    for (const row of data.table.rows) {
      const id = cleanText(cell(row, 0), 80);
      const title = cleanText(cell(row, 1), 100);
      const version = cleanText(cell(row, 2), 24);
      const url = songUrl(cell(row, 3));
      const enabled = cleanText(cell(row, 4), 20);
      const songOrder = Number(cell(row, 5)) || 9999;
      const versionOrder = Number(cell(row, 6)) || 9999;
      const desc = cleanText(cell(row, 7), 150);
      if (!id || !title || !version || !url || enabled !== "표시") continue;
      if (!bySong.has(id)) bySong.set(id, { id, title, desc, order: songOrder, versions: [], labels: new Set() });
      const entry = bySong.get(id);
      if (entry.labels.has(version)) continue;
      entry.labels.add(version);
      entry.versions.push({ version, url, order: versionOrder });
    }
    const songs = [...bySong.values()].filter(x => x.versions.length >= 2);
    for (const song of songs) song.versions.sort((a, b) => a.order - b.order || a.version.localeCompare(b.version));
    songs.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "ko"));
    return songs;
  }
  function elt(tag, cls, content) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (content !== undefined) e.textContent = content;
    return e;
  }
  function attachVote(vote, songId, version, status) {
    vote.disabled = false;
    vote.addEventListener("click", async function () {
      vote.disabled = true;
      status.textContent = "좋아요를 기록하고 있습니다…";
      try {
        let saved = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch("/api/vote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ songId, version })
          });
          const result = await response.json();
          if (response.ok && result.ok === true && result.stored === true) {
            saved = true;
            break;
          }
          // Retry only when the server confirms no write took place.
          if (attempt === 0 && result.code === "MUSIC_LIST_UNAVAILABLE") continue;
          const reason = {
            INVALID_SELECTION: "등록된 버전 확인 실패",
            MUSIC_LIST_UNAVAILABLE: "음악목록 연결 실패",
            VOTE_STORE_UNAVAILABLE: "저장소 연결 실패",
            VOTING_NOT_READY: "저장소 준비 중"
          }[result.code] || "서버 응답 오류";
          throw new Error(reason + (result.code ? " (" + result.code + ")" : ""));
        }
        if (!saved) throw new Error("음악목록 연결 실패");
        status.textContent = "버전 " + version + "에 좋아요를 보냈습니다. 다시 눌러도 됩니다.";
        vote.classList.add("is-liked");
      } catch (error) {
        status.textContent = "버전 " + version + " 좋아요 저장 실패: " + (error.message || "네트워크 오류") + ". 잠시 후 다시 시도해 주세요.";
      } finally {
        vote.disabled = false;
      }
    });

  }
  function newVote(songId, version, title, status) {
    const vote = elt("button", "music-version-vote");
    vote.type = "button";
    vote.title = "좋아요 · " + version + " 버전";
    vote.setAttribute("aria-label", title + " 버전 " + version + " 좋아요 누르기");
    vote.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
    attachVote(vote, songId, version, status);
    return vote;
  }
  function activateFallback() {
    const card = root.querySelector(".music-song");
    if (!card) return;
    const status = card.querySelector(".music-status");
    const title = card.querySelector("h3")?.textContent?.trim() || "음악";
    for (const versionCard of card.querySelectorAll(".music-version")) {
      const link = versionCard.querySelector("a.music-version-letter");
      const actions = versionCard.querySelector(".music-version-actions");
      if (!link || !actions) continue;
      const version = link.textContent.trim();
      if (!/^[A-D]$/.test(version)) continue;
      let vote = actions.querySelector(".music-version-vote");
      if (vote) attachVote(vote, "s10-1", version, status);
      else actions.appendChild(newVote("s10-1", version, title, status));
    }
    if (status) status.textContent = "A · B · C · D를 눌러 듣고, 마음에 들면 👍를 눌러주세요.";
  }

  function draw(songs) {
    const frag = document.createDocumentFragment();
    if (!songs.length) {
      const empty = elt("p", "music-status", "현재 공개된 비교 음원이 없습니다. 새 곡이 등록되면 이곳에 표시됩니다.");
      frag.appendChild(empty);
    }
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const card = elt("article", "music-song");
      const top = elt("div", "music-song-top");
      const left = elt("div");
      left.appendChild(elt("span", "music-song-num", "SONG " + String(i + 1).padStart(2, "0")));
      left.appendChild(elt("h3", "", song.title));
      top.appendChild(left);
      top.appendChild(elt("span", "music-song-count", song.versions.length + "개 버전"));
      card.appendChild(top);
      if (song.desc) card.appendChild(elt("p", "music-lab-desc", song.desc));
      const grid = elt("div", "music-versions");
      const status = elt("p", "music-status", "A · B · C 등을 눌러 음악을 듣고, 마음에 들면 👍를 눌러주세요.");
      status.setAttribute("role","status");
      status.setAttribute("aria-live","polite");
      for (const v of song.versions) {
        const panel = elt("div", "music-version");
        const actions = elt("div", "music-version-actions");
        const a = elt("a", "music-version-letter", v.version);
        a.href = v.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = "버전 " + v.version + " 듣기";
        a.setAttribute("aria-label", song.title + " 버전 " + v.version + " 음악 듣기 (새 창)");
        actions.appendChild(a);
        actions.appendChild(newVote(song.id, v.version, song.title, status));
        panel.appendChild(actions);
        grid.appendChild(panel);
      }
      card.appendChild(grid);
      card.appendChild(status);
      frag.appendChild(card);
    }
    root.replaceChildren(frag);
  }
  window[CALL] = function (payload) {
    clearTimeout(waitTimer);
    if (pendingScript && pendingScript.parentNode) pendingScript.remove();
    pendingScript = null;
    try {
      const songs = listFromSheet(payload);
      const signature = JSON.stringify(songs.map(x => [x.id, x.title, x.desc, x.order, x.versions]));
      lastSongs = songs;
      if (!loaded || signature !== lastSig) { draw(songs); lastSig = signature; }
      loaded = true;
      root.setAttribute("data-source", "live-google-sheet");
    } catch (e) {
      if (!loaded) root.setAttribute("data-source", "initial-snapshot");
    }
  };
  function refresh() {
    if (pendingScript) return;
    const script = document.createElement("script");
    requestedAt = Date.now();
    const options = "out:json;responseHandler:" + CALL;
    script.src = "https://docs.google.com/spreadsheets/d/" + SOURCE_ID +
      "/gviz/tq?gid=" + encodeURIComponent(TAB_ID) +
      "&headers=1&range=" + encodeURIComponent("A2:H1000") +
      "&tqx=" + encodeURIComponent(options) +
      "&tq=" + encodeURIComponent("select *") +
      "&_=" + requestedAt;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onerror = function () {
      clearTimeout(waitTimer);
      if (script.parentNode) script.remove();
      if (pendingScript === script) pendingScript = null;
    };
    pendingScript = script;
    document.head.appendChild(script);
    waitTimer = setTimeout(function () {
      if (pendingScript === script) {
        if (script.parentNode) script.remove();
        pendingScript = null;
      }
    }, TIMEOUT_MS);
  }
  activateFallback();
  refresh();
  window.setInterval(function () {
    if (!document.hidden) refresh();
  }, POLL_MS);
})();