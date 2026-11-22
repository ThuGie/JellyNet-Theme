import type { Kind, Layout, Library, Shelf } from './api';
import { button, el } from './main';

const sources: [Kind, string][] = [
  ['resume', 'Continue Watching'], ['next', 'Next Up'], ['latest', 'Recently Added'],
  ['releases', 'New Releases'], ['favorites', 'My List'], ['genre', 'Genre'], ['tag', 'Tag'],
  ['collection', 'Collection'], ['recommend', 'Because You Watched'], ['catalog', 'Library or catalog']
];

function control(title: string, input: HTMLElement) {
  const label = el('label', 'jn-field', title);
  label.append(input);
  return label;
}

function select(entries: [string, string][], value = '') {
  const input = el('select');
  for (const [key, name] of entries) {
    const option = el('option', '', name);
    option.value = key;
    input.append(option);
  }
  input.value = value;
  return input;
}

function checkbox(value: boolean, change: (value: boolean) => void) {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => change(input.checked));
  return input;
}

export function renderEditor(host: HTMLElement, draft: Layout, api: Library, signal: AbortSignal,
  save: (draft: Layout) => Promise<void>, reset: () => Promise<Layout>) {
  const general = el('div', 'jn-editor-panel');
  const list = el('div', 'jn-editor-panel');
  const editor = el('div', 'jn-editor-panel');
  const status = el('p', 'jn-status');
  status.setAttribute('role', 'status');
  let selected: Shelf | undefined;
  let request: AbortController | undefined;
  let resetting = false;
  let saving = false;

  const saveButton = button('Save layout', async () => {
    if (saving || resetting) return;
    if (draft.shelves.some(shelf => !shelf.title.trim() || (['genre', 'tag', 'collection'].includes(shelf.kind) && !shelf.value))) {
      status.textContent = 'Give each shelf a name and select a category where required.';
      return;
    }
    saving = true;
    saveButton.disabled = true;
    status.textContent = 'Saving…';
    try { await save(JSON.parse(JSON.stringify(draft)) as Layout); }
    catch {
      status.textContent = 'Layout couldn’t be saved. Your draft is still here.';
      saveButton.textContent = 'Retry save';
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  }, 'jn-button jn-primary');

  const renderGeneral = () => {
    general.replaceChildren(
      control('Show featured title', checkbox(draft.featured, value => { draft.featured = value; })),
      control('Use standard Jellyfin home', checkbox(draft.standard, value => { draft.standard = value; }))
    );
  };

  const renderList = (focus?: string) => {
    list.replaceChildren(el('h2', '', 'Shelves'));
    draft.shelves.forEach((shelf, index) => {
      const row = el('div', 'jn-editor-row');
      const edit = button(shelf.title || 'Untitled shelf', () => { selected = shelf; renderFields(); });
      edit.dataset.editorFocus = shelf.id;
      const move = (direction: number) => {
        const next = index + direction;
        [draft.shelves[index], draft.shelves[next]] = [draft.shelves[next], draft.shelves[index]];
        renderList(shelf.id);
      };
      const up = button('Move up', () => move(-1));
      const down = button('Move down', () => move(1));
      up.disabled = index === 0;
      down.disabled = index === draft.shelves.length - 1;
      const remove = button('Remove', () => {
        draft.shelves.splice(index, 1);
        if (selected === shelf) { selected = undefined; renderFields(); }
        renderList(draft.shelves[Math.min(index, draft.shelves.length - 1)]?.id ?? 'add');
      });
      edit.setAttribute('aria-label', 'Edit ' + shelf.title);
      row.append(edit, up, down, remove);
      list.append(row);
    });

    const add = button('Add shelf', () => {
      if (draft.shelves.length >= 24) return;
      selected = { id: 'shelf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), title: 'Recently Added', kind: 'latest' };
      draft.shelves.push(selected);
      renderList();
      renderFields();
      editor.querySelector('input')?.focus();
    });
    add.dataset.editorFocus = 'add';
    add.disabled = draft.shelves.length >= 24;
    list.append(add);
    if (focus) [...list.querySelectorAll<HTMLElement>('[data-editor-focus]')].find(node => node.dataset.editorFocus === focus)?.focus();
  };

  function renderFields() {
    request?.abort();
    editor.replaceChildren();
    editor.hidden = !selected;
    if (!selected) return;
    const shelf = selected;
    const name = el('input');
    name.maxLength = 80;
    name.value = shelf.title;
    name.addEventListener('input', () => { shelf.title = name.value; renderList(); });
    const source = select(sources, shelf.kind);
    source.addEventListener('change', () => {
      shelf.kind = source.value as Kind;
      shelf.value = undefined;
      shelf.title = sources.find(([key]) => key === shelf.kind)![1];
      renderFields();
      renderList();
      editor.querySelector('select')?.focus();
    });

    editor.append(el('h2', '', 'Edit shelf'), control('Source', source), control('Name', name),
      control('Hide shelf', checkbox(Boolean(shelf.hidden), value => { shelf.hidden = value; })),
      control('Landscape cards', checkbox(Boolean(shelf.landscape), value => { shelf.landscape = value; })));

    const category = el('div');
    const filters = el('div', 'jn-filters');
    const preview = el('div', 'jn-preview');
    editor.append(category, filters);
    const choice = (key: 'value' | 'library' | 'media' | 'year' | 'watched' | 'sort', title: string,
      values: [string, string][], parent: HTMLElement) => {
      const input = select(values, shelf[key]);
      input.addEventListener('change', () => { shelf[key] = input.value || undefined; });
      parent.append(control(title, input));
    };

    if (!['resume', 'next', 'recommend'].includes(shelf.kind)) {
      choice('media', 'Media type', [['', 'Movies and series'], ['Movie', 'Movies'], ['Series', 'Series'], ['*', 'All media']], filters);
      choice('watched', 'Watched status', [['', 'Any'], ['true', 'Watched'], ['false', 'Unwatched']], filters);
      choice('sort', 'Sort', [['', 'Default'], ['SortName', 'Title'], ['PremiereDate', 'Release date'], ['DateCreated', 'Date added']], filters);
      void api.years(signal).then(years => {
        if (filters.isConnected && !signal.aborted) choice('year', 'Year',
          [['', 'Any year'], ...years.map((year): [string, string] => [String(year), String(year)])], filters);
      }).catch(() => {});
      void api.filters(signal).then(data => {
        if (!filters.isConnected || signal.aborted) return;
        if (shelf.kind === 'genre' || shelf.kind === 'tag') {
          const names = shelf.kind === 'genre' ? data.Genres : data.Tags;
          choice('value', shelf.kind === 'genre' ? 'Genre' : 'Tag',
            [['', 'Select a category'], ...(names ?? []).map((value): [string, string] => [value, value])], category);
        }
      }).catch(() => { if (category.isConnected) category.textContent = 'Category options are unavailable.'; });
      if (shelf.kind !== 'collection') void api.views().then(data => {
        if (filters.isConnected && !signal.aborted) choice('library', 'Library',
          [['', 'All libraries'], ...data.Items.map((item): [string, string] => [item.Id, item.Name])], filters);
      }).catch(() => {});
      else void api.collections(signal).then(items => {
        if (category.isConnected && !signal.aborted) choice('value', 'Collection',
          [['', 'Select a collection'], ...items.map((item): [string, string] => [item.Id, item.Name])], category);
      }).catch(() => { if (category.isConnected) category.textContent = 'Collections are unavailable.'; });
    }

    editor.append(button('Preview shelf', async () => {
      if (signal.aborted) return;
      request?.abort();
      const task = new AbortController();
      request = task;
      if (['genre', 'tag', 'collection'].includes(shelf.kind) && !shelf.value) {
        preview.textContent = 'Select a category to preview this shelf.';
        return;
      }
      preview.textContent = 'Loading preview…';
      try {
        const data = await api.shelf(shelf, task.signal, 0, 5);
        if (!task.signal.aborted) preview.textContent = data.Items.map(item => item.Name).join(' · ') || 'This shelf is empty.';
      } catch { if (!task.signal.aborted) preview.textContent = 'This shelf could not be previewed.'; }
    }), preview);
  }

  signal.addEventListener('abort', () => request?.abort(), { once: true });
  const resetButton = button('Reset to defaults', async () => {
    if (saving || resetting) return;
    resetting = true;
    resetButton.disabled = true;
    try {
      Object.assign(draft, await reset());
      selected = undefined;
      renderGeneral();
      renderList();
      renderFields();
      status.textContent = 'Default layout restored in this draft. Save to apply it.';
    } finally {
      resetting = false;
      resetButton.disabled = false;
    }
  });
  const actions = el('div', 'jn-actions jn-editor-actions');
  actions.append(saveButton, resetButton, status);
  host.append(general, list, editor, actions);
  renderGeneral();
  renderList();
  renderFields();
}
