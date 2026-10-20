# 独立审核记录

每个**要发布的版本**必须在此目录有一份 `<version>.json`，否则 `check-review-record` 会拒绝发布。

## 格式

```json
{
  "version": "0.3.20",
  "author": "OfferKuai Team",
  "reviewer": "<独立审核者（≠ 作者；可以是独立 subagent）>",
  "verdict": "pass",
  "date": "YYYY-MM-DD",
  "scope": ["lib/**", "scripts/**", "test/**"],
  "evidence": [
    "node scripts/release.mjs --dry-run --skip-tests ⇒ exit 0",
    "npx vitest run ⇒ 338 passed / 0 failed",
    "对抗性负对照：注入内部词 ⇒ check-external-surface exit 1"
  ]
}
```

## 规则

1. `reviewer` 必须 ≠ `author`（作者不能自审）。
2. `verdict` 必须为 `"pass"`。
3. `evidence` 必须非空（命令/读数/链接，可复核）。
4. 记录随版本提交入库；发布后不可回改（如须更正，新增一份并注明）。
