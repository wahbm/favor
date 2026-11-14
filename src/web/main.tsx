import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, download, setCsrf, ApiError, appBase } from './api';
import {
  today,
  amountToCents,
  type User,
  type Ledger,
  type Meta,
  type Entry,
  type Summary,
  type RecordInput,
  type Person,
  type Named,
} from '../shared/domain';
import './style.css';
const money = (n: number) =>
  new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    n / 100,
  );
const beijingTime = (v: string) =>
  new Date(v.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
const emptyMeta: Meta = { people: [], occasions: [], events: [], members: [] };
type View = 'overview' | 'records' | 'people' | 'events' | 'settings';
type Filters = {
  personId: string;
  occasionId: string;
  eventId: string;
  direction: string;
  ownership: string;
  from: string;
  to: string;
};
const blankFilters: Filters = {
  personId: '',
  occasionId: '',
  eventId: '',
  direction: '',
  ownership: '',
  from: '',
  to: '',
};
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    book: (
      <>
        <path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4z" />
        <path d="M13 7a3 3 0 0 1 3-3h4v14h-3a4 4 0 0 0-4 3" />
      </>
    ),
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    records: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" />
      </>
    ),
    events: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2" />
      </>
    ),
    settings: (
      <>
        <path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="m7 17 10-10M7 7h10v10" />,
    down: <path d="m7 7 10 10M7 17h10V7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    export: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6" />
      </>
    ),
    chevron: <path d="m8 5 7 7-7 7" />,
    leaf: (
      <>
        <path d="M20 3C8 1 1 9 6 16s17 0 14-13Z" />
        <path d="M4 21 16 8" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.book}
    </svg>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [bootError, setBootError] = useState('');
  const [ledgers, setLedgers] = useState<Ledger[]>([]),
    [ledgerId, setLedgerId] = useState(''),
    [meta, setMeta] = useState<Meta>(emptyMeta),
    [view, setView] = useState<View>('overview');
  const [entries, setEntries] = useState<Entry[]>([]),
    [summary, setSummary] = useState<Summary>({ income: 0, expense: 0, count: 0 }),
    [filters, setFilters] = useState<Filters>(blankFilters),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0),
    [dataError, setDataError] = useState('');
  const [editor, setEditor] = useState<Entry | 'new' | null>(null),
    [newLedger, setNewLedger] = useState(false),
    [editPerson, setEditPerson] = useState<Person | 'new' | null>(null),
    [toast, setToast] = useState('');
  const [invite, setInvite] = useState(
    () => new URLSearchParams(location.search).get('invite') || '',
  );
  const [joining, setJoining] = useState(false);
  const ledger = ledgers.find((l) => l.id === ledgerId);
  const notify = (s: string) => setToast(s);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  async function loadLedgers(preferred?: string) {
    const list = await api<Ledger[]>('/ledgers');
    setLedgers(list);
    setLedgerId((old) =>
      preferred && list.some((l) => l.id === preferred)
        ? preferred
        : list.some((l) => l.id === old)
          ? old
          : list[0]?.id || '',
    );
  }
  async function bootSession() {
    setBoot(true);
    setBootError('');
    try {
      const data = await api<{ user: User; csrf: string }>('/auth/me');
      setCsrf(data.csrf);
      setUser(data.user);
      await loadLedgers();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setBootError((e as Error).message);
    } finally {
      setBoot(false);
    }
  }
  useEffect(() => {
    void bootSession();
  }, []);
  useEffect(() => {
    setFilters(blankFilters);
    setEntries([]);
    setMeta(emptyMeta);
    setView('overview');
  }, [ledgerId]);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v && k !== 'ownership') query.set(k, v);
  }
  if (filters.ownership === 'family') query.set('scope', 'family');
  else if (filters.ownership === 'personal') query.set('scope', 'personal');
  else if (filters.ownership) {
    query.set('scope', 'personal');
    query.set('ownerId', filters.ownership);
  }
  const queryString = query.toString();
  useEffect(() => {
    if (!user || !ledgerId) return;
    const abort = new AbortController();
    setLoading(true);
    setDataError('');
    Promise.all([
      api<Meta>(`/ledgers/${ledgerId}/meta`, 'GET', undefined, abort.signal),
      api<{ records: Entry[]; summary: Summary }>(
        `/ledgers/${ledgerId}/records?${queryString}`,
        'GET',
        undefined,
        abort.signal,
      ),
    ])
      .then(([m, r]) => {
        setMeta(m);
        setEntries(r.records);
        setSummary(r.summary);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setDataError(e.message);
          setEntries([]);
          if (e.status === 401) {
            setUser(null);
            setLedgers([]);
          }
          if (e.status === 404) void loadLedgers();
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [user, ledgerId, queryString, refresh]);
  const reload = () => setRefresh((n) => n + 1);
  async function signedIn(data: { user: User; csrf: string }) {
    setCsrf(data.csrf);
    setUser(data.user);
    await loadLedgers();
  }
  async function logout() {
    try {
      await api('/auth/logout', 'POST');
      setUser(null);
      setLedgerId('');
      setLedgers([]);
      setCsrf('');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function acceptInvite() {
    setJoining(true);
    try {
      const data = await api<{ id: string }>('/invites/accept', 'POST', { token: invite });
      setInvite('');
      history.replaceState(null, '', appBase);
      await loadLedgers(data.id);
      notify('已加入家庭账本');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setJoining(false);
    }
  }
  if (boot)
    return (
      <div className="center-screen">
        <div className="brand">
          <Icon name="book" size={30} />
          有来有往
        </div>
        <p>正在打开你的账本…</p>
      </div>
    );
  if (bootError)
    return (
      <div className="center-screen">
        <h2>暂时无法连接服务</h2>
        <p>{bootError}</p>
        <button onClick={() => void bootSession()}>重新连接</button>
      </div>
    );
  if (!user) return <Auth onSuccess={signedIn} invited={!!invite} />;
  const titles: Record<View, string> = {
    overview: '账本概览',
    records: '往来记录',
    people: '往来人物',
    events: '具体事件',
    settings: '账本与设置',
  };
  function navigate(v: View) {
    setView(v);
    setFilters(blankFilters);
  }
  const groupBy = (kind: 'personId' | 'eventId', id: string) =>
    entries
      .filter((r) => r[kind] === id)
      .reduce(
        (s, r) => {
          s[r.direction] += r.amountCents;
          s.count++;
          return s;
        },
        { income: 0, expense: 0, count: 0 },
      );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href={appBase} className="brand">
          <span className="brand-mark">
            <Icon name="book" size={25} />
          </span>
          <span>
            有来有往<small>人情有记，情谊有续</small>
          </span>
        </a>
        <div className="ledger-picker">
          <label htmlFor="ledger-select">当前账本</label>
          <select id="ledger-select" value={ledgerId} onChange={(e) => setLedgerId(e.target.value)}>
            {ledgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.kind === 'family' ? '家庭 · ' : '个人 · '}
                {l.name}
              </option>
            ))}
          </select>
          <button className="text-button" onClick={() => setNewLedger(true)}>
            <Icon name="plus" size={15} />
            创建家庭账本
          </button>
        </div>
        <nav aria-label="主导航">
          {(['overview', 'records', 'people', 'events', 'settings'] as View[]).map((v) => (
            <button
              key={v}
              className={view === v ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate(v)}
            >
              <Icon name={v} />
              {titles[v]}
              {view === v && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Icon name="leaf" size={28} />
          <p>
            记的是往来，
            <br />
            留的是情谊。
          </p>
          <span>每一份心意，都值得被记住。</span>
        </div>
        <div className="user-row">
          <span className="avatar">{user.username.slice(0, 1)}</span>
          <div>
            <strong>{user.username}</strong>
            <small>让情谊有迹可循</small>
          </div>
          <button className="text-button" onClick={() => void logout()}>
            退出
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            我的账本 <span className="breadcrumb">/</span> {titles[view]}
          </span>
          <span className="today">
            {today().replaceAll('-', '.')} <span className="status-dot" />
            安心记录每一笔
          </span>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {ledger?.kind === 'family'
                  ? 'FAMILY LEDGER · 家庭共享'
                  : 'PERSONAL LEDGER · 个人专属'}
              </div>
              <h1>
                {titles[view]}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {ledger?.name} ·{' '}
                {ledger?.kind === 'family'
                  ? '一起记下生活里的人情往来'
                  : '把收到的心意和送出的祝福，认真收藏'}
              </p>
            </div>
            <button
              className="primary"
              disabled={!ledger || loading}
              onClick={() => setEditor('new')}
            >
              <Icon name="plus" size={19} />
              记一笔往来
            </button>
          </div>
          {invite && (
            <div className="invite-banner">
              <div>
                <strong>你收到了一份家庭账本邀请</strong>
                <p>加入后，该账本中的记录将对所有成员共享。</p>
              </div>
              <button disabled={joining} onClick={() => void acceptInvite()}>
                {joining ? '正在加入…' : '接受邀请'}
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setInvite('');
                  history.replaceState(null, '', appBase);
                }}
              >
                忽略
              </button>
            </div>
          )}
          {dataError && (
            <div className="error" role="alert">
              {dataError}
              <button className="text-button" onClick={reload}>
                重试
              </button>
            </div>
          )}
          {ledger && view !== 'settings' && (
            <>
              {(view === 'overview' || view === 'records') && (
                <>
                  <div className="stats">
                    <Stat
                      label="累计收入"
                      value={summary.income}
                      kind="income"
                      subtitle="收到的心意"
                    />
                    <Stat
                      label="累计支出"
                      value={summary.expense}
                      kind="expense"
                      subtitle="送出的祝福"
                    />
                    <Stat
                      label="往来差额"
                      value={summary.income - summary.expense}
                      kind="balance"
                      subtitle="收入 − 支出 · 不代表债务"
                    />
                  </div>
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <h2>
                          {view === 'overview' ? '最近往来' : '往来明细'}{' '}
                          <span className="count">{summary.count} 笔</span>
                        </h2>
                        <p>一份心意，一段值得记住的关系</p>
                      </div>
                      <button
                        className="secondary"
                        onClick={() =>
                          download(
                            `/ledgers/${ledgerId}/export.csv?${queryString}`,
                            `人情往来-${today()}.csv`,
                          ).catch((e) => notify(e.message))
                        }
                      >
                        <Icon name="export" size={16} />
                        导出 CSV
                      </button>
                    </div>
                    <div className="filters">
                      <label>
                        人物
                        <select
                          value={filters.personId}
                          onChange={(e) => setFilters({ ...filters, personId: e.target.value })}
                        >
                          <option value="">全部人物</option>
                          {meta.people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                              {p.note ? ` · ${p.note}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        事由
                        <select
                          value={filters.occasionId}
                          onChange={(e) => setFilters({ ...filters, occasionId: e.target.value })}
                        >
                          <option value="">全部事由</option>
                          {meta.occasions.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        具体事件
                        <select
                          value={filters.eventId}
                          onChange={(e) => setFilters({ ...filters, eventId: e.target.value })}
                        >
                          <option value="">全部事件</option>
                          {meta.events.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        收支
                        <select
                          value={filters.direction}
                          onChange={(e) => setFilters({ ...filters, direction: e.target.value })}
                        >
                          <option value="">全部收支</option>
                          <option value="income">收入</option>
                          <option value="expense">支出</option>
                        </select>
                      </label>
                      {ledger.kind === 'family' && (
                        <label>
                          归属
                          <select
                            value={filters.ownership}
                            onChange={(e) => setFilters({ ...filters, ownership: e.target.value })}
                          >
                            <option value="">全部归属</option>
                            <option value="family">仅家庭</option>
                            <option value="personal">全部个人</option>
                            {meta.members.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.username}
                                {!m.active ? '（已退出）' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label>
                        开始日期
                        <input
                          type="date"
                          min="1900-01-01"
                          max={today()}
                          value={filters.from}
                          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                        />
                      </label>
                      <label>
                        结束日期
                        <input
                          type="date"
                          min={filters.from || '1900-01-01'}
                          max={today()}
                          value={filters.to}
                          onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                        />
                      </label>
                      {Object.values(filters).some(Boolean) && (
                        <button className="text-button" onClick={() => setFilters(blankFilters)}>
                          重置筛选
                        </button>
                      )}
                    </div>
                    {loading ? (
                      <div className="empty">正在整理往来记录…</div>
                    ) : (
                      <RecordTable
                        records={view === 'overview' ? entries.slice(0, 8) : entries}
                        onEdit={setEditor}
                        onPerson={(id) => {
                          setView('records');
                          setFilters({ ...blankFilters, personId: id });
                        }}
                      />
                    )}
                    {view === 'overview' && entries.length > 8 && (
                      <button className="view-all" onClick={() => setView('records')}>
                        查看全部 {entries.length} 笔往来 <Icon name="chevron" size={15} />
                      </button>
                    )}
                  </section>
                  <div className="footnote">
                    <Icon name="leaf" size={16} />
                    <span>人情往来，不必分毫相抵；每一笔记录，都是一份惦念。</span>
                  </div>
                </>
              )}
              {view === 'people' && (
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        往来人物 <span className="count">{meta.people.length} 位</span>
                      </h2>
                      <p>点击人物查看往来明细；同名人物可用关系和说明区分。</p>
                    </div>
                    <button className="secondary" onClick={() => setEditPerson('new')}>
                      <Icon name="plus" size={16} />
                      添加人物
                    </button>
                  </div>
                  <div className="people-grid">
                    {meta.people.map((p) => {
                      const s = groupBy('personId', p.id);
                      return (
                        <article className="person-card" key={p.id}>
                          <div className="person-top">
                            <span className="avatar large">{p.name.slice(0, 1)}</span>
                            <div>
                              <h3>{p.name}</h3>
                              <p>
                                {p.relationship || '未设置关系'}
                                {p.note ? ' · ' + p.note : ''}
                              </p>
                            </div>
                          </div>
                          <div className="person-totals">
                            <span>
                              收入 <strong className="income">¥{money(s.income)}</strong>
                            </span>
                            <span>
                              支出 <strong className="expense">¥{money(s.expense)}</strong>
                            </span>
                          </div>
                          <div className="person-actions">
                            <button
                              className="text-button"
                              onClick={() => {
                                setView('records');
                                setFilters({ ...blankFilters, personId: p.id });
                              }}
                            >
                              查看 {s.count} 笔往来 →
                            </button>
                            <button className="text-button muted" onClick={() => setEditPerson(p)}>
                              编辑资料
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {!meta.people.length && (
                    <Empty
                      title="还没有往来人物"
                      text="从记下第一笔人情开始，或先添加一位亲朋好友。"
                    />
                  )}
                </section>
              )}
              {view === 'events' && (
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        具体事件 <span className="count">{meta.events.length} 场</span>
                      </h2>
                      <p>将一场婚礼、一次乔迁的往来归到一起。</p>
                    </div>
                  </div>
                  {meta.events.map((e) => {
                    const s = groupBy('eventId', e.id);
                    return (
                      <button
                        key={e.id}
                        className="event-row"
                        onClick={() => {
                          setView('records');
                          setFilters({ ...blankFilters, eventId: e.id });
                        }}
                      >
                        <span className="event-icon">
                          <Icon name="events" />
                        </span>
                        <span className="event-name">
                          <strong>{e.name}</strong>
                          <small>{s.count} 笔往来</small>
                        </span>
                        <span>
                          收入 <strong className="income">¥{money(s.income)}</strong>
                        </span>
                        <span>
                          支出 <strong className="expense">¥{money(s.expense)}</strong>
                        </span>
                        <Icon name="chevron" size={16} />
                      </button>
                    );
                  })}
                  {!meta.events.length && (
                    <Empty
                      title="把一场重要的事，记在一起"
                      text="记账时创建具体事件，例如“我的婚礼”，即可在这里汇总。"
                    />
                  )}
                </section>
              )}
            </>
          )}
          {ledger && view === 'settings' && (
            <Settings
              key={ledgerId}
              ledger={ledger}
              user={user}
              meta={meta}
              reload={() => {
                reload();
                void loadLedgers();
              }}
              notify={notify}
            />
          )}
        </main>
        <footer>
          有来有往 <span>·</span> 愿每一份情谊，都有回响。
        </footer>
      </div>
      {editor && ledger && (
        <RecordEditor
          key={typeof editor === 'string' ? 'new' : editor.id}
          ledger={ledger}
          meta={meta}
          user={user}
          entry={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            reload();
            notify('往来记录已保存');
          }}
        />
      )}
      {newLedger && (
        <NameForm
          title="创建家庭账本"
          label="账本名称"
          placeholder="例如：我们家的礼金簿"
          onClose={() => setNewLedger(false)}
          onSave={async (name) => {
            const data = await api<{ id: string }>('/ledgers', 'POST', { name });
            await loadLedgers(data.id);
            setNewLedger(false);
            notify('家庭账本已创建，可在设置中邀请家人');
          }}
        />
      )}
      {editPerson && ledger && (
        <PersonForm
          person={editPerson === 'new' ? null : editPerson}
          onClose={() => setEditPerson(null)}
          onSave={async (p) => {
            await api(
              `/ledgers/${ledger.id}/people${editPerson === 'new' ? '' : '/' + editPerson.id}`,
              editPerson === 'new' ? 'POST' : 'PUT',
              p,
            );
            setEditPerson(null);
            reload();
            notify('人物资料已保存');
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  kind,
  subtitle,
}: {
  label: string;
  value: number;
  kind: string;
  subtitle: string;
}) {
  return (
    <article className={'stat ' + kind}>
      <div className="stat-label">
        {label}
        <span className="stat-icon">
          <Icon
            name={kind === 'income' ? 'down' : kind === 'expense' ? 'arrow' : 'book'}
            size={20}
          />
        </span>
      </div>
      <div className="stat-value">
        <small>¥</small>
        {money(value)}
      </div>
      <p>{subtitle}</p>
    </article>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="book" size={32} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function RecordTable({
  records,
  onEdit,
  onPerson,
}: {
  records: Entry[];
  onEdit: (r: Entry) => void;
  onPerson: (id: string) => void;
}) {
  if (!records.length)
    return (
      <Empty
        title="这里还没有往来记录"
        text="点击“记一笔往来”，留住第一份心意；也可以调整筛选条件。"
      />
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>往来人物 / 事由</th>
            <th>日期</th>
            <th>归属</th>
            <th>收支金额</th>
            <th>备注</th>
            <th>
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="record-person">
                  <span className={'avatar ' + (r.direction === 'income' ? 'green' : 'orange')}>
                    {r.personName.slice(0, 1)}
                  </span>
                  <div>
                    <button className="person-link" onClick={() => onPerson(r.personId)}>
                      {r.personName}
                    </button>
                    <small>
                      {r.occasionName}
                      {r.eventName ? ' · ' + r.eventName : ''}
                      {r.personNote ? ' · ' + r.personNote : ''}
                    </small>
                  </div>
                </div>
              </td>
              <td className="date-cell">{r.date.replaceAll('-', '.')}</td>
              <td>
                <span className={'badge ' + r.scope}>
                  {r.scope === 'family' ? '家庭' : r.ownerName}
                </span>
              </td>
              <td>
                <span className={'amount ' + r.direction}>
                  {r.direction === 'income' ? '+' : '−'} {money(r.amountCents)}
                </span>
                <small className="direction-label">
                  {r.direction === 'income' ? '收入' : '支出'}
                </small>
              </td>
              <td className="note-cell" title={r.note}>
                {r.note || '—'}
              </td>
              <td>
                <button className="text-button" onClick={() => onEdit(r)}>
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Auth({
  onSuccess,
  invited,
}: {
  onSuccess: (data: { user: User; csrf: string }) => Promise<void>;
  invited: boolean;
}) {
  const [register, setRegister] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth-shell">
      <section className="auth-story">
        <div className="brand">
          <Icon name="book" size={32} />
          有来有往
        </div>
        <div className="story-copy">
          <span className="eyebrow">FOR EVERY KIND GESTURE</span>
          <h1>
            一笔往来，
            <br />
            一份长久的惦念。
          </h1>
          <p>
            从婚礼上的祝福，到乔迁时的心意。
            <br />
            把生活中的人情记清，让重要的人留在心上。
          </p>
          <div className="story-lines">
            <span>情</span>
            <div />
            <span>谊</span>
            <div />
            <span>长</span>
            <div />
            <span>存</span>
          </div>
        </div>
        <small>人情有记，情谊有续。</small>
      </section>
      <section className="auth-main">
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            setError('');
            try {
              await onSuccess(
                await api(
                  '/auth/' + (register ? 'register' : 'login'),
                  'POST',
                  Object.fromEntries(form),
                ),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="eyebrow">WELCOME {register ? 'ABOARD' : 'BACK'}</span>
          <h2>{register ? '开启你的第一本账' : '欢迎回来'}</h2>
          <p>
            {invited
              ? '登录或注册后，即可接受家庭账本邀请。'
              : register
                ? '注册后会自动创建仅你可见的个人账本。'
                : '登录，看看那些值得被记住的心意。'}
          </p>
          <label>
            用户名
            <input
              name="username"
              autoComplete="username"
              required
              minLength={2}
              maxLength={32}
              placeholder="请输入用户名"
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              minLength={10}
              maxLength={128}
              placeholder="至少 10 位字符"
            />
          </label>
          {register && <p className="hint">请妥善保存密码，第一版暂不提供自助找回。</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? '请稍候…' : register ? '注册并创建账本' : '登录账本'}
            <Icon name="chevron" size={17} />
          </button>
          <p className="auth-switch">
            {register ? '已经有账号？' : '还没有账号？'}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setRegister(!register);
                setError('');
              }}
            >
              {register ? '直接登录' : '创建账号'}
            </button>
          </p>
        </form>
      </section>
    </div>
  );
}
function NameForm({
  title,
  label,
  placeholder,
  onClose,
  onSave,
}: {
  title: string;
  label: string;
  placeholder: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onSave(String(new FormData(e.currentTarget).get('name')).trim());
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {label}
          <input name="name" autoFocus required maxLength={80} placeholder={placeholder} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PersonForm({
  person,
  onSave,
  onClose,
}: {
  person: Person | null;
  onSave: (p: Omit<Person, 'id'>) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={person ? '编辑人物资料' : '添加往来人物'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          try {
            await onSave({
              name: String(data.get('name')),
              relationship: String(data.get('relationship')),
              note: String(data.get('note')),
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          姓名 / 称呼
          <input name="name" required maxLength={80} defaultValue={person?.name} autoFocus />
        </label>
        <label>
          人物关系
          <input
            name="relationship"
            maxLength={80}
            placeholder="例如：同学、亲戚、同事"
            defaultValue={person?.relationship}
          />
        </label>
        <label>
          区分说明
          <input
            name="note"
            maxLength={300}
            placeholder="例如：高中同学翰林，用于区分同名人物"
            defaultValue={person?.note}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存人物'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RecordEditor({
  ledger,
  meta,
  user,
  entry,
  onSaved,
  onClose,
}: {
  ledger: Ledger;
  meta: Meta;
  user: User;
  entry: Entry | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [personId, setPersonId] = useState(entry?.personId || ''),
    [occasionId, setOccasionId] = useState(entry?.occasionId || ''),
    [eventId, setEventId] = useState(entry?.eventId || ''),
    [scope, setScope] = useState<'family' | 'personal'>(
      entry?.scope || (ledger.kind === 'personal' ? 'personal' : 'family'),
    ),
    [ownerId, setOwnerId] = useState(entry?.ownerId || user.id),
    [direction, setDirection] = useState(entry?.direction || 'expense'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [people, setPeople] = useState(meta.people),
    [occasions, setOccasions] = useState(meta.occasions),
    [events, setEvents] = useState(meta.events);
  const path = `/ledgers/${ledger.id}`;
  const reusable = meta.reusable ?? { people: [], occasions: [], events: [] };
  const activeMembers = meta.members.filter(
    (m) => m.active || m.id === entry?.ownerId || m.id === entry?.handlerId,
  );
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      let p = personId,
        o = occasionId,
        ev = eventId;
      if (p === 'new') {
        const person = await api<Person>(path + '/people', 'POST', {
          name: f.get('personName'),
          relationship: f.get('relationship') || '',
          note: f.get('personNote') || '',
        });
        p = person.id;
        setPeople([...people, person]);
        setPersonId(p);
      }
      if (o === 'new') {
        const item = await api<Named>(path + '/occasions', 'POST', { name: f.get('occasionName') });
        o = item.id;
        setOccasions([...occasions, item]);
        setOccasionId(o);
      }
      if (ev === 'new') {
        const item = await api<Named>(path + '/events', 'POST', { name: f.get('eventName') });
        ev = item.id;
        setEvents([...events, item]);
        setEventId(ev);
      }
      const body: RecordInput = {
        personId: p.replace(/^reuse:/, ''),
        occasionId: o.replace(/^reuse:/, ''),
        eventId: ev.replace(/^reuse:/, '') || null,
        reuse: {
          person: p.startsWith('reuse:'),
          occasion: o.startsWith('reuse:'),
          event: ev.startsWith('reuse:'),
        },
        direction,
        date: String(f.get('date')),
        amountCents: amountToCents(String(f.get('amount'))),
        scope,
        ownerId: scope === 'personal' ? ownerId : null,
        handlerId: String(f.get('handlerId')) || null,
        note: String(f.get('note') || ''),
      };
      await api(path + '/records' + (entry ? '/' + entry.id : ''), entry ? 'PUT' : 'POST', {
        ...body,
        ...(entry ? { version: entry.version } : {}),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!entry || !window.confirm('确定删除这笔往来记录？此操作不可撤销。')) return;
    setBusy(true);
    try {
      await api(path + '/records/' + entry.id, 'DELETE', { version: entry.version });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={entry ? '往来记录详情' : '记一笔往来'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="direction-toggle">
          <button
            type="button"
            className={direction === 'expense' ? 'selected expense' : ''}
            onClick={() => setDirection('expense')}
          >
            ↗ 支出 · 送出祝福
          </button>
          <button
            type="button"
            className={direction === 'income' ? 'selected income' : ''}
            onClick={() => setDirection('income')}
          >
            ↙ 收入 · 收到心意
          </button>
        </div>
        <div className="form-grid">
          <label>
            金额（元）
            <input
              name="amount"
              inputMode="decimal"
              required
              placeholder="0.00"
              defaultValue={entry ? (entry.amountCents / 100).toFixed(2) : ''}
            />
          </label>
          <label>
            日期
            <input
              name="date"
              type="date"
              required
              min="1900-01-01"
              max={today()}
              defaultValue={entry?.date || today()}
            />
          </label>
          <label>
            往来人物
            <select required value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">选择人物</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.relationship ? ' · ' + p.relationship : ''}
                  {p.note ? ' · ' + p.note : ''}
                </option>
              ))}
              {reusable.people.length > 0 && (
                <optgroup label="从我的其他账本复用（保存后加入本账本）">
                  {reusable.people.map((p) => (
                    <option key={p.id} value={'reuse:' + p.id}>
                      {p.name}
                      {p.relationship ? ' · ' + p.relationship : ''}
                      {p.note ? ' · ' + p.note : ''} — {p.sourceLedgerName}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="new">＋ 添加新人物（允许同名）</option>
            </select>
          </label>
          <label>
            事由
            <select required value={occasionId} onChange={(e) => setOccasionId(e.target.value)}>
              <option value="">选择事由</option>
              {occasions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
              {reusable.occasions.length > 0 && (
                <optgroup label="从我的其他账本复用（保存后加入本账本）">
                  {reusable.occasions.map((o) => (
                    <option key={o.id} value={'reuse:' + o.id}>
                      {o.name} — {o.sourceLedgerName}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="new">＋ 自定义事由</option>
            </select>
          </label>
        </div>
        {personId === 'new' && (
          <div className="inline-fields">
            <label>
              新人物姓名
              <input name="personName" required maxLength={80} />
            </label>
            <div className="form-grid">
              <label>
                人物关系（选填）
                <input name="relationship" maxLength={80} placeholder="例如：高中同学" />
              </label>
              <label>
                区分说明（选填）
                <input name="personNote" maxLength={300} placeholder="用于区分同名人物" />
              </label>
            </div>
          </div>
        )}
        {occasionId === 'new' && (
          <label>
            自定义事由
            <input name="occasionName" required maxLength={80} placeholder="例如：升学" />
          </label>
        )}
        <label>
          具体事件（选填）
          <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">不关联具体事件</option>
            {events.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            {reusable.events.length > 0 && (
              <optgroup label="从我的其他账本复用（保存后加入本账本）">
                {reusable.events.map((o) => (
                  <option key={o.id} value={'reuse:' + o.id}>
                    {o.name} — {o.sourceLedgerName}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="new">＋ 创建具体事件</option>
          </select>
        </label>
        {eventId === 'new' && (
          <label>
            新事件名称
            <input name="eventName" required maxLength={80} placeholder="例如：我的婚礼" />
          </label>
        )}
        {ledger.kind === 'family' && (
          <div className="form-grid">
            <label>
              人情归属维度
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as 'family' | 'personal')}
              >
                <option value="family">家庭</option>
                <option value="personal">个人</option>
              </select>
            </label>
            {scope === 'personal' && (
              <label>
                归属成员
                <select required value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  {activeMembers.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.active && m.id !== entry?.ownerId}>
                      {m.username}
                      {!m.active ? '（已退出）' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <label>
          经手人（选填）
          <select name="handlerId" defaultValue={entry ? entry.handlerId || '' : user.id}>
            <option value="">未指定</option>
            {activeMembers.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.active && m.id !== entry?.handlerId}>
                {m.username}
                {!m.active ? '（已退出）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          备注（选填）
          <textarea
            name="note"
            maxLength={2000}
            rows={3}
            defaultValue={entry?.note}
            placeholder="例如：夫妻共同送礼、由父母代收"
          />
        </label>
        {[personId, occasionId, eventId].some((id) => id.startsWith('reuse:')) && (
          <p className="hint">
            保存后，所选资料会加入当前账本并对本账本成员可见；往来记录不会复制，各账本资料独立维护。
          </p>
        )}
        <p className="hint">
          {ledger.kind === 'family'
            ? '本笔记录对当前家庭账本所有成员可见；归属维度仅用于统计。'
            : '本笔记录仅你可见，归属本人。'}
        </p>
        {entry && (
          <p className="audit">
            创建：{entry.creatorName} · {beijingTime(entry.createdAt)}
            <br />
            最近修改：{entry.updaterName} · {beijingTime(entry.updatedAt)}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {entry && (
            <button
              type="button"
              className="danger-text"
              disabled={busy}
              onClick={() => void remove()}
            >
              删除记录
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存记录'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Settings({
  ledger,
  user,
  meta,
  reload,
  notify,
}: {
  ledger: Ledger;
  user: User;
  meta: Meta;
  reload: () => void;
  notify: (s: string) => void;
}) {
  const [inviteUrl, setInviteUrl] = useState(''),
    [invites, setInvites] = useState<{ id: string; expiresAt: string; revoked: number }[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [backup, setBackup] = useState<unknown>(null),
    [preview, setPreview] = useState<{ added: number; skipped: number; total: number } | null>(
      null,
    ),
    [filename, setFilename] = useState('');
  const owner = ledger.ownerId === user.id,
    path = `/ledgers/${ledger.id}`;
  async function loadInvites() {
    if (owner && ledger.kind === 'family') setInvites(await api(path + '/invites'));
  }
  useEffect(() => {
    loadInvites().catch((e) => setError(e.message));
  }, [ledger.id]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-grid">
      {ledger.kind === 'family' && (
        <section className="panel settings-panel">
          <div className="section-heading">
            <div>
              <h2>家庭成员</h2>
              <p>所有有效成员均可维护本账本中的记录。</p>
            </div>
            <span className="badge family">共同维护</span>
          </div>
          {meta.members.map((m) => (
            <div className="member-row" key={m.id}>
              <span className="avatar">{m.username.slice(0, 1)}</span>
              <div>
                <strong>
                  {m.username}
                  {m.id === user.id ? '（我）' : ''}
                </strong>
                <small>
                  {m.id === ledger.ownerId ? '创建者' : m.active ? '成员' : '已退出 · 保留历史归属'}
                </small>
              </div>
              {m.active && m.id !== ledger.ownerId && (owner || m.id === user.id) && (
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        m.id === user.id
                          ? '退出后将无法查看此账本，确定退出？'
                          : '确定移除此成员？历史记录会保留。',
                      )
                    )
                      void action(async () => {
                        await api(path + '/members/' + m.id, 'DELETE');
                        reload();
                        notify('成员权限已更新');
                      });
                  }}
                >
                  {m.id === user.id ? '退出账本' : '移除'}
                </button>
              )}
            </div>
          ))}
          {owner && (
            <>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const data = await api<{ url: string }>(path + '/invites', 'POST');
                    setInviteUrl(data.url);
                    await loadInvites();
                  })
                }
              >
                <Icon name="plus" size={16} />
                创建 7 天有效的邀请链接
              </button>
              {inviteUrl && (
                <div className="invite-link">
                  <label>
                    新邀请链接（仅本次展示）
                    <input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
                  </label>
                  <button
                    className="text-button"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(inviteUrl)
                        .then(() => notify('邀请链接已复制'))
                        .catch(() => notify('请选中链接并手动复制'))
                    }
                  >
                    复制链接
                  </button>
                </div>
              )}
              <div className="invite-list">
                {invites.map((i) => (
                  <div key={i.id}>
                    <span>
                      有效期至 {beijingTime(i.expiresAt)}
                      {i.revoked ? ' · 已撤销' : ''}
                    </span>
                    {!i.revoked && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api(path + '/invites/' + i.id, 'DELETE');
                            await loadInvites();
                            setInviteUrl('');
                          })
                        }
                      >
                        撤销
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      <section className="panel settings-panel">
        <div className="section-heading">
          <div>
            <h2>数据备份与导入</h2>
            <p>JSON 备份当前账本全部记录；CSV 导出支持筛选。</p>
          </div>
          <Icon name="export" />
        </div>
        <p className="hint">
          备份不包含密码、账号权限或邀请。导入不会创建成员；家庭记录涉及的归属人、经手人需已属于当前账本。
        </p>
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void action(() => download(path + '/export.json', `${ledger.name}-${today()}.json`))
            }
          >
            导出 JSON 备份
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void action(() => download(path + '/export.csv', `${ledger.name}-${today()}.csv`))
            }
          >
            导出全部 CSV
          </button>
        </div>
        <label className="file-label">
          选择 JSON 备份进行预览
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              setPreview(null);
              setBackup(null);
              setFilename(file?.name || '');
              if (!file) return;
              void action(async () => {
                if (file.size > 8 * 1024 * 1024) throw new Error('备份文件不能超过8MB');
                const data = JSON.parse(await file.text());
                const p = await api<{ added: number; skipped: number; total: number }>(
                  path + '/import/preview',
                  'POST',
                  data,
                );
                setBackup(data);
                setPreview(p);
              });
            }}
          />
        </label>
        {preview && (
          <div className="import-preview">
            <strong>{filename}</strong>
            <p>
              共 {preview.total} 笔 · 将新增 {preview.added} 笔 · 重复跳过 {preview.skipped} 笔
            </p>
            <p className="hint">
              确认后写入当前账本「{ledger.name}」。整批校验失败时不会写入任何数据。
            </p>
            <button
              className="primary"
              disabled={busy || preview.added === 0}
              onClick={() =>
                void action(async () => {
                  const result = await api<{ added: number; skipped: number }>(
                    path + '/import/commit',
                    'POST',
                    backup,
                  );
                  setPreview(null);
                  setBackup(null);
                  reload();
                  notify(`已导入 ${result.added} 笔，跳过 ${result.skipped} 笔重复记录`);
                })
              }
            >
              确认导入当前账本
            </button>
          </div>
        )}
      </section>
      <section className="panel settings-panel">
        <div className="section-heading">
          <div>
            <h2>账号安全</h2>
            <p>修改密码后，其他登录会话将失效。</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              data = Object.fromEntries(new FormData(form));
            void action(async () => {
              const result = await api<{ csrf: string }>('/auth/password', 'POST', data);
              setCsrf(result.csrf);
              form.reset();
              notify('密码已修改');
            });
          }}
        >
          <label>
            当前密码
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          <label>
            新密码
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={128}
              placeholder="至少 10 位字符"
            />
          </label>
          <button className="secondary" disabled={busy}>
            修改密码
          </button>
        </form>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
