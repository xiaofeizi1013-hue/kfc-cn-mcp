import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { KfcClient, KfcError } from './client.js';
import { findMenuItem, lineKey, searchMenu, yuan } from './menu.js';
import type { CartLine, CartState, ParsedMenu, StoreSummary } from './types.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

interface ToolEnvelope {
  ok: boolean;
  [key: string]: unknown;
}

function ok(payload: Omit<ToolEnvelope, 'ok'>): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, ...payload }, null, 2),
      },
    ],
  };
}

function fail(error: unknown): ToolResult {
  if (error instanceof KfcError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: false,
              error: {
                message: error.message,
                code: error.code ?? null,
                hint: error.hint ?? null,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { ok: false, error: { message, code: null, hint: null } },
          null,
          2,
        ),
      },
    ],
  };
}

function storeView(store: StoreSummary): Record<string, unknown> {
  return {
    storeCode: store.storeCode,
    name: store.name,
    address: store.address ?? '',
    city: store.cityName ?? '',
    distanceMeters: store.distanceMeters ?? null,
    openHours:
      store.openTime && store.closeTime ? `${store.openTime}-${store.closeTime}` : null,
    status: store.status ?? null,
    statusText: store.statusText ?? '',
    phone: store.phone ?? '',
    takeMealPlace: store.takeMealPlace ?? '',
  };
}

function menuItemView(
  item: ParsedMenu['items'][number],
  options: { withCategory?: boolean } = {},
): Record<string, unknown> {
  const view: Record<string, unknown> = {
    linkId: item.linkId,
    name: item.name,
    priceCents: item.priceCents,
    price: yuan(item.priceCents),
    isCombo: item.isCombo,
    needsOptions: item.needsOptions,
  };
  if (item.originalPriceCents && item.originalPriceCents > item.priceCents) {
    view.originalPriceCents = item.originalPriceCents;
    view.originalPrice = yuan(item.originalPriceCents);
  }
  if (item.maxQuantity != null) view.maxQuantity = item.maxQuantity;
  if (options.withCategory) {
    view.category = item.category;
    if (item.parentCategory) view.parentCategory = item.parentCategory;
  }
  return view;
}

function cartView(cart: CartState | undefined): Record<string, unknown> {
  if (!cart || cart.lines.length === 0) {
    return {
      empty: true,
      items: [],
      total: yuan(0),
      totalCents: 0,
      hint: '购物车是空的，先调用 cart_add 添加餐品。',
    };
  }
  return {
    empty: false,
    cartId: cart.cartId,
    items: cart.lines.map((line) => ({
      lineKey: line.key,
      linkId: line.linkId,
      name: line.name,
      quantity: line.quantity,
      unitPrice: yuan(line.unitPriceCents),
      lineTotal: yuan(line.unitPriceCents * line.quantity),
      ...(line.selections ? { selections: line.selections } : {}),
    })),
    total: yuan(cart.totalCents),
    totalCents: cart.totalCents,
  };
}

function logTool(name: string, started: number, extra = ''): void {
  const ms = Date.now() - started;
  process.stderr.write(`[kfc-cn-mcp] ${name} ${ms}ms${extra ? ` ${extra}` : ''}\n`);
}

const phoneSchema = z
  .string()
  .describe('取餐联系电话，11 位中国大陆手机号（如 13800138000）');

export function createServer(client: KfcClient): McpServer {
  const server = new McpServer(
    { name: 'kfc-cn', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'KFC China ordering. Order flow: find_stores -> select_store -> search_menu/get_item -> cart_add -> preview_order -> place_order(confirm=true, phone). Prices are in cents in JSON and formatted in `price`. This server never handles payment: after place_order the diner must pay in the KFC app/H5.',
    },
  );

  // ── stores ──────────────────────────────────────────────────────────────

  server.registerTool(
    'find_stores',
    {
      title: 'Find KFC China stores',
      description:
        'Find KFC China restaurants by 门店关键词 + 城市国标码 (gbCityCode, e.g. 310100 = Shanghai) or by latitude/longitude. Returns storeCode you pass to select_store. 查询肯德基门店，返回 storeCode。',
      inputSchema: {
        keyword: z
          .string()
          .min(1)
          .optional()
          .describe('门店/地址关键词，如“淮海路”“人民广场”'),
        cityCode: z
          .string()
          .min(4)
          .optional()
          .describe('城市国标码 gbCityCode，例如上海 310100、北京 110100、深圳 440300'),
        latitude: z.number().min(-90).max(90).optional().describe('纬度，配合 longitude 使用'),
        longitude: z.number().min(-180).max(180).optional().describe('经度，配合 latitude 使用'),
        limit: z.number().int().min(1).max(20).default(8).describe('返回数量上限'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ keyword, cityCode, latitude, longitude, limit }) => {
      const started = Date.now();
      try {
        const hasGeo = latitude != null && longitude != null;
        if (!hasGeo && !keyword) {
          throw new KfcError('请提供 keyword（配合 cityCode）或 latitude/longitude。', {
            hint: '例如 keyword="淮海路", cityCode="310100"；或 latitude=31.23, longitude=121.47。',
          });
        }
        const stores = hasGeo
          ? await client.searchStoresByLbs(latitude, longitude)
          : await client.searchStoresByKeyword(keyword as string, cityCode);
        const sorted = [...stores].sort(
          (a, b) => (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER),
        );
        const result = ok({
          count: Math.min(sorted.length, limit),
          total: sorted.length,
          stores: sorted.slice(0, limit).map(storeView),
          hint:
            sorted.length === 0
              ? '没有找到门店，换个关键词或坐标再试。'
              : '调用 select_store(storeCode) 选定门店后会加载该店菜单。',
        });
        logTool('find_stores', started, `count=${sorted.length}`);
        return result;
      } catch (error) {
        logTool('find_stores', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'select_store',
    {
      title: 'Select store',
      description:
        'Bind the ordering session to one KFC China store by storeCode and load its live menu. 选定门店并加载菜单；之后所有购物车/下单都针对该门店。',
      inputSchema: {
        storeCode: z.string().min(2).describe('门店编码，来自 find_stores 的 storeCode，例如 SH2103'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ storeCode }) => {
      const started = Date.now();
      try {
        const hadCart = (client.cart?.lines.length ?? 0) > 0;
        await client.ensureSession(storeCode);
        const store = client.currentStore;
        if (!store || store.storeCode !== storeCode) {
          throw new KfcError(`无法切换到门店 ${storeCode}。`, {
            hint: '确认 storeCode 是否正确、门店是否营业。',
          });
        }
        const menu = await client.getMenu({ storeCode });
        const result = ok({
          store: storeView(store),
          menu: {
            categories: menu.categories.length,
            items: menu.items.length,
          },
          cartCleared: hadCart ? Boolean(client.cart === undefined || client.cart.lines.length === 0) : false,
          hint: '调用 get_menu 看分类，search_menu 搜索餐品，cart_add 加购。',
        });
        logTool('select_store', started, storeCode);
        return result;
      } catch (error) {
        logTool('select_store', started, 'error');
        return fail(error);
      }
    },
  );

  // ── menu ────────────────────────────────────────────────────────────────

  server.registerTool(
    'get_menu',
    {
      title: 'Get menu',
      description:
        'List the selected store menu: categories with item counts, or all items of one category. 查看菜单分类或某个分类下的餐品（linkId/价格/是否需要选规格）。',
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe('分类名（支持模糊匹配），如“汉堡卷”“饮品”“早餐”'),
        includeItems: z
          .boolean()
          .default(false)
          .describe('为 true 时不传 category 也返回每个分类的前若干个餐品'),
        limit: z.number().int().min(1).max(200).default(60).describe('返回餐品数量上限'),
        refresh: z.boolean().default(false).describe('为 true 时强制刷新菜单缓存'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ category, includeItems, limit, refresh }) => {
      const started = Date.now();
      try {
        const menu = await client.getMenu({ force: refresh });
        if (category) {
          const needle = category.toLowerCase();
          const matches = menu.categories.filter(
            (c) =>
              c.name.toLowerCase().includes(needle) ||
              (c.parent ?? '').toLowerCase().includes(needle),
          );
          if (matches.length === 0) {
            return ok({
              store: client.currentStore ? storeView(client.currentStore) : null,
              category,
              matchedCategories: [],
              items: [],
              hint: `没有匹配的分类。可用分类：${menu.categories.map((c) => c.name).join('、')}`,
            });
          }
          const items = matches.flatMap((c) => c.items).slice(0, limit);
          logTool('get_menu', started, `category=${category} items=${items.length}`);
          return ok({
            store: client.currentStore ? storeView(client.currentStore) : null,
            category,
            matchedCategories: matches.map((c) => ({
              name: c.name,
              parent: c.parent ?? null,
              itemCount: c.itemCount,
            })),
            count: items.length,
            items: items.map((item) => menuItemView(item, { withCategory: true })),
            hint: '需要套餐可选项时调用 get_item(linkId)；加购调用 cart_add。',
          });
        }

        const categories = menu.categories.map((c) => ({
          name: c.name,
          parent: c.parent ?? null,
          itemCount: c.itemCount,
          ...(includeItems
            ? { sampleItems: c.items.slice(0, 3).map((i) => menuItemView(i)) }
            : {}),
        }));
        logTool('get_menu', started, `categories=${categories.length}`);
        return ok({
          store: client.currentStore ? storeView(client.currentStore) : null,
          totalItems: menu.items.length,
          categories,
          hint: '用 get_menu(category="…") 查看分类餐品，或 search_menu(query="…") 搜索。',
        });
      } catch (error) {
        logTool('get_menu', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'search_menu',
    {
      title: 'Search menu',
      description:
        'Fuzzy-search dishes in the selected store menu by Chinese name/description. 按中文名/描述搜索餐品，返回 linkId、价格、是否需要选规格。',
      inputSchema: {
        query: z.string().min(1).describe('搜索词，如“原味鸡”“蛋挞”“咖啡”'),
        limit: z.number().int().min(1).max(30).default(8),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      const started = Date.now();
      try {
        const menu = await client.getMenu();
        const items = searchMenu(menu, query, limit);
        logTool('search_menu', started, `query=${query} hits=${items.length}`);
        return ok({
          query,
          count: items.length,
          items: items.map((item) => menuItemView(item, { withCategory: true })),
          hint:
            items.length === 0
              ? '没搜到，试试更短的关键词，或 get_menu 查看分类。'
              : '套餐用 get_item 查看可选内容；cart_add 支持 selections。',
        });
      } catch (error) {
        logTool('search_menu', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get item detail',
      description:
        'Get dish detail plus combo rounds (套餐可选内容) and option groups. 查商品详情；套餐会返回 comboRounds（roundId、可选商品、最少/最多份数）。',
      inputSchema: {
        linkId: z.string().optional().describe('商品 linkId，例如 100129947'),
        name: z.string().optional().describe('商品名（模糊匹配），与 linkId 二选一'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ linkId, name }) => {
      const started = Date.now();
      try {
        let id = linkId;
        let category: string | undefined;
        if (!id) {
          if (!name) throw new KfcError('请提供 linkId 或 name。');
          const menu = await client.getMenu();
          const item = findMenuItem(menu, name);
          if (!item) throw new KfcError(`菜单里没有找到“${name}”。`);
          id = item.linkId;
          category = item.category;
        }
        const detail = await client.getItemDetail(id);
        logTool('get_item', started, id);
        return ok({
          item: {
            linkId: detail.linkId,
            name: detail.name,
            category: category ?? null,
            price: yuan(detail.priceCents),
            priceCents: detail.priceCents,
            originalPrice:
              detail.originalPriceCents && detail.originalPriceCents > detail.priceCents
                ? yuan(detail.originalPriceCents)
                : null,
            description: detail.description ?? '',
            isCombo: detail.isCombo,
            comboRounds: detail.comboRounds.map((round) => ({
              roundId: round.roundId,
              name: round.name,
              minCount: round.minCount,
              maxCount: round.maxCount,
              items: round.items.map((i) => ({
                linkId: i.linkId,
                name: i.name,
                showName: i.showName ?? i.name,
                price: i.priceCents != null ? yuan(i.priceCents) : null,
                maxCount: i.maxCount ?? null,
                available: i.available,
              })),
            })),
            optionGroups: detail.optionGroups,
          },
          hint: detail.isCombo
            ? 'cart_add 的 selections 形如 {"1":[{"linkId":"100129945","quantity":2}]}，key 为 roundId；不传则自动按最少份数选第一个可选项。'
            : '可直接 cart_add。',
        });
      } catch (error) {
        logTool('get_item', started, 'error');
        return fail(error);
      }
    },
  );

  // ── cart ────────────────────────────────────────────────────────────────

  server.registerTool(
    'cart_add',
    {
      title: 'Add to cart',
      description:
        'Add dishes to the cart (套餐可传 selections；不传则按套餐最少份数自动选择). 加购；数量累加，套餐会自动选默认规格。',
      inputSchema: {
        items: z
          .array(
            z.object({
              linkId: z.string().min(1).describe('商品 linkId'),
              quantity: z.number().int().min(1).max(99).default(1),
              selections: z
                .record(
                  z.string(),
                  z.array(
                    z.object({
                      linkId: z.string().min(1),
                      quantity: z.number().int().min(1).max(99).default(1),
                    }),
                  ),
                )
                .optional()
                .describe('套餐选择：{"roundId":[{"linkId":"…","quantity":1}]}'),
            }),
          )
          .min(1)
          .max(20),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ items }) => {
      const started = Date.now();
      try {
        const menu = await client.getMenu();
        const cart = await client.addToCart(
          items.map((item) => ({
            linkId: item.linkId,
            quantity: item.quantity,
            selections: item.selections,
          })),
          menu,
        );
        logTool('cart_add', started, `items=${items.length}`);
        return ok({
          cart: cartView(cart),
          hint: '继续加购，或调用 preview_order 核对金额。',
        });
      } catch (error) {
        logTool('cart_add', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'cart_set_quantity',
    {
      title: 'Set cart quantity',
      description:
        'Set the quantity of one cart line (0 removes it). 修改购物车某一行的数量，0 表示删除；lineKey 来自 cart_view。',
      inputSchema: {
        lineKey: z.string().min(1).describe('cart_view 返回的 lineKey（也可以用 linkId）'),
        quantity: z.number().int().min(0).max(99),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ lineKey: key, quantity }) => {
      const started = Date.now();
      try {
        const cart = await client.setQuantity(key, quantity);
        logTool('cart_set_quantity', started, `${key} -> ${quantity}`);
        return ok({ cart: cartView(cart) });
      } catch (error) {
        logTool('cart_set_quantity', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'cart_remove',
    {
      title: 'Remove cart line',
      description: 'Remove one line from the cart by lineKey or linkId. 删除购物车中的一行。',
      inputSchema: {
        lineKey: z.string().min(1).describe('cart_view 返回的 lineKey（也可以用 linkId）'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ lineKey: key }) => {
      const started = Date.now();
      try {
        const cart = await client.removeLine(key);
        logTool('cart_remove', started, key);
        return ok({ cart: cartView(cart) });
      } catch (error) {
        logTool('cart_remove', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'cart_clear',
    {
      title: 'Clear cart',
      description: 'Remove every dish from the cart. 清空购物车。',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const started = Date.now();
      try {
        await client.clearCart();
        logTool('cart_clear', started);
        return ok({ cart: { empty: true, items: [], total: yuan(0) } });
      } catch (error) {
        logTool('cart_clear', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'cart_view',
    {
      title: 'View cart',
      description: 'Show cart lines, quantities and total. 查看购物车。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const started = Date.now();
      try {
        const cart = client.cart;
        const result = ok({
          cart: cartView(cart),
          store: client.currentStore ? storeView(client.currentStore) : null,
        });
        logTool('cart_view', started);
        return result;
      } catch (error) {
        logTool('cart_view', started, 'error');
        return fail(error);
      }
    },
  );

  // ── checkout ────────────────────────────────────────────────────────────

  server.registerTool(
    'preview_order',
    {
      title: 'Preview order',
      description:
        'Server-side price/stock validation before ordering (locks the current price) and returns a previewToken for place_order. 结算预校验，返回金额、门店、是否需登录和 previewToken（10 分钟内有效）。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const started = Date.now();
      try {
        const preview = await client.previewOrder();
        const token = client.previewToken(preview);
        logTool('preview_order', started, `total=${preview.totalCents}`);
        return ok({
          preview: {
            items: preview.items.map((i) => ({
              name: i.name,
              quantity: i.quantity,
              priceCents: i.priceCents,
              price: yuan(i.priceCents),
            })),
            goods: yuan(preview.goodsCents),
            packaging: yuan(preview.packCents),
            delivery: yuan(preview.deliveryCents),
            discount: yuan(preview.discountCents),
            total: yuan(preview.totalCents),
            totalCents: preview.totalCents,
            store: preview.store ? storeView(preview.store) : null,
            requiresLogin: preview.requiresLogin,
            warnings: preview.warnings,
          },
          previewToken: token,
          next: [
            '向用餐人确认门店、餐品、金额和手机号。',
            '确认后调用 place_order：confirm=true、phone=11 位手机号、packType=dinein|takeaway、previewToken。',
            '下单成功后需在肯德基 App/H5 内完成支付；本服务不处理支付。',
          ],
        });
      } catch (error) {
        logTool('preview_order', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'place_order',
    {
      title: 'Place order',
      description:
        'Submit the previewed order to KFC China. Requires confirm=true, the previewToken from preview_order and the diner phone. Creates a real unpaid order; payment must be completed by the diner in the KFC app/H5. 真实下单（会生成未支付订单），必须显式 confirm=true。',
      inputSchema: {
        confirm: z
          .literal(true)
          .describe('必须显式传 true，表示用餐人已确认门店/餐品/金额'),
        phone: phoneSchema.describe('取餐联系电话，11 位中国大陆手机号'),
        packType: z
          .enum(['dinein', 'takeaway'])
          .default('dinein')
          .describe('dinein=堂食（默认），takeaway=外带'),
        previewToken: z
          .string()
          .min(8)
          .describe('preview_order 返回的 previewToken'),
        expectedTotalCents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('可选：用户确认的总金额（分），与预览不一致时拒绝下单'),
        remark: z.string().max(100).optional().describe('备注，例如“不要辣”“少冰”'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ phone, packType, previewToken, expectedTotalCents, remark, confirm }) => {
      const started = Date.now();
      try {
        if (confirm !== true) {
          throw new KfcError('place_order 需要显式 confirm=true。');
        }
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          throw new KfcError('手机号格式不正确，请提供 11 位中国大陆手机号。', {
            hint: '例如 13800138000；该号码仅用于取餐联系。',
          });
        }
        const result = await client.placeOrder({
          phone,
          packType,
          previewToken,
          expectedTotalCents,
          remark,
        });
        logTool('place_order', started, `order=${result.orderId}`);
        return ok({
          order: {
            orderId: result.orderId,
            total: yuan(result.totalCents),
            totalCents: result.totalCents,
            store: result.store ? storeView(result.store) : null,
          },
          payment: {
            required: true,
            note: '订单已在肯德基系统创建，但尚未支付。请在 15 分钟内打开肯德基 App 或 order.kfc.com.cn 的“我的订单”完成支付；超时订单会自动取消。本 MCP 不接触支付信息。',
          },
          next: [
            '让用餐人打开肯德基 App/H5 完成支付。',
            '支付后用 order_status(orderId) 查询状态（实验性接口，可能不可用）。',
          ],
        });
      } catch (error) {
        logTool('place_order', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'order_status',
    {
      title: 'Order status',
      description:
        'Check an order status by orderId (experimental; KFC may require the logged-in account). 查询订单状态，实验性接口。',
      inputSchema: {
        orderId: z.string().min(3).describe('place_order 返回的订单号'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ orderId }) => {
      const started = Date.now();
      try {
        const raw = await client.orderStatus(orderId);
        const code = raw.code as number | undefined;
        logTool('order_status', started, `code=${code}`);
        if (code !== 0) {
          return ok({
            orderId,
            available: false,
            message: String(raw.msg ?? raw.message ?? '接口未返回订单状态'),
            hint: '该接口可能需要登录态；请让用餐人在肯德基 App 的“订单”中查看。',
          });
        }
        return ok({ orderId, available: true, status: raw.data ?? raw });
      } catch (error) {
        logTool('order_status', started, 'error');
        return fail(error);
      }
    },
  );

  server.registerTool(
    'session_status',
    {
      title: 'Session status',
      description:
        'Show current store, cart, preview and session age for troubleshooting. 查看当前会话/门店/购物车状态。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const started = Date.now();
      try {
        const status = await client.status();
        logTool('session_status', started);
        return ok({ session: status });
      } catch (error) {
        logTool('session_status', started, 'error');
        return fail(error);
      }
    },
  );

  return server;
}
