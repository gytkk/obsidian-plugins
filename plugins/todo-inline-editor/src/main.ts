import { App, ItemView, MarkdownPostProcessorContext, Notice, Plugin, TFile, TFolder, Vault, WorkspaceLeaf } from 'obsidian';

// ─── Constants ──────────────────────────────────────────────

const VIEW_TYPE = 'todo-inline-view';
const TODO_FOLDER = 'todos';
const TASK_RE = /^([\s]*[-*+])\s\[(.)\]\s+(.+)$/;
const FIELD_RE = /\[(\w+)::\s*([^\]]+)\]/g;
const DATE_FIELDS = ['due', 'created', 'completion'];
const COMPLETED_DAYS = 7;

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

interface DateInfo {
  key: string;
  value: string;
  editable: boolean;
  cls?: string;
}

// ─── Helpers ────────────────────────────────────────────────

const getToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const due = task.fields['due'];
  return due ? due < getToday() : false;
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

// ─── TodoRenderer ───────────────────────────────────────────

class TodoRenderer {
  isUpdating = false;
  onUpdate: (() => void) | null = null;

  constructor(private app: App) {}

  async loadAllTasks(): Promise<Task[]> {
    const folder = this.app.vault.getAbstractFileByPath(TODO_FOLDER);
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
      .sort((a, b) => (a.fields['due'] ?? '9999').localeCompare(b.fields['due'] ?? '9999'));

    const done = allTasks
      .filter((t) => t.status === 'x' && isWithinDays(t.fields['completion'], COMPLETED_DAYS))
      .sort((a, b) => (b.fields['completion'] ?? '').localeCompare(a.fields['completion'] ?? ''));

    const scrollTop = container.scrollTop;
    document.querySelector('.todo-inline-status-popup')?.remove();
    container.empty();
    container.addClass('todo-inline-view');

    this.renderGroupedSection(container, '\uC9C4\uD589\uC911', pending);
    this.renderSection(container, '\uC644\uB8CC', done);

    container.scrollTop = scrollTop;
  }

  private renderGroupedSection(container: HTMLElement, title: string, tasks: Task[]): void {
    container.createEl('h2', { text: title });

    if (tasks.length > 0) {
      const groups = new Map<string, Task[]>();
      for (const task of tasks) {
        const key = task.fields['due'] ?? '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(task);
      }

      for (const [key, groupTasks] of groups) {
        container.createEl('div', { cls: 'todo-inline-date-group', text: key || '\uB0A0\uC9DC \uC5C6\uC74C' });
        for (const task of groupTasks) {
          this.renderTask(container, task);
        }
      }
    }

    // Add task row
    const addRow = container.createDiv({ cls: 'todo-inline-item todo-inline-add-row' });
    addRow.createEl('span', { cls: 'todo-inline-status-btn todo-inline-add-circle' });
    const addPlaceholder = addRow.createEl('span', {
      cls: 'todo-inline-add-placeholder',
      text: '\uD560 \uC77C\uC744 \uC785\uB825\uD558\uC138\uC694...',
    });

    addRow.addEventListener('click', () => {
      if (addRow.querySelector('.todo-inline-add-input')) return;
      addPlaceholder.style.display = 'none';
      const input = addRow.createEl('input', {
        cls: 'todo-inline-add-input',
        type: 'text',
        attr: { placeholder: '\uD560 \uC77C\uC744 \uC785\uB825\uD558\uC138\uC694...' },
      });
      input.focus();

      const save = () => {
        const desc = input.value.trim();
        input.remove();
        addPlaceholder.style.display = '';
        if (desc) this.addTask(desc);
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
      this.renderTask(container, task);
    }
  }

  private renderTask(container: HTMLElement, task: Task): void {
    const isDone = task.status === 'x';
    const overdue = !isDone && isOverdue(task);

    const row = container.createDiv({
      cls: `todo-inline-item${isDone ? ' is-done' : ''}${overdue ? ' todo-inline-item-overdue' : ''}`,
    });

    // Status button
    const statusIcons: Record<string, string> = { ' ': '', 'x': '\u2713' };
    const statusBtn = row.createEl('button', {
      cls: 'todo-inline-status-btn',
      text: statusIcons[task.status] ?? '',
    });

    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.updateTaskStatus(task, task.status === 'x' ? ' ' : 'x');
    });

    statusBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const existing = document.querySelector('.todo-inline-status-popup');
      if (existing) { existing.remove(); return; }

      const popup = document.createElement('div');
      popup.className = 'todo-inline-status-popup';

      const options = [
        { value: ' ', icon: '\u25CB', label: '\uC9C4\uD589\uC911' },
        { value: 'x', icon: '\u2713', label: '\uC644\uB8CC' },
      ];

      for (const opt of options) {
        const optEl = document.createElement('div');
        optEl.className = `todo-inline-status-option${opt.value === task.status ? ' is-active' : ''}`;

        const iconSpan = document.createElement('span');
        iconSpan.className = 'todo-inline-status-option-icon';
        iconSpan.textContent = opt.icon;
        optEl.appendChild(iconSpan);

        const labelSpan = document.createElement('span');
        labelSpan.textContent = opt.label;
        optEl.appendChild(labelSpan);

        optEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          popup.remove();
          if (opt.value !== task.status) this.updateTaskStatus(task, opt.value);
        });
        popup.appendChild(optEl);
      }

      document.body.appendChild(popup);
      const rect = statusBtn.getBoundingClientRect();
      popup.style.top = `${rect.bottom + 4}px`;
      popup.style.left = `${rect.left}px`;

      setTimeout(() => {
        const closeHandler = (ev: MouseEvent) => {
          if (!popup.contains(ev.target as Node)) {
            popup.remove();
            document.removeEventListener('click', closeHandler);
          }
        };
        document.addEventListener('click', closeHandler);
      }, 0);
    });

    // Description (contenteditable)
    const descEl = row.createEl('span', {
      cls: 'todo-inline-item-desc',
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

    // Dates (right-aligned)
    const dates: DateInfo[] = [];
    if (isDone) {
      if (task.fields['created']) dates.push({ key: 'created', value: task.fields['created'], editable: false, cls: 'todo-inline-item-date-created' });
      if (task.fields['completion']) dates.push({ key: 'completion', value: task.fields['completion'], editable: false });
    } else {
      if (task.fields['due']) dates.push({ key: 'due', value: task.fields['due'], editable: true });
    }

    if (dates.length > 0) {
      const dateWrap = row.createDiv({ cls: 'todo-inline-item-dates' });
      for (const d of dates) {
        const dateCls = `todo-inline-item-date${d.cls ? ` ${d.cls}` : ''}${d.key !== 'due' && d.key !== 'created' ? ' todo-inline-item-date-secondary' : ''}`;
        const dateRow = dateWrap.createDiv({ cls: dateCls });
        const dateVal = dateRow.createEl('span', {
          cls: 'todo-inline-item-date-value',
          text: d.value,
        });

        if (d.editable) {
          dateVal.addEventListener('click', () => {
            dateVal.style.display = 'none';
            const input = dateRow.createEl('input', {
              cls: 'todo-inline-item-date-input',
              type: 'date',
              value: d.value,
            });
            input.focus();
            try { input.showPicker(); } catch { /* not supported */ }

            const saveDate = () => {
              const newDate = input.value;
              input.remove();
              dateVal.style.display = '';
              if (newDate && newDate !== d.value) this.updateTaskField(task, d.key, newDate);
            };
            input.addEventListener('blur', saveDate);
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
              if (e.key === 'Escape') { input.value = d.value; input.blur(); }
            });
          });
        }
      }
    }

    // Delete button
    const deleteBtn = row.createEl('button', {
      cls: 'todo-inline-delete-btn',
      text: '\u00D7',
      attr: { 'aria-label': '\uC0AD\uC81C' },
    });
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteTask(task);
    });
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
          new Notice('Task not found in file. Refreshing view.');
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
    const updated = cloneTask(task, { status: newStatus });
    if (newStatus === 'x') {
      updated.fields['completion'] = getToday();
    } else {
      delete updated.fields['completion'];
    }
    await this.updateTaskInFile(task, updated);
  }

  private async updateTaskDesc(task: Task, newDesc: string): Promise<void> {
    await this.updateTaskInFile(task, cloneTask(task, { desc: newDesc }));
  }

  private async addTask(desc: string): Promise<void> {
    const filePath = `${TODO_FOLDER}/active.md`;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) {
      new Notice(`File not found: ${filePath}`);
      return;
    }

    const td = getToday();
    const newLine = `- [ ] ${desc} [due:: ${td}] [created:: ${td}]`;
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
          new Notice('Task not found in file.');
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

// ─── TodoView ───────────────────────────────────────────────

class TodoView extends ItemView {
  private plugin: TodoInlineEditorPlugin;
  private refreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private renderer: TodoRenderer;

  constructor(leaf: WorkspaceLeaf, plugin: TodoInlineEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.renderer = new TodoRenderer(this.app);
    this.renderer.onUpdate = () => this.scheduleRefresh();
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Todo'; }
  getIcon(): string { return 'check-square'; }

  async onOpen(): Promise<void> {
    await this.refresh();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file.path.startsWith(`${TODO_FOLDER}/`) && !this.renderer.isUpdating) {
          this.scheduleRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file.path.startsWith(`${TODO_FOLDER}/`)) this.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file.path.startsWith(`${TODO_FOLDER}/`)) this.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file.path.startsWith(`${TODO_FOLDER}/`) || oldPath.startsWith(`${TODO_FOLDER}/`)) {
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

export default class TodoInlineEditorPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new TodoView(leaf, this));

    this.addRibbonIcon('check-square', 'Open Todo View', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-todo-view',
      name: 'Open Todo View',
      callback: () => this.activateView(),
    });

    this.registerMarkdownCodeBlockProcessor('todo-view', (_source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
      const renderer = new TodoRenderer(this.app);
      renderer.render(el);

      let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
      const scheduleRefresh = () => {
        if (refreshTimeout) clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(() => renderer.render(el), 300);
      };
      renderer.onUpdate = scheduleRefresh;

      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (file.path.startsWith(`${TODO_FOLDER}/`) && !renderer.isUpdating) {
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
