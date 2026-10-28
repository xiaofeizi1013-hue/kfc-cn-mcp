export interface StoreSummary {
  storeCode: string;
  name: string;
  address?: string;
  cityName?: string;
  distanceMeters?: number;
  openTime?: string;
  closeTime?: string;
  status?: number;
  statusText?: string;
  phone?: string;
  latitude?: string;
  longitude?: string;
  takeMealPlace?: string;
}

export interface MenuItemOptionValue {
  linkId?: string;
  name?: string;
  priceCents?: number;
  [key: string]: unknown;
}

export interface MenuItem {
  linkId: string;
  name: string;
  showName?: string;
  description?: string;
  priceCents: number;
  originalPriceCents?: number;
  menuFlag: string;
  menuFlagType?: string;
  category: string;
  parentCategory?: string;
  maxQuantity?: number;
  isCombo: boolean;
  needsOptions: boolean;
  imageUrl?: string;
  saleFlag?: string;
  stockFlag?: string;
  raw: Record<string, unknown>;
}

export interface MenuCategory {
  id: string;
  name: string;
  parent?: string;
  itemCount: number;
  items: MenuItem[];
}

export interface ParsedMenu {
  storeCode: string;
  fetchedAt: number;
  categories: MenuCategory[];
  items: MenuItem[];
}

export interface ComboRoundItem {
  linkId: string;
  name: string;
  showName?: string;
  priceCents?: number;
  maxCount?: number;
  available: boolean;
}

export interface ComboRound {
  roundId: string;
  name: string;
  minCount: number;
  maxCount: number;
  items: ComboRoundItem[];
}

export interface ItemDetail {
  linkId: string;
  name: string;
  description?: string;
  priceCents: number;
  originalPriceCents?: number;
  menuFlag: string;
  menuFlagType?: string;
  isCombo: boolean;
  comboRounds: ComboRound[];
  optionGroups: unknown[];
  imageUrl?: string;
  raw?: Record<string, unknown>;
}

export interface CartLine {
  /** Stable identity: linkId + selected combo items. */
  key: string;
  linkId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  menuFlag: string;
  selections?: Record<string, Array<{ linkId: string; quantity: number }>>;
  /** Exact object posted to /api/v2/cart/update. */
  payload: Record<string, unknown>;
}

export interface ServerCartItem {
  id: string;
  linkId: string;
  name: string;
  quantity: number;
  priceCents: number;
}

export interface CartState {
  cartId: string;
  lines: CartLine[];
  serverItems: ServerCartItem[];
  totalCents: number;
  updatedAt: number;
}

export interface OrderPreview {
  cartId: string;
  totalCents: number;
  goodsCents: number;
  packCents: number;
  deliveryCents: number;
  discountCents: number;
  items: ServerCartItem[];
  store?: StoreSummary;
  requiresLogin: boolean;
  warnings: string[];
  createdAt: number;
}

export interface PersistedState {
  version: 1;
  deviceId: string;
  sessionId: string;
  env: string;
  cookies: Record<string, string>;
  lastInitAt: number;
  store?: StoreSummary;
  cart?: CartState;
  pendingPreview?: OrderPreview;
  menu?: {
    storeCode: string;
    fetchedAt: number;
    categories: MenuCategory[];
    items: MenuItem[];
  };
}
