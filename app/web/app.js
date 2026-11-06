/* GitHub 下载器 —— 前端逻辑（原生 JS，无需构建） */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const app = {
  view: "search",
  settings: { token_set: false },
  tasks: [],
  library: [],
  search: { q: "", sort: "stars", page: 1, items: [], hasMore: false, busy: false },
  modal: { repoId: "", displayName: "", tag: "", releases: [], files: [], selected: new Set(), busy: false },
  taskNodes: new Map(),
  knownStatus: new Map(),
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n <= 0) return "未知大小";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

function fmtSpeed(n) {
  if (!n || n <= 0) return "—";
  return fmtBytes(n) + "/s";
}

function fmtEta(seconds) {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${(seconds / 3600).toFixed(1)} 小时`;
}

function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  return String(n);
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function toast(message, type = "") {
  const box = document.createElement("div");
  box.className = "toast" + (type ? " " + type : "");
  box.textContent = message;
  $("#toasts").appendChild(box);
  setTimeout(() => {
    box.style.transition = "opacity .3s";
    box.style.opacity = "0";
    setTimeout(() => box.remove(), 320);
  }, type === "err" ? 6000 : 3200);
}

async function api(path, options = {}) {
  const config = { headers: { "Content-Type": "application/json" }, ...options };
  try {
    const response = await fetch(path, config);
    return await response.json();
  } catch (err) {
    return { ok: false, error: "连不上本地服务，程序可能已经关闭。请重新双击「启动下载器」。" };
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("路径已复制", "ok");
  } catch (err) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast("路径已复制", "ok");
  }
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */
function switchView(name) {
  if (!["search", "tasks", "library", "settings"].includes(name)) name = "search";
  app.view = name;
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === "view-" + name));
  if (name === "library") loadLibrary(true);
  if (name === "settings") loadSettings();
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */
function normalizeRepoId(text) {
  let value = (text || "").trim();
  const lower = value.toLowerCase();
  if (lower.includes("github.com")) {
    value = value.slice(lower.indexOf("github.com") + "github.com".length);
  }
  value = value.split("?")[0].split("#")[0].replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = value.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
}

function isRepoIdLike(text) {
  const value = (text || "").trim();
  if (!value) return false;
  if (value.toLowerCase().includes("github.com")) return true;
  return /^[\w.\-]+\/[\w.\-]+$/.test(value);
}

async function doSearch(reset = true) {
  const raw = $("#search-input").value.trim();
  if (isRepoIdLike(raw)) {
    const repoId = normalizeRepoId(raw);
    if (!repoId) { toast("这个链接认不出来，请用「作者/仓库名」的格式", "err"); return; }
    openDownloadDialog(repoId, repoId.split("/")[1]);
    return;
  }
  if (app.search.busy) return;
  app.search.busy = true;
  if (reset) {
    app.search.page = 1;
    app.search.q = raw;
    app.search.items = [];
    $("#search-results").innerHTML = `<div class="card muted">正在搜索…</div>`;
  }
  app.search.sort = $("#search-sort").value;
  const data = await api(`/api/search?q=${encodeURIComponent(app.search.q)}&page=${app.search.page}&size=12&sort=${app.search.sort}`);
  app.search.busy = false;

  const hint = $("#search-hint");
  if (!data.ok) {
    hint.classList.remove("hidden");
    hint.textContent = data.error || "搜索失败，请稍后再试";
    $("#search-results").innerHTML = "";
    $("#load-more").classList.add("hidden");
    return;
  }
  hint.classList.add("hidden");
  app.search.items = app.search.items.concat(data.items || []);
  app.search.hasMore = !!data.has_more;
  setResultHead(app.search.q ? `搜索「${app.search.q}」` : "热门仓库", `${app.search.items.length} 个结果`);
  renderSearch();
}

async function loadFeatured() {
  if (app.search.items.length) return;
  const data = await api(`/api/search?q=&size=12&sort=stars`);
  if (!data.ok) return;
  app.search.items = data.items || [];
  app.search.page = 1;
  app.search.hasMore = false;
  if (!app.search.items.length) return;
  setResultHead("热门仓库", "按星标数排序");
  renderSearch();
}

function setResultHead(title, sub) {
  const head = $("#result-head");
  if (!title) { head.classList.add("hidden"); return; }
  head.classList.remove("hidden");
  $("#result-title").textContent = title;
  $("#result-sub").textContent = sub || "";
}

function renderSearch() {
  const box = $("#search-results");
  if (!app.search.items.length) {
    box.innerHTML = `<div class="card"><h3>没搜到结果</h3><p class="muted small" style="margin-top:6px">换个关键词，或直接粘贴仓库链接。</p></div>`;
    $("#load-more").classList.add("hidden");
    return;
  }
  box.innerHTML = app.search.items.map((item, index) => `
    <article class="card model-card">
      <h3>${esc(item.repo_id)}</h3>
      <div class="repo-id">${esc(item.owner || "")}</div>
      <p class="desc">${esc(item.description || "这个仓库没有写简介。")}</p>
      <div class="meta-row">
        <span>星标 <b>${fmtCount(item.stars)}</b></span>
        <span>复刻 <b>${fmtCount(item.forks)}</b></span>
        ${item.language ? `<span>语言 <b>${esc(item.language)}</b></span>` : ""}
        ${item.license ? `<span>许可 <b>${esc(item.license)}</b></span>` : ""}
      </div>
      <div class="card-actions">
        <button class="btn primary small" data-download="${index}">看 Release</button>
        <button class="btn ghost small" data-open="${index}">打开主页</button>
      </div>
    </article>
  `).join("");
  $("#load-more").classList.toggle("hidden", !app.search.hasMore);
}

/* ------------------------------------------------------------------ */
/* 下载弹窗                                                            */
/* ------------------------------------------------------------------ */
async function openDownloadDialog(repoId, displayName) {
  app.modal = { repoId, displayName: displayName || repoId, tag: "", releases: [],
                files: [], selected: new Set(), busy: true };
  $("#modal").classList.remove("hidden");
  $("#modal-title").textContent = displayName || repoId;
  $("#modal-sub").textContent = repoId;
  $("#modal-files").innerHTML = `<div class="muted small pad">正在读取 Release…</div>`;
  $("#modal-summary").textContent = "";
  $("#modal-start").disabled = true;
  await loadReleases();
}

async function loadReleases() {
  const { repoId } = app.modal;
  $("#modal-files").innerHTML = `<div class="muted small pad">正在读取 Release…</div>`;
  const data = await api(`/api/releases?repo_id=${encodeURIComponent(repoId)}`);
  if (!data.ok) {
    $("#modal-files").innerHTML = `<div class="muted small pad">${esc(data.error || "读取失败")}</div>`;
    return;
  }
  app.modal.releases = data.releases || [];
  const select = $("#modal-release");
  if (!app.modal.releases.length) {
    select.innerHTML = `<option value="">（这个仓库没有 Release）</option>`;
    $("#modal-files").innerHTML = `<div class="muted small pad">没有 Release。下拉框里仍可选「源码压缩包」。</div>`;
  } else {
    select.innerHTML = app.modal.releases.map((rel) =>
      `<option value="${esc(rel.tag)}">${esc(rel.tag)}${rel.prerelease ? "（预发布）" : ""}</option>`
    ).join("");
  }
  const first = app.modal.releases.find((r) => !r.prerelease) || app.modal.releases[0];
  app.modal.tag = first ? first.tag : "";
  if (first) select.value = first.tag;
  app.modal.busy = false;
  buildFileList();
}

function currentRelease() {
  return app.modal.releases.find((rel) => rel.tag === app.modal.tag) || null;
}

function buildFileList() {
  const rel = currentRelease();
  const files = [];
  if (rel) {
    rel.assets.forEach((asset) => {
      files.push({ name: asset.name, size: asset.size, url: asset.url, resumable: true, kind: "asset" });
    });
  }
  // 源码压缩包：始终作为可选项，不支持断点续传
  const tag = app.modal.tag || "HEAD";
  files.push({
    name: `${app.modal.repoId.split("/")[1]}-${tag}.zip`,
    size: 0,
    url: `https://codeload.github.com/${app.modal.repoId}/zip/${tag}`,
    resumable: false,
    kind: "source",
  });
  app.modal.files = files;
  app.modal.selected = new Set(files.filter((f) => f.kind === "asset").map((f) => f.name));
  renderModalFiles();
}

function renderModalFiles() {
  const { files, selected } = app.modal;
  $("#modal-files").innerHTML = files.map((file) => `
    <label class="file-row">
      <input type="checkbox" data-path="${esc(file.name)}" ${selected.has(file.name) ? "checked" : ""}>
      <span class="fname">${esc(file.name)}${file.kind === "source" ? "　（源码包，不支持续传）" : ""}</span>
      <span class="fsize">${file.size ? fmtBytes(file.size) : "未知大小"}</span>
    </label>
  `).join("");
  const assetCount = files.filter((f) => f.kind === "asset").length;
  $("#modal-file-count").textContent = assetCount ? `(资源 ${assetCount} 个)` : "(无 Release 资源)";
  updateModalSummary();
}

function updateModalSummary() {
  const { files, selected } = app.modal;
  let size = 0;
  let count = 0;
  files.forEach((file) => {
    if (selected.has(file.name)) { size += Number(file.size) || 0; count += 1; }
  });
  $("#modal-summary").innerHTML = `已选 <b>${count}</b> 个文件，合计 <b>${fmtBytes(size)}</b>`;
  $("#modal-start").disabled = count === 0 || app.modal.busy;
}

function pickFiles(kind) {
  const { files } = app.modal;
  if (kind === "all") app.modal.selected = new Set(files.map((f) => f.name));
  else if (kind === "none") app.modal.selected = new Set();
  else if (kind === "src") {
    const src = files.find((f) => f.kind === "source");
    if (src) app.modal.selected.add(src.name);
  } else if (kind === "win") {
    app.modal.selected = new Set(files
      .filter((f) => /windows|win32|win64|win_|\.exe$|\.msi$/i.test(f.name))
      .map((f) => f.name));
  }
  renderModalFiles();
}

async function startDownload() {
  const { repoId, tag, files, selected, displayName } = app.modal;
  if (!selected.size) { toast("至少选一个文件"); return; }
  const payload = {
    repo_id: repoId,
    revision: tag || "latest",
    display_name: displayName,
    files: files.filter((f) => selected.has(f.name)).map((f) => ({
      path: f.name, size: f.size, url: f.url, resumable: f.resumable,
    })),
  };
  $("#modal-start").disabled = true;
  const data = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
  $("#modal-start").disabled = false;
  if (!data.ok) { toast(data.error || "创建任务失败", "err"); return; }
  $("#modal").classList.add("hidden");
  toast("已经加入下载队列", "ok");
  switchView("tasks");
  pollState();
}

/* ------------------------------------------------------------------ */
/* 任务列表                                                            */
/* ------------------------------------------------------------------ */
function buildTaskNode(task) {
  const node = document.createElement("article");
  node.className = "card task";
  node.dataset.id = task.id;
  node.innerHTML = `
    <div class="task-top">
      <div>
        <div class="task-title"><h3></h3><span class="status"></span></div>
        <div class="repo-id" style="margin-top:4px"></div>
      </div>
      <div class="muted small target"></div>
    </div>
    <div class="progress-wrap">
      <div class="progress"><div class="progress-bar"></div></div>
      <div class="progress-line"><span class="stat-left"></span><span class="stat-right"></span></div>
    </div>
    <div class="task-error hidden"></div>
    <div class="task-actions"></div>
  `;
  node._refs = {
    title: $("h3", node), status: $(".status", node), repo: $(".repo-id", node),
    target: $(".target", node), bar: $(".progress-bar", node),
    left: $(".stat-left", node), right: $(".stat-right", node),
    error: $(".task-error", node), actions: $(".task-actions", node),
  };
  return node;
}

function actionButton(label, action, style = "ghost") {
  return `<button class="btn ${style} small" data-action="${action}">${label}</button>`;
}

function updateTaskNode(node, task) {
  const refs = node._refs;
  refs.title.textContent = task.display_name || task.repo_id;
  refs.repo.textContent = `${task.repo_id} @ ${task.revision || "latest"}`;
  refs.target.textContent = task.local_dir || "";

  const key = task.status === "running" || task.status === "queued" ? "running"
    : task.status === "done" ? "done"
    : task.status === "error" ? "error"
    : task.status === "paused" || task.status === "pausing" ? "paused" : "";
  refs.status.className = "status " + key;
  refs.status.textContent = task.status_text || task.status;

  const percent = Math.max(0, Math.min(100, Number(task.percent) || 0));
  refs.bar.style.width = percent + "%";
  refs.bar.className = "progress-bar " + key;

  refs.left.innerHTML = `<b>${percent.toFixed(1)}%</b> · ${fmtBytes(task.bytes_done)} / ${fmtBytes(task.bytes_total)}`
    + `${task.total_files ? ` · ${task.files_done || 0}/${task.total_files} 个文件` : ""}`;
  const parts = [];
  if (task.speed > 0) parts.push(fmtSpeed(task.speed));
  if (task.eta > 0) parts.push(fmtEta(task.eta));
  refs.right.textContent = parts.join(" · ");

  if (task.error) {
    refs.error.classList.remove("hidden");
    refs.error.textContent = task.error;
  } else {
    refs.error.classList.add("hidden");
  }

  const actions = [];
  if (task.status === "running" || task.status === "queued") actions.push(actionButton("暂停", "pause"));
  if (task.status === "paused" || task.status === "pausing") actions.push(actionButton("继续", "resume", "primary"));
  if (task.status === "error") actions.push(actionButton("重试", "retry", "primary"));
  if (task.status === "done") actions.push(actionButton("打开文件夹", "open"));
  if (task.status !== "done") actions.push(actionButton("取消", "cancel"));
  actions.push(actionButton("复制路径", "copy"));
  actions.push(actionButton("删除记录", "remove", "danger"));
  const html = actions.join("");
  if (refs.actions._html !== html) {
    refs.actions.innerHTML = html;
    refs.actions._html = html;
  }
}

function renderTasks(tasks) {
  const list = $("#task-list");
  const seen = new Set();
  tasks.forEach((task, index) => {
    seen.add(task.id);
    let node = app.taskNodes.get(task.id);
    if (!node) node = buildTaskNode(task);
    app.taskNodes.set(task.id, node);
    updateTaskNode(node, task);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  app.taskNodes.forEach((node, id) => {
    if (!seen.has(id)) { node.remove(); app.taskNodes.delete(id); }
  });
  $("#tasks-empty").classList.toggle("hidden", tasks.length > 0);
}

async function handleTaskAction(taskId, action, task) {
  if (action === "open") { api("/api/open", { method: "POST", body: JSON.stringify({ path: task.local_dir }) }); return; }
  if (action === "copy") { copyText(task.local_dir); return; }
  if (action === "remove") {
    if (!confirm("只是从列表里移除，已经下载的文件不会被删除。继续吗？")) return;
    await api(`/api/tasks/${taskId}`, { method: "DELETE" });
    pollState();
    return;
  }
  const data = await api(`/api/tasks/${taskId}/${action}`, { method: "POST" });
  if (!data.ok) toast(data.error || "操作失败", "err");
  pollState();
}

/* ------------------------------------------------------------------ */
/* 本地库                                                              */
/* ------------------------------------------------------------------ */
async function loadLibrary(force = false) {
  const data = await api(`/api/library${force ? "?force=1" : ""}`);
  if (!data.ok) return;
  app.library = data.items || [];
  renderLibrary(data.total_size || 0);
}

function taskForPath(path) {
  if (!path) return null;
  const target = String(path).toLowerCase();
  return app.tasks.find((t) => t.local_dir && String(t.local_dir).toLowerCase() === target) || null;
}

function renderLibrary(totalSize) {
  $("#library-empty").classList.toggle("hidden", app.library.length > 0);
  $("#library-total").textContent = app.library.length
    ? `· ${app.library.length} 个 · 共 ${fmtBytes(totalSize)}` : "";
  $("#library-list").innerHTML = app.library.map((item, index) => {
    const task = taskForPath(item.path);
    let badge = `<span class="status paused">未完成</span>`;
    if (task && task.status === "running") badge = `<span class="status running">下载中 ${task.percent}%</span>`;
    else if (task && task.status === "queued") badge = `<span class="status running">排队中</span>`;
    else if (task && task.status === "error") badge = `<span class="status error">出错</span>`;
    else if (task && task.status === "paused") badge = `<span class="status paused">已暂停 ${task.percent}%</span>`;
    else if (item.complete) badge = `<span class="status done">已完成</span>`;
    return `
    <article class="card">
      <div class="lib-item">
        <div class="lib-main">
          <div class="task-title"><h3>${esc(item.repo_id || item.name)}</h3>${badge}</div>
          <div class="meta-row" style="margin-top:6px">
            <span>占用 <b>${fmtBytes(item.size)}</b></span>
            <span>文件 <b>${item.files}</b></span>
            <span>版本 <b>${esc(item.revision || "latest")}</b></span>
          </div>
          <div class="lib-path">${esc(item.path)}</div>
        </div>
        <div class="row-gap">
          <button class="btn ghost small" data-lib-open="${index}">打开</button>
          <button class="btn ghost small" data-lib-copy="${index}">复制路径</button>
          <button class="btn danger ghost small" data-lib-del="${index}">删除</button>
        </div>
      </div>
    </article>`;
  }).join("");
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */
async function loadSettings() {
  const data = await api("/api/settings");
  if (!data.ok) return;
  app.settings = data.settings;
  const s = data.settings;
  $("#set-dir").value = s.download_dir;
  $("#set-mirror").value = s.mirror || "";
  $("#set-proxy").value = s.proxy || "";
  $("#set-token").value = "";
  $("#set-parallel").value = s.max_parallel_models;
  $("#set-files").value = s.files_per_model;
  $("#set-parallel-val").textContent = s.max_parallel_models;
  $("#set-files-val").textContent = s.files_per_model;
  $("#set-token-tip").innerHTML = s.token_set
    ? "已保存 token。<b>接口额度 5000 次/小时</b>。输入新值可替换，或点「清除」。"
    : "不填 token 时接口只有 <b>60 次/小时</b>，浏览几个仓库就用完；填了是 <b>5000 次/小时</b>。去 GitHub → Settings → Developer settings → Personal access tokens 创建，<b>不需要勾任何权限</b>。";
  $("#pill-saved").textContent = "保存到 " + shortenPath(s.download_dir);
  $("#status-url").textContent = location.origin;
  $("#status-mirror").textContent = s.mirror || "直连";
  $("#status-token").textContent = s.token_set ? "已填写" : "未填写";
}

function shortenPath(path) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return parts[parts.length - 2] + "/" + parts[parts.length - 1];
}

async function saveSettings(clearToken = false) {
  const payload = {
    download_dir: $("#set-dir").value.trim(),
    mirror: $("#set-mirror").value.trim(),
    proxy: $("#set-proxy").value.trim(),
    max_parallel_models: Number($("#set-parallel").value),
    files_per_model: Number($("#set-files").value),
    token: clearToken ? "__clear__" : $("#set-token").value.trim(),
  };
  const data = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
  if (!data.ok) { toast(data.error || "保存失败", "err"); return; }
  toast(clearToken ? "token 已清除" : "设置已保存", "ok");
  $("#set-token").value = "";
  await loadSettings();
  pollState();
}

async function testEndpoint() {
  const button = $("#set-test");
  button.disabled = true;
  button.textContent = "测试中…";
  const data = await api("/api/test-endpoint", { method: "POST" });
  button.disabled = false;
  button.textContent = "测试接口";
  if (data.ok) toast(data.message, "ok");
  else toast(data.error || "连接失败", "err");
}

/* ------------------------------------------------------------------ */
/* 轮询                                                                */
/* ------------------------------------------------------------------ */
async function pollState() {
  const data = await api("/api/state");
  if (!data.ok) {
    $("#pill-running").textContent = "服务已断开";
    return;
  }
  app.settings = data.settings;
  app.tasks = data.tasks || [];
  renderTasks(app.tasks);

  const active = app.tasks.filter((t) => ["running", "queued", "pausing"].includes(t.status)).length;
  $("#pill-running").textContent = active ? `下载中 ${active}` : "空闲";
  $("#badge-tasks").textContent = app.tasks.filter((t) => ["running", "queued", "pausing", "paused", "error"].includes(t.status)).length;

  if (data.versions) {
    $("#net-component").textContent = data.versions.curl_version || "—";
    $("#status-mirror").textContent = data.versions.mirror || "直连";
    $("#status-token").textContent = data.versions.token || "未填写";
    const rate = data.versions.rate || {};
    const quota = rate.remaining != null ? `${rate.remaining}/${rate.limit}` : "—";
    $("#status-quota").textContent = quota;
    $("#pill-quota").textContent = "额度 " + quota;
  }

  app.tasks.forEach((task) => {
    const before = app.knownStatus.get(task.id);
    app.knownStatus.set(task.id, task.status);
    if (before && before !== task.status) {
      if (task.status === "done") {
        toast(`「${task.display_name || task.repo_id}」下载完成`, "ok");
        loadLibrary(true);
      } else if (task.status === "error") {
        toast(`「${task.display_name || task.repo_id}」出错：${task.error || ""}`, "err");
      }
    }
  });

  if (data.library) {
    app.library = data.library.items || [];
    if (app.view === "library") renderLibrary(data.library.total_size || 0);
    else $("#badge-library").textContent = app.library.length;
  }
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */
function bindEvents() {
  $("#tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) switchView(tab.dataset.view);
  });

  $("#search-btn").addEventListener("click", () => doSearch(true));
  $("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(true); });
  $("#search-sort").addEventListener("change", () => doSearch(true));
  $("#load-more").addEventListener("click", () => { app.search.page += 1; doSearch(false); });

  $("#quick-tags").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    $("#search-input").value = chip.dataset.q;
    doSearch(true);
  });

  $("#search-results").addEventListener("click", (event) => {
    const download = event.target.closest("[data-download]");
    const openHome = event.target.closest("[data-open]");
    if (openHome) {
      const item = app.search.items[Number(openHome.dataset.open)];
      if (item) window.open(`https://github.com/${item.repo_id}`, "_blank");
      return;
    }
    if (download) {
      const item = app.search.items[Number(download.dataset.download)];
      if (item) openDownloadDialog(item.repo_id, item.repo_id.split("/")[1]);
    }
  });

  $("#task-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const node = button.closest(".task");
    const task = app.tasks.find((t) => t.id === node.dataset.id);
    if (task) handleTaskAction(task.id, button.dataset.action, task);
  });

  $("#pause-all").addEventListener("click", async () => {
    for (const task of app.tasks.filter((t) => ["running", "queued"].includes(t.status))) {
      await api(`/api/tasks/${task.id}/pause`, { method: "POST" });
    }
    pollState();
  });
  $("#resume-all").addEventListener("click", async () => {
    for (const task of app.tasks.filter((t) => ["paused", "error"].includes(t.status))) {
      await api(`/api/tasks/${task.id}/resume`, { method: "POST" });
    }
    pollState();
  });

  $("#library-refresh").addEventListener("click", () => loadLibrary(true));
  $("#library-open").addEventListener("click", () => {
    if (app.settings) api("/api/open", { method: "POST", body: JSON.stringify({ path: app.settings.download_dir }) });
  });
  $("#library-list").addEventListener("click", async (event) => {
    const open = event.target.closest("[data-lib-open]");
    const copy = event.target.closest("[data-lib-copy]");
    const del = event.target.closest("[data-lib-del]");
    if (open) {
      const item = app.library[Number(open.dataset.libOpen)];
      if (item) api("/api/open", { method: "POST", body: JSON.stringify({ path: item.path }) });
    } else if (copy) {
      const item = app.library[Number(copy.dataset.libCopy)];
      if (item) copyText(item.path);
    } else if (del) {
      const item = app.library[Number(del.dataset.libDel)];
      if (!item) return;
      if (!confirm(`确定删除磁盘上的「${item.repo_id || item.name}」吗？\n会真的删掉 ${fmtBytes(item.size)}，删完不能恢复。`)) return;
      const data = await api("/api/delete-folder", { method: "POST", body: JSON.stringify({ path: item.path }) });
      if (!data.ok) { toast(data.error || "删除失败", "err"); return; }
      toast("已删除", "ok");
      loadLibrary(true);
    }
  });

  $("#set-browse").addEventListener("click", async () => {
    const data = await api("/api/browse", { method: "POST", body: JSON.stringify({ initial: $("#set-dir").value }) });
    if (data.ok && data.path) $("#set-dir").value = data.path;
  });
  $("#set-parallel").addEventListener("input", (e) => { $("#set-parallel-val").textContent = e.target.value; });
  $("#set-files").addEventListener("input", (e) => { $("#set-files-val").textContent = e.target.value; });
  $("#set-save").addEventListener("click", () => saveSettings(false));
  $("#set-token-clear").addEventListener("click", () => saveSettings(true));
  $("#set-test").addEventListener("click", testEndpoint);
  $("#btn-log").addEventListener("click", () => api("/api/open-log", { method: "POST" }));
  $("#btn-quit").addEventListener("click", async () => {
    if (!confirm("确定要退出程序吗？正在下载的任务会暂停，下次启动可以继续。")) return;
    await api("/api/shutdown", { method: "POST" });
    toast("程序已退出，可以直接关闭这个网页了");
    document.body.innerHTML = `<div style="display:grid;place-items:center;height:100vh;font-family:system-ui"><div style="text-align:center"><h2>已退出</h2><p style="color:#6d7588;margin-top:8px">现在可以关闭这个页面了。</p></div></div>`;
  });

  $("#modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#modal-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#modal-start").addEventListener("click", startDownload);
  $("#modal-release").addEventListener("change", (e) => {
    app.modal.tag = e.target.value;
    buildFileList();
  });
  $("#modal-reload").addEventListener("click", loadReleases);
  $("#modal-files").addEventListener("change", (event) => {
    const box = event.target.closest("input[type=checkbox]");
    if (!box) return;
    if (box.checked) app.modal.selected.add(box.dataset.path);
    else app.modal.selected.delete(box.dataset.path);
    updateModalSummary();
  });
  $$("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => pickFiles(button.dataset.pick));
  });
  $("#modal").addEventListener("click", (event) => {
    if (event.target === $("#modal")) $("#modal").classList.add("hidden");
  });
}

async function boot() {
  bindEvents();
  await loadSettings();
  await pollState();
  setInterval(pollState, 1200);
  switchView((location.hash || "#search").slice(1));
  loadFeatured();
  $("#search-input").focus();
}

boot();
