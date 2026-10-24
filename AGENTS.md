# QuickWin Agents

## 重要规则

> 优先检索：实施前检索官方文档 / API 参考、GitHub issues、Stack Overflow 及开源项目源码

> `rg` 优先，`grep` 兜底

> 避免 `as`/`any` 等类型不安全写法；确需时写注释说明

> 构建、测试与 VM 服务访问须在容器 `quickwin-dev` 内执行（宿主无交叉工具链；hostfwd 端口仅容器网络可达）
> 宿主发起的命令一律用 `docker/qc` 包一层：
> `./docker/qc <命令>`（= `podman exec -w /workspace`；命令按 argv 直传、不起 shell、退出码透传；复合命令写 `./docker/qc bash -c '...'`）
> - 宿主仅负责 git、文件编辑与文档；容器执行 `make js/cc64/cc32/execd/test`、`bash docker/scripts/fetch-ready.sh` 及 VM 端口 curl
> - 直接跑 `./docker/run.sh`（不经 qc）会在宿主建出宿主路径的 overlay，事后难以区分是污染还是损坏
> - CI 不用 qc：CI 本身在容器内，直接调 `make` / `run.sh`

> 禁止自动提交：须先展示 `git diff` 与拟用 commit message，经用户同意方可执行 `git add` / `commit` / `push`；回复 "continue"、"commit"、"push" 或直接给出 message 视为同意

> commit message：依据 diff 实际内容生成，英文表述，风格对齐 `git log`；文档/注释/微调等不重要的改动从简

> 环境变量中可能有 GH_TOKEN

> 文档不写 commit id（哈希）与源码行号（`file.c:123`、`L123`）等易漂移信息

> 使用中文思考和回答

## 开发流程

双机验证流程（C/execd 变更后加 `--restart`）：

```bash
./docker/qc bash -c 'make js && cd docker && ./run.sh win7 && ./http_test.sh win7 && ./run.sh xp && ./http_test.sh xp'
```

完整 make 目标与故障排查见 skill `workflow`

## 进行中计划

`.agents/TODO.md`（`REMOVE_LIBFFI_PLAN.md` 为已完成决策档案）

## 更多内容参考

`.agents/`、`docs/`
