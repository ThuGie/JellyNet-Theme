export interface Item {
  Id: string;
  Name: string;
  Type: string;
  MediaType?: string;
  Overview?: string;
  ProductionYear?: number;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  SeriesId?: string;
  SeriesName?: string;
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  SeriesPrimaryImageTag?: string;
  CollectionType?: string;
  Genres?: string[];
  Tags?: string[];
  UserData?: { PlayedPercentage?: number; PlaybackPositionTicks?: number };
}

interface Client {
  serverId(): string;
  accessToken(): string | undefined;
  getCurrentUserId(): string | undefined;
  getUrl(path: string): string;
  setRequestHeaders(headers: Record<string, string>): void;
  getItems(userId: string, params: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    ApiClient?: Client;
    JellyTube?: { open(): Promise<void> | void };
    JellyManga?: { open(): Promise<void> | void };
    jellySpotPlugin?: { openUserUi(tab: string): void };
  }
}

export type Session = { client: Client; user: string; key: string };
export type Query = Record<string, string | number | boolean | undefined>;
export type Kind = 'resume' | 'next' | 'latest' | 'favorites' | 'releases' | 'genre' | 'tag' | 'collection' | 'recommend' | 'catalog';
export interface Shelf {
  id: string;
  kind: Kind;
  value?: string;
  title: string;
  hidden?: boolean;
  landscape?: boolean;
  library?: string;
  media?: string;
  year?: string;
  watched?: string;
  sort?: string;
}

export interface Layout {
  version: 1;
  standard: boolean;
  featured: boolean;
  shelves: Shelf[];
}

export interface Settings {
  IsAdmin: boolean;
  Links: { Name: string; Url: string; AdminOnly: boolean }[];
  PinnedTags: string[];
  PinnedCollections: string[];
}

export interface Page { Items: Item[]; TotalRecordCount?: number }
export interface Filters { Genres?: string[]; Tags?: string[] }

export function session(): Session | undefined {
  const client = window.ApiClient;
  const user = client?.getCurrentUserId();
  if (!client || !user || !client.accessToken()) return;
  const base = new URL(client.getUrl('System/Info/Public'), location.href);
  if (base.origin !== location.origin) return;
  return { client, user, key: base.href + ':' + client.serverId() + ':' + user };
}

export class HttpError extends Error {
  constructor(readonly status: number) { super(`Jellyfin returned ${status}`); }
}

export class Library {
  private cache = new Map<string, { expires: number; data: unknown }>();
  private requests = new Map<string, { signal?: AbortSignal; promise: Promise<unknown> }>();

  constructor(readonly account: Session, private unauthorized: (status: number) => void) {}

  clear() {
    this.cache.clear();
    this.requests.clear();
  }

  invalidateProgress() {
    for (const [key, value] of this.cache) {
      if (value.expires <= Date.now() || /Resume|NextUp|isFavorite|isPlayed/.test(key)) this.cache.delete(key);
    }
  }

  async request<T>(path: string, query: Query = {}, signal?: AbortSignal, ttl = 0, body?: unknown): Promise<T> {
    const { client } = this.account;
    const url = new URL(client.getUrl(path), location.href);
    if (url.origin !== location.origin) throw new Error('Unexpected Jellyfin origin');
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    const key = url.href;
    const cached = this.cache.get(key);
    if (ttl && cached && cached.expires > Date.now()) return cached.data as T;
    const existing = this.requests.get(key);
    if (body === undefined && existing && existing.signal === signal) return existing.promise as Promise<T>;

    const run = async () => {
      const headers: Record<string, string> = {};
      client.setRequestHeaders(headers);
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(url.href, {
        headers, signal, cache: 'no-store', method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (session()?.key !== this.account.key) throw new Error('Jellyfin account changed');
      if (response.status === 401 || response.status === 403) {
        this.clear();
        this.unauthorized(response.status);
      }
      if (!response.ok) throw new HttpError(response.status);
      const data = response.status === 204 || !response.headers.get('Content-Type')?.includes('json')
        ? undefined : await response.json();
      if (ttl && !signal?.aborted) {
        this.cache.delete(key);
        this.cache.set(key, { data, expires: Date.now() + ttl });
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      }
      return data as T;
    };

    const promise = run();
    if (body === undefined) this.requests.set(key, { signal, promise });
    try {
      return await promise;
    } finally {
      if (this.requests.get(key)?.promise === promise) this.requests.delete(key);
    }
  }

  views() {
    return this.request<Page>('UserViews', { userId: this.account.user }, undefined, 300000);
  }

  async filters(signal?: AbortSignal): Promise<Filters> {
    const data = await this.request<Pick<Filters, 'Tags'> & { Genres?: (string | { Name: string })[] }>(
      'Items/Filters2', { userId: this.account.user, includeItemTypes: 'Movie,Series', recursive: true }, signal, 300000
    );
    return { ...data, Genres: data.Genres?.map(genre => typeof genre === 'string' ? genre : genre.Name).filter(Boolean) };
  }

  async years(signal?: AbortSignal) {
    const data = await this.request<Page>('Years', {
      userId: this.account.user, includeItemTypes: 'Movie,Series', recursive: true, enableImages: false
    }, signal, 300000);
    return data.Items.map(item => Number(item.Name)).filter(Number.isInteger).sort((left, right) => right - left);
  }

  async collections(signal: AbortSignal) {
    const items: Item[] = [];
    const limit = 100;
    for (let startIndex = 0; !signal.aborted; startIndex += limit) {
      const page = await this.request<Page>('Items', {
        userId: this.account.user, includeItemTypes: 'BoxSet', recursive: true, sortBy: 'SortName',
        startIndex, limit, enableTotalRecordCount: false
      }, signal, 300000);
      items.push(...page.Items);
      if (page.Items.length < limit) break;
    }
    return items;
  }
  shelf(shelf: Shelf, signal: AbortSignal, start = 0, limit = 16, search = '', paged = false): Promise<Page> {
    const userId = this.account.user;
    const query = { userId, startIndex: start, limit, enableTotalRecordCount: paged };
    if (shelf.kind === 'resume') return this.request('UserItems/Resume', { ...query, mediaTypes: 'Video', imageTypeLimit: 1, enableUserData: true }, signal, 30000);
    if (shelf.kind === 'next') return this.request('Shows/NextUp', { ...query, imageTypeLimit: 1, enableUserData: true, enableResumable: false }, signal, 30000);
    if (shelf.kind === 'recommend') return this.recommend(signal, start, limit);

    const sort = shelf.sort ?? (shelf.kind === 'latest' ? 'DateCreated' : shelf.kind === 'releases' ? 'PremiereDate' : 'SortName');
    return this.request('Items', {
      ...query, recursive: true, includeItemTypes: shelf.media === '*' ? undefined : shelf.media || 'Movie,Series',
      parentId: shelf.kind === 'collection' ? shelf.value : shelf.library,
      genres: shelf.kind === 'genre' ? shelf.value : undefined,
      tags: shelf.kind === 'tag' ? shelf.value : undefined,
      years: shelf.year, isPlayed: shelf.watched, isFavorite: shelf.kind === 'favorites' ? true : undefined,
      searchTerm: search, sortBy: sort, sortOrder: sort === 'SortName' ? 'Ascending' : 'Descending',
      enableUserData: shelf.kind === 'favorites' || Boolean(shelf.watched), imageTypeLimit: 1
    }, signal, shelf.kind === 'favorites' || shelf.watched ? 30000 : 300000);
  }

  private async recommend(signal: AbortSignal, start: number, limit: number): Promise<Page> {
    const common = { userId: this.account.user, recursive: true, includeItemTypes: 'Movie,Series' };
    const watched = await this.request<Page>('Items', {
      ...common, isPlayed: true, fields: 'Genres,Tags', sortBy: 'DatePlayed',
      sortOrder: 'Descending', limit: 5, enableTotalRecordCount: false
    }, signal, 30000);
    const seed = watched.Items.find(item => item.Genres?.length || item.Tags?.length);
    if (!seed) return { Items: [], TotalRecordCount: 0 };
    const page = await this.request<Page>('Items', {
      ...common, isPlayed: false, genres: seed.Genres?.[0], tags: seed.Genres?.length ? undefined : seed.Tags?.[0],
      sortBy: 'CommunityRating', sortOrder: 'Descending', startIndex: start, limit,
      enableTotalRecordCount: true
    }, signal, 30000);
    return (page.TotalRecordCount ?? page.Items.length) >= 4 ? page : { Items: [], TotalRecordCount: 0 };
  }

  image(item: Item, backdrop: boolean, width: number): string {
    const own = backdrop ? item.BackdropImageTags?.[0] : item.ImageTags?.Primary;
    const parent = backdrop ? item.ParentBackdropImageTags?.[0] : item.SeriesPrimaryImageTag;
    const id = own ? item.Id : backdrop ? item.ParentBackdropItemId : item.SeriesId;
    const tag = own || parent;
    if (!id || !tag) return '';
    const url = new URL(this.account.client.getUrl(`Items/${encodeURIComponent(id)}/Images/${backdrop ? 'Backdrop/0' : 'Primary'}`));
    url.searchParams.set('maxWidth', String(width));
    url.searchParams.set('quality', backdrop ? '75' : '82');
    url.searchParams.set('tag', tag);
    return url.href;
  }

  private preferences(signal?: AbortSignal, body?: unknown) {
    return this.request<{ CustomPrefs?: Record<string, string> }>(
      'DisplayPreferences/00000000000000000000000000000000',
      { userId: this.account.user, client: 'JellyNet' }, signal, 0, body
    );
  }

  async loadLayout(signal: AbortSignal): Promise<Layout | undefined> {
    const data = await this.preferences(signal);
    const raw = data?.CustomPrefs?.jellynetLayout;
    if (!raw) return;
    const layout = JSON.parse(raw) as Layout;
    if (layout.version !== 1 || !Array.isArray(layout.shelves)) throw new Error('Unsupported JellyNet layout');
    return layout;
  }

  async saveLayout(layout: Layout) {
    const existing = await this.preferences();
    await this.preferences(undefined, {
      ...existing, Client: 'JellyNet',
      CustomPrefs: { ...existing?.CustomPrefs, jellynetLayout: JSON.stringify(layout) }
    });
  }
}

export function details(item: Item, account: Session) {
  return `#/details?id=${encodeURIComponent(item.Id)}&serverId=${encodeURIComponent(account.client.serverId())}`;
}

export async function play(item: Item, account: Session): Promise<boolean> {
  const host = document.createElement('div');
  host.hidden = true;
  host.innerHTML = '<div is="emby-itemscontainer" class="itemsContainer"></div>';
  const container = host.firstElementChild as HTMLElement & { fetchData: () => Promise<unknown> };
  container.fetchData = () => account.client.getItems(account.user, { Ids: item.Id, Fields: 'MediaSources', Limit: 1 });
  const action = document.createElement('button');
  const ticks = item.UserData?.PlaybackPositionTicks ?? 0;
  action.className = 'itemAction';
  Object.assign(action.dataset, {
    id: item.Id, serverid: account.client.serverId(), type: item.Type,
    mediatype: item.MediaType ?? (item.Type === 'Series' ? '' : 'Video'),
    action: ticks > 0 ? 'resume' : 'play', positionticks: String(ticks)
  });
  container.append(action);
  document.body.append(host);
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    if (session()?.key !== account.key) return false;
    return !action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  } finally {
    host.remove();
  }
}
