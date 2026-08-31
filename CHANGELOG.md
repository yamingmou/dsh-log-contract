## 0.3.7 — 2026-08-31 · L3/L4/L5 + 独立审查 5 项修复 + health-scan 巡检

### 新增

- **L3 `check --resume` 三档结论**：loadable / resumable / compactable——体检不只报违规，
  还能判定会话能否加载/续跑/压缩（`bin/dsh-log-contract.mjs check <file> --resume`）；
- **L4 fix 原语收编**：neutralize / clip-crossstep / drop-turnnull / trim 等收进统一命令；
- **L5 `--trim-budget`**：按 token 预算裁剪（中文字符密度实测校准）；
- **health-scan.mjs 定期巡检**（`scripts/health-scan.mjs`）：全量扫描会话 → 分级
  （🟢健康/🟡可自修/🔴损坏）→ 报告归档 `健康巡检报告-*.md`——生产级运行时的
  「定期巡检」层（工程-生产级运行时/自检机制）。

### 修复（独立审查 5 项）

- neutralize-orphan 误伤健康文件（孤立判定过宽）；
- extract-turn 同 seq 丢内容（同 seq 多事件只取最后一个）；
- tail-renumber 崩溃（尾部非数字/空文件）；
- keep-ranges 静默输出错误 header（header 被当普通行）；
- 工具 exit 码不统一（成功/失败无法脚本判断）。

---

## 0.3.6 — 2026-08-30 · T2 规则盲区修复（非 chunk 引用 + usage 前提）

### 事故（2026-08-30 第二层根因）

- 526f1835 neutralize 后仍报错：6 个 error 级 T2 跨 step 引用（seq 936047 等）。
- 精查 936047：sourceEventSeqs 2011 个引用 = 2001 同 step chunk + **10 个非 chunk**
  （assistant/message、tool/call、tool/result、step/end、step/start 各 2）——DSH resend
  在 step 未关时把旧 step 整段引用进新消息。
- **官方 `dsh-token-meter/lib/index.js:644`：非 chunk 引用直接 throw `is not assistant/chunk`**
  （:640 非更早 / :641 重复 / :644 非 chunk / :645 跨 step，四查全 throw）。
- 我们 0.3.5 的 T2 规则写 `continue`（注释"非 chunk 官方跳过"）——**假设错误** →
  磁盘 check 全绿、实机必崩；clip-crossstep 同样错误保留非 chunk 引用。

### 修复

- **关键区分（官方 :592 前提）**：`_estimateProviderAssistant` 只在
  `event.data.usage !== undefined && nextHeader !== undefined` 时被调用——
  **replace marker（空内容、无 usage）根本不走 source 检查**，其非 chunk
  sourceEventSeqs 是 S5 遮蔽语义、合法且必需，**不可裁剪**；只有带 usage 的
  append 消息才检查/裁剪。
- T2 规则 + clip-crossstep 都加 usage 前提；非 chunk 引用改报 error（原 continue）。
- 526f1835 修复：只裁剪 936047 一条（2011→2001，去掉 10 个非 chunk），
  5 条 replace marker 不动；复检 0 违规。
- 测试 +2（非 chunk → T2 error / replace marker 无 usage 不报），**81 全绿**。

### 铁律沉淀

- **规则必须逐字镜像官方源码**——凡注释写"官方跳过/官方不管"的，先打开官方源码
  确认，别猜（本事故就是"猜官方跳过"猜错的）。

## 0.3.6 发版清查台账（2026-08-30）

- 全量历史会话清查（~/.dsh/sessions 85 会话）：**error 级违规 0**（T1/T2/I1/S9 全清）。
- 526f1835 遗留 6 个 0.4.6 时代 turn-null marker（seq 1091709/1101061/1113626/1114597/1129716/1144037）已在前序 neutralize 中处理；跨 step 引用 936047 已 clip（2011→2001）。
- 说明：0.3.6 的 T2 usage 前提修复后复扫，replace marker（无 usage）的 sourceEventSeqs 不再误报——S5 遮蔽语义合法引用保留。
