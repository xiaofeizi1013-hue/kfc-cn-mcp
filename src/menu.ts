import type {
  ComboRound,
  ComboRoundItem,
  ItemDetail,
  MenuCategory,
  MenuItem,
  ParsedMenu,
  StoreSummary,
} from './types.js';

export function yuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(cents)) return '-';
  return `¥${(cents / 100).toFixed(2)}`;
}

function asCents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseStore(raw: Record<string, unknown>): StoreSummary {
  const status = Number(raw.status);
  return {
    storeCode: String(raw.storecode ?? raw.storeCode ?? ''),
    name: String(raw.storename ?? raw.storeName ?? ''),
    address: str(raw.address),
    cityName: str(raw.cityName),
    distanceMeters:
      typeof raw.distance === 'number' ? Math.round(raw.distance) : undefined,
    openTime: str(raw.starttime) ?? str(raw.startTime),
    closeTime: str(raw.endtime) ?? str(raw.endTime),
    status: Number.isFinite(status) ? status : undefined,
    statusText: str(raw.statuscomments),
    phone: str(raw.phone),
    latitude: raw.lat != null ? String(raw.lat) : undefined,
    longitude: raw.lng != null ? String(raw.lng) : undefined,
    takeMealPlace: str(raw.takeMealPlace),
  };
}

function menuItemFromRaw(
  raw: Record<string, unknown>,
  category: string,
  parentCategory: string | undefined,
): MenuItem {
  const menuFlag = String(raw.menuFlag ?? '');
  const viewOptionValues = raw.viewOptionValues;
  const needsOptions =
    menuFlag === 'S' ||
    (Array.isArray(viewOptionValues) && viewOptionValues.length > 0) ||
    (Array.isArray(raw.subLinkIds) && raw.subLinkIds.length > 0);
  return {
    linkId: String(raw.linkId ?? raw.systemId ?? ''),
    name: String(raw.nameCn ?? raw.menuCn ?? raw.showNameCn ?? ''),
    showName: str(raw.showNameCn),
    description: str(raw.descCn)?.slice(0, 400),
    priceCents: asCents(raw.price ?? raw.apiPrice),
    originalPriceCents: asCents(raw.priceInitial ?? raw.apiOrgPrice) || undefined,
    menuFlag,
    menuFlagType: raw.menuFlagType != null ? String(raw.menuFlagType) : undefined,
    category,
    parentCategory,
    maxQuantity: raw.maxQty != null ? Number(raw.maxQty) : undefined,
    isCombo: menuFlag === 'S',
    needsOptions,
    imageUrl: str(raw.imageUrl),
    saleFlag: raw.saleFlag != null ? String(raw.saleFlag) : undefined,
    stockFlag: raw.stockFlag != null ? String(raw.stockFlag) : undefined,
    raw,
  };
}

/**
 * The H5 menu is a two-level tree: each top category has either its own
 * `menuList` or `childClassList[]` entries with their own `menuList`.
 */
export function parseMenu(
  storeCode: string,
  dataMenu: Record<string, unknown> | undefined,
): ParsedMenu {
  const categories: MenuCategory[] = [];
  const items: MenuItem[] = [];
  const menuData = Array.isArray(dataMenu?.menuData) ? dataMenu.menuData : [];

  for (const cat of menuData as Array<Record<string, unknown>>) {
    const topName = String(cat.nameCn ?? '');
    const catId = String(cat.classId ?? topName);

    const direct = Array.isArray(cat.menuList) ? (cat.menuList as Array<Record<string, unknown>>) : [];
    if (direct.length > 0) {
      const parsed = direct.map((r) => menuItemFromRaw(r, topName, undefined));
      categories.push({ id: catId, name: topName, itemCount: parsed.length, items: parsed });
      items.push(...parsed);
    }

    const children = Array.isArray(cat.childClassList)
      ? (cat.childClassList as Array<Record<string, unknown>>)
      : [];
    for (const child of children) {
      const childName = String(child.nameCn ?? topName);
      const childItems = Array.isArray(child.menuList)
        ? (child.menuList as Array<Record<string, unknown>>)
        : [];
      if (childItems.length === 0) continue;
      const parsed = childItems.map((r) => menuItemFromRaw(r, childName, topName));
      categories.push({
        id: String(child.classId ?? `${catId}:${childName}`),
        name: childName,
        parent: topName,
        itemCount: parsed.length,
        items: parsed,
      });
      items.push(...parsed);
    }
  }

  return { storeCode, fetchedAt: Date.now(), categories, items };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

export function searchMenu(menu: ParsedMenu, query: string, limit = 10): MenuItem[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: Array<{ item: MenuItem; score: number }> = [];
  for (const item of menu.items) {
    const name = normalize(item.name);
    const show = normalize(item.showName ?? '');
    const desc = normalize(item.description ?? '');
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q)) score = 60 + Math.min(20, q.length);
    else if (show.includes(q)) score = 40;
    else if (desc.includes(q)) score = 10;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.priceCents - b.item.priceCents);
  return scored.slice(0, limit).map((s) => s.item);
}

export function findMenuItem(menu: ParsedMenu, linkIdOrName: string): MenuItem | undefined {
  const byId = menu.items.find((i) => i.linkId === linkIdOrName);
  if (byId) return byId;
  const exact = menu.items.find((i) => i.name === linkIdOrName);
  if (exact) return exact;
  return searchMenu(menu, linkIdOrName, 1)[0];
}

export function parseItemDetail(raw: Record<string, unknown>): ItemDetail {
  const superCombo = (raw.superComboDetail ?? raw.superCombo ?? {}) as Record<string, unknown>;
  const roundsRaw = Array.isArray(superCombo.roundList)
    ? (superCombo.roundList as Array<Record<string, unknown>>)
    : [];
  const comboRounds: ComboRound[] = roundsRaw.map((round) => {
    const itemList = Array.isArray(round.itemList)
      ? (round.itemList as Array<Record<string, unknown>>)
      : [];
    const items: ComboRoundItem[] = itemList.map((i) => ({
      linkId: String(i.linkId ?? ''),
      name: String(i.nameCn ?? i.menuCn ?? ''),
      showName: str(i.showNameCn),
      priceCents: asCents(i.price ?? i.apiPrice) || undefined,
      maxCount: i.maxCount != null ? Number(i.maxCount) : undefined,
      available: String(i.saleFlag ?? '1') !== '0' && String(i.disabledStatus ?? '0') !== '1',
    }));
    return {
      roundId: String(round.roundId ?? ''),
      name: String(round.roundName ?? ''),
      minCount: Number(round.riMinCount ?? 0),
      maxCount: Number(round.riMaxCount ?? 0),
      items,
    };
  });

  return {
    linkId: String(raw.linkId ?? ''),
    name: String(raw.nameCn ?? raw.showNameCn ?? ''),
    description: str(raw.descCn),
    priceCents: asCents(raw.price ?? raw.apiPrice),
    originalPriceCents: asCents(raw.priceInitial ?? raw.apiOrgPrice) || undefined,
    menuFlag: String(raw.menuFlag ?? ''),
    menuFlagType: raw.menuFlagType != null ? String(raw.menuFlagType) : undefined,
    isCombo: comboRounds.length > 0 || String(raw.menuFlag ?? '') === 'S',
    comboRounds,
    optionGroups: Array.isArray(raw.viewOptionValues) ? raw.viewOptionValues : [],
    imageUrl: str(raw.imageUrl),
    raw,
  };
}

export function lineKey(
  linkId: string,
  selections?: Record<string, Array<{ linkId: string; quantity: number }>>,
): string {
  if (!selections) return linkId;
  const parts = Object.keys(selections)
    .sort()
    .map((round) => {
      const picked = [...(selections[round] ?? [])]
        .sort((a, b) => a.linkId.localeCompare(b.linkId))
        .map((s) => `${s.linkId}x${s.quantity}`)
        .join('+');
      return `${round}:${picked}`;
    });
  return `${linkId}|${parts.join('|')}`;
}
