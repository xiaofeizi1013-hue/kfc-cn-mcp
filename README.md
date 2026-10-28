# kfc-cn-mcp

肯德基中国（[order.kfc.com.cn](https://order.kfc.com.cn/preorder-taro/menu?label=preorder)）点餐 MCP 服务器，**为 Hermes Agent 适配**，同时兼容任何支持 stdio 的 MCP 客户端（Claude Desktop、Cursor、Cherry Studio 等）。

它把肯德基中国 H5 点餐的真实接口封装成一组工具：找门店 → 看菜单 → 加购物车 → 结算预览 → 提交订单。**不依赖浏览器自动化**，直接走官方 H5 的 JSON 接口（含 KBS 签名与字段加密），因此速度快、资源占用低，价格与库存都是真实的。

> 本项目参考了 [markswendsen-code/mcp-kfc](https://github.com/markswendsen-code/mcp-kfc) 的工具形态（search_menu / add_to_cart / view_cart / checkout …），但美国 KFC 的实现是 Playwright 点击网页 + 估算价格；中国版是重写的 HTTP 客户端，能真正在肯德基中国下单。

---

## 1. 能力与边界

### 已实现

| 工具 | 作用 |
| --- | --- |
| `find_stores` | 按关键词 + 城市国标码，或经纬度找门店，返回 `storeCode` |
| `select_store` | 选定门店并加载该店实时菜单（走 `validStore → changeStoreOrAddress → cart/create → menu/list`） |
| `get_menu` | 查看分类/某个分类下的餐品（`linkId`、价格、是否套餐） |
| `search_menu` | 按中文名/描述搜索餐品 |
| `get_item` | 商品详情 + 套餐可选内容（`comboRounds`）+ 规格 |
| `cart_add` | 加购；套餐可不传 `selections` 自动按最少份数选默认项 |
| `cart_set_quantity` | 修改某行数量（0 = 删除） |
| `cart_remove` | 删除某行 |
| `cart_clear` | 清空购物车 |
| `cart_view` | 查看购物车与合计 |
| `preview_order` | 服务端结算预校验，返回金额、门店、是否需登录、`previewToken` |
| `place_order` | **真实下单**（生成未支付订单）；必须 `confirm=true` + `previewToken` + 手机号 |
| `order_status` | 查询订单状态（实验性，可能需要登录态） |
| `session_status` | 查看当前门店/购物车/会话状态，便于排障 |

### 明确不做

- **不处理支付**：`place_order` 成功后订单处于“未支付”，用餐人需在 15 分钟内到肯德基 App / H5「我的订单」完成微信/支付宝支付；超时自动取消。本 MCP 不接触支付密码、验证码、银行卡。
- **不保存账号密码**：默认免登录点餐（H5 的「免登录点餐」能力）。会员价、优惠券、大神卡、积分等需要登录的权益暂未接入。
- **不绕过风控**：若肯德基触发人机验证（geetest），工具会返回提示，需要用餐人在 App/H5 内完成。
- **不做预约时段**：默认“尽快取餐”。H5 的「预约」选时间尚未封装（接口已具备，后续可加）。

---

## 2. 环境要求

- Node.js **≥ 18.17**（建议 20/22/24）
- 能直连 `order.kfc.com.cn`、`store.kfc.com.cn`（如公司网络有代理，请给 Hermes 进程配置 `HTTPS_PROXY`）
- Hermes Agent（标准安装已含 MCP 支持）

---

## 3. 安装与构建

```powershell
git clone <this-repo> kfc-cn-mcp
cd kfc-cn-mcp
npm install
npm run build
```

构建产物是 `dist/index.js`，Hermes 直接用 `node` 启动它，不需要常驻服务。

自检（会真实访问肯德基接口，只读 + 加购/清空购物车，**不会下单**）：

```powershell
npm run smoke
```

成功时最后一行是 `SMOKE OK`。

---

## 4. 接入 Hermes

### 4.1 写入 `~/.hermes/config.yaml`

把下面的片段合并进 `mcp_servers`（Windows 示例，路径改成你的实际路径）：

```yaml
mcp_servers:
  kfc_cn:
    command: "node"
    args:
      - "C:/Users/你的用户名/kfc-cn-mcp/dist/index.js"
    env:
      KFC_STATE_DIR: "C:/Users/你的用户名/.kfc-cn-mcp"
      # 默认城市：上海 310100；北京 110100；深圳 440300；广州 440100
      KFC_CITY_CODE: "310100"
      # 默认坐标（用于“附近门店”推荐，可改成你的常用位置）
      KFC_LATITUDE: "31.2304"
      KFC_LONGITUDE: "121.4737"
    timeout: 60
    connect_timeout: 20
    tools:
      include:
        - find_stores
        - select_store
        - get_menu
        - search_menu
        - get_item
        - cart_add
        - cart_set_quantity
        - cart_remove
        - cart_clear
        - cart_view
        - preview_order
        - place_order
        - order_status
        - session_status
      prompts: false
      resources: false
```

完整可复制版本见 [`hermes/config.snippet.yaml`](hermes/config.snippet.yaml)。

### 4.2 或者用 `hermes mcp add`

```powershell
hermes mcp add kfc_cn --command node --args "C:\path\to\kfc-cn-mcp\dist\index.js"
```

然后编辑 `~/.hermes/config.yaml` 补上 `env` 和 `tools.include`（`hermes mcp add` 不一定支持一次写入全部字段）。

### 4.3 验证

```powershell
hermes mcp test kfc_cn
```

应能看到 14 个工具。然后在 Hermes 会话里：

```text
/reload-mcp
```

问一句：「用 kfc_cn 的工具查一下上海淮海路附近的肯德基」。

Hermes 注册后的工具名形如：

```text
mcp_kfc_cn_find_stores
mcp_kfc_cn_select_store
mcp_kfc_cn_search_menu
mcp_kfc_cn_cart_add
mcp_kfc_cn_preview_order
mcp_kfc_cn_place_order
...
```

### 4.4 收紧权限（推荐）

如果只想让 Hermes 查菜单、不想让它下单，把 `place_order` 从 `tools.include` 里删掉即可；购物车工具可以保留。

Hermes 支持 `tools.exclude`，也可以反过来只排除危险工具：

```yaml
    tools:
      exclude: [place_order]
```

### 4.5 装配套 Skill（可选）

`hermes/skills/kfc-cn-ordering/SKILL.md` 是一份 Hermes Skill，教模型按正确顺序调用工具、什么时候必须停下来让用户确认。复制到 Hermes 技能目录：

```powershell
# Windows
Copy-Item -Recurse hermes\skills\kfc-cn-ordering "$env:USERPROFILE\.hermes\skills\"

# macOS / Linux
mkdir -p ~/.hermes/skills
cp -r hermes/skills/kfc-cn-ordering ~/.hermes/skills/
```

之后在 Hermes 里输入 `/kfc-cn-ordering` 或直接说“帮我点肯德基”，它会按 Skill 的流程执行。

---

## 5. 使用示例

```text
你：帮我看看上海淮海路附近有哪些肯德基。
AI：（find_stores keyword=淮海路 cityCode=310100）
    附近有「淮海路餐厅 SH1146」「淮海路新金钟餐厅 SH2103」…

你：选淮海路餐厅，看看有什么汉堡。
AI：（select_store storeCode=SH1146 → get_menu category=汉堡卷）
    培根鸡腿肉霸堡 ¥24.90、泰夯Q虾鸡腿肉霸堡 ¥24.90…

你：来一个培根鸡腿肉霸堡，再加一个特大号鸡腿桶。
AI：（cart_add → cart_view）
    购物车：培根鸡腿肉霸堡 ×1、S特大号鸡腿桶 ×1，合计 ¥64.80

你：可以，手机号 138****8000，堂食。
AI：（preview_order → place_order confirm=true phone=… previewToken=…）
    订单已提交：订单号 1793…，合计 ¥64.80。
    请在 15 分钟内到肯德基 App「我的订单」完成支付。
```

### 套餐选择

`get_item` 会返回：

```json
{
  "comboRounds": [
    {
      "roundId": "1",
      "name": "小食",
      "minCount": 2,
      "maxCount": 2,
      "items": [{ "linkId": "100129945", "name": "特大号鸡腿1个", "maxCount": 2 }]
    }
  ]
}
```

加购时可以显式指定：

```json
{
  "items": [
    {
      "linkId": "100129947",
      "quantity": 1,
      "selections": { "1": [{ "linkId": "100129945", "quantity": 2 }] }
    }
  ]
}
```

不传 `selections` 时，会按每轮 `minCount` 自动选第一个可选项（与 H5 默认行为一致）。

---

## 6. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KFC_STATE_DIR` | `~/.kfc-cn-mcp` | 会话 cookie、sessionId、菜单缓存、购物车状态目录 |
| `KFC_CITY_CODE` | `310100` | 默认城市国标码（`find_stores` 未传 `cityCode` 时使用） |
| `KFC_LATITUDE` / `KFC_LONGITUDE` | `31.2304` / `121.4737` | 默认坐标（上海人民广场），用于附近门店与切换门店时的距离计算 |
| `KFC_HTTP_TIMEOUT_MS` | `20000` | 单次接口超时 |

城市国标码示例：北京 `110100`、上海 `310100`、广州 `440100`、深圳 `440300`、杭州 `330100`、成都 `510100`、南京 `320100`、武汉 `420100`。

---

## 7. 状态与并发

- 状态保存在 `KFC_STATE_DIR/session.json`（cookie + sessionId + 购物车）与 `menu.json`（菜单缓存，30 分钟有效）。
- 每个 Hermes 会话会拉起一个 MCP 进程；同一时间只应有一个进程操作同一个 `KFC_STATE_DIR`，否则购物车会互相覆盖。多开时给每个进程设置不同的 `KFC_STATE_DIR`。
- `session.json` 里有肯德基会话 cookie，属于敏感文件；不要提交到 Git（项目已 `.gitignore`）。

---

## 8. 故障排查

| 现象 | 原因/处理 |
| --- | --- |
| `无法连接肯德基接口 … ECONNRESET / ETIMEDOUT` | 网络或代理问题。给 Hermes 配 `HTTPS_PROXY`，或换网络。 |
| `初始化门店菜单失败：参数错误` | 接口/版本变化，或门店不支持自取。先 `find_stores` 换门店。 |
| `会话已过期` | 已自动重建会话并重试；若仍失败，重新 `select_store`。 |
| `商品校验失败，可能已售罄` | 菜单缓存过期，`get_menu(refresh=true)` 后重新加购。 |
| `触发人机验证` | 肯德基风控，需在 App/H5 人工完成，MCP 无法绕过。 |
| `hermes mcp test` 失败 | 检查 `node` 是否在 PATH、`args` 是否是绝对路径、`dist/index.js` 是否已构建。 |
| 工具列表里没有 `place_order` | 被 `tools.include/exclude` 过滤了。 |
| 下单成功但没看到支付入口 | 打开肯德基 App →「我的」→「订单」，或 `order.kfc.com.cn` 的订单页；未支付订单 15 分钟后取消。 |

---

## 9. 实现说明（给维护者）

详细接口笔记见 [`docs/API-NOTES.md`](docs/API-NOTES.md)。核心点：

- H5 入口：`https://order.kfc.com.cn/preorder-taro/menu`
- 预订单接口：`https://order.kfc.com.cn/preorder-portal`
- 门店接口：`https://order.kfc.com.cn/store-portal`
- 每个请求带 `kbck` / `kbcts` / `kbsv` 三个头；`kbsv = md5(client_key \t client_sec \t 时间戳 \t 路径 \t\t 完整 JSON body)`。
- `encodeList` 里的字段（手机号、经纬度、门店坐标等）用 DES-CBC（key=iv=`D963r1wp`，PKCS7，Base64）加密。
- `cart/update` 的 `quantity` 是**增量**而不是绝对值（已实测）；删除用 `cart/clearItem`。
- 这些常量来自公开 H5 bundle，官方改版后可能需要重新提取；代码里集中在 `src/crypto.ts`，便于更新。

---

## 10. 合规与免责

- 仅供**个人学习与自用**。请遵守肯德基用户协议、门店规则与当地法律。
- 请勿用于代下单、黄牛、批量刷单、爬取价格或其他商业用途。
- 下单会产生**真实订单**（未支付也会占用门店产能），请确保用餐人确认后再调用 `place_order`。
- 项目与肯德基（Yum China）无关联；接口可能随时变更，维护者不对下单失败、价格变动、订单取消等负责。
- 参考项目：[markswendsen-code/mcp-kfc](https://github.com/markswendsen-code/mcp-kfc)（MIT）。

---

## 11. License

MIT
