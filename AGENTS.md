# QuickWin Agents

## 重要规则

> **优先检索**：实施前检索官方文档 / API 参考、GitHub issues、Stack Overflow 及开源项目源码。

> **构建、测试与 VM 服务访问须在容器 `quickwin-dev` 内执行**（宿主无交叉工具链；hostfwd 端口仅容器网络可达）：
> `podman exec quickwin-dev bash -lc 'cd /workspace && <命令>'`
> - 宿主仅负责 git、文件编辑与文档；容器执行 `make js/cc64/cc32/exec_server/test`、`docker/*.sh` 及 VM 端口 curl
> - 遗漏 `cd /workspace` 将找不到 Makefile；宿主运行 `make` 报错或 curl 端口被拒即属违反本规则

> **禁止自动提交**：须先展示 `git diff` 与拟用 commit message，经用户同意方可执行 `git add` / `commit` / `push`；回复 "continue"、"commit"、"push" 或直接给出 message 视为同意。

> **commit message**：依据 diff 实际内容生成（不得依据文件名推断），以英文表述，风格对齐 `git log`。

> **使用中文思考和回答**

## 开发流程（必读）

双机验证流程（容器内执行；C/exec_server 变更后加 `--restart`）：

```bash
podman exec quickwin-dev bash -lc 'cd /workspace && make js && cd docker && ./run.sh win7 && ./http_test.sh win7 && ./run.sh xp && ./http_test.sh xp'
```

完整 make 目标、CLI、gen_const 及故障排查，见 `.agents/DEVELOPMENT_WORKFLOW.md`。

## 进行中计划

`.agents/*PLAN.md`、`.agents/TODO.md`

## 更多内容参考

`.agents/`、`docs/`
