"""核对已下载的 GitHub 资源是否齐全。

不调用 GitHub API（那边有额度限制），直接读每个目录里的 `.download-meta.json`，
按里面的清单比对文件大小。

用法：python app/verify_models.py
"""

import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
REPORT = DATA / "verify-report.json"
META_NAME = ".download-meta.json"


def load_settings() -> dict:
    path = DATA / "settings.json"
    settings = {"download_dir": str(BASE / "downloads")}
    if path.exists():
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
            for key in settings:
                if key in stored:
                    settings[key] = stored[key]
        except Exception:
            pass
    return settings


def main() -> int:
    root = Path(load_settings()["download_dir"])
    print(f"下载目录：{root}\n")
    if not root.exists():
        print("目录不存在，先下载点东西吧。")
        return 1

    results = []
    for meta_path in sorted(root.glob("*/*/" + META_NAME)):
        model_dir = meta_path.parent
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        manifest = meta.get("manifest") or []
        if not manifest:
            print(f"[跳过] {model_dir.name}: 没有清单记录（老版本下载的）")
            continue

        entry = {"repo": meta.get("repo_id") or model_dir.name,
                 "revision": meta.get("revision") or "latest",
                 "dir": str(model_dir)}
        missing, bad, ok, total = [], [], 0, 0
        for item in manifest:
            name = item.get("path") or ""
            size = int(item.get("size") or 0)
            if not name:
                continue
            total += size
            target = model_dir / name
            if not target.exists():
                missing.append({"path": name, "size": size, "url": item.get("url") or ""})
                continue
            try:
                actual = target.stat().st_size
            except OSError:
                missing.append({"path": name, "size": size, "url": item.get("url") or ""})
                continue
            if size and actual != size:
                bad.append({"path": name, "size": size, "actual": actual,
                            "url": item.get("url") or ""})
            else:
                ok += 1

        entry.update({"files_total": len(manifest), "remote_total": total,
                      "ok": ok, "missing": missing, "bad": bad})
        results.append(entry)
        flag = "OK" if not missing and not bad else "缺失"
        print(f"[{flag}] {entry['repo']} @ {entry['revision']}: 正常 {ok}，"
              f"缺失 {len(missing)}，大小不符 {len(bad)}")

    DATA.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    total_missing = sum(len(r.get("missing") or []) for r in results)
    total_bad = sum(len(r.get("bad") or []) for r in results)
    print(f"\n共 {len(results)} 个目录：缺失 {total_missing} 个文件，大小不符 {total_bad} 个")
    if total_missing or total_bad:
        print("运行 `python app/repair_missing.py` 可以自动补齐。")
    else:
        print("全部完整。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
