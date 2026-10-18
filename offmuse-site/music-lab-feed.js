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
      for (const v of song.versions) {
        const panel = elt("div", "music-version");
        panel.appendChild(elt("span", "music-version-letter", v.version));
        const a = elt("a", "music-version-link", "Suno 듣기 ↗");
        a.href = v.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", song.title + " 버전 " + v.version + " Suno에서 듣기");
        panel.appendChild(a);
        grid.appendChild(panel);
      }
      card.appendChild(grid);
      card.appendChild(elt("p", "music-status", "음원을 감상할 수 있습니다. 선호도 투표는 별도 연결 준비 중입니다."));
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
  refresh();
  window.setInterval(function () {
    if (!document.hidden) refresh();
  }, POLL_MS);
})();