# 开发与反馈说明

## 这个项目不接收代码修改

**Pull Request 不会被合并。** 这不是客套话，是真的不合并，避免你白写。

欢迎的：

- 提 [Issue](https://github.com/15072400099/github-downloader/issues/new/choose) 说清遇到的问题
- 使用体验上的建议
- 兼容性反馈：你在什么网络环境、用了哪个加速镜像

不接收的：

- 代码 PR
- 自动依赖升级 PR

想自己改着用完全可以：MIT 允许你 fork 任意修改，只是不会合并回本仓库。

---

## 本地跑起来改

需要 Windows 10/11 + Python 3.10 以上。**没有第三方依赖**，不需要 pip install：

```bat
启动下载器.bat
```

或直接：

```bat
python app\server.py
```

界面在 <http://127.0.0.1:8768>。改前端刷新页面即可，改后端要重启。

### 代码结构

```
app/server.py            HTTP 服务与路由（标准库，无框架）
app/gh_client.py         GitHub 接口封装与错误翻译
app/download_manager.py  任务队列、进度、暂停续传、本地库
app/transport.py         HTTP 传输层（调用系统 curl）
app/verify_models.py     按本地清单核对文件
app/repair_missing.py    只补缺失的文件
```

### 三个必须知道的坑

**1. `.bat` 文件必须是 GBK 编码。**
`cmd.exe` 按系统 ANSI 代码页解析批处理，存成 UTF-8 会直接报「'到' 不是内部或外部命令」。
`.gitattributes` 已把 `*.bat` 标记为 `-text`。

**2. 不要提交 `downloads/`、`data/`、`python/`、`.venv/`、`build/`、`dist/`。**
都在 `.gitignore` 里。

**3. 只监听 `127.0.0.1`。**
本程序没有鉴权，却带有删除文件夹的接口。改成 `0.0.0.0` 等于把删文件权限开放给局域网。

### 关于依赖

**项目是零第三方依赖的**，请保持：只用标准库 + 系统自带 `curl.exe`。
CI 有一条「零依赖检查」，出现 `import requests` 就会红。

传输层在 `app/transport.py`，改动时注意：

- Windows 自带 curl 8.4 不带 zlib，**不能用 `--compressed`**
- GitHub 的源码包不支持 Range，下载这类资源要传 `resume=False`

### 提交前自测

- [ ] 能启动，界面能打开
- [ ] 搜索能出结果
- [ ] 打开一个仓库的 Release，资源列表能显示
- [ ] 下载一个小资源（如 `fzf` 的 windows zip）能完成
- [ ] 下载中点「暂停」再「继续」，进度没有归零
- [ ] 「检查并补齐现有文件」能正常输出
