import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { desEncrypt, kbsHeaders } from './crypto.js';
import { lineKey, parseItemDetail, parseMenu, parseStore } from './menu.js';
import type {
  CartLine,
  CartState,
  ItemDetail,
  OrderPreview,
  ParsedMenu,
  PersistedState,
  ServerCartItem,
  StoreSummary,
} from './types.js';

const PREORDER_BASE = 'https://order.kfc.com.cn/preorder-portal';
const STORE_BASE = 'https://order.kfc.com.cn/store-portal';
const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const SESSION_TTL_MS = 20 * 60 * 1000;
const MENU_TTL_MS = 30 * 60 * 1000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

const SESSION_EXPIRED_CODES = new Set([
  120000999, 100002, 100200051, 130000409, 100200830, 100200831,
]);

export interface KfcClientConfig {
  stateDir: string;
  cityCode: string;
  latitude: number;
  longitude: number;
  timeoutMs: number;
}

export class KfcError extends Error {
  readonly code: number | string | undefined;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(
    message: string,
    options: { code?: number | string; hint?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'KfcError';
    this.code = options.code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get sessionExpired(): boolean {
    const code = Number(this.code);
    if (SESSION_EXPIRED_CODES.has(code)) return true;
    const text = String(this.code ?? '');
    return text.length === 9 && text.endsWith('006');
  }
}

interface KfcResponse {
  code?: number;
  msg?: string;
  message?: string;
  flag?: boolean;
  data?: Record<string, unknown>;
  traceId?: string;
  env?: string;
  [key: string]: unknown;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): KfcClientConfig {
  return {
    stateDir:
      process.env.KFC_STATE_DIR?.trim() ||
      join(homedir(), '.kfc-cn-mcp'),
    cityCode: process.env.KFC_CITY_CODE?.trim() || '310100',
    latitude: envNumber('KFC_LATITUDE', 31.2304),
    longitude: envNumber('KFC_LONGITUDE', 121.4737),
    timeoutMs: envNumber('KFC_HTTP_TIMEOUT_MS', 20_000),
  };
}

function newDeviceId(): string {
  return randomBytes(16).toString('base64url');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function pickCartItems(cart: Record<string, unknown>): ServerCartItem[] {
  const items = Array.isArray(cart.items) ? cart.items : [];
  return items.map((raw) => {
    const item = asRecord(raw);
    return {
      id: String(item.id ?? ''),
      linkId: String(item.linkId ?? ''),
      name: String(item.nameCN ?? item.nameCn ?? item.showNameCn ?? ''),
      quantity: Number(item.quantity ?? 1),
      priceCents: Number(item.price ?? 0),
    };
  });
}

function serverItemToPayload(item: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    linkId: item.linkId,
    quantity: item.quantity,
    itemType: item.itemType,
    menuFlag: item.menuFlag,
    menuFlagType: item.menuFlagType,
    card: false,
  };
  if (Array.isArray(item.superComboItems)) {
    payload.superComboItems = item.superComboItems.map((raw) => {
      const sub = asRecord(raw);
      return {
        linkId: sub.linkId,
        itemType: sub.itemType,
        showNameCn: sub.showNameCn,
        quantity: sub.quantity,
        mealdealId: sub.mealdealId,
        menuFlag: sub.menuFlag,
      };
    });
  }
  if (item.promotionCode) payload.promotionCode = item.promotionCode;
  if (item.staticPrice != null) payload.staticPrice = item.staticPrice;
  return payload;
}

function defaultState(): PersistedState {
  return {
    version: 1,
    deviceId: newDeviceId(),
    sessionId: '',
    env: '',
    cookies: {},
    lastInitAt: 0,
  };
}

export class KfcClient {
  readonly config: KfcClientConfig;
  private state: PersistedState = defaultState();
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(config: KfcClientConfig = loadConfig()) {
    this.config = config;
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private get sessionFile(): string {
    return join(this.config.stateDir, 'session.json');
  }

  private get menuFile(): string {
    return join(this.config.stateDir, 'menu.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(this.config.stateDir, { recursive: true });
    try {
      const raw = await readFile(this.sessionFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed && parsed.version === 1) {
        this.state = { ...defaultState(), ...parsed };
      }
    } catch {
      // no saved session yet
    }
    try {
      const raw = await readFile(this.menuFile, 'utf8');
      const menu = JSON.parse(raw) as PersistedState['menu'];
      if (menu?.storeCode && menu.storeCode === this.state.store?.storeCode) {
        this.state.menu = menu;
      }
    } catch {
      // no cached menu
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 0);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.config.stateDir, { recursive: true });
        const tmp = `${this.sessionFile}.${process.pid}.tmp`;
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, this.sessionFile);
      });
    return this.saveChain;
  }

  /** Write the cached menu separately; it is large and changes rarely. */
  private persistMenu(): Promise<void> {
    const menu = this.state.menu ? JSON.stringify(this.state.menu) : null;
    if (!menu) return Promise.resolve();
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.config.stateDir, { recursive: true });
        const menuTmp = `${this.menuFile}.${process.pid}.tmp`;
        await writeFile(menuTmp, menu, { encoding: 'utf8', mode: 0o600 });
        await rename(menuTmp, this.menuFile);
      });
    return this.saveChain;
  }

  // ── http ─────────────────────────────────────────────────────────────────

  private cookieHeader(): string {
    return Object.entries(this.state.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  private captureCookies(response: Response): void {
    const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const list = anyHeaders.getSetCookie ? anyHeaders.getSetCookie() : [];
    for (const cookie of list) {
      const pair = cookie.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index > 0) {
        this.state.cookies[pair.slice(0, index)] = pair.slice(index + 1);
      }
    }
  }

  private async post(
    base: string,
    path: string,
    body: Record<string, unknown>,
    options: { retry?: number } = {},
  ): Promise<KfcResponse> {
    const retries = options.retry ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const raw = JSON.stringify(body);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: '*/*',
        'accept-language': 'zh-CN',
        'user-agent': DEFAULT_UA,
        origin: 'https://order.kfc.com.cn',
        referer:
          'https://order.kfc.com.cn/preorder-taro/menu?label=preorder',
        'x-yumc-route-channel': 'h5',
        'x-yumc-route-usercode': '',
        'x-yumc-client-deviceid': '',
        'cache-control': 'no-cache',
        ...kbsHeaders(path, raw),
      };
      if (this.state.env) headers['x-yumc-route-cell'] = this.state.env;
      const cookie = this.cookieHeader();
      if (cookie) headers.cookie = cookie;

      try {
        const response = await fetch(base + path, {
          method: 'POST',
          headers,
          body: raw,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        this.captureCookies(response);
        const text = await response.text();
        let json: KfcResponse;
        try {
          json = JSON.parse(text) as KfcResponse;
        } catch {
          throw new KfcError(
            `KFC 接口返回了非 JSON 响应（HTTP ${response.status}）`,
            { code: response.status, details: text.slice(0, 300) },
          );
        }
        if (typeof json.env === 'string' && json.env) this.state.env = json.env;
        if (!response.ok && (json.code == null || json.code === 0)) {
          json.code = response.status;
        }
        return json;
      } catch (error) {
        lastError = error;
        if (error instanceof KfcError) throw error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          continue;
        }
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        throw new KfcError(
          `无法连接肯德基接口：${(error as Error).message}${cause ? ` (${cause})` : ''}`,
          { hint: '检查网络或代理设置；该接口需要能直连 order.kfc.com.cn。' },
        );
      }
    }
    throw lastError instanceof Error ? lastError : new KfcError('未知网络错误');
  }

  private ensureOk(response: KfcResponse, action: string): KfcResponse {
    if (response.code !== 0) {
      const code = response.code;
      const message = response.msg ?? response.message ?? '未知错误';
      throw new KfcError(`${action}失败：${message}`, {
        code,
        hint: this.hintForCode(code, message),
        details: response,
      });
    }
    return response;
  }

  private hintForCode(code: unknown, message: string): string | undefined {
    const num = Number(code);
    if (SESSION_EXPIRED_CODES.has(num)) return '会话已过期，请重试（会自动重建会话）。';
    if (num === 100250001) return '参数校验失败，可能是门店/菜单已变化，请重新选择门店。';
    if (num === 100330241) return '手机号格式不正确，请提供 11 位中国大陆手机号。';
    if (num === 100060154) return '商品校验失败，可能已售罄或价格变动，请刷新菜单后重试。';
    if (/登录|login/i.test(message)) return '该操作需要登录肯德基账号（当前为免登录模式）。';
    if (/验证|geetest|captcha/i.test(message)) return '触发人机验证，请在肯德基 App / H5 内完成该订单。';
    return undefined;
  }

  /** Retry once after rebuilding a session when KFC says it expired. */
  private async withSessionRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof KfcError && error.sessionExpired) {
        const previousStore = this.state.store?.storeCode;
        this.resetSession();
        await this.init();
        if (previousStore && previousStore !== this.state.store?.storeCode) {
          await this.selectStore(previousStore);
        }
        return operation();
      }
      throw error;
    }
  }

  // ── common params ────────────────────────────────────────────────────────

  private common(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      portalType: 'WAP',
      channelName: 'Mobile Web',
      channelId: '13',
      brand: 'KFC_PRE',
      business: 'preorder',
      sessionId: this.state.sessionId || undefined,
      deviceId: this.state.deviceId,
      clientVersion: 'v6.910(b42759d4)',
      fversion: '20260914',
      versionNum: '5',
      ...extra,
    };
  }

  private clientMeta(): Record<string, unknown> {
    return {
      encodeList: [],
      isFromCustomerClient: true,
      secretKey: 'kfc',
    };
  }

  // ── session / init ───────────────────────────────────────────────────────

  resetSession(): void {
    this.state.sessionId = '';
    this.state.env = '';
    this.state.cookies = {};
    this.state.cart = undefined;
    this.state.pendingPreview = undefined;
  }

  get currentStore(): StoreSummary | undefined {
    return this.state.store;
  }

  get sessionAgeMs(): number {
    return Date.now() - this.state.lastInitAt;
  }

  async ensureSession(storeCode?: string): Promise<void> {
    await this.load();
    const expired =
      Date.now() - this.state.lastInitAt > SESSION_TTL_MS &&
      (this.state.cart?.lines.length ?? 0) === 0;
    const previousStore = this.state.store?.storeCode;
    if (!this.state.sessionId || expired) {
      await this.init();
      if (!storeCode && previousStore && previousStore !== this.state.store?.storeCode) {
        await this.selectStore(previousStore);
      }
    }
    if (storeCode != null && storeCode !== this.state.store?.storeCode) {
      await this.selectStore(storeCode);
    }
  }

  /**
   * Switch to a specific store. The H5 flow is:
   *   validStore -> cart/changeStoreOrAddress -> cart/create -> menu/list
   * (init/combine/preorder ignores storeCode and always picks the nearest store)
   */
  async selectStore(storeCode: string): Promise<void> {
    await this.ensureSession();
    this.state.pendingPreview = undefined;
    const latEnc = desEncrypt(String(this.config.latitude));
    const lngEnc = desEncrypt(String(this.config.longitude));

    const valid = await this.post(STORE_BASE, '/api/v2/store/validStore', {
      ...this.common({}),
      portalSource: '',
      ticket: '',
      storeCode,
      mylat: latEnc,
      mylng: lngEnc,
      encodeList: ['mylat', 'mylng'],
      isFromCustomerClient: true,
      secretKey: 'kfc',
    });
    this.ensureOk(valid, `校验门店 ${storeCode}`);
    const store = asRecord(asRecord(valid.data).store);
    if (!store.storecode) {
      throw new KfcError(`门店 ${storeCode} 当前不可用于点餐。`, {
        hint: '可能未营业、不支持预约自取，或已下线；换一家门店试试。',
      });
    }

    const storePayload = JSON.parse(JSON.stringify(store)) as Record<string, unknown>;
    const encryptField = (value: unknown): unknown =>
      value == null || value === '' ? value : desEncrypt(String(value));
    for (const key of ['lat', 'lng', 'phone']) {
      if (storePayload[key]) storePayload[key] = encryptField(storePayload[key]);
    }
    const subStores = Array.isArray(storePayload.subStores)
      ? (storePayload.subStores as Array<Record<string, unknown>>)
      : [];
    for (const sub of subStores) {
      for (const key of ['lat', 'lng', 'phone']) {
        if (sub[key]) sub[key] = encryptField(sub[key]);
      }
    }
    const encodeList = [
      'userLatitude',
      'userLongitude',
      'store.phone',
      'store.subStores.phone',
      'store.lat',
      'store.lng',
      'store.subStores.lat',
      'store.subStores.lng',
    ];

    const changed = await this.post(PREORDER_BASE, '/api/v2/cart/changeStoreOrAddress', {
      ...this.common({}),
      store: storePayload,
      scene: 1,
      env: this.state.env,
      userLongitude: lngEnc,
      userLatitude: latEnc,
      encodeList,
      isFromCustomerClient: true,
      secretKey: 'kfc',
    });
    this.ensureOk(changed, '切换门店');

    const created = await this.post(PREORDER_BASE, '/api/v2/cart/create', {
      ...this.common({}),
      store: storePayload,
      scene: 1,
      changeMode: 2,
      env: this.state.env,
      userLongitude: lngEnc,
      userLatitude: latEnc,
      encodeList,
      isFromCustomerClient: true,
      secretKey: 'kfc',
    });
    this.ensureOk(created, '创建门店购物车');

    this.state.store = parseStore(store);
    const cart = asRecord(asRecord(created.data).cart);
    if (cart.id) this.adoptCart(cart);

    const menuResponse = await this.post(PREORDER_BASE, '/api/v2/menu/list', {
      ...this.common({}),
      store,
      env: this.state.env,
      encodeList: [],
      isFromCustomerClient: true,
      secretKey: 'kfc',
    });
    this.ensureOk(menuResponse, '加载门店菜单');
    const parsed = parseMenu(storeCode, asRecord(menuResponse.data));
    if (parsed.items.length > 0) {
      this.state.menu = {
        storeCode,
        fetchedAt: parsed.fetchedAt,
        categories: parsed.categories,
        items: parsed.items,
      };
    }
    await this.persistMenu();
    await this.persist();
  }

  async init(storeCode?: string): Promise<void> {
    await this.load();
    const lat = desEncrypt(String(this.config.latitude));
    const lng = desEncrypt(String(this.config.longitude));
    const body: Record<string, unknown> = {
      ...this.common({}),
      body: { geoLocation: { lng, lat } },
      userLongitude: lng,
      userLatitude: lat,
      encodeList: [
        'body.geoLocation.lng',
        'body.geoLocation.lat',
        'userLatitude',
        'userLongitude',
      ],
      isFromCustomerClient: true,
      secretKey: 'kfc',
    };
    delete body.sessionId;
    if (storeCode) body.storeCode = storeCode;

    const response = await this.post(PREORDER_BASE, '/api/v2/init/combine/preorder', body);
    this.ensureOk(response, '初始化门店菜单');
    const data = asRecord(response.data);
    const sessionId = String(data.sessionId ?? '');
    if (!sessionId) throw new KfcError('初始化失败：响应中没有 sessionId');

    this.state.sessionId = sessionId;
    this.state.lastInitAt = Date.now();
    if (response.env) this.state.env = String(response.env);

    const recommend = asRecord(data.dataRecommend);
    const storeRaw =
      asRecord(asRecord(data.dataCart).cart).store ??
      asRecord(recommend.storeRecommend) ??
      (Array.isArray(recommend.stores) ? recommend.stores[0] : undefined);
    if (storeRaw && typeof storeRaw === 'object') {
      this.state.store = parseStore(storeRaw as Record<string, unknown>);
    }

    const menu = parseMenu(
      this.state.store?.storeCode ?? storeCode ?? '',
      asRecord(data.dataMenu),
    );
    if (menu.items.length > 0) {
      this.state.menu = {
        storeCode: menu.storeCode,
        fetchedAt: menu.fetchedAt,
        categories: menu.categories,
        items: menu.items,
      };
    }

    const cart = asRecord(asRecord(data.dataCart).cart);
    if (cart.id) this.adoptCart(cart);

    await this.persistMenu();
    await this.persist();
  }

  // ── menu ─────────────────────────────────────────────────────────────────

  async getMenu(options: { storeCode?: string; force?: boolean } = {}): Promise<ParsedMenu> {
    await this.ensureSession(options.storeCode);
    const cached = this.state.menu;
    const fresh =
      cached &&
      cached.storeCode === this.state.store?.storeCode &&
      Date.now() - cached.fetchedAt < MENU_TTL_MS;
    if (cached && fresh && !options.force) {
      return {
        storeCode: cached.storeCode,
        fetchedAt: cached.fetchedAt,
        categories: cached.categories,
        items: cached.items,
      };
    }
    await this.init(options.storeCode ?? this.state.store?.storeCode);
    const refreshed = this.state.menu;
    if (!refreshed) throw new KfcError('菜单为空：该门店当前可能未营业。');
    return {
      storeCode: refreshed.storeCode,
      fetchedAt: refreshed.fetchedAt,
      categories: refreshed.categories,
      items: refreshed.items,
    };
  }

  async getItemDetail(linkId: string): Promise<ItemDetail> {
    await this.ensureSession();
    return this.withSessionRetry(async () => {
      const response = await this.post(PREORDER_BASE, '/api/v3/menu/detail', {
        ...this.common({
          descNeed: true,
          linkId,
          env: this.state.env,
          ...this.clientMeta(),
        }),
      });
      this.ensureOk(response, '获取商品详情');
      return parseItemDetail(asRecord(response.data));
    });
  }

  // ── stores ───────────────────────────────────────────────────────────────

  async searchStoresByLbs(lat: number, lng: number): Promise<StoreSummary[]> {
    await this.load();
    const encryptedLat = desEncrypt(String(lat));
    const encryptedLng = desEncrypt(String(lng));
    const response = await this.post(STORE_BASE, '/api/v2/store/searchByLbs', {
      ...this.common({}),
      mylat: encryptedLat,
      mylng: encryptedLng,
      callScene: 'menuScene',
      env: this.state.env,
      encodeList: ['mylat', 'mylng'],
      isFromCustomerClient: true,
      secretKey: 'kfc',
    });
    this.ensureOk(response, '搜索附近门店');
    const data = asRecord(response.data);
    const stores = Array.isArray(data.stores) ? data.stores : [];
    return stores.map((s) => parseStore(asRecord(s)));
  }

  async searchStoresByKeyword(keyword: string, gbCityCode?: string): Promise<StoreSummary[]> {
    await this.load();
    const response = await this.post(
      STORE_BASE,
      '/api/v2/store/searchByCityCodeAndKeyword',
      {
        ...this.common({}),
        gbCityCode: gbCityCode ?? this.config.cityCode,
        keyword,
        ...this.clientMeta(),
      },
    );
    this.ensureOk(response, '搜索门店');
    const data = asRecord(response.data);
    const stores = Array.isArray(data.stores) ? data.stores : [];
    return stores.map((s) => parseStore(asRecord(s)));
  }

  // ── cart ─────────────────────────────────────────────────────────────────

  get cart(): CartState | undefined {
    return this.state.cart;
  }

  get pendingPreview(): OrderPreview | undefined {
    const preview = this.state.pendingPreview;
    if (!preview) return undefined;
    if (Date.now() - preview.createdAt > PREVIEW_TTL_MS) return undefined;
    return preview;
  }

  private adoptCart(cart: Record<string, unknown>): void {
    const cartId = String(cart.id ?? '');
    const serverItems = pickCartItems(cart);
    const totalCents = Number(cart.total ?? 0);
    const previousLines = this.state.cart?.lines ?? [];
    const rawItems = Array.isArray(cart.items) ? cart.items : [];

    // Match server items to our richer local lines by linkId, in order, so
    // combo selections and display names survive a server round-trip.
    const previousByLink = new Map<string, CartLine[]>();
    for (const line of previousLines) {
      const list = previousByLink.get(line.linkId) ?? [];
      list.push(line);
      previousByLink.set(line.linkId, list);
    }

    const lines: CartLine[] = rawItems.map((raw) => {
      const item = asRecord(raw);
      const linkId = String(item.linkId ?? '');
      const quantity = Number(item.quantity ?? 1);
      const priceCents = Number(item.price ?? 0);
      const existing = previousByLink.get(linkId)?.shift();
      if (existing) {
        existing.quantity = quantity;
        if (priceCents > 0) existing.unitPriceCents = priceCents;
        return existing;
      }
      return {
        key: linkId,
        linkId,
        name: String(item.nameCN ?? item.nameCn ?? item.showNameCn ?? ''),
        unitPriceCents: priceCents,
        quantity,
        menuFlag: String(item.menuFlag ?? ''),
        payload: serverItemToPayload(item),
      };
    });

    this.state.cart = {
      cartId,
      lines,
      serverItems,
      totalCents,
      updatedAt: Date.now(),
    };
  }

  /**
   * POST /api/v2/cart/update treats `quantity` as a DELTA on the server cart
   * (verified against the live API). Positive adds, negative removes.
   */
  private async applyDeltas(
    deltas: Array<{ payload: Record<string, unknown>; delta: number }>,
  ): Promise<CartState> {
    this.ensureSessionReady();
    const usable = deltas.filter((d) => d.delta !== 0);
    if (usable.length === 0) {
      return this.state.cart as CartState;
    }
    // Any cart mutation invalidates the previous price preview.
    this.state.pendingPreview = undefined;
    const items = usable.map((d) => ({ ...d.payload, quantity: d.delta }));
    const response = await this.post(PREORDER_BASE, '/api/v2/cart/update', {
      ...this.common({
        selectProductId: '',
        items,
        scenceType: '',
        env: this.state.env,
        ...this.clientMeta(),
      }),
    });
    this.ensureOk(response, '更新购物车');
    const cart = asRecord(asRecord(response.data).cart);
    if (cart.id) {
      this.adoptCart(cart);
    } else {
      this.state.cart = {
        cartId: this.state.cart?.cartId ?? '',
        lines: [],
        serverItems: [],
        totalCents: 0,
        updatedAt: Date.now(),
      };
    }
    await this.persist();
    return this.state.cart as CartState;
  }

  private ensureSessionReady(): void {
    if (!this.state.sessionId) {
      throw new KfcError('尚未初始化门店，请先调用 select_store。', {
        hint: '先 find_stores 找门店，再 select_store。',
      });
    }
  }

  async addToCart(
    entries: Array<{
      linkId: string;
      quantity: number;
      selections?: Record<string, Array<{ linkId: string; quantity: number }>>;
    }>,
    menu: ParsedMenu,
  ): Promise<CartState> {
    await this.ensureSession();
    const lineMap = new Map<string, CartLine>();
    for (const line of this.state.cart?.lines ?? []) lineMap.set(line.key, line);

    const deltas: Array<{ payload: Record<string, unknown>; delta: number }> = [];
    for (const entry of entries) {
      const item = menu.items.find((i) => i.linkId === entry.linkId);
      if (!item) {
        throw new KfcError(`菜单中找不到商品 ${entry.linkId}`, {
          hint: '先调用 get_menu 或 search_menu 获取最新 linkId。',
        });
      }
      if (item.maxQuantity && entry.quantity > item.maxQuantity) {
        throw new KfcError(
          `「${item.name}」单次最多可加 ${item.maxQuantity} 份，当前 ${entry.quantity} 份。`,
        );
      }
      const detail =
        item.isCombo || item.needsOptions
          ? await this.getItemDetail(item.linkId)
          : undefined;
      const { payload, selections } = await this.buildCartPayload(
        item,
        entry.quantity,
        detail,
        entry.selections,
      );
      const key = lineKey(item.linkId, selections);
      if (!lineMap.has(key)) {
        lineMap.set(key, {
          key,
          linkId: item.linkId,
          name: item.name,
          unitPriceCents: item.priceCents,
          quantity: 0,
          menuFlag: item.menuFlag,
          selections,
          payload,
        });
      }
      deltas.push({ payload, delta: entry.quantity });
    }

    // Make placeholder lines visible to adoptCart() so metadata survives.
    if (!this.state.cart) {
      this.state.cart = {
        cartId: '',
        lines: [...lineMap.values()],
        serverItems: [],
        totalCents: 0,
        updatedAt: Date.now(),
      };
    } else {
      this.state.cart.lines = [...lineMap.values()];
    }

    return this.withSessionRetry(() => this.applyDeltas(deltas));
  }

  private async buildCartPayload(
    item: ParsedMenu['items'][number],
    quantity: number,
    detail: ItemDetail | undefined,
    selections: Record<string, Array<{ linkId: string; quantity: number }>> | undefined,
  ): Promise<{
    payload: Record<string, unknown>;
    selections?: Record<string, Array<{ linkId: string; quantity: number }>>;
  }> {
    const isCombo = item.isCombo || (detail?.comboRounds.length ?? 0) > 0;
    if (!isCombo) {
      return {
        payload: { ...item.raw, quantity },
      };
    }
    if (!detail || detail.comboRounds.length === 0) {
      throw new KfcError(`商品 ${item.name} 需要选择套餐内容，但未获取到可选规格。`, {
        hint: '调用 get_item 查看 comboRounds 后再下单。',
      });
    }

    const chosen: Record<string, Array<{ linkId: string; quantity: number }>> = {};
    const superComboItems: Array<Record<string, unknown>> = [];

    for (const round of detail.comboRounds) {
      const wanted = selections?.[round.roundId];
      let picks = wanted;
      if (!picks || picks.length === 0) {
        // Default: first available item, quantity = round minimum.
        const available = round.items.filter((i) => i.available);
        if (available.length === 0) {
          throw new KfcError(`套餐「${round.name}」当前没有可选项。`, {
            hint: '换一个门店或商品试试。',
          });
        }
        const first = available[0]!;
        const min = Math.max(1, round.minCount || 1);
        const cap = first.maxCount && first.maxCount > 0 ? first.maxCount : min;
        picks = [{ linkId: first.linkId, quantity: Math.min(min, cap) }];
      }

      const total = picks.reduce((sum, p) => sum + p.quantity, 0);
      if (round.minCount > 0 && total < round.minCount) {
        throw new KfcError(
          `套餐「${round.name}」至少需要选 ${round.minCount} 份，当前选了 ${total} 份。`,
        );
      }
      if (round.maxCount > 0 && total > round.maxCount) {
        throw new KfcError(
          `套餐「${round.name}」最多只能选 ${round.maxCount} 份，当前选了 ${total} 份。`,
        );
      }

      for (const pick of picks) {
        const option = round.items.find((i) => i.linkId === pick.linkId);
        if (!option) {
          throw new KfcError(`套餐「${round.name}」中没有商品 ${pick.linkId}。`);
        }
        if (option.maxCount && pick.quantity > option.maxCount) {
          throw new KfcError(
            `「${option.name}」在该套餐中最多可选 ${option.maxCount} 份。`,
          );
        }
        superComboItems.push({
          linkId: option.linkId,
          itemType: 2,
          showNameCn: option.showName ?? option.name,
          quantity: pick.quantity,
          mealdealId: round.roundId,
          menuFlag: 'P',
        });
      }
      chosen[round.roundId] = picks;
    }

    return {
      payload: {
        linkId: item.linkId,
        quantity,
        superComboItems,
        card: false,
        itemType: 13,
        menuFlag: 'S',
        menuFlagType: item.menuFlagType ?? '1',
      },
      selections: chosen,
    };
  }

  private findLine(lineKeyOrLinkId: string): CartLine | undefined {
    const cart = this.state.cart;
    if (!cart) return undefined;
    return (
      cart.lines.find((l) => l.key === lineKeyOrLinkId) ??
      cart.lines.find((l) => l.linkId === lineKeyOrLinkId)
    );
  }

  private findServerItem(line: CartLine): ServerCartItem | undefined {
    const items = this.state.cart?.serverItems ?? [];
    return items.find((item) => item.linkId === line.linkId);
  }

  async setQuantity(lineKeyOrLinkId: string, quantity: number): Promise<CartState> {
    await this.ensureSession();
    this.ensureSessionReady();
    const line = this.findLine(lineKeyOrLinkId);
    if (!line) throw new KfcError(`购物车中没有 ${lineKeyOrLinkId}。`);
    if (quantity <= 0) return this.removeLine(line.key);
    const current = line.quantity;
    if (quantity === current) return this.state.cart as CartState;

    const delta = quantity - current;
    const first = await this.withSessionRetry(() =>
      this.applyDeltas([{ payload: line.payload, delta }]),
    );
    const after = this.findLine(line.key);
    if (after && after.quantity === quantity) return first;

    // Some promotions clamp deltas; fall back to remove + re-add.
    await this.removeLine(line.key);
    const menu = await this.getMenu();
    return this.addToCart([{ linkId: line.linkId, quantity, selections: line.selections }], menu);
  }

  async removeLine(lineKeyOrLinkId: string): Promise<CartState> {
    await this.ensureSession();
    this.ensureSessionReady();
    const line = this.findLine(lineKeyOrLinkId);
    if (!line) throw new KfcError(`购物车中没有 ${lineKeyOrLinkId}。`);
    this.state.pendingPreview = undefined;
    const serverItem = this.findServerItem(line);
    if (serverItem?.id) {
      const response = await this.post(PREORDER_BASE, '/api/v2/cart/clearItem', {
        ...this.common({
          cartId: this.state.cart?.cartId ?? '',
          itemId: serverItem.id,
          env: this.state.env,
          ...this.clientMeta(),
        }),
      });
      this.ensureOk(response, '删除餐品');
      const cart = asRecord(asRecord(response.data).cart);
      if (cart.id) {
        this.adoptCart(cart);
      } else {
        this.state.cart = {
          cartId: this.state.cart?.cartId ?? '',
          lines: (this.state.cart?.lines ?? []).filter((l) => l.key !== line.key),
          serverItems: (this.state.cart?.serverItems ?? []).filter(
            (item) => item.id !== serverItem.id,
          ),
          totalCents: Math.max(0, (this.state.cart?.totalCents ?? 0) - line.unitPriceCents * line.quantity),
          updatedAt: Date.now(),
        };
      }
      await this.persist();
      return this.state.cart as CartState;
    }
    return this.withSessionRetry(() =>
      this.applyDeltas([{ payload: line.payload, delta: -line.quantity }]),
    );
  }

  async clearCart(): Promise<void> {
    await this.ensureSession();
    this.state.pendingPreview = undefined;
    const cart = this.state.cart;
    if (!cart) {
      this.state.cart = undefined;
      return;
    }
    const cartId = cart.cartId;
    for (const item of cart.serverItems) {
      if (!item.id) continue;
      try {
        await this.post(PREORDER_BASE, '/api/v2/cart/clearItem', {
          ...this.common({
            cartId,
            itemId: item.id,
            env: this.state.env,
            ...this.clientMeta(),
          }),
        });
      } catch {
        // best effort
      }
    }
    this.state.cart = undefined;
    this.state.pendingPreview = undefined;
    await this.persist();
  }

  async refreshCart(): Promise<CartState> {
    await this.ensureSession();
    const cart = this.state.cart;
    if (!cart) throw new KfcError('购物车为空。');
    const response = await this.post(PREORDER_BASE, '/api/v2/cart/confirm', {
      ...this.common({
        cartId: cart.cartId,
        env: this.state.env,
        ...this.clientMeta(),
      }),
    });
    this.ensureOk(response, '获取购物车');
    const data = asRecord(response.data);
    this.adoptCart(asRecord(data.cart));
    await this.persist();
    return this.state.cart as CartState;
  }

  // ── preview + submit ─────────────────────────────────────────────────────

  async previewOrder(): Promise<OrderPreview> {
    await this.ensureSession();
    const cart = this.state.cart;
    if (!cart || cart.lines.length === 0 || cart.serverItems.length === 0) {
      throw new KfcError('购物车是空的，无法结算。', {
        hint: '先调用 cart_add 添加餐品。',
      });
    }
    const response = await this.withSessionRetry(() =>
      this.post(PREORDER_BASE, '/api/v2/cart/confirm', {
        ...this.common({
          cartId: cart.cartId,
          env: this.state.env,
          ...this.clientMeta(),
        }),
      }),
    );
    this.ensureOk(response, '订单预校验');
    const data = asRecord(response.data);
    const cartData = asRecord(data.cart);
    const amounts = asRecord(data.cartAmount);
    const invalid = asRecord(data.invalidItems);
    const warnings: string[] = [];
    if (Object.keys(invalid).length > 0) warnings.push('部分餐品已失效，已从订单中移除。');

    const totalCents = Number(amounts.payAmount ?? cartData.total ?? cart.totalCents);
    const preview: OrderPreview = {
      cartId: String(cartData.id ?? cart.cartId),
      totalCents,
      goodsCents: Number(amounts.goods ?? totalCents),
      packCents: Number(amounts.pack ?? 0),
      deliveryCents: Number(amounts.delivery ?? 0),
      discountCents: Number(amounts.totalDiscount ?? 0),
      items: pickCartItems(cartData),
      store: this.state.store,
      requiresLogin: Number(data.hasLogIn ?? 0) === 1,
      warnings,
      createdAt: Date.now(),
    };
    this.state.pendingPreview = preview;
    this.adoptCart(cartData);
    await this.persist();
    return preview;
  }

  async placeOrder(input: {
    phone: string;
    packType: 'dinein' | 'takeaway';
    remark?: string;
    expectedTotalCents?: number;
    previewToken: string;
  }): Promise<{
    orderId: string;
    totalCents: number;
    store?: StoreSummary;
    raw: Record<string, unknown>;
  }> {
    await this.ensureSession();
    const preview = this.pendingPreview;
    if (!preview) {
      throw new KfcError('没有有效的订单预览，请先调用 preview_order。', {
        hint: '预览 10 分钟内有效，价格确认后才能下单。',
      });
    }
    if (input.previewToken !== this.previewToken(preview)) {
      throw new KfcError('订单预览令牌不匹配，请重新调用 preview_order。');
    }
    if (input.expectedTotalCents != null && input.expectedTotalCents !== preview.totalCents) {
      throw new KfcError(
        `金额不一致：用户确认 ${input.expectedTotalCents} 分，当前预览 ${preview.totalCents} 分。请重新预览。`,
      );
    }
    if (!/^1[3-9]\d{9}$/.test(input.phone)) {
      throw new KfcError('手机号格式不正确，请提供 11 位中国大陆手机号。');
    }

    const cart = this.state.cart;
    if (!cart) throw new KfcError('购物车状态丢失，请重新添加餐品并预览。');

    const params: Record<string, unknown> = {
      businessLine: 'preorder',
      phone: desEncrypt(input.phone),
      packType: input.packType === 'takeaway' ? '1' : '2',
      orderId: cart.cartId,
    };
    if (input.remark) params.iremark = input.remark.slice(0, 100);

    const response = await this.withSessionRetry(() =>
      this.post(PREORDER_BASE, '/api/v2/order/submit', {
        ...this.common({
          ...params,
          env: this.state.env,
          encodeList: ['phone'],
          isFromCustomerClient: true,
          secretKey: 'kfc',
        }),
      }),
    );
    this.ensureOk(response, '提交订单');
    const data = asRecord(response.data);
    const order = asRecord(data.order ?? data.orderInfo);
    const orderId = String(
      data.orderId ?? order.orderId ?? data.orderid ?? data.id ?? '',
    );
    if (!orderId) {
      throw new KfcError('订单已提交但未返回订单号，请在肯德基 App 的订单列表中查看。', {
        details: response,
      });
    }

    this.state.cart = undefined;
    this.state.pendingPreview = undefined;
    await this.persist();

    return {
      orderId,
      totalCents: preview.totalCents,
      store: this.state.store,
      raw: data,
    };
  }

  previewToken(preview: OrderPreview): string {
    // Local guard token; not a security boundary, just an accidental-submit guard.
    return `pv-${preview.cartId}-${preview.totalCents}-${preview.createdAt}`;
  }

  async orderStatus(orderId: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.post(
      PREORDER_BASE,
      '/api/v2/order/getOrderStatusById',
      {
        ...this.common({
          orderId,
          brand: 'KFC_PRE',
          businessLine: 'preorder',
          env: this.state.env,
          ...this.clientMeta(),
        }),
      },
    );
    return response as Record<string, unknown>;
  }

  async status(): Promise<Record<string, unknown>> {
    await this.load();
    return {
      hasSession: Boolean(this.state.sessionId),
      sessionAgeSeconds: this.state.sessionId ? Math.round(this.sessionAgeMs / 1000) : null,
      store: this.state.store,
      cart: this.state.cart
        ? {
            cartId: this.state.cart.cartId,
            lines: this.state.cart.lines.map((line) => ({
              key: line.key,
              linkId: line.linkId,
              name: line.name,
              quantity: line.quantity,
            })),
            totalCents: this.state.cart.totalCents,
          }
        : null,
      pendingPreview: this.pendingPreview
        ? { totalCents: this.pendingPreview.totalCents, createdAt: this.pendingPreview.createdAt }
        : null,
      menuAgeSeconds: this.state.menu
        ? Math.round((Date.now() - this.state.menu.fetchedAt) / 1000)
        : null,
      env: this.state.env,
    };
  }
}
