import { details, HttpError, Library, play, session, type Item, type Kind, type Layout, type Settings, type Shelf } from './api';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(text: string, action: () => unknown, cls = 'jn-button') {
  const node = el('button', cls, text);
  node.type = 'button';
  node.addEventListener('click', () => void action());
  return node;
}

function link(text: string, href: string, cls = 'jn-button') {
  const node = el('a', cls, text);
  node.href = href;
  return node;
}

function route(view = '', params: Record<string, string | undefined> = {}) {
  const query = new URLSearchParams();
  if (view) query.set('jellynet', view);
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const suffix = query.toString();
  return suffix ? '#/home?' + suffix : '#/home';
}

function saveTarget(shelf: Shelf) {
  return route('browse', {
    kind: shelf.kind, value: shelf.value, title: shelf.title,
    library: shelf.library, media: shelf.media, year: shelf.year, watched: shelf.watched, sort: shelf.sort
  });
}

const genreShelves: Shelf[] = [
  { id: 'action-adventure', title: 'Action & Adventure', kind: 'genre', value: 'Action|Adventure|Action & Adventure' },
  { id: 'animation', title: 'Animation', kind: 'genre', value: 'Animation' }
];

const defaults: Shelf[] = [
  { id: 'latest-movies', title: 'Latest Movies', kind: 'latest', media: 'Movie' },
  { id: 'latest-series', title: 'Latest Series', kind: 'latest', media: 'Series' },
  ...genreShelves,
  { id: 'favorites', title: 'My List', kind: 'favorites', hidden: true },
  { id: 'resume', title: 'Continue Watching', kind: 'resume', landscape: true, hidden: true },
  { id: 'next', title: 'Next Up', kind: 'next', landscape: true, hidden: true }
];

function initial(): Layout {
  return { version: 1, standard: false, featured: true, shelves: defaults.map(shelf => ({ ...shelf })) };
}

const kinds = new Set<Kind>(['resume', 'next', 'latest', 'favorites', 'releases', 'genre', 'tag', 'collection', 'recommend', 'catalog']);
const trustedHash = /^#\/[\w/-]+(?:\?[^\s]*)?$/;
const nativeBrowse = /^#\/(?:details|library|list|search|favorites|playlists?|user\/settings)(?:[/?]|$)/;
const userRoute = /^#\/(?!login|selectserver|addserver|wizard|startup)[\w/-]+(?:[?]|$)/;

function safeLink(value: string) {
  if (trustedHash.test(value)) return value;
  if (!/^https?:\/\/|^\/(?!\/)/i.test(value)) return;
  try {
    const url = new URL(value, location.href);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid target */ }
}

function image(src: string, eager = false) {
  const node = el('img');
  node.alt = '';
  node.decoding = 'async';
  node.loading = eager ? 'eager' : 'lazy';
  node.addEventListener('error', () => node.remove(), { once: true });
  node.src = src;
  return node;
}

function optionList(label: string, choices: [string, string][], current = '') {
  const wrap = el('label', 'jn-field', label);
  const input = el('select');
  for (const [value, name] of choices) {
    const item = el('option', '', name);
    item.value = value;
    input.append(item);
  }
  input.value = current;
  wrap.append(input);
  return { wrap, input };
}

type Position = { top: number; focus?: string };
let app: Theme | undefined;
let blocked: string | undefined;

class Theme {
  readonly api: Library;
  private root = el('div', 'jn-root');
  private content = el('main', 'jn-content');
  private menu?: HTMLDialogElement;
  private controller = new AbortController();
  private lifetime = new AbortController();
  private observer?: IntersectionObserver;
  private positions = new Map<string, Position>();
  private hash = '';
  private layout = initial();
  private settings?: Settings;
  private customized = false;
  private layoutReadable = false;

  private player = false;
  private featuredChoices = new Map<string, Item[]>();
  private nativeMain?: HTMLElement;
  private nativeState?: { inert: boolean; aria: string | null };
  private configLinks: Settings['Links'] = [];

  constructor(readonly account: NonNullable<ReturnType<typeof session>>) {
    this.api = new Library(account, status => {
      this.api.clear();
      if (status === 401 && this.settings) {
        this.destroy();
        if (app === this) app = undefined;
        blocked = account.key;
      }
    });
  }

  async start() {
    const signal = this.lifetime.signal;
    const [settings, layoutResult] = await Promise.all([
      this.api.request<Settings>('JellyNet/Settings', {}, signal),
      this.api.loadLayout(signal).then(layout => ({ ok: true, layout })).catch(() => ({ ok: false, layout: undefined }))
    ]);
    this.settings = settings;
    if (!this.settings || signal.aborted) { clearBoot(false); return; }

    void fetch(new URL('config.json', location.href), { signal }).then(response => response.json())
      .then(data => {
        this.configLinks = (Array.isArray(data.menuLinks) ? data.menuLinks : [])
          .filter((entry: {name?: unknown; url?: unknown}) => typeof entry.name === 'string' && typeof entry.url === 'string')
          .map((entry: {name: string; url: string}) => ({ Name: entry.name, Url: entry.url, AdminOnly: false }));
      }).catch(() => {});

    this.layoutReadable = layoutResult.ok;
    if (layoutResult.layout) {
      this.layout = layoutResult.layout;
      this.customized = true;
    }
    if (!signal.aborted) this.sync();
  }

  sync() {
    if (!this.settings || this.lifetime.signal.aborted) return;
    const next = location.hash;
    const isPlayer = /^#\/video(?:[/?]|$)/.test(next);
    if (this.player && !isPlayer) this.api.invalidateProgress();
    this.player = isPlayer;
    if (next === this.hash) return;
    if (this.root.isConnected) {
      const focus = (document.activeElement as HTMLElement | null)?.dataset.focus;
      this.positions.set(this.hash, { top: this.content.scrollTop, focus });
      if (this.positions.size > 30) this.positions.delete(this.positions.keys().next().value!);
    }
    if (!/^#\/home(?:\?|$)/.test(next)) this.api.invalidateProgress();
    this.hash = next;
    this.render();
  }

  destroy() {
    this.lifetime.abort();
    this.controller.abort();
    this.observer?.disconnect();
    this.menu?.close();
    this.root.remove();
    this.restoreStock();
    this.api.clear();
    clearBoot(false);
  }

  private restoreStock() {
    document.body.classList.remove('jn-enhanced', 'jn-native-details', 'jn-native-palette', 'jn-native-chrome', 'jn-match-details', 'jn-player-theme');
    document.body.style.removeProperty('--jn-detail-art');
    if (!this.nativeMain || !this.nativeState) return;
    this.nativeMain.inert = this.nativeState.inert;
    if (this.nativeState.aria === null) this.nativeMain.removeAttribute('aria-hidden');
    else this.nativeMain.setAttribute('aria-hidden', this.nativeState.aria);
    this.nativeMain = undefined;
    this.nativeState = undefined;
  }

  private navigationBar() {
    const bar = el('header', 'jn-bar');
    const hamburger = button('', () => this.openMenu(hamburger), 'jn-button jn-hamburger');
    hamburger.setAttribute('aria-label', 'Open navigation');
    const menuIcon = el('span', 'jn-menu-icon');
    menuIcon.setAttribute('aria-hidden', 'true');
    hamburger.append(menuIcon);
    hamburger.dataset.focus = 'menu';
    const nav = el('nav', 'jn-nav');
    nav.setAttribute('aria-label', 'Browse');
    nav.append(
      link('Home', route()),
      link('Movies', route('movies')),
      link('Series', route('series')),
      link('Categories', route('categories')),
      link('Search', route('search'))
    );
    for (const item of nav.querySelectorAll('a')) {
      if (item.hash === this.hash) item.setAttribute('aria-current', 'page');
    }
    bar.append(hamburger, link('JellyNet', route(), 'jn-brand'), nav);
    return bar;
  }

  private render() {
    this.controller.abort();
    this.controller = new AbortController();
    this.observer?.disconnect();
    this.menu?.close();
    this.root.remove();
    this.root.classList.remove('jn-detail-chrome');
    this.restoreStock();
    const [path, query] = this.hash.split('?');
    if (path !== '#/home') {
      if (!this.layout.standard && userRoute.test(path)) {
        document.body.classList.add('jn-native-palette');
        if (nativeBrowse.test(path)) {
          document.body.classList.add('jn-native-details');
          this.mountNativeChrome();
        }
        if (path === '#/details') this.styleDetail(new URLSearchParams(query));
        if (path === '#/video') document.body.classList.add('jn-player-theme');
      }
      releaseBoot();
      return;
    }
    const params = new URLSearchParams(query);
    const view = params.get('jellynet') || '';
    if (view && !['browse', 'categories', 'search', 'customize', 'stock', 'movies', 'series'].includes(view)) return;

    const signal = this.controller.signal;
    if (view === 'stock' || (this.layout.standard && !view)) {
      clearBoot(false);
      if (!this.layout.standard && (params.has('jellynetPlugin') || params.has('tab'))) {
        document.body.classList.add('jn-native-palette');
      }
      const shortcut = view === 'stock' && !this.layout.standard
        ? link('Back to JellyNet', route(), 'jn-button jn-stock-shortcut')
        : link('Customize Home', route('customize'), 'jn-button jn-stock-shortcut');
      this.root.replaceChildren(shortcut);
      this.root.classList.add('jn-standard');
      document.body.append(this.root);
      return;
    }

    this.root.classList.remove('jn-standard');
    const bar = this.navigationBar();
    this.content.classList.toggle('jn-home-content', !view);
    this.content.replaceChildren();
    this.root.replaceChildren(bar, this.content);
    document.body.classList.add('jn-enhanced');
    document.body.append(this.root);
    clearBoot(!this.layout.standard);
    const stock = document.querySelector<HTMLElement>('#reactRoot, #appRoot, .mainAnimatedPages');
    if (stock) {
      this.nativeMain = stock;
      this.nativeState = { inert: stock.inert, aria: stock.getAttribute('aria-hidden') };
      stock.inert = true;
      stock.setAttribute('aria-hidden', 'true');
    }

    const position = this.positions.get(this.hash);
    const restore = () => {
      this.content.scrollTop = position?.top ?? 0;
      if (position?.focus) {
        const item = [...this.root.querySelectorAll<HTMLElement>('[data-focus]')].find(node => node.dataset.focus === position.focus);
        item?.focus({ preventScroll: true });
      }
    };
    restore();
    if (view === 'browse' || view === 'search') this.browse(params, signal, restore);
    else if (view === 'movies' || view === 'series') {
      const media = view === 'movies' ? 'Movie' : 'Series';
      const title = view === 'movies' ? 'Movies' : 'Series';
      const catalog: Shelf = { id: 'all-' + view, title, kind: 'catalog', media };
      this.content.classList.add('jn-home-content');
      this.home(signal, restore, position, catalog);
    }
    else if (view === 'categories') void this.categories(signal).then(restore).catch(() => this.error(this.content, signal));
    else if (view === 'customize') void this.customize(signal).catch(() => this.error(this.content, signal));
    else this.home(signal, restore, position);
  }

  private mountNativeChrome() {
    document.body.classList.add('jn-native-chrome');
    this.root.classList.remove('jn-standard');
    this.root.classList.add('jn-detail-chrome');
    this.root.replaceChildren(this.navigationBar());
    document.body.append(this.root);
  }

  private styleDetail(params: URLSearchParams) {
    document.body.classList.add('jn-match-details');
    const id = params.get('id');
    const signal = this.controller.signal;
    if (!id || !/^[0-9a-f-]{32,36}$/i.test(id)) return;
    void this.api.item(id, signal).then(item => {
      if (signal.aborted) return;
      const artwork = this.api.image(item, true, 1280) || this.api.image(item, false, 640);
      if (artwork) document.body.style.setProperty('--jn-detail-art', `url("${artwork}")`);
    }).catch(() => {});
  }

  private error(host: HTMLElement, signal: AbortSignal, retry = () => this.render()) {
    if (signal.aborted) return;
    host.replaceChildren(el('p', 'jn-status', 'Jellyfin couldn’t load this section.'), button('Retry', retry));
  }

  private async openMenu(trigger: HTMLButtonElement) {
    if (this.menu?.open || !this.root.isConnected) return;
    const dialog = el('dialog', 'jn-drawer');
    this.menu = dialog;
    dialog.setAttribute('aria-label', 'JellyNet navigation');
    const grouping = (title: string) => {
      const group = el('section', 'jn-menu-group');
      group.append(el('h2', '', title));
      dialog.append(group);
      return group;
    };
    const top = el('div', 'jn-drawer-top');
    top.append(el('strong', '', 'JellyNet'), button('Close', () => dialog.close(), 'jn-button jn-drawer-close'));
    dialog.append(top);
    const browse = grouping('Browse');
    browse.append(link('Home', route()), link('Movies', route('movies')),
      link('Series', route('series')),
      link('Categories', route('categories')), link('Search', route('search')));
    const plugins = grouping('Plugins');
    const settings = grouping('Settings');
    settings.append(link('Customize Home', route('customize')), link('Open standard Jellyfin home', route('stock')), link('Jellyfin settings', '#/user/settings'));
    if (this.settings?.IsAdmin) settings.append(link('Dashboard', '#/dashboard'));
    const addPlugin = (name: string, open: () => unknown) => plugins.append(button(name, () => {
      dialog.close();
      trigger.focus();
      void Promise.resolve().then(open).catch(() => {
        if (this.root.isConnected) this.content.prepend(el('p', 'jn-status', name + ' could not be opened.'));
      });
    }));
    if (window.jellySeerrPlugin?.selectjellySeerrTab) browse.append(button('Requests', () => {
      dialog.close();
      void this.openRequests();
    }));
    const vote = document.getElementById('jellyvote-header-btn');
    if (vote) addPlugin('JellyVote', () => vote.click());
    if (window.JellyTube) addPlugin('YouTube', () => window.JellyTube?.open());
    if (window.jellySpotPlugin) addPlugin('Spotify', () => {
      location.hash = route('stock', { tab: 'browse' });
    });
    if (window.JellyManga) addPlugin('JellyTome (Manga)', () => window.JellyManga?.open());
    const seen = new Set<string>();
    for (const entry of [...(this.settings?.Links ?? []), ...this.configLinks]) {
      const url = safeLink(entry.Url);
      if (!url || (entry.AdminOnly && !this.settings?.IsAdmin) || seen.has(url)) continue;
      seen.add(url);
      plugins.append(link(entry.Name, url));
    }
    if (plugins.children.length === 1) plugins.hidden = true;

    dialog.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('a')) dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (this.menu === dialog) this.menu = undefined;
      if (trigger.isConnected) trigger.focus();
    });
    this.root.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else {
      dialog.setAttribute('open', '');
      dialog.close = () => {
        if (!dialog.hasAttribute('open')) return;
        dialog.removeAttribute('open');
        dialog.dispatchEvent(new Event('close'));
      };
      dialog.querySelector('button')?.focus();
    }

  }

  private async openRequests() {
    location.hash = route('stock', { jellynetPlugin: 'requests' });
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!location.hash.includes('jellynetPlugin=requests')) return;
      const tab = document.querySelector<HTMLElement>(
        '[data-jellyseerr-modern-tab="requests"], button[data-jellyseerr-tab="requests"]'
      );
      const seerr = window.jellySeerrPlugin;
      if (seerr?.selectjellySeerrTab && tab) {
        await seerr.selectjellySeerrTab('requests');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  private card(item: Item, landscape: boolean, eager: boolean) {
    const card = link('', details(item, this.account), 'jn-card' + (landscape ? ' jn-landscape' : ''));
    card.dataset.focus = item.Id;
    const artwork = el('div', 'jn-artwork');
    const src = this.api.image(item, landscape, landscape ? 460 : 320) || this.api.image(item, false, 320);
    if (src) artwork.append(image(src, eager));
    else artwork.append(el('span', 'jn-monogram', item.Name.trim().charAt(0) || '•'));
    const progress = item.UserData?.PlayedPercentage;
    if (progress && progress > 0 && progress < 100) {
      const indicator = el('progress');
      indicator.max = 100;
      indicator.value = progress;
      indicator.setAttribute('aria-label', 'Playback progress');
      artwork.append(indicator);
    }
    card.append(artwork, el('span', 'jn-title', item.SeriesName || item.Name));
    if (item.SeriesName) card.append(el('small', 'jn-subtitle', item.Name));
    return card;
  }

  private featured(host: HTMLElement, items: Item[]) {
    const item = items[0];
    if (!item) return;
    const art = image(this.api.image(item, true, 1280), true);
    art.setAttribute('fetchpriority', 'high');
    const copy = el('div', 'jn-feature-copy');
    copy.append(el('h1', '', item.SeriesName || item.Name));
    if (item.ProductionYear) copy.append(el('p', 'jn-year', String(item.ProductionYear)));
    const actions = el('div', 'jn-actions');
    actions.append(button(item.UserData?.PlaybackPositionTicks ? 'Resume' : 'Play', async () => {
      if (!await play(item, this.account) && session()?.key === this.account.key) location.hash = details(item, this.account);
    }, 'jn-button jn-primary'), link('Details', details(item, this.account)));
    if (items.length > 1) actions.append(button('Another pick', () => {
      items.push(items.shift()!);
      this.featured(host, items);
      host.querySelector<HTMLButtonElement>('.jn-actions button:last-child')?.focus();
    }));
    copy.append(actions);
    host.replaceChildren(art, copy);
    host.hidden = false;
  }

  private async defaultShelves(signal: AbortSignal): Promise<Shelf[]> {
    const pinned: Shelf[] = [];
    const seen = new Set<string>();
    for (const tag of this.settings?.PinnedTags ?? []) {
      if (!seen.has(tag)) pinned.push({ id: 'tag-' + tag, kind: 'tag', value: tag, title: tag });
      seen.add(tag);
    }
    const collections = this.settings?.PinnedCollections ?? [];
    if (collections.length) {
      const page = await this.api.request<{ Items: Item[] }>('Items', {
        userId: this.account.user, ids: collections.join(','), includeItemTypes: 'BoxSet', limit: 30
      }, signal, 300000);
      for (const item of page.Items) pinned.push({ id: item.Id, kind: 'collection', value: item.Id, title: item.Name });
    }
    return pinned;
  }

  private home(signal: AbortSignal, restore: () => void, position?: Position, catalog?: Shelf) {
    const home = el('div', 'jn-home');
    if (!this.customized) home.classList.add('jn-default-home');
    const hero = el('section', 'jn-feature');
    hero.hidden = true;
    home.append(hero);
    this.content.append(home);

    const queue: (() => Promise<void>)[] = [];
    let active = 0;
    const pump = () => {
      while (!signal.aborted && queue.length && active < 3) {
        active++;
        const task = queue.shift()!;
        void task().finally(() => { active--; pump(); });
      }
    };

    const visible = new Map<Element, () => void>();
    if ('IntersectionObserver' in window) {
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) visible.get(entry.target)?.();
      }, { root: this.content, rootMargin: '260px' });
    }

    const add = (shelf: Shelf, index: number) => {
      if (shelf.hidden || signal.aborted) return;
      const section = el('section', 'jn-shelf');
      section.dataset.kind = shelf.kind;
      const header = el('div', 'jn-shelf-header');
      header.append(el('h2', '', shelf.title), link('See all', saveTarget(shelf)));
      const row = el('div', 'jn-row');
      const loading = el('p', 'jn-status', 'Loading…');
      row.append(loading);
      section.append(header, row);
      home.append(section);

      const load = () => {
        row.replaceChildren(loading);
        queue.push(async () => {
          try {
            const result = await this.api.shelf(shelf, signal);
            if (signal.aborted) return;
            if (!result.Items.length) section.hidden = true;
            else row.replaceChildren(...result.Items.map((item, i) => this.card(item, Boolean(shelf.landscape), index < 2 && i < 3)));
            if (position?.focus && row.querySelector('[data-focus="' + CSS.escape(position.focus) + '"]')) restore();
          } catch { this.error(row, signal, load); }
        });
        pump();
      };
      const activate = () => {
        if (!visible.delete(section)) return;
        this.observer?.unobserve(section);
        load();
      };
      if (index < 3 || !this.observer || position) load();
      else {
        visible.set(section, activate);
        section.addEventListener('focusin', activate, { once: true });
        this.observer.observe(section);
      }
    };

    const shelves = catalog ? [defaults[catalog.media === 'Movie' ? 0 : 1], ...genreShelves]
      .map(shelf => ({ ...shelf, media: catalog.media })) : this.layout.shelves;
    if (catalog) {
      const catalogBar = el('div', 'jn-catalog-bar');
      catalogBar.append(el('h1', '', catalog.title), link('Browse all ' + catalog.title.toLowerCase(), saveTarget(catalog)));
      home.prepend(catalogBar);
    }
    shelves.forEach(add);
    if (catalog || this.layout.featured) {
      queue.push(async () => {
        try {
          const key = catalog?.media ?? 'home';
          let picks = this.featuredChoices.get(key);
          if (!picks) {
            const recent = catalog
              ? (await this.api.shelf(catalog.media === 'Series' ? defaults[1] : defaults[0], signal)).Items
              : (await Promise.all([
                ...defaults.slice(0, 2).map(shelf => this.api.shelf(shelf, signal).catch(() => ({ Items: [] }))),
                this.api.shelf({ id: 'featured-recommend', title: '', kind: 'recommend' }, signal, 0, 12)
                  .catch(() => ({ Items: [] }))
              ])).flatMap(page => page.Items);
            if (signal.aborted) return;
            picks = [...new Map(recent.map(item => [item.Id, item])).values()].filter(item => this.api.image(item, true, 1280));
            for (let i = picks.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [picks[i], picks[j]] = [picks[j], picks[i]];
            }
            this.featuredChoices.set(key, picks);
          }
          if (!signal.aborted) this.featured(hero, picks);
        } catch { /* The home remains usable without featured art. */ }
      });
      pump();
    }
    if (!catalog && !this.customized) {
      void this.defaultShelves(signal).then(shelves => {
        shelves.forEach((shelf, index) => add(shelf, this.layout.shelves.length + index));
      }).catch(() => {});
    }
    if (!catalog && this.layout.shelves.every(shelf => shelf.hidden) && this.customized) {
      home.append(link('Customize Home', route('customize')));
    }
  }

  private async categories(signal: AbortSignal) {
    const field = el('input');
    field.type = 'search';
    field.placeholder = 'Find a category';
    field.setAttribute('aria-label', 'Find a category');
    const list = el('div', 'jn-category-list');
    this.content.append(el('h1', '', 'Categories'), field, list);
    const genres = (await this.api.filters(signal)).Genres ?? [];
    if (signal.aborted) return;
    let revision = 0;
    const previews = new Map<string, Promise<Item | undefined>>();
    let previewSlots = 0;
    const previewQueue: (() => void)[] = [];
    const preview = (shelf: Shelf) => {
      const key = shelf.kind + ':' + shelf.value;
      const cached = previews.get(key);
      if (cached) return cached;
      const request = new Promise<Item | undefined>((resolve, reject) => {
        const run = () => {
          if (signal.aborted) { resolve(undefined); return; }
          previewSlots++;
          void this.api.shelf(shelf, signal, 0, 4).then(page => {
            const artwork = (item: Item) => this.api.image(item, true, 420) || this.api.image(item, false, 320);
            resolve(page.Items.find(artwork) ?? page.Items[0]);
          }, reject).finally(() => {
            previewSlots--;
            previewQueue.shift()?.();
          });
        };
        if (previewSlots < 4) run(); else previewQueue.push(run);
      });
      previews.set(key, request);
      return request;
    };
    const render = async () => {
      const attempt = ++revision;
      list.replaceChildren();
      const needle = field.value.trim().toLocaleLowerCase();
      const status = el('p', 'jn-status', 'Loading categories…');
      list.append(status);
      const matches = genres.filter(genre => genre.toLocaleLowerCase().includes(needle));
      const grid = el('div', 'jn-category-grid');
      let cursor = 0;
      let failed = false;
      const more = button('Show more genres', () => void load());
      const load = async () => {
        more.disabled = true;
        do {
          const batch = matches.slice(cursor, cursor + 12);
          cursor += batch.length;
          const tiles = await Promise.all(batch.map(async name => {
            const shelf: Shelf = { id: '', kind: 'genre', value: name, title: name };
            try {
              const item = await preview(shelf);
              if (!item) return;
              const tile = link('', saveTarget(shelf), 'jn-category-tile');
              const src = this.api.image(item, true, 420) || this.api.image(item, false, 320);
              if (src) tile.append(image(src));
              tile.append(el('span', '', name));
              tile.dataset.focus = 'genre' + name;
              return tile;
            } catch { failed = true; }
          }));
          if (signal.aborted || attempt !== revision) return;
          for (const tile of tiles) if (tile) grid.append(tile);
        } while (!grid.children.length && cursor < matches.length);
        grid.hidden = !grid.children.length;
        more.hidden = cursor >= matches.length;
        more.disabled = false;
        status.hidden = !!grid.children.length;
        status.textContent = failed ? 'Genres could not be loaded.' : 'No matching genres.';
      };
      more.hidden = true;
      list.append(grid, more);
      await load();
    };
    let searchTimer: number | undefined;
    field.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void render(), 180);
    });
    signal.addEventListener('abort', () => {
      clearTimeout(searchTimer);
      previewQueue.splice(0).forEach(run => run());
    }, { once: true });
    await render();
  }

  private browse(params: URLSearchParams, signal: AbortSignal, restore: () => void) {
    const kind = params.get('kind') as Kind;
    const search = params.get('jellynet') === 'search';
    const shelf: Shelf = {
      id: '', kind: kinds.has(kind) ? kind : 'catalog', value: params.get('value') ?? undefined,
      title: search ? 'Search' : params.get('title') || 'Browse',
      library: params.get('library') ?? undefined, media: params.get('media') ?? undefined,
      year: params.get('year') ?? undefined, watched: params.get('watched') ?? undefined, sort: params.get('sort') ?? undefined
    };
    const field = el('input');
    field.type = 'search';
    field.placeholder = 'Search movies and series';
    field.setAttribute('aria-label', field.placeholder);
    field.value = params.get('q') ?? '';
    const toolbar = el('div', 'jn-filters');
    const filterPanel = el('details', 'jn-browse-filters');
    filterPanel.append(el('summary', '', 'Filters and sorting'), toolbar);
    const grid = el('div', 'jn-grid jn-browse-grid');
    const requestGrid = el('div', 'jn-grid jn-browse-grid');
    const requestSection = el('section', 'jn-request-results');
    requestSection.append(el('h2', '', 'Available to request'), requestGrid);
    requestSection.hidden = true;
    const count = el('p', 'jn-browse-count');
    count.setAttribute('role', 'status');
    const catalogPage = !search && (shelf.media === 'Movie' || shelf.media === 'Series');
    const heading = el('div', 'jn-browse-heading' + (catalogPage ? ' jn-library-masthead' : ''));
    const mastheadArt = el('div', 'jn-library-art');
    if (catalogPage) heading.append(mastheadArt);
    heading.append(el('h1', '', shelf.title), count);
    const pager = el('div', 'jn-actions');
    this.content.append(heading);
    if (search) {
      field.className = 'jn-search-query';
      this.content.append(field);
      if (window.jellySeerrPlugin) {
        field.placeholder = 'Search your library and JellySeerr';
        field.setAttribute('aria-label', field.placeholder);
      }
    }
    if (!['resume', 'next', 'recommend'].includes(shelf.kind)) this.content.append(filterPanel);
    this.content.append(grid, pager, requestSection);

    const save = (page: number) => {
      for (const key of ['library', 'media', 'year', 'watched', 'sort'] as const) {
        if (shelf[key]) params.set(key, shelf[key]!); else params.delete(key);
      }
      if (search && field.value.trim()) params.set('q', field.value.trim()); else params.delete('q');
      if (page) params.set('page', String(page)); else params.delete('page');
      this.hash = '#/home?' + params.toString();
      history.replaceState(history.state, '', this.hash);
    };

    let task: AbortController | undefined;
    let debounce: number | undefined;
    let page = Math.min(10000, Math.max(0, Number(params.get('page')) || 0));
    const limit = 36;
    const load = async (remember = true) => {
      task?.abort();
      if (signal.aborted) return;
      const current = new AbortController();
      task = current;
      if (remember) save(page);
      pager.replaceChildren();
      requestSection.hidden = true;
      count.textContent = '';
      const query = field.value.trim();
      if (search && query.length >= 2 && window.jellySeerrPlugin && window.jellySeerrModal) {
        requestSection.hidden = false;
        requestGrid.replaceChildren(el('p', 'jn-status', 'Searching JellySeerr...'));
        void this.api.requestSearch(query, current.signal).then(items => {
          if (current.signal.aborted || signal.aborted) return;
          const cards = items.map(item => this.requestCard(item)).filter((card): card is HTMLButtonElement => !!card);
          requestGrid.replaceChildren(...cards);
          if (!cards.length) requestGrid.append(el('p', 'jn-status', 'No request results.'));
        }).catch(() => {
          if (!current.signal.aborted && !signal.aborted) requestGrid.replaceChildren(el('p', 'jn-status', 'JellySeerr results are temporarily unavailable.'));
        });
      }
      grid.replaceChildren(el('p', 'jn-status', 'Loading…'));
      try {
        if (search && !field.value.trim()) {
          grid.replaceChildren(el('p', 'jn-status', 'Enter a movie or series title.'));
          return;
        }
        const data = await this.api.shelf(shelf, current.signal, page * limit, limit, field.value.trim(), true);
        if (current.signal.aborted || signal.aborted) return;
        grid.replaceChildren(...data.Items.map((item, i) => this.card(item, false, i < 6)));
        if (catalogPage) {
          const art = data.Items.map(item => this.api.image(item, true, 960)).find(Boolean);
          mastheadArt.replaceChildren(...(art ? [image(art, true)] : []));
        }
        const total = data.TotalRecordCount ?? data.Items.length;
        count.textContent = search ? `${total} in your library` : `${total} ${total === 1 ? 'title' : 'titles'}`;
        if (!data.Items.length) grid.append(el('p', 'jn-status', 'No titles found.'));
        if (page) pager.append(button('Previous page', () => { page--; this.content.scrollTop = 0; void load(); }));
        if (data.TotalRecordCount == null ? data.Items.length === limit : (page + 1) * limit < data.TotalRecordCount) {
          pager.append(button('Next page', () => { page++; this.content.scrollTop = 0; void load(); }));
        }
        if (!remember) restore();
      } catch { this.error(grid, current.signal, () => void load()); }
    };

    signal.addEventListener('abort', () => { task?.abort(); clearTimeout(debounce); }, { once: true });
    field.addEventListener('input', () => {
      task?.abort();
      clearTimeout(debounce);
      page = 0;
      debounce = window.setTimeout(() => void load(), 250);
    });

    if (!['resume', 'next', 'recommend'].includes(shelf.kind)) {
      const add = (label: string, key: 'library' | 'media' | 'year' | 'watched' | 'sort', options: [string, string][]) => {
        const control = optionList(label, options, shelf[key]);
        control.input.addEventListener('change', () => {
          shelf[key] = control.input.value || undefined;
          page = 0;
          void load();
        });
        toolbar.append(control.wrap);
      };
      add('Type', 'media', [['', 'Movies and series'], ['Movie', 'Movies'], ['Series', 'Series'], ['*', 'All media']]);
      add('Watched', 'watched', [['', 'Any status'], ['true', 'Watched'], ['false', 'Unwatched']]);
      add('Sort', 'sort', [['', 'Default'], ['SortName', 'Title'], ['PremiereDate', 'Release date'], ['DateCreated', 'Date added']]);
      if (shelf.kind !== 'collection') void (shelf.media === 'Movie' ? this.api.movieLibraries() : this.api.views().then(page => page.Items)).then(items => {
        if (!signal.aborted) add('Library', 'library', [['', 'All libraries'], ...items.map((item): [string, string] => [item.Id, item.Name])]);
      }).catch(() => {});
      void this.api.years(signal).then(years => {
        if (!signal.aborted) add('Year', 'year', [['', 'Any year'], ...years.map((year): [string, string] => [String(year), String(year)])]);
      }).catch(() => {});
    }
    void load(false);
  }

  private requestCard(item: Item) {
    const provider = Object.fromEntries(Object.entries(item.ProviderIds ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const id = Number(provider.tmdb);
    const source = (item.SourceType ?? item.Type).toLowerCase();
    const type = source === 'movie' ? 'movie' : ['tv', 'series'].includes(source) ? 'tv' : '';
    if (!Number.isSafeInteger(id) || id <= 0 || !type) return;
    const card = button('', () => window.jellySeerrModal?.open(id, type), 'jn-card jn-request-card');
    const artwork = el('div', 'jn-artwork');
    const poster = provider.tmdbposterpath;
    const cached = provider.jellyseerrposter;
    if (cached && /^\/JellySeerr\/CachedImage\/[a-f0-9]+$/i.test(cached)) {
      artwork.append(image(this.account.client.getUrl(cached.slice(1))));
    } else if (poster && /^\/[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(poster)) {
      artwork.append(image('https://image.tmdb.org/t/p/w342' + poster));
    } else artwork.append(el('span', 'jn-monogram', item.Name.trim().charAt(0) || ''));
    card.append(artwork, el('span', 'jn-title', item.Name));
    return card;
  }

  private async customize(signal: AbortSignal) {
    this.content.append(el('h1', '', 'Customize Home'));
    if (!this.layoutReadable) {
      const layout = await this.api.loadLayout(signal);
      this.layoutReadable = true;
      if (layout) { this.layout = layout; this.customized = true; }
    }
    const editor = await import('./editor');
    if (signal.aborted) return;
    const draft = JSON.parse(JSON.stringify(this.layout)) as Layout;
    if (!this.customized) draft.shelves.push(...await this.defaultShelves(signal).catch(() => []));
    if (signal.aborted) return;
    editor.renderEditor(this.content, draft, this.api, signal, async (layout) => {
      await this.api.saveLayout(layout);
      if (signal.aborted) return;
      this.layout = layout;
      this.customized = true;
      this.api.invalidateProgress();
      location.hash = route();
    }, async () => {
      const layout = initial();
      layout.shelves.push(...await this.defaultShelves(signal).catch(() => []));
      return layout;
    });
  }
}

function releaseBoot() {
  document.documentElement.classList.remove('jn-preparing');
}

function clearBoot(remember: boolean) {
  releaseBoot();
  try {
    if (remember) sessionStorage.setItem('jellynet-ready', '1');
    else sessionStorage.removeItem('jellynet-ready');
  } catch { /* Storage is optional. */ }
}

function reconcile() {
  const account = session();
  if (app && app.account.key !== account?.key) {
    app.destroy();
    app = undefined;
  }
  if (account?.key !== blocked) blocked = undefined;
  if (!account || blocked || (!app && !userRoute.test(location.hash))) return;
  if (app) {
    app.sync();
    return;
  }
  const theme = new Theme(account);
  app = theme;
  void theme.start().catch(error => {
    if (app !== theme) return;
    theme.destroy();
    app = undefined;
    if (error instanceof HttpError && [401, 403, 404].includes(error.status)) blocked = account.key;
  });
}

function remote(event: KeyboardEvent) {
  const root = document.querySelector('.jn-root');
  if (!root || root.classList.contains('jn-standard') || document.body.classList.contains('jt-open') || document.getElementById('jm-app') || document.querySelector('.jv-modal-backdrop')) return;
  const dialog = root.querySelector<HTMLDialogElement>('dialog[open]');
  if (root.classList.contains('jn-detail-chrome') && !dialog && !(event.target instanceof Element && root.contains(event.target))) return;
  if (dialog && ['Escape', 'GoBack', 'BrowserBack', 'Backspace'].includes(event.key)
      && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (typeof dialog.close === 'function') dialog.close();
    else {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    }
    return;
  }

  if (/^Arrow/.test(event.key) && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
       || event.target instanceof HTMLTextAreaElement)) {
    const nodes = [...(dialog ?? root).querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input, select, summary')]
      .filter(node => node.getClientRects().length);
    const current = document.activeElement as HTMLElement;
    let target: HTMLElement | undefined;
    if (!nodes.includes(current)) target = nodes[0];
    else {
      const origin = current.getBoundingClientRect();
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const center = (rect: DOMRect) => [rect.x + rect.width / 2, rect.y + rect.height / 2];
      const [x, y] = center(origin);
      let best = Infinity;
      for (const node of nodes) {
        if (node === current) continue;
        const [nx, ny] = center(node.getBoundingClientRect());
        const primary = (horizontal ? nx - x : ny - y) * direction;
        const cross = Math.abs(horizontal ? ny - y : nx - x);
        if (primary <= 8) continue;
        const score = primary + cross * 3 + (cross > primary * 2 ? 200 : 0);
        if (score < best) { best = score; target = node; }
      }
    }
    if (target) {
      event.preventDefault();
      event.stopImmediatePropagation();
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

document.addEventListener('keydown', remote, true);
window.addEventListener('hashchange', reconcile);
window.addEventListener('popstate', reconcile);
const navigation = (window as Window & { navigation?: EventTarget }).navigation;
navigation?.addEventListener('currententrychange', reconcile);

// Older app webviews may replace the login route without emitting a hash-change event.
let loginCheck: number | undefined;
document.addEventListener('submit', () => {
  if (!/^#\/login(?:[?]|$)/.test(location.hash) || loginCheck !== undefined) return;
  const deadline = Date.now() + 5000;
  loginCheck = window.setInterval(() => {
    reconcile();
    if (app || Date.now() > deadline) {
      window.clearInterval(loginCheck);
      loginCheck = undefined;
    }
  }, 50);
}, true);
window.addEventListener('storage', reconcile);
document.addEventListener('visibilitychange', reconcile);
window.setInterval(() => { if (!document.hidden) reconcile(); }, 1000);
reconcile();
