# 肯德基中国 H5 接口笔记

本文件记录 `kfc-cn-mcp` 依赖的接口细节，方便官方改版后维护。所有内容来自公开的 H5 前端 bundle（`https://order.kfc.com.cn/preorder-taro/js/app.*.js`）与真实请求抓包，仅用于互操作。

> 接口随时可能变更；改版后优先重新抓包，并更新 `src/crypto.ts` 与本文。

## 1. 域名与路径

| 用途 | Base |
| --- | --- |
| 预订单/菜单/购物车/订单 | `https://order.kfc.com.cn/preorder-portal` |
| 门店搜索/校验 | `https://order.kfc.com.cn/store-portal` |
| H5 页面 | `https://order.kfc.com.cn/preorder-taro/menu?label=preorder` |

H5 的 `kfcPreDomain` 配置：`https://order.kfc.com.cn/preorder-portal`；`storesDomain`：`https://order.kfc.com.cn/store-portal`。

## 2. 请求头与签名（KBS）

每个 POST 都带：

```http
content-type: application/json
origin: https://order.kfc.com.cn
referer: https://order.kfc.com.cn/preorder-taro/menu?label=preorder
x-yumc-route-channel: h5
x-yumc-route-cell: <env>            # 初始化响应里的 env，例如 yumc1
kbck: kbwapzJAAUs1g2od              # client_key (kfc.WEB)
kbcts: 1793185498174                # 毫秒时间戳
kbsv: ab04b13a568f20fcbbb8291b14ec3cb0
cookie: sessionIdCookie=...; sessionIdCookie.sig=...; route-cell=yumc1; ...
```

签名串（POST）：

```
{client_key}\t{client_sec}\t{timestamp}\t{path}\t\t{JSON.stringify(body)}
```

`kbsv = md5(签名串)`，小写 hex。注意：

- `path` 是接口路径（`/api/v2/...`），不含域名和 base。
- body 必须与实际发送的字节完全一致（字段顺序、空格都会影响签名）。
- 先加密 `encodeList` 字段，再序列化、再签名。

`client_key` / `client_sec`（kfc.WEB）：

```
kbwapzJAAUs1g2od
fegFLVMJJ88If2hp
```

这些值在 bundle 的 `kbsInfo` 数组里是分片 + Base64 混淆的：把所有片段拼起来 Base64 解码，得到 `[["kfc.WEB",{"client_key":"...","client_sec":"..."}], ...]`。

## 3. 字段加密（encodeList）

请求体里的 `encodeList` 列出需要加密的字段路径（支持 `a.b.c`）。加密算法：

- DES-CBC，PKCS7 padding
- key = iv = `D963r1wp`（brand `kfc` 的 `apiSecretKey`；从 bundle 的 `["RDk","2M3","Ixd","3A$"]` 拼成 `RDk2M3Ixd3A=` 再 Base64 解码得到）
- 输出 Base64

Node 的 OpenSSL 3 禁用了单 DES，本项目用 3DES-EDE（三个子密钥相同）等价实现，见 `src/crypto.ts`。

响应里若带 `encodeList`，对应字段用同一算法解密（本项目当前只发不收加密字段）。

## 4. 公共参数

```json
{
  "portalType": "WAP",
  "channelName": "Mobile Web",
  "channelId": "13",
  "brand": "KFC_PRE",
  "business": "preorder",
  "sessionId": "...",
  "deviceId": "...",
  "clientVersion": "v6.910(b42759d4)",
  "fversion": "20260914",
  "versionNum": "5",
  "env": "yumc1",
  "encodeList": [],
  "isFromCustomerClient": true,
  "secretKey": "kfc"
}
```

`deviceId` 是 H5 随机生成的 16 字节 base64url；`sessionId` 由 init 接口返回。

## 5. 初始化（选最近门店 + 菜单 + 购物车）

`POST /preorder-portal/api/v2/init/combine/preorder`

```json
{
  "portalType": "WAP",
  "channelName": "Mobile Web",
  "channelId": "13",
  "brand": "KFC_PRE",
  "business": "preorder",
  "deviceId": "...",
  "clientVersion": "v6.910(b42759d4)",
  "fversion": "20260914",
  "versionNum": "5",
  "body": { "geoLocation": { "lng": "<DES(121.4737)>", "lat": "<DES(31.2304)>" } },
  "userLongitude": "<DES>",
  "userLatitude": "<DES>",
  "encodeList": ["body.geoLocation.lng", "body.geoLocation.lat", "userLatitude", "userLongitude"],
  "isFromCustomerClient": true,
  "secretKey": "kfc"
}
```

响应：

```json
{
  "code": 0,
  "data": {
    "sessionId": "...",
    "dataRecommend": { "stores": [...], "storeRecommend": {...} },
    "dataCart": { "cart": { "id": "...", "items": [], "total": 0 } },
    "dataMenu": { "menuData": [ { "nameCn": "...", "menuList": [], "childClassList": [...] } ] }
  },
  "env": "yumc1"
}
```

**注意**：`init/combine/preorder` 会忽略请求里的 `storeCode`，永远选离 `geoLocation` 最近的门店。要指定门店必须走第 7 节的切换流程。

## 6. 门店搜索

`POST /store-portal/api/v2/store/searchByLbs`

```json
{ "...common": "...", "mylat": "<DES(lat)>", "mylng": "<DES(lng)>", "callScene": "menuScene",
  "encodeList": ["mylat", "mylng"], "isFromCustomerClient": true, "secretKey": "kfc" }
```

`POST /store-portal/api/v2/store/searchByCityCodeAndKeyword`

```json
{ "...common": "...", "gbCityCode": "310100", "keyword": "淮海路", "encodeList": [] }
```

响应 `data.stores[]`，字段：`storecode`、`storename`、`address`、`lat`、`lng`、`distance`、`starttime`、`endtime`、`status`、`typeCode`、`bookingMerge` 等。

## 7. 切换门店（关键）

H5 的切换流程是四步：

1. `POST /store-portal/api/v2/store/validStore`

```json
{ "...common": "...", "portalSource": "", "ticket": "", "storeCode": "SH1146",
  "mylat": "<DES(lat)>", "mylng": "<DES(lng)>",
  "encodeList": ["mylat", "mylng"], "isFromCustomerClient": true, "secretKey": "kfc" }
```

响应 `data.store`：完整门店对象，含 `lat`、`lng`、`bookingExt`、`storePublicSign` 等。

2. `POST /preorder-portal/api/v2/cart/changeStoreOrAddress`

```json
{ "...common": "...", "store": { "...完整门店对象，lat/lng/phone 用 DES 加密": "..." },
  "scene": 1, "userLongitude": "<DES>", "userLatitude": "<DES>",
  "encodeList": ["userLatitude","userLongitude","store.phone","store.subStores.phone",
                  "store.lat","store.lng","store.subStores.lat","store.subStores.lng"],
  "isFromCustomerClient": true, "secretKey": "kfc" }
```

3. `POST /preorder-portal/api/v2/cart/create`

与第 2 步相同，另加 `"changeMode": 2`。响应 `data.cart` 是新门店的购物车。

4. `POST /preorder-portal/api/v2/menu/list`

```json
{ "...common": "...", "store": { "...完整门店对象，lat/lng 用明文": "..." },
  "env": "yumc1", "encodeList": [], "isFromCustomerClient": true, "secretKey": "kfc" }
```

响应 `data.menuData`，结构与 init 的菜单一致；门店切换后菜单可能比 init 更全（例如 109 vs 33 个商品）。

## 8. 菜单

- 菜单树：`menuData[]`，每个分类有 `menuList[]`，或 `childClassList[].menuList[]`（二级分类）。
- 商品字段：`linkId`、`nameCn`、`showNameCn`、`price`（分）、`priceInitial`、`menuFlag`（`P` 单品 / `S` 套餐 / `G` 会员商品）、`menuFlagType`、`descCn`、`maxQty`、`saleFlag`、`stockFlag`、`viewOptionValues`。
- 套餐详情：`POST /api/v3/menu/detail`，body `{ descNeed: true, linkId }`。响应 `data.superComboDetail.roundList[]`：
  - `roundId`、`roundName`、`riMinCount`、`riMaxCount`
  - `itemList[]`：`linkId`、`nameCn`、`showNameCn`、`price`、`maxCount`、`saleFlag`

## 9. 购物车

- `POST /api/v2/cart/update`：body `items[]`。

  ```json
  { "linkId": "100047613", "quantity": 1, "card": false, "itemType": 0,
    "menuFlag": "P", "menuFlagType": "1" }
  ```

  **`quantity` 是增量**：购物车已有 1 份时再传 `quantity: 1` 会变成 2 份；传 `-1` 会减 1。这一点与 H5 的“全量重建”直觉不同，本项目已按增量实现。

  套餐 item：

  ```json
  { "linkId": "100129947", "quantity": 1, "card": false, "itemType": 13,
    "menuFlag": "S", "menuFlagType": "1",
    "superComboItems": [
      { "linkId": "100129945", "itemType": 2, "showNameCn": "特大号鸡腿BBN(天府椒麻风味)1个",
        "quantity": 2, "mealdealId": "1", "menuFlag": "P" },
      { "linkId": "1421", "itemType": 2, "showNameCn": "葡式蛋挞BBN(1只)",
        "quantity": 1, "mealdealId": "2", "menuFlag": "P" }
    ] }
  ```

  `mealdealId` 就是 `roundId`。

- `POST /api/v2/cart/clearItem`：`{ "cartId": "...", "itemId": "..." }`，删除一行。
- `POST /api/v2/cart/confirm`：`{ "cartId": "..." }`，结算预校验；响应 `data.cart`、`data.cartAmount`、`data.hasLogIn`、`data.invalidItems`。

## 10. 提交订单

`POST /api/v2/order/submit`

```json
{
  "...common": "...",
  "businessLine": "preorder",
  "phone": "<DES(13800138000)>",
  "packType": "2",
  "orderId": "<cartId>",
  "iremark": "不要辣",
  "env": "yumc1",
  "encodeList": ["phone"],
  "isFromCustomerClient": true,
  "secretKey": "kfc"
}
```

- `packType`：`1` = 外带（carryout），`2` = 堂食（dinein）。
- `orderId` 传购物车 id（`cartId`）。
- 服务端按当前 session 的购物车校验；购物车为空时返回 `100330215 无购买餐品`。
- 手机号为空/格式错：`100330241 电话不正确`。
- 请求设置 `needFingerPrint: true`，可能触发 geetest 人机验证。

成功响应会包含订单号（字段可能是 `data.orderId` 或 `data.order.orderId`），随后 H5 会跳转收银台；本项目只返回订单号，支付由用餐人在 App/H5 完成。

## 11. 订单状态

`POST /api/v2/order/getOrderStatusById`，body `{ orderId, brand: "KFC_PRE", businessLine: "preorder" }`。

该接口在未登录/无订单时会返回 `100340600 无法获取订单品牌数据`，因此标为实验性。

## 12. 错误码（常见）

| code | 含义 | 处理 |
| --- | --- | --- |
| `120000404` | 入参没有 sessionId | 先 init / select_store |
| `100250001` | 参数错误 | 检查门店/菜单是否变化 |
| `100060154` | 产品验证失败 | 刷新菜单、重选商品 |
| `100330215` | 无购买餐品 | 购物车为空 |
| `100330241` | 电话不正确 | 11 位手机号 |
| `120000999` / 9 位且以 `006` 结尾 | session 失效 | 重建会话后重试 |
| `100340600` | 订单品牌数据缺失 | 订单状态接口需要登录态 |

## 13. 改版后如何更新常量

1. 打开 `https://order.kfc.com.cn/preorder-taro/menu`，下载 `js/app.*.js`。
2. 搜索 `kbsInfo`，取出后面的字符串数组，拼接后 Base64 解码，找 `kfc.WEB` 的 `client_key` / `client_sec`。
3. 搜索 `apiSecretKey`，找 `"kfc"` 对应的分片（形如 `["RDk","2M3","Ixd","3A$"]`），用 `$` 替换成 `=` 后 Base64 解码，得到 8 位 DES key。
4. 更新 `src/crypto.ts` 中的 `KBS_CLIENT_KEY`、`KBS_CLIENT_SEC`、`DES_KEY`，跑 `npm run smoke`。

抓包时最容易漏的是 `kbck/kbcts/kbsv` 与 `encodeList`：少一个就会得到 `参数错误` 或签名失败。
