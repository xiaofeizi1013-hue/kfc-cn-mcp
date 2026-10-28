# Hermes 快速接入

本目录包含三样东西：

1. `config.snippet.yaml` —— 可直接合并进 `~/.hermes/config.yaml` 的 MCP 配置。
2. `skills/kfc-cn-ordering/SKILL.md` —— 教 Hermes 正确使用这些工具、下单前必须确认的 Skill。
3. `install.ps1` / `install.sh` —— 一键把 Skill 复制到 Hermes 技能目录（不修改 config）。

## 步骤

```powershell
# 1. 构建
cd kfc-cn-mcp
npm install
npm run build

# 2. 把 config.snippet.yaml 里的 kfc_cn 条目合并到 ~/.hermes/config.yaml
#    记得把 args 改成 dist/index.js 的绝对路径

# 3. 验证
hermes mcp test kfc_cn

# 4. 在 Hermes 会话里
/reload-mcp

# 5. 可选：安装配套 Skill
.\hermes\install.ps1
```

## Hermes 里的工具名

Hermes 会自动加前缀：`mcp_kfc_cn_find_stores`、`mcp_kfc_cn_place_order` …

## 只想查菜单、不想下单

```yaml
tools:
  exclude: [place_order]
```

## 多会话隔离

每个 Hermes 会话会拉一个 MCP 进程；如果同时开多个会话点餐，给每个会话配不同的 `KFC_STATE_DIR`，避免购物车互相覆盖。
