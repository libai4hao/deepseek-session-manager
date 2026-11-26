import { tokenFromUserToken } from '../core/auth';
import { authHeaders } from '../core/http';
import { createFetchTransport } from '../core/transport';
import { dedupeLinks, parseLinks, splitLines } from '../core/parser';
import { buildIndex, guardLink } from '../core/guard';
import { getMessages, listSessions, verifyDeleted } from '../core/repository';
import { runQueue } from '../core/executor';
import { buildSnapshot } from '../core/snapshot';
import { locateSession, sessionIdFromHref } from './sidebar';
import type { ExecResult, ParsedLink, SessionMeta, Transport } from '../core/types';
import { execResultToAudit, toAuditLine, type AuditEvent } from '../core/audit';

const HOST_ID = 'dsx-host';
const AUDIT_KEY = 'dsx:audit:v1';
const AUDIT_CAP = 200;

interface Row {
  link: string;
  id?: string;
  title: string;
  updatedAt?: number;
  pinned?: boolean;
  status: 'ok' | 'reject';
  code?: string;
  detail?: string;
  result?: ExecResult;
}

const state = {
  rows: [] as Row[],
  sessions: [] as SessionMeta[],
  index: new Map<string, SessionMeta>(),
  previewToken: undefined as string | undefined,
  previewInput: '',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

function formatTime(updatedAt?: number): string {
  if (!updatedAt) return '-';
  return new Date(updatedAt * 1000).toLocaleString('zh-CN', { hour12: false });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function download(name: string, content: string, type = 'application/json'): void {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function readToken(): string | undefined {
  return tokenFromUserToken(localStorage.getItem('userToken'));
}

function makeTransport(token: string): Transport {
  return createFetchTransport({ headers: authHeaders(token), credentials: 'include' });
}

function readAuditLines(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AUDIT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === 'string') : [];
  } catch {
    return [];
  }
}

function appendAudit(events: AuditEvent[]): void {
  if (events.length === 0) return;
  try {
    const lines = readAuditLines().concat(events.map(toAuditLine)).slice(-AUDIT_CAP);
    localStorage.setItem(AUDIT_KEY, JSON.stringify(lines));
  } catch {
    // audit is best-effort; never block the delete flow on storage errors
  }
}

function mountShareNotice(): void {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  host.attachShadow({ mode: 'open' }).innerHTML = `
    <style>
      .card { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #fff7ed; color: #7c2d12;
              border: 1px solid #fed7aa; border-radius: 10px; padding: 10px 12px; max-width: 280px; box-shadow: 0 6px 24px rgba(0,0,0,.12); }
    </style>
    <div class="card">这是分享页，只读。DSX 的定位与删除只对本人账号会话生效。</div>`;
  document.body.appendChild(host);
}

function mountPanel(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #111827; }
      .ball { width: 46px; height: 46px; border-radius: 50%; background: #111827; color: #fff; display: flex;
              align-items: center; justify-content: center; font-weight: 700; cursor: pointer; user-select: none;
              box-shadow: 0 8px 24px rgba(0,0,0,.18); letter-spacing: .5px; }
      .panel { position: fixed; right: 16px; bottom: 74px; width: 380px; max-height: 72vh; display: none;
               flex-direction: column; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
               box-shadow: 0 12px 40px rgba(0,0,0,.16); overflow: hidden; }
      .panel.open { display: flex; }
      .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;
              border-bottom: 1px solid #f3f4f6; font-weight: 600; }
      .head small { font-weight: 400; color: #6b7280; margin-left: 6px; }
      .x { cursor: pointer; color: #9ca3af; font-size: 16px; padding: 0 4px; }
      textarea { margin: 10px 12px 6px; height: 84px; resize: vertical; border: 1px solid #e5e7eb; border-radius: 8px;
                 padding: 8px; font: 12px/1.5 ui-monospace, Consolas, monospace; outline: none; }
      textarea:focus { border-color: #93c5fd; }
      .bar { display: flex; gap: 8px; padding: 0 12px 8px; align-items: center; flex-wrap: wrap; }
      button { border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 7px; padding: 5px 10px;
               cursor: pointer; font-size: 12px; color: #111827; }
      button:hover { background: #f3f4f6; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
      button.danger:hover { background: #b91c1c; }
      .dry { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #374151; }
      .rows { max-height: 34vh; overflow: auto; border-top: 1px solid #f3f4f6; }
      .row { display: grid; grid-template-columns: 44px 1fr 74px; gap: 6px; padding: 7px 12px; border-bottom: 1px solid #f9fafb;
             align-items: center; }
      .row[data-locate] { cursor: pointer; }
      .row[data-locate]:hover { background: #fffbeb; }
      .row .tag { font-size: 11px; text-align: center; border-radius: 4px; padding: 1px 0; }
      .row .ok { background: #ecfdf5; color: #047857; }
      .row .reject { background: #fef2f2; color: #b91c1c; }
      .row .done { background: #eff6ff; color: #1d4ed8; }
      .row .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row .sub { font-size: 11px; color: #9ca3af; }
      .empty { padding: 14px 12px; color: #9ca3af; font-size: 12px; }
      .foot { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-top: 1px solid #f3f4f6; background: #fafafa; }
      .hint { flex: 1; font-size: 11px; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
    <div class="wrap">
      <div class="ball">DSX</div>
      <div class="panel">
        <div class="head"><span>DeepSeek 会话管家<small>链接 → 侧栏定位 → 删除</small></span><span class="x">×</span></div>
        <textarea placeholder="每行一个会话链接，例如：&#10;https://chat.deepseek.com/a/chat/s/&lt;id&gt;"></textarea>
        <div class="bar">
          <button id="fill">定位当前会话</button>
          <button id="preview">解析并预览</button>
          <button id="locate">定位侧栏</button>
          <label class="dry"><input type="checkbox" id="dry" checked>仅预演</label>
        </div>
        <div class="rows"><div class="empty">粘贴链接后点「解析并预览」。</div></div>
        <div class="foot">
          <button class="danger" id="apply">执行删除</button>
          <button id="audit">审计</button>
          <span class="hint"></span>
        </div>
      </div>
    </div>`;

  document.body.appendChild(host);

  const panel = shadow.querySelector<HTMLDivElement>('.panel')!;
  const ball = shadow.querySelector<HTMLDivElement>('.ball')!;
  const textarea = shadow.querySelector<HTMLTextAreaElement>('textarea')!;
  const rowsBox = shadow.querySelector<HTMLDivElement>('.rows')!;
  const hint = shadow.querySelector<HTMLSpanElement>('.hint')!;
  const dryBox = shadow.querySelector<HTMLInputElement>('#dry')!;
  const applyBtn = shadow.querySelector<HTMLButtonElement>('#apply')!;
  const previewBtn = shadow.querySelector<HTMLButtonElement>('#preview')!;
  const auditBtn = shadow.querySelector<HTMLButtonElement>('#audit')!;
  const fillBtn = shadow.querySelector<HTMLButtonElement>('#fill')!;
  const locateBtn = shadow.querySelector<HTMLButtonElement>('#locate')!;
  let deleting = false;

  const setHint = (text: string): void => {
    hint.textContent = text;
  };

  ball.addEventListener('click', () => panel.classList.toggle('open'));
  shadow.querySelector('.x')!.addEventListener('click', () => panel.classList.remove('open'));

  fillBtn.addEventListener('click', () => {
    textarea.value = location.href;
    void locate(sessionIdFromHref(location.href) ?? undefined);
  });

  const locate = async (id?: string): Promise<void> => {
    const target = id ?? state.rows.find(row => row.status === 'ok' && row.id)?.id;
    if (!target) {
      setHint('没有可定位条目，先解析预览');
      return;
    }

    setHint('在左侧会话栏定位…');
    const outcome = await locateSession(target);
    const short = target.slice(0, 8);

    if (outcome.found) {
      setHint(`已在侧栏定位 ${short}${outcome.scrolled ? `（滚动 ${outcome.steps} 步）` : ''}`);
    } else {
      setHint('侧栏只加载常用的约百条，未包含该会话；接口已确认存在，可直接删除');
    }
  };

  locateBtn.addEventListener('click', () => void locate());
  rowsBox.addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-locate]');
    const id = row?.dataset.locate;
    if (id) void locate(id);
  });

  auditBtn.addEventListener('click', () => {
    const auditLines = readAuditLines();
    if (auditLines.length === 0) {
      setHint('暂无有效审计记录');
      return;
    }
    download(`dsx-audit-${stamp()}.jsonl`, auditLines.join('\n') + '\n', 'application/x-ndjson');
    setHint('审计已下载');
  });

  const renderRows = (): void => {
    if (state.rows.length === 0) {
      rowsBox.innerHTML = '<div class="empty">没有条目。</div>';
      return;
    }

    rowsBox.innerHTML = state.rows
      .map(row => {
        const tag = row.result
          ? row.result.status === 'deleted'
            ? 'done'
            : 'reject'
          : row.status === 'ok'
            ? 'ok'
            : 'reject';
        const label = row.result
          ? row.result.status
          : row.status === 'ok'
            ? '待删'
            : (row.code ?? '拒绝').toString().slice(0, 6);

        const sub = row.detail
          ? escapeHtml(row.detail)
          : `${escapeHtml(formatTime(row.updatedAt))}${row.pinned ? ' · 置顶' : ''}`;

        return `<div class="row"${row.id && row.status === 'ok' ? ` data-locate="${escapeHtml(row.id)}" title="点一下在左侧会话栏定位"` : ''}>
          <span class="tag ${tag}">${escapeHtml(label)}</span>
          <span><span class="title">${escapeHtml(row.title)}</span><br><span class="sub">${sub}</span></span>
          <span class="sub">${escapeHtml((row.id ?? '-').slice(0, 8))}</span>
        </div>`;
      })
      .join('');
  };

  const refresh = async (): Promise<void> => {
    const token = readToken();
    if (!token) {
      setHint('未读到 userToken，请确认已登录');
      return;
    }

    previewBtn.disabled = true;
    applyBtn.disabled = true;
    locateBtn.disabled = true;
    setHint('读取会话列表…');

    try {
      const transport = makeTransport(token);
      state.sessions = await listSessions(transport);
      state.index = buildIndex(state.sessions);
      state.previewToken = token;
      state.previewInput = textarea.value;

      const links: ParsedLink[] = dedupeLinks(parseLinks(splitLines(textarea.value)));
      state.rows = links.map(link => {
        const outcome = guardLink(link, state.index, { protectPinned: true });
        if (outcome.ok && outcome.meta) {
          return {
            link: link.raw,
            id: outcome.meta.id,
            title: outcome.meta.title,
            updatedAt: outcome.meta.updatedAt,
            pinned: outcome.meta.pinned,
            status: 'ok',
            detail: '归属校验通过',
          };
        }
        return {
          link: link.raw,
          id: link.id,
          title: link.id ?? link.raw.slice(0, 40),
          status: 'reject',
          code: outcome.code,
          detail: outcome.detail,
        };
      });

      renderRows();
      const okCount = state.rows.filter(row => row.status === 'ok').length;
      const okRows = state.rows.filter(row => row.status === 'ok' && row.id);
      let suffix = '';

      // Single target: locate it in the sidebar right away, that is the primary job.
      if (okRows.length === 1) {
        const located = await locateSession(okRows[0].id as string);
        okRows[0].detail = located.found ? '已定位到左侧会话栏' : '接口已确认存在（侧栏未加载该条）';
        renderRows();
        suffix = located.found ? '，已定位到侧栏' : '，侧栏未加载该条';
      }

      setHint(`${state.sessions.length} 条会话可用，本次可删 ${okCount} 条${suffix}`);
    } catch (error) {
      setHint(`失败：${(error as Error).message}`);
    } finally {
      previewBtn.disabled = false;
      applyBtn.disabled = false;
      locateBtn.disabled = false;
    }
  };

  previewBtn.addEventListener('click', () => void refresh());

  applyBtn.addEventListener('click', () => {
    if (deleting) return;
    void (async () => {
      const targets = state.rows.filter(row => row.status === 'ok' && row.id);
      if (targets.length === 0) {
        setHint('没有可删条目，先解析预览');
        return;
      }
      if (dryBox.checked) {
        setHint('预演模式：未调用删除接口');
        return;
      }

      const confirmed =
        targets.length > 5
          ? prompt(`将删除 ${targets.length} 条会话，不可恢复。输入 DELETE 确认：`) === 'DELETE'
          : confirm(`删除 ${targets.length} 条会话？删除后不可恢复。`);

      if (!confirmed) return;

      const token = readToken();
      if (!token) {
        setHint('未读到 userToken');
        return;
      }
      if (token !== state.previewToken || textarea.value !== state.previewInput) {
        setHint('登录态或输入内容已变化，请重新解析并预览后再删除');
        return;
      }

      deleting = true;
      applyBtn.disabled = true;
      previewBtn.disabled = true;

      try {
        let freshSessions: SessionMeta[];
        try {
          freshSessions = await listSessions(makeTransport(token));
        } catch (error) {
          setHint(`删除前重新校验失败，已中止：${(error as Error).message}`);
          return;
        }
        const freshIndex = buildIndex(freshSessions);
        for (const target of targets) {
          const link = parseLinks([target.link])[0];
          const outcome = link ? guardLink(link, freshIndex, { protectPinned: true }) : undefined;
          if (!outcome?.ok || !outcome.meta || outcome.meta.id !== target.id || outcome.meta.pinned) {
            setHint(`删除前校验失败：${target.id?.slice(0, 8) ?? '目标'} 已不存在、归属变化或已置顶；请重新预览`);
            return;
          }
        }
        state.sessions = freshSessions;
        state.index = freshIndex;

        const audit: AuditEvent[] = [];
        let auditFlushed = false;

        try {
          setHint('生成快照…');
          const transport = makeTransport(token);
          const snapshots = [];

          for (const row of targets) {
            const meta = state.index.get(row.id!);
            if (!meta) throw new Error(`${row.id?.slice(0, 8) ?? '目标'} 已不在最新会话列表中`);
            const messages = await getMessages(transport, meta.id);
            snapshots.push(buildSnapshot(meta, messages));
          }
          download(`dsx-snapshots-${stamp()}.json`, JSON.stringify(snapshots, null, 2));

          const ids = targets.map(row => row.id as string);

          setHint('开始删除…');
          const results = await runQueue(
            transport,
            ids,
            { intervalMs: 500, batchSize: 20, batchPauseMs: 10_000, retries: 2, shape: 'auto' },
            {
              onStart: (id, position, total) => setHint(`[${position + 1}/${total}] ${id.slice(0, 8)} …`),
              onResult: result => {
                const row = state.rows.find(item => item.id === result.id);
                if (row) row.result = result;
                audit.push(execResultToAudit(result));
                renderRows();
              },
            },
          );

          appendAudit(audit);
          auditFlushed = true;

          try {
            const verify = await verifyDeleted(transport, ids);
            const still = verify.filter(entry => entry.stillThere).length;
            state.sessions = await listSessions(transport);
            state.index = buildIndex(state.sessions);
            setHint(`完成：删除 ${results.filter(r => r.status === 'deleted').length} 条，仍在列表 ${still} 条`);
          } catch {
            setHint(`完成：删除 ${results.filter(r => r.status === 'deleted').length} 条（复核失败）`);
          }
        } catch (error) {
          if (!auditFlushed && audit.length > 0) appendAudit(audit);
          setHint(`执行异常中止：${(error as Error).message}`);
        }
      } finally {
        deleting = false;
        dryBox.checked = true;
        applyBtn.disabled = false;
        previewBtn.disabled = false;
      }
    })();
  });

  renderRows();
}

function boot(): void {
  if (location.pathname.startsWith('/share/')) {
    mountShareNotice();
    return;
  }
  mountPanel();

  // Feature 1: highlight the conversation you are currently reading in the sidebar.
  const currentId = sessionIdFromHref(location.href);
  if (currentId) {
    window.setTimeout(() => {
      void locateSession(currentId);
    }, 700);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
