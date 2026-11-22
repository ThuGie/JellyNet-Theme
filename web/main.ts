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

const defaults: Shelf[] = [
  { id: 'resume', title: 'Continue Watching', kind: 'resume', landscape: true },
  { id: 'next', title: 'Next Up', kind: 'next', landscape: true },
  { id: 'latest', title: 'Recently Added', kind: 'latest' },
  { id: 'favorites', title: 'My List', kind: 'favorites' }
];

function initial(): Layout {
  return { version: 1, standard: false, featured: true, shelves: defaults.map(shelf => ({ ...shelf })) };
}

const kinds = new Set<Kind>(['resume', 'next', 'latest', 'favorites', 'releases', 'genre', 'tag', 'collection', 'recommend', 'catalog']);
const trustedHash = /^#\/[\w/-]+(?:\?[^\s]*)?$/;

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
  private views: Item[] = [];

  private player = false;
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
    if (!this.settings || signal.aborted) return;

    void this.api.views().then(data => { if (!signal.aborted) this.views = data.Items; }).catch(() => {});
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
  }

  private restoreStock() {
    document.body.classList.remove('jn-enhanced');
    if (!this.nativeMain || !this.nativeState) return;
    this.nativeMain.inert = this.nativeState.inert;
    if (this.nativeState.aria === null) this.nativeMain.removeAttribute('aria-hidden');
    else this.nativeMain.setAttribute('aria-hidden', this.nativeState.aria);
    this.nativeMain = undefined;
    this.nativeState = undefined;
  }

  private render() {
    this.controller.abort();
    this.controller = new AbortController();
    this.observer?.disconnect();
    this.menu?.close();
    this.root.remove();
    this.restoreStock();
    const [path, query] = this.hash.split('?');
    if (path !== '#/home') return;
    const params = new URLSearchParams(query);
    const view = params.get('jellynet') || '';
    if (view && !['browse', 'categories', 'search', 'customize', 'stock'].includes(view)) return;

    const signal = this.controller.signal;
    if (view === 'stock' || (this.layout.standard && !view)) {
      const shortcut = view === 'stock' && !this.layout.standard
        ? link('Back to JellyNet', route(), 'jn-button jn-stock-shortcut')
        : link('Customize Home', route('customize'), 'jn-button jn-stock-shortcut');
      this.root.replaceChildren(shortcut);
      this.root.classList.add('jn-standard');
      document.body.append(this.root);
      return;
    }

    this.root.classList.remove('jn-standard');
    const bar = el('header', 'jn-bar');
    const hamburger = button('☰', () => this.openMenu(hamburger), 'jn-button jn-hamburger');
    hamburger.setAttribute('aria-label', 'Open navigation');
    hamburger.dataset.focus = 'menu';
    const nav = el('nav', 'jn-nav');
    nav.setAttribute('aria-label', 'Browse');
    nav.append(
      link('Home', route()),
      link('Movies', saveTarget({ id: '', kind: 'catalog', media: 'Movie', title: 'Movies' })),
      link('Series', saveTarget({ id: '', kind: 'catalog', media: 'Series', title: 'Series' })),
      link('Categories', route('categories')),
      link('Search', route('search'))
    );
    for (const item of nav.querySelectorAll('a')) {
      if (item.hash === this.hash) item.setAttribute('aria-current', 'page');
    }
    bar.append(hamburger, link('JellyNet', route(), 'jn-brand'), nav);
    this.content.replaceChildren();
    this.root.replaceChildren(bar, this.content);
    document.body.classList.add('jn-enhanced');
    document.body.append(this.root);
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
    else if (view === 'categories') void this.categories(signal).then(restore).catch(() => this.error(this.content, signal));
    else if (view === 'customize') void this.customize(signal).catch(() => this.error(this.content, signal));
    else this.home(signal, restore, position);
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
    dialog.append(button('Close', () => dialog.close()));
    const browse = grouping('Browse');
    browse.append(link('Home', route()), link('Movies', saveTarget({ id: '', kind: 'catalog', media: 'Movie', title: 'Movies' })),
      link('Series', saveTarget({ id: '', kind: 'catalog', media: 'Series', title: 'Series' })),
      link('Categories', route('categories')), link('Search', route('search')));
    const libraries = grouping('Libraries');
    const plugins = grouping('Plugins');
    const settings = grouping('Settings');
    settings.append(link('Customize Home', route('customize')), link('Open standard Jellyfin home', route('stock')), link('Jellyfin settings', '#/user/settings'));
    if (this.settings?.IsAdmin) settings.append(link('Dashboard', '#/dashboard'));
    if (window.JellyTube) plugins.append(button('YouTube', () => {
      dialog.close();
      trigger.focus();
      void Promise.resolve(window.JellyTube?.open()).catch(() => {
        if (this.root.isConnected) this.content.prepend(el('p', 'jn-status', 'YouTube could not be opened.'));
      });
    }));
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
    const renderLibraries = (items: Item[]) => {
      if (!dialog.isConnected) return;
      for (const item of items) libraries.append(link(item.Name, saveTarget({
        id: '', kind: 'catalog', library: item.Id, title: item.Name, media: '*'
      })));
      if (!items.length) libraries.hidden = true;
    };
    if (this.views.length) renderLibraries(this.views);
    else void this.api.views().then(data => renderLibraries(data.Items)).catch(() => { libraries.hidden = true; });
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
    const item = items.find(candidate => this.api.image(candidate, true, 1280));
    if (!item) return;
    const art = image(this.api.image(item, true, 1280), true);
    art.setAttribute('fetchpriority', 'high');
    const copy = el('div', 'jn-feature-copy');
    copy.append(el('p', 'jn-feature-label', 'Featured'), el('h1', '', item.SeriesName || item.Name));
    if (item.ProductionYear) copy.append(el('p', 'jn-year', String(item.ProductionYear)));
    const actions = el('div', 'jn-actions');
    actions.append(button(item.UserData?.PlaybackPositionTicks ? 'Resume' : 'Play', async () => {
      if (!await play(item, this.account) && session()?.key === this.account.key) location.hash = details(item, this.account);
    }, 'jn-button jn-primary'), link('Details', details(item, this.account)));
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
    const filters = await this.api.filters(signal);
    return [...pinned, ...(filters.Genres ?? []).slice(0, 3).map((genre): Shelf => ({
      id: 'genre-' + genre, kind: 'genre', value: genre, title: genre
    }))];
  }

  private home(signal: AbortSignal, restore: () => void, position?: Position) {
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
      if (index < 2 || !this.observer || position) load();
      else {
        visible.set(section, activate);
        section.addEventListener('focusin', activate, { once: true });
        this.observer.observe(section);
      }
    };

    this.layout.shelves.forEach(add);
    if (this.layout.featured) {
      queue.push(async () => {
        try {
          const recent = await this.api.shelf(defaults[2], signal);
          if (!signal.aborted) this.featured(hero, recent.Items);
        } catch { /* The home remains usable without featured art. */ }
      });
      pump();
    }
    if (!this.customized) {
      void this.defaultShelves(signal).then(shelves => {
        shelves.forEach((shelf, index) => add(shelf, this.layout.shelves.length + index));
      }).catch(() => {});
    }
    if (this.layout.shelves.every(shelf => shelf.hidden) && this.customized) {
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
    const [filters, collections] = await Promise.all([
      this.api.filters(signal),
      this.api.collections(signal)
    ]);
    if (signal.aborted) return;
    const groups: [string, Kind, [string, string][]][] = [
      ['Genres', 'genre', (filters.Genres ?? []).map(value => [value, value])],
      ['Collections', 'collection', collections.map(item => [item.Id, item.Name])],
      ['Tags', 'tag', (filters.Tags ?? []).map(value => [value, value])]
    ];
    const render = () => {
      list.replaceChildren();
      const needle = field.value.trim().toLocaleLowerCase();
      for (const [title, kind, entries] of groups) {
        const matches = entries.filter(([, name]) => name.toLocaleLowerCase().includes(needle));
        if (!matches.length) continue;
        const section = el('section');
        section.append(el('h2', '', title));
        const grid = el('div', 'jn-category-grid');
        for (const [value, name] of matches) {
          const tile = link(name, saveTarget({ id: '', kind, value, title: name }));
          tile.dataset.focus = kind + value;
          grid.append(tile);
        }
        section.append(grid);
        list.append(section);
      }
      if (!list.children.length) list.append(el('p', 'jn-status', 'No matching categories.'));
    };
    field.addEventListener('input', render);
    render();
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
    const grid = el('div', 'jn-grid');
    const pager = el('div', 'jn-actions');
    this.content.append(el('h1', '', shelf.title));
    if (search) this.content.append(field);
    this.content.append(toolbar, grid, pager);

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
      grid.replaceChildren(el('p', 'jn-status', 'Loading…'));
      try {
        if (search && !field.value.trim()) {
          grid.replaceChildren(el('p', 'jn-status', 'Enter a movie or series title.'));
          return;
        }
        const data = await this.api.shelf(shelf, current.signal, page * limit, limit, field.value.trim(), true);
        if (current.signal.aborted || signal.aborted) return;
        grid.replaceChildren(...data.Items.map((item, i) => this.card(item, false, i < 6)));
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
      if (shelf.kind !== 'collection') void this.api.views().then(data => {
        if (!signal.aborted) add('Library', 'library', [['', 'All libraries'], ...data.Items.map((item): [string, string] => [item.Id, item.Name])]);
      }).catch(() => {});
      void this.api.years(signal).then(years => {
        if (!signal.aborted) add('Year', 'year', [['', 'Any year'], ...years.map((year): [string, string] => [String(year), String(year)])]);
      }).catch(() => {});
    }
    void load(false);
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

function reconcile() {
  const account = session();
  if (app && app.account.key !== account?.key) {
    app.destroy();
    app = undefined;
  }
  if (account?.key !== blocked) blocked = undefined;
  if (!account || blocked || (!app && !/^#\/home(?:[?]|$)/.test(location.hash))) return;
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
  if (!root || root.classList.contains('jn-standard') || document.body.classList.contains('jt-open')) return;
  const dialog = root.querySelector<HTMLDialogElement>('dialog[open]');
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
    const nodes = [...(dialog ?? root).querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input, select')]
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
window.addEventListener('storage', reconcile);
document.addEventListener('visibilitychange', reconcile);
window.setInterval(() => { if (!document.hidden) reconcile(); }, 1000);
reconcile();
