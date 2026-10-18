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
  let votingEnabled = false;
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
      const status = elt("p", "music-status", votingEnabled ? "마음에 남는 버전에 👍를 눌러주세요. 여러 번 누를 수 있습니다." : "음원을 감상할 수 있습니다. 좋아요 기능은 연결 준비 중입니다.");
      status.setAttribute("role","status");
      status.setAttribute("aria-live","polite");
      for (const v of song.versions) {
        const panel = elt("div", "music-version");
        panel.appendChild(elt("span", "music-version-letter", v.version));
        const actions = elt("div", "music-version-actions");
        const a = elt("a", "music-version-link", "Suno 듣기 ↗");
        a.href = v.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", song.title + " 버전 " + v.version + " Suno에서 듣기");
        actions.appendChild(a);
        if (votingEnabled) {
          const vote = elt("button", "music-version-vote");
          vote.type = "button";
          vote.title = "좋아요 · " + v.version + " 버전";
          vote.setAttribute("aria-label", song.title + " 버전 " + v.version + " 좋아요 누르기");
          vote.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
          vote.addEventListener("click", async function () {
            vote.disabled = true;
            status.textContent = "좋아요를 기록하고 있습니다…";
            try {
              const response = await fetch("/api/vote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ songId: song.id, version: v.version })
              });
              const result = await response.json();
              if (!response.ok || result.ok !== true || result.stored !== true) {
                throw new Error("Vote not saved");
              }
              status.textContent = "버전 " + v.version + "에 좋아요를 보냈습니다. 다시 눌러도 됩니다.";
              vote.classList.add("is-liked");
            } catch (_) {
              status.textContent = "좋아요를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";
            } finally {
              vote.disabled = false;
            }
          });
          actions.appendChild(vote);
        }
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
  async function checkVoteStatus() {
    let enabled = false;
    try {
      const response = await fetch("/api/vote", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        enabled = data.ok === true && data.enabled === true;
      }
    } catch (_) {}
    if (enabled !== votingEnabled) {
      votingEnabled = enabled;
      if (loaded) {
        draw(lastSongs);
        lastSig = "";
      }
    }
  }
  refresh();
  checkVoteStatus();
  window.setInterval(function () {
    checkVoteStatus();
    if (!document.hidden) refresh();
  }, POLL_MS);
})();