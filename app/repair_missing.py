"""补齐缺失的下载文件（按 .download-meta.json 里记录的地址重新拉）。

只补差额，已下好的不会重下；地址是当初下载时用的那条（可能带加速镜像前缀）。

用法：先跑 app/verify_models.py 生成报告，再跑 `python app/repair_missing.py`
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
REPORT = DATA / "verify-report.json"

sys.path.insert(0, str(BASE / "app"))

import gh_client  # noqa: E402
from download_manager import download_file_to  # noqa: E402

WORKERS = 3


def load_settings() -> dict:
    path = DATA / "settings.json"
    settings = {"download_dir": str(BASE / "downloads"), "proxy": ""}
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
    if not REPORT.exists():
        print("找不到校验报告，请先运行：python app/verify_models.py")
        return 1

    settings = load_settings()
    gh_client.configure(settings)
    proxy = gh_client.proxy()

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    jobs = []
    for entry in report:
        for item in (entry.get("missing") or []) + (entry.get("bad") or []):
            url = item.get("url") or ""
            if not url:
                continue
            target = Path(entry["dir"]) / item["path"]
            jobs.append((item["path"], url, target, int(item["size"])))

    if not jobs:
        print("没有需要补的文件。")
        return 0

    print(f"待补齐 {len(jobs)} 个文件（只补差额）\n", flush=True)

    def run(job):
        name, url, target, expect = job

        def on_progress(delta):
            if delta > 0:
                print(f"    {name[-46:]:46} +{delta / 1048576:.0f} MB", flush=True)

        try:
            download_file_to(url, target, expect, proxy=proxy, on_progress=on_progress)
            return name, True, "补齐"
        except BaseException as exc:  # noqa: BLE001
            return name, False, gh_client.explain_error(exc)

    ok_count = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for name, ok, msg in pool.map(run, jobs):
            ok_count += 1 if ok else 0
            print(f"  [{'OK' if ok else 'FAIL'}] {name}: {msg}", flush=True)

    print(f"\n完成：{ok_count}/{len(jobs)} 个文件补齐")
    return 0 if ok_count == len(jobs) else 2


if __name__ == "__main__":
    sys.stdout.reconfigure(errors="replace")
    raise SystemExit(main())
