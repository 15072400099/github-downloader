"""GitHub 访问封装（纯 HTTP，零第三方依赖）。

四件事：搜索仓库、仓库详情、列出 Release（含资源）、列出版本标签。
所有请求都通过 transport（背后是系统 curl）发出。

两个必须知道的现实：
1. 未登录时核心接口只有 60 次/小时，搜索 10 次/分钟；填了 token 是 5000 次/小时
2. 下载地址在 github.com 上，国内常被阻断，所以默认套一层加速镜像前缀
"""

from __future__ import annotations

import threading
import time

import transport

API = "https://api.github.com"
DEFAULT_MIRROR = "https://gh-proxy.com"

SORTS = {
    "stars": "星标最多",
    "forks": "复刻最多",
    "updated": "最近更新",
}

_lock = threading.RLock()
_cache: dict[tuple, tuple[float, object]] = {}
_CACHE_TTL = 90.0

settings: dict = {"token": "", "mirror": DEFAULT_MIRROR, "proxy": ""}
_rate: dict = {"remaining": None, "limit": None, "reset": None}


def configure(cfg: dict) -> None:
    with _lock:
        settings["token"] = (cfg.get("token") or "").strip()
        settings["mirror"] = (cfg.get("mirror") or "").strip().rstrip("/")
        settings["proxy"] = (cfg.get("proxy") or "").strip()
        _cache.clear()


def token() -> str:
    return settings.get("token") or ""


def mirror() -> str:
    return settings.get("mirror") or ""


def proxy() -> str:
    return settings.get("proxy") or ""


def rate_limit() -> dict:
    return dict(_rate)


def _get(path: str, params: dict | None = None, timeout: int = 45):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "github-download-manager/1.0"}
    if token():
        headers["Authorization"] = f"Bearer {token()}"
    data = transport.get_json(f"{API}{path}", params, timeout=timeout,
                              proxy=proxy(), headers=headers)
    # 限流信息在响应头里，transport 目前只回 JSON，这里用一次轻量请求兜底更新
    return data


def refresh_rate_limit() -> dict:
    """查一次当前限流状态（每次消耗 1 次配额）。"""
    try:
        data = transport.get_json(f"{API}/rate_limit", proxy=proxy()) or {}
        core = (data.get("resources") or {}).get("core") or {}
        with _lock:
            _rate.update({
                "remaining": core.get("remaining"),
                "limit": core.get("limit"),
                "reset": core.get("reset"),
            })
        return dict(_rate)
    except Exception:
        return dict(_rate)


def _cached(key: tuple, producer):
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    value = producer()
    _cache[key] = (now, value)
    if len(_cache) > 200:
        for k in list(_cache)[:100]:
            _cache.pop(k, None)
    return value


def explain_error(exc: BaseException) -> str:
    text = str(exc)
    low = text.lower()

    if "http 404" in low:
        return "仓库或资源不存在，检查名字是否写对（形如 cli/cli）"
    if "http 403" in low or "http 429" in low:
        if "rate limit" in low or "limited" in low:
            return "GitHub 接口调用次数用完了。填一个 token 可以提到 5000 次/小时，等一小时也会恢复"
        return "被 GitHub 限流或拒绝访问，稍后再试；填 token 可以提高额度"
    if "http 401" in low:
        return "token 无效或已过期，去设置里换一个"
    if "http 5" in low:
        return "GitHub 服务端出错（5xx），通常是他们那边的问题，稍后再试"
    if "resolve host" in low or "could not resolve" in low:
        return "域名解析失败：api.github.com 解析不了，检查网络或 DNS"
    if "connection refused" in low or "connection reset" in low:
        return "连接被拒绝或重置，可能是网络阻断；可以在设置里填代理"
    if "timed out" in low or "timeout" in low:
        return "连接超时，检查网络或在设置里填代理"
    if "curl 失败" in text:
        return f"网络请求失败：{text[:160]}"
    if "不是 json" in text:
        return "GitHub 返回的不是 JSON，可能是接口变了或被中间设备拦截"
    return f"{type(exc).__name__}: {text[:200]}"


# ---------------------------------------------------------------------------
# 搜索
# ---------------------------------------------------------------------------
def search_repos(query: str, page: int = 1, page_size: int = 12, sort: str = "stars") -> dict:
    query = (query or "").strip()
    sort = sort if sort in SORTS else "stars"
    page = max(1, int(page))
    key = ("search", query, page, page_size, sort, bool(token()))

    def produce():
        if not query:
            # 没有关键词时给一批高星仓库，避免空白页
            params = {"q": "stars:>10000", "sort": sort, "order": "desc",
                      "per_page": page_size, "page": page}
        else:
            params = {"q": query, "sort": sort, "order": "desc",
                      "per_page": page_size, "page": page}
        data = _get("/search/repositories", params) or {}
        rows = data.get("items") or []
        total = int(data.get("total_count") or 0)
        items = []
        for row in rows:
            full_name = row.get("full_name") or ""
            if not full_name:
                continue
            license_info = row.get("license") or {}
            items.append({
                "repo_id": full_name,
                "display_name": row.get("name") or full_name.split("/")[-1],
                "owner": (row.get("owner") or {}).get("login") or full_name.split("/")[0],
                "description": (row.get("description") or "").strip(),
                "stars": row.get("stargazers_count") or 0,
                "forks": row.get("forks_count") or 0,
                "language": row.get("language") or "",
                "license": license_info.get("spdx_id") or "",
                "size_kb": row.get("size") or 0,
                "updated_at": row.get("updated_at"),
                "archived": bool(row.get("archived")),
                "tasks": [],
                "downloads": row.get("stargazers_count") or 0,
                "file_size": 0,
            })
        return {"items": items, "page": page, "page_size": page_size,
                "has_more": page * page_size < total}

    try:
        return _cached(key, produce)
    except Exception as exc:  # noqa: BLE001
        return {"items": [], "page": page, "page_size": page_size, "has_more": False,
                "error": explain_error(exc)}


# ---------------------------------------------------------------------------
# 仓库 / Release
# ---------------------------------------------------------------------------
def repo_detail(repo_id: str) -> dict:
    repo_id = normalize_repo_id(repo_id)
    if not repo_id:
        return {"error": "请输入仓库名，形如 cli/cli"}

    def produce():
        data = _get(f"/repos/{repo_id}") or {}
        license_info = data.get("license") or {}
        return {
            "repo_id": data.get("full_name") or repo_id,
            "display_name": data.get("name") or repo_id.split("/")[-1],
            "description": (data.get("description") or "").strip(),
            "stars": data.get("stargazers_count") or 0,
            "forks": data.get("forks_count") or 0,
            "language": data.get("language") or "",
            "license": license_info.get("spdx_id") or "",
            "size_kb": data.get("size") or 0,
            "default_branch": data.get("default_branch") or "main",
            "archived": bool(data.get("archived")),
        }

    try:
        return _cached(("detail", repo_id), produce)
    except Exception as exc:  # noqa: BLE001
        return {"error": explain_error(exc)}


def list_releases(repo_id: str, limit: int = 20) -> dict:
    """列出 Release 及其资源。每个资源都带上大小和下载地址。"""
    repo_id = normalize_repo_id(repo_id)

    def produce():
        data = _get(f"/repos/{repo_id}/releases", {"per_page": limit}) or []
        releases = []
        for row in data if isinstance(data, list) else []:
            assets = []
            for asset in row.get("assets") or []:
                assets.append({
                    "name": asset.get("name") or "",
                    "size": int(asset.get("size") or 0),
                    "url": asset.get("browser_download_url") or "",
                    "downloads": asset.get("download_count") or 0,
                    "resumable": True,
                })
            releases.append({
                "tag": row.get("tag_name") or "",
                "name": row.get("name") or row.get("tag_name") or "",
                "published_at": row.get("published_at"),
                "prerelease": bool(row.get("prerelease")),
                "draft": bool(row.get("draft")),
                "assets": assets,
            })
        return releases

    try:
        return {"releases": _cached(("releases", repo_id), produce)}
    except Exception as exc:  # noqa: BLE001
        return {"releases": [], "error": explain_error(exc)}


def list_tags(repo_id: str, limit: int = 20) -> dict:
    repo_id = normalize_repo_id(repo_id)

    def produce():
        data = _get(f"/repos/{repo_id}/tags", {"per_page": limit}) or []
        return [row.get("name") for row in data if row.get("name")]

    try:
        return {"tags": _cached(("tags", repo_id), produce)}
    except Exception as exc:  # noqa: BLE001
        return {"tags": [], "error": explain_error(exc)}


def archive_url(repo_id: str, revision: str = "") -> str:
    """源码压缩包地址。注意：这类下载不支持 Range，断点续传要降级。"""
    repo_id = normalize_repo_id(repo_id)
    ref = revision or "HEAD"
    return f"https://codeload.github.com/{repo_id}/zip/{ref}"


def download_url(asset_url: str) -> str:
    """把原始下载地址套上加速镜像前缀（如果配置了）。"""
    base = mirror()
    if not base or not asset_url:
        return asset_url
    return f"{base}/{asset_url}"


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def normalize_repo_id(text: str) -> str:
    """接受仓库名或页面链接，统一成 owner/repo。"""
    text = (text or "").strip().strip('"').strip("'")
    if not text:
        return ""
    low = text.lower()
    if "github.com" in low:
        idx = low.index("github.com")
        text = text[idx + len("github.com"):]
    text = text.split("?")[0].split("#")[0].replace("\\", "/").strip("/")
    parts = [p for p in text.split("/") if p]
    if len(parts) >= 2:
        return f"{parts[0]}/{parts[1]}"
    return ""


def looks_like_repo_id(text: str) -> bool:
    text = (text or "").strip()
    if "github.com" in text.lower():
        return True
    return "/" in text and len(text.split("/")) == 2 and " " not in text
