---
name: kfc-cn-ordering
description: 在中国肯德基（order.kfc.com.cn）选门店、查菜单、加购物车、预览并提交自取订单。支付需用餐人在肯德基 App/H5 完成，本 Skill 绝不代付。
version: 1.0.0
metadata:
  hermes:
    tags: [kfc, 肯德基, food, ordering, china, takeaway]
    category: lifestyle
---

# 肯德基中国点餐（kfc-cn-mcp）

## When to Use

当用户想在中国大陆的肯德基点餐、查附近门店、看菜单/价格、加购物车、下单自取时使用。工具来自 `kfc_cn` MCP 服务器，Hermes 中注册名形如 `mcp_kfc_cn_*`。

不要用于：美国/其他国家的 KFC、外卖配送（本服务器只支持到店自取/堂食）、代付、批量下单。

## Preconditions

- `kfc_cn` 已在 `~/.hermes/config.yaml` 的 `mcp_servers` 中启用，且 `hermes mcp test kfc_cn` 通过。
- 用户能提供：城市（或经纬度）、门店、餐品、取餐手机号、堂食/外带。
- 用户明确知道：下单后需自己在肯德基 App/H5 支付。

## Procedure

1. **定位门店**
   - `mcp_kfc_cn_find_stores`，参数二选一：
     - `keyword` + `cityCode`（国标码，如上海 `310100`）
     - `latitude` + `longitude`
   - 把候选门店（名称、地址、营业时间、距离）列给用户选，不要擅自替用户选店。

2. **选定门店**
   - `mcp_kfc_cn_select_store`，`storeCode` 用上一步返回值。
   - 该操作会切换门店并重建购物车；如果用户已有购物车，先提醒“切换门店会清空当前购物车”。

3. **找餐品**
   - 分类浏览：`mcp_kfc_cn_get_menu`（可传 `category`，如“汉堡卷”“饮品”）。
   - 关键词搜索：`mcp_kfc_cn_search_menu`（如“原味鸡”“蛋挞”）。
   - 套餐/规格：`mcp_kfc_cn_get_item`，看 `comboRounds`（每轮 `minCount`/`maxCount`/可选 `linkId`）。
   - 价格以返回的 `price` 为准，不要自行换算或猜测。

4. **加购物车**
   - `mcp_kfc_cn_cart_add`，`items: [{linkId, quantity, selections?}]`。
   - 套餐不传 `selections` 时会按每轮最少份数自动选第一个可选项；用户对套餐内容有要求时，先 `get_item` 再传 `selections`（key 是 `roundId`）。
   - 改数量：`mcp_kfc_cn_cart_set_quantity`（0 = 删除）；删除单行：`mcp_kfc_cn_cart_remove`；清空：`mcp_kfc_cn_cart_clear`。
   - 每次操作后用 `mcp_kfc_cn_cart_view` 把购物车和合计复述给用户。

5. **结算预览（必须）**
   - `mcp_kfc_cn_preview_order`。
   - 把门店、餐品、数量、合计、`requiresLogin`、`warnings` 原样告诉用户。
   - 若 `requiresLogin=true`，告知当前只能免登录点餐，会员价/优惠券不可用。

6. **向用户确认（硬性）**
   - 必须得到用户**明确确认**：门店、餐品、数量、总价、手机号、堂食/外带。
   - 未确认前不得调用 `place_order`。

7. **提交订单**
   - `mcp_kfc_cn_place_order`：
     - `confirm: true`
     - `phone`: 用户提供的 11 位手机号
     - `packType`: `dinein`（堂食，默认）或 `takeaway`（外带）
     - `previewToken`: 上一步返回值
     - `expectedTotalCents`: 用户确认的金额（强烈建议传，防止价格变动）
     - `remark`: 可选备注
   - 成功后把订单号、金额、门店告诉用户，并强调：**15 分钟内到肯德基 App/H5「我的订单」完成支付，否则订单自动取消**。

8. **查询状态（可选）**
   - `mcp_kfc_cn_order_status`，传 `orderId`。该接口可能需要登录态，失败时引导用户去 App 查看。

## Rules

- **绝不代付**：不询问、不保存支付密码、验证码、银行卡。支付只能由用餐人完成。
- **绝不擅自下单**：没有用户明确确认，不调用 `place_order`；`confirm=true` 只代表“已确认”，不是“可以随便下”。
- **手机号最小化**：只用于取餐联系；不要写入长期记忆、日志或 skill 文件。
- **金额一致**：`expectedTotalCents` 与预览不一致时，工具会拒绝；此时重新 `preview_order` 并向用户解释价格变化。
- **门店切换会清空购物车**：切换前提醒用户。
- **风控**：遇到“触发人机验证/请登录”提示，停止自动流程，让用户在 App/H5 完成。
- **失败不重试下单**：`place_order` 超时或报错时，先 `order_status` 或让用户查 App，避免重复下单。

## Pitfalls

- `find_stores` 用关键词时必须给 `cityCode`（国标码），否则默认用配置的城市。
- `cart/update` 在底层是增量语义；不要绕过 MCP 直接改状态文件。
- 菜单缓存 30 分钟；遇到“商品校验失败/售罄”时用 `get_menu(refresh=true)` 再重试。
- 套餐的 `linkId` 与单品不同；不要拿套餐里的子商品 `linkId` 当主商品加购。
- 多开 Hermes 会话时给每个会话不同的 `KFC_STATE_DIR`，否则购物车会互相覆盖。

## Verification

- 点餐前：`mcp_kfc_cn_session_status` 确认 `store` 正确、`cart` 非空、`pendingPreview` 存在。
- 下单后：把 `orderId` 复述给用户，并让用户确认收到支付提示。
- 若工具返回 `ok:false`，把 `error.message` 与 `error.hint` 原样转述，不要编造成功。
