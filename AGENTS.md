# QuickWin Agents

## 重要规则

> **遇到问题，先在网上查一下**
>
> 在尝试自行解决问题之前，应该首先通过搜索引擎查找相关的技术文档、官方示例或社区讨论。这包括但不限于：
> - 官方文档和 API 参考
> - GitHub issues 和 pull requests
> - Stack Overflow 等技术社区的讨论
> - 相关开源项目的源代码
>
> **为什么要这样做：**
> - 可以避免重复造轮子，直接使用社区验证过的解决方案
> - 能够学习到最佳实践和正确的实现方式
> - 节省大量调试时间
> - 确保使用正确的 API 和方法签名

> **禁止自动 commit：提交前必须先让用户确认 diff 和 commit message**
>
> 每次 commit 前，先把 `git diff`（变更内容）和拟用的 commit message 展示给用户，用户明确同意后才执行 `git commit` 和 `git push`。用户说 "continue"、"commit"、"push" 或直接给出 commit message 时视为同意。
>
> **流程：**
> 1. 运行 `git diff` 展示变更
> 2. 写出拟用的 commit message
> 3. 等待用户确认
> 4. 确认后执行 `git add` + `git commit` + `git push`

> **commit message 必须基于 `git diff --cached 或 git diff` 内容生成**
>
> 1. 先运行 `git diff --cached 或 git diff` 查看具体变更内容
> 2. 根据 diff 内容（改了什么、为什么改）生成 commit message
> 3. 不得仅凭文件名列表猜测 commit message
> 4. commit message 风格与 `git log` 历史风格一致。

> **commit message 用英文概述**

> **使用中文思考和回答**

## 构建与运行

见 `.agents/DEVELOPMENT_WORKFLOW.md`（容器环境、make 目标、CLI 参数、gen_const、提交规范、排错）。

## 进行中计划

`.agents/*PLAN.md`、`.agents/TODO.md`

## 更多内容参考

`.agents/`、`docs/`