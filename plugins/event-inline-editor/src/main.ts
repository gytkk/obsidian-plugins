import { App, ItemView, MarkdownPostProcessorContext, Notice, Plugin, TFile, TFolder, Vault, WorkspaceLeaf } from 'obsidian';

// ─── Constants ──────────────────────────────────────────────

const VIEW_TYPE = 'event-inline-view';
const EVENT_FOLDER = 'events';
const TASK_RE = /^([\s]*[-*+])\s\[(.)\]\s+(.+)$/;
const FIELD_RE = /\[(\w+)::\s*([^\]]+)\]/g;
const DATE_FIELDS = ['date', 'start', 'end'];
const COMPLETED_DAYS = 7;
const DAY_NAMES = ['\uC77C', '\uC6D4', '\uD654', '\uC218', '\uBAA9', '\uAE08', '\uD1A0'];

// ─── Types ──────────────────────────────────────────────────

interface Task {
  prefix: string;
  status: string;
  desc: string;
  fields: Record<string, string>;
  filePath: string;
  lineNum: number;
  raw: string;
}

interface Dropdown {
  element: HTMLDivElement;
  getValue: () => string;
  focusAndOpen: () => void;
}

interface TimeRow {
  element: HTMLDivElement;
  getTime: () => string;
  focusHour: () => void;
}

// ─── Helpers ────────────────────────────────────────────────

const getToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const getDayName = (dateStr: string): string => {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return '';
  return DAY_NAMES[new Date(y, m - 1, d).getDay()] ?? '';
};

const formatTime = (task: Task): string => {
  const { start, end } = task.fields;
  if (start && end) return `${start} - ${end}`;
  if (start) return `${start} ~`;
  return '';
};

const parseTask = (line: string, lineNum: number, filePath: string): Task | null => {
  const m = line.match(TASK_RE);
  if (!m) return null;
  const [, prefix, status, rest] = m;
  if (!prefix || !status || !rest) return null;

  const fields: Record<string, string> = {};
  const re = new RegExp(FIELD_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(rest)) !== null) {
    fields[match[1]!] = match[2]!.trim();
  }
  const desc = rest.replace(FIELD_RE, '').trim();
  return { prefix, status, desc, fields, filePath, lineNum, raw: line };
};

const parseTasks = (content: string, filePath: string): Task[] =>
  content.split('\n').reduce<Task[]>((acc, line, i) => {
    const t = parseTask(line, i, filePath);
    if (t) acc.push(t);
    return acc;
  }, []);

const taskToLine = (task: Task): string => {
  let line = `${task.prefix || '-'} [${task.status}] ${task.desc}`;
  for (const key of DATE_FIELDS) {
    if (task.fields[key]) line += ` [${key}:: ${task.fields[key]}]`;
  }
  for (const key of Object.keys(task.fields)) {
    if (!DATE_FIELDS.includes(key)) line += ` [${key}:: ${task.fields[key]}]`;
  }
  return line;
};

const isWithinDays = (dateStr: string | undefined, days: number): boolean => {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(y, m - 1, d);
  const now = new Date();
  return date >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
};

const isOverdue = (task: Task): boolean => {
  const date = task.fields['date'];
  return date ? date < getToday() : false;
};

const findLineIndex = (lines: string[], task: Task): number => {
  if (lines[task.lineNum] === task.raw) return task.lineNum;
  let closestDist = Infinity;
  let targetIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === task.raw) {
      const dist = Math.abs(i - task.lineNum);
      if (dist < closestDist) {
        closestDist = dist;
        targetIdx = i;
      }
    }
  }
  return targetIdx;
};

const cloneTask = (task: Task, overrides: Partial<Task> = {}): Task => ({
  prefix: task.prefix,
  status: task.status,
  desc: task.desc,
  fields: { ...task.fields },
  filePath: task.filePath,
  lineNum: task.lineNum,
  raw: task.raw,
  ...overrides,
});

// ─── EventRenderer ──────────────────────────────────────────

class EventRenderer {
  isUpdating = false;
  onUpdate: (() => void) | null = null;

  constructor(private app: App) {}

  async loadAllTasks(): Promise<Task[]> {
    const folder = this.app.vault.getAbstractFileByPath(EVENT_FOLDER);
    if (!folder || !(folder instanceof TFolder)) return [];

    const files: TFile[] = [];
    Vault.recurseChildren(folder, (f) => {
      if (f instanceof TFile && f.extension === 'md') files.push(f);
    });

    const allTasks: Task[] = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      allTasks.push(...parseTasks(content, file.path));
    }
    return allTasks;
  }

  async render(container: HTMLElement): Promise<void> {
    const allTasks = await this.loadAllTasks();

    const pending = allTasks
      .filter((t) => t.status === ' ')
      .sort((a, b) => {
        const dateA = a.fields['date'] ?? '9999';
        const dateB = b.fields['date'] ?? '9999';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return (a.fields['start'] ?? '99:99').localeCompare(b.fields['start'] ?? '99:99');
      });

    const done = allTasks
      .filter((t) => t.status === 'x' && isWithinDays(t.fields['date'], COMPLETED_DAYS))
      .sort((a, b) => (b.fields['date'] ?? '').localeCompare(a.fields['date'] ?? ''));

    const scrollTop = container.scrollTop;
    container.empty();
    container.addClass('event-inline-view');

    this.renderGroupedSection(container, '\uC608\uC815', pending);
    this.renderSection(container, '\uC644\uB8CC', done);

    container.scrollTop = scrollTop;
  }

  private renderGroupedSection(container: HTMLElement, title: string, tasks: Task[]): void {
    container.createEl('h2', { text: title });

    if (tasks.length > 0) {
      const groups = new Map<string, Task[]>();
      for (const task of tasks) {
        const key = task.fields['date'] ?? '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(task);
      }

      for (const [key, groupTasks] of groups) {
        const label = key ? `${key} (${getDayName(key)})` : '\uB0A0\uC9DC \uC5C6\uC74C';
        container.createEl('div', { cls: 'event-inline-date-group', text: label });
        for (const task of groupTasks) {
          this.renderEvent(container, task);
        }
      }
    }

    // Add event row
    const addRow = container.createDiv({ cls: 'event-inline-item event-inline-add-row' });
    addRow.createEl('span', { cls: 'event-inline-status-btn event-inline-add-circle' });
    const addPlaceholder = addRow.createEl('span', {
      cls: 'event-inline-add-placeholder',
      text: '\uC774\uBCA4\uD2B8\uB97C \uC785\uB825\uD558\uC138\uC694...',
    });

    addRow.addEventListener('click', () => {
      if (addRow.querySelector('.event-inline-add-input')) return;
      addPlaceholder.style.display = 'none';
      const input = addRow.createEl('input', {
        cls: 'event-inline-add-input',
        type: 'text',
        attr: { placeholder: '\uC774\uBCA4\uD2B8\uB97C \uC785\uB825\uD558\uC138\uC694...' },
      });
      input.focus();

      const save = () => {
        const desc = input.value.trim();
        input.remove();
        addPlaceholder.style.display = '';
        if (desc) this.addEvent(desc);
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
      });
    });
  }

  private renderSection(container: HTMLElement, title: string, tasks: Task[]): void {
    container.createEl('h2', { text: title });
    for (const task of tasks) {
      this.renderEvent(container, task);
    }
  }

  private renderEvent(container: HTMLElement, task: Task): void {
    const isDone = task.status === 'x';
    const overdue = !isDone && isOverdue(task);

    const row = container.createDiv({
      cls: `event-inline-item${isDone ? ' is-done' : ''}${overdue ? ' event-inline-item-overdue' : ''}`,
    });

    // Status button
    const statusIcons: Record<string, string> = { ' ': '', 'x': '\u2713' };
    const statusBtn = row.createEl('button', {
      cls: 'event-inline-status-btn',
      text: statusIcons[task.status] ?? '',
    });
    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.updateTaskStatus(task, task.status === 'x' ? ' ' : 'x');
    });

    // Description (contenteditable)
    const descEl = row.createEl('span', {
      cls: 'event-inline-item-desc',
      text: task.desc,
    });
    if (!isDone) descEl.setAttribute('contenteditable', 'true');

    let originalDesc = task.desc;
    descEl.addEventListener('focus', () => { originalDesc = descEl.textContent ?? ''; });
    descEl.addEventListener('blur', () => {
      const newDesc = (descEl.textContent ?? '').trim();
      if (newDesc && newDesc !== originalDesc) {
        this.updateTaskDesc(task, newDesc);
      } else if (!newDesc) {
        descEl.textContent = originalDesc;
      }
    });
    descEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); descEl.blur(); }
      if (e.key === 'Escape') { descEl.textContent = originalDesc; descEl.blur(); }
    });

    // Right area: time + date
    const datesEl = row.createDiv({ cls: 'event-inline-item-dates' });

    if (isDone) {
      if (task.fields['date']) {
        const timeStr = formatTime(task);
        const dateEl = datesEl.createDiv({ cls: 'event-inline-item-date' });
        dateEl.createEl('span', {
          cls: 'event-inline-item-date-value',
          text: task.fields['date'] + (timeStr ? ` ${timeStr}` : ''),
        });
      }
    } else {
      // Time (clickable)
      const timeText = formatTime(task);
      const timeEl = datesEl.createEl('span', {
        cls: `event-inline-item-time${timeText ? '' : ' is-empty'}`,
        text: timeText || '+',
      });
      timeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showTimeEditor(timeEl, task);
      });

      // Date
      if (task.fields['date']) {
        const dateEl = datesEl.createDiv({ cls: 'event-inline-item-date' });
        const dateVal = dateEl.createEl('span', {
          cls: 'event-inline-item-date-value',
          text: task.fields['date'],
        });
        dateVal.addEventListener('click', () => {
          dateVal.style.display = 'none';
          const input = dateEl.createEl('input', {
            cls: 'event-inline-item-date-input',
            type: 'date',
            value: task.fields['date'] ?? '',
          });
          input.focus();
          try { input.showPicker(); } catch { /* not supported */ }

          const saveDate = () => {
            const newDate = input.value;
            input.remove();
            dateVal.style.display = '';
            if (newDate && newDate !== task.fields['date']) {
              this.updateTaskField(task, 'date', newDate);
            }
          };
          input.addEventListener('blur', saveDate);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = task.fields['date'] ?? ''; input.blur(); }
          });
        });
      }
    }

    // Delete button
    const deleteBtn = row.createEl('button', {
      cls: 'event-inline-delete-btn',
      text: '\u00D7',
      attr: { 'aria-label': '\uC0AD\uC81C' },
    });
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteTask(task);
    });
  }

  private showTimeEditor(timeEl: HTMLElement, task: Task): void {
    document.querySelector('.event-inline-time-editor')?.remove();

    const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    const mins = ['00', '15', '30', '45'];

    const parseTime = (str: string | undefined): { h: string; m: string } => {
      if (!str) return { h: '', m: '' };
      const [h = '', m = ''] = str.split(':');
      return { h, m };
    };

    const popup = document.createElement('div');
    popup.className = 'event-inline-time-editor';

    popup.addEventListener('click', () => {
      for (const el of popup.querySelectorAll('.event-inline-dropdown-menu.is-open')) {
        el.classList.remove('is-open');
      }
    });

    const createDropdown = (
      options: string[],
      current: string,
      placeholder: string,
      onAutoConfirm?: () => void,
    ): Dropdown => {
      const wrapper = document.createElement('div');
      wrapper.className = 'event-inline-dropdown';
      let value = current;

      const trigger = document.createElement('button');
      trigger.className = 'event-inline-dropdown-trigger';
      trigger.textContent = current || placeholder;
      if (!current) trigger.classList.add('is-placeholder');
      wrapper.appendChild(trigger);

      const menu = document.createElement('div');
      menu.className = 'event-inline-dropdown-menu';
      let selectedEl: HTMLElement | null = null;
      const itemEls: HTMLElement[] = [];

      const selectItem = (opt: string, itemEl: HTMLElement) => {
        value = opt;
        trigger.textContent = opt;
        trigger.classList.remove('is-placeholder');
        menu.querySelector('.is-selected')?.classList.remove('is-selected');
        itemEl.classList.add('is-selected');
        selectedEl = itemEl;
      };

      const scrollToSelected = () => {
        if (selectedEl) {
          menu.scrollTop = selectedEl.offsetTop - menu.offsetHeight / 2 + selectedEl.offsetHeight / 2;
        }
      };

      const openMenu = () => {
        for (const el of popup.querySelectorAll('.event-inline-dropdown-menu.is-open')) {
          if (el !== menu) el.classList.remove('is-open');
        }
        menu.classList.add('is-open');
        scrollToSelected();
      };

      for (const opt of options) {
        const item = document.createElement('div');
        item.className = 'event-inline-dropdown-item';
        item.textContent = opt;
        if (opt === current) {
          item.classList.add('is-selected');
          selectedEl = item;
        }
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          selectItem(opt, item);
          menu.classList.remove('is-open');
        });
        itemEls.push(item);
        menu.appendChild(item);
      }

      wrapper.appendChild(menu);

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.classList.contains('is-open')) {
          menu.classList.remove('is-open');
        } else {
          openMenu();
        }
      });

      // Keyboard: type-ahead & navigation
      let typeBuffer = '';
      let typeTimer: ReturnType<typeof setTimeout> | null = null;

      trigger.addEventListener('keydown', (e) => {
        if (/^\d$/.test(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          if (!menu.classList.contains('is-open')) openMenu();

          typeBuffer += e.key;
          if (typeTimer) clearTimeout(typeTimer);
          typeTimer = setTimeout(() => { typeBuffer = ''; }, 1000);

          let matches = options.filter(o => o.startsWith(typeBuffer));
          if (matches.length === 0 && typeBuffer.length === 1) {
            typeBuffer = '0' + typeBuffer;
            matches = options.filter(o => o.startsWith(typeBuffer));
          }
          if (matches.length === 0) { typeBuffer = ''; return; }

          const matchOpt = matches[0]!;
          selectItem(matchOpt, itemEls[options.indexOf(matchOpt)]!);
          scrollToSelected();

          if (matches.length === 1) {
            menu.classList.remove('is-open');
            typeBuffer = '';
            if (typeTimer) clearTimeout(typeTimer);
            onAutoConfirm?.();
          }
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          if (!menu.classList.contains('is-open')) { openMenu(); return; }
          const curIdx = selectedEl ? itemEls.indexOf(selectedEl) : -1;
          const nextIdx = e.key === 'ArrowDown'
            ? (curIdx < itemEls.length - 1 ? curIdx + 1 : 0)
            : (curIdx > 0 ? curIdx - 1 : itemEls.length - 1);
          selectItem(options[nextIdx]!, itemEls[nextIdx]!);
          scrollToSelected();
        } else if (e.key === 'Enter') {
          if (menu.classList.contains('is-open')) {
            e.preventDefault();
            e.stopPropagation();
            menu.classList.remove('is-open');
            typeBuffer = '';
            if (typeTimer) clearTimeout(typeTimer);
            onAutoConfirm?.();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          menu.classList.remove('is-open');
          typeBuffer = '';
        }
      });

      return {
        element: wrapper,
        getValue: () => value,
        focusAndOpen: () => { trigger.focus(); openMenu(); },
      };
    };

    const createTimeRow = (
      label: string,
      currentTime: string | undefined,
      onRowConfirm?: () => void,
    ): TimeRow => {
      const cur = parseTime(currentTime);
      const rowEl = document.createElement('div');
      rowEl.className = 'event-inline-time-row';

      const lbl = document.createElement('span');
      lbl.className = 'event-inline-time-label';
      lbl.textContent = label;
      rowEl.appendChild(lbl);

      const minRef: { focusAndOpen?: () => void } = {};

      const hourDd = createDropdown(hours, cur.h, '--', () => {
        minRef.focusAndOpen?.();
      });
      rowEl.appendChild(hourDd.element);

      const colon = document.createElement('span');
      colon.className = 'event-inline-time-colon';
      colon.textContent = ':';
      rowEl.appendChild(colon);

      const minDd = createDropdown(mins, cur.m, '--', onRowConfirm);
      minRef.focusAndOpen = minDd.focusAndOpen;
      rowEl.appendChild(minDd.element);

      return {
        element: rowEl,
        getTime: () => {
          const hv = hourDd.getValue();
          if (!hv) return '';
          return `${hv}:${minDd.getValue() || '00'}`;
        },
        focusHour: () => hourDd.focusAndOpen(),
      };
    };

    const startRow = createTimeRow('시작', task.fields['start']);
    const endRow = createTimeRow('종료', task.fields['end']);
    popup.appendChild(startRow.element);
    popup.appendChild(endRow.element);

    let closeHandler: ((ev: MouseEvent) => void) | null = null;
    let keyHandler: ((ev: KeyboardEvent) => void) | null = null;

    const saveAndClose = () => {
      const newStart = startRow.getTime();
      const newEnd = endRow.getTime();
      popup.remove();
      if (closeHandler) document.removeEventListener('click', closeHandler);
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      if (newStart !== (task.fields['start'] ?? '') || newEnd !== (task.fields['end'] ?? '')) {
        this.updateEventTime(task, newStart, newEnd);
      }
    };

    const clearBtn = document.createElement('button');
    clearBtn.className = 'event-inline-time-clear';
    clearBtn.textContent = '\uC2DC\uAC04 \uC0AD\uC81C';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popup.remove();
      if (closeHandler) document.removeEventListener('click', closeHandler);
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      this.updateEventTime(task, '', '');
    });
    popup.appendChild(clearBtn);

    // Position below timeEl
    document.body.appendChild(popup);
    const rect = timeEl.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(0, rect.right - popup.offsetWidth)}px`;

    // Auto-focus start hour dropdown
    requestAnimationFrame(() => startRow.focusHour());

    // Close on outside click or Enter key
    setTimeout(() => {
      closeHandler = (ev: MouseEvent) => {
        if (!popup.contains(ev.target as Node)) saveAndClose();
      };
      keyHandler = (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && !popup.querySelector('.event-inline-dropdown-menu.is-open')) {
          ev.preventDefault();
          saveAndClose();
        }
      };
      document.addEventListener('click', closeHandler);
      document.addEventListener('keydown', keyHandler);
    }, 0);
  }

  // ─── File Writers ─────────────────────────────────────────

  private async updateTaskInFile(task: Task, updatedTask: Task): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file || !(file instanceof TFile)) return;

    const newLine = taskToLine(updatedTask);
    this.isUpdating = true;
    let updated = false;

    try {
      await this.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        const targetIdx = findLineIndex(lines, task);
        if (targetIdx === -1) {
          new Notice('Event not found in file. Refreshing view.');
          return data;
        }
        lines[targetIdx] = newLine;
        updated = true;
        return lines.join('\n');
      });

      if (updated) {
        task.raw = newLine;
        task.prefix = updatedTask.prefix;
        task.status = updatedTask.status;
        task.desc = updatedTask.desc;
        task.fields = updatedTask.fields;
      }
    } finally {
      this.isUpdating = false;
      this.onUpdate?.();
    }
  }

  private async updateTaskStatus(task: Task, newStatus: string): Promise<void> {
    await this.updateTaskInFile(task, cloneTask(task, { status: newStatus }));
  }

  private async updateTaskDesc(task: Task, newDesc: string): Promise<void> {
    await this.updateTaskInFile(task, cloneTask(task, { desc: newDesc }));
  }

  private async updateEventTime(task: Task, newStart: string, newEnd: string): Promise<void> {
    const updated = cloneTask(task);
    if (newStart) {
      updated.fields['start'] = newStart;
    } else {
      delete updated.fields['start'];
    }
    if (newEnd) {
      updated.fields['end'] = newEnd;
    } else {
      delete updated.fields['end'];
    }
    await this.updateTaskInFile(task, updated);
  }

  private async addEvent(desc: string): Promise<void> {
    const filePath = `${EVENT_FOLDER}/active.md`;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) {
      new Notice(`File not found: ${filePath}`);
      return;
    }

    const newLine = `- [ ] ${desc} [date:: ${getToday()}]`;
    this.isUpdating = true;
    try {
      await this.app.vault.process(file, (data) => `${data.trimEnd()}\n${newLine}\n`);
    } finally {
      this.isUpdating = false;
      this.onUpdate?.();
    }
  }

  async deleteTask(task: Task): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file || !(file instanceof TFile)) return;

    this.isUpdating = true;
    try {
      await this.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        const targetIdx = findLineIndex(lines, task);
        if (targetIdx === -1) {
          new Notice('Event not found in file.');
          return data;
        }
        lines.splice(targetIdx, 1);
        return lines.join('\n');
      });
    } finally {
      this.isUpdating = false;
      this.onUpdate?.();
    }
  }

  private async updateTaskField(task: Task, field: string, value: string): Promise<void> {
    const updated = cloneTask(task);
    updated.fields[field] = value;
    await this.updateTaskInFile(task, updated);
  }
}

// ─── EventView ──────────────────────────────────────────────

class EventView extends ItemView {
  private plugin: EventInlineEditorPlugin;
  private refreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private renderer: EventRenderer;

  constructor(leaf: WorkspaceLeaf, plugin: EventInlineEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.renderer = new EventRenderer(this.app);
    this.renderer.onUpdate = () => this.scheduleRefresh();
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Events'; }
  getIcon(): string { return 'calendar'; }

  async onOpen(): Promise<void> {
    await this.refresh();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file.path.startsWith(`${EVENT_FOLDER}/`) && !this.renderer.isUpdating) {
          this.scheduleRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file.path.startsWith(`${EVENT_FOLDER}/`)) this.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file.path.startsWith(`${EVENT_FOLDER}/`)) this.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file.path.startsWith(`${EVENT_FOLDER}/`) || oldPath.startsWith(`${EVENT_FOLDER}/`)) {
          this.scheduleRefresh();
        }
      })
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => this.refresh(), 300);
  }

  async onClose(): Promise<void> {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
  }

  private async refresh(): Promise<void> {
    await this.renderer.render(this.contentEl);
  }
}

// ─── Plugin ─────────────────────────────────────────────────

export default class EventInlineEditorPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new EventView(leaf, this));

    this.addRibbonIcon('calendar', 'Open Event View', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-event-view',
      name: 'Open Event View',
      callback: () => this.activateView(),
    });

    this.registerMarkdownCodeBlockProcessor('event-view', (_source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
      const renderer = new EventRenderer(this.app);
      renderer.render(el);

      let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
      const scheduleRefresh = () => {
        if (refreshTimeout) clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(() => renderer.render(el), 300);
      };
      renderer.onUpdate = scheduleRefresh;

      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (file.path.startsWith(`${EVENT_FOLDER}/`) && !renderer.isUpdating) {
            scheduleRefresh();
          }
        })
      );
    });
  }

  async onunload(): Promise<void> {}

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);

    if (leaves.length > 0) {
      workspace.revealLeaf(leaves[0]!);
    } else {
      const leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
        workspace.revealLeaf(leaf);
      }
    }
  }
}
