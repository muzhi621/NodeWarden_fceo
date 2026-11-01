import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Database,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-preact';
import ConfirmDialog from '@/components/ConfirmDialog';
import LoadingState from '@/components/LoadingState';
import type { AuthedFetch } from '@/lib/api/shared';
import {
  DEFAULT_CLUSTER_POLICY,
  clearDbConfig,
  getDbConfigStatus,
  probeDbNodes,
  saveDbConfig,
  syncDbCluster,
  testDbNode,
  type DbClusterPolicy,
  type DbConfigStatus,
  type DbNodeInput,
  type DbNodeRole,
  type DbSyncCopyMode,
  type MaskedDbNode,
  type NodeHealthSnapshot,
  type NodeProbeResult,
} from '@/lib/api/db-config';

interface DatabaseSettingsPageProps {
  authedFetch: AuthedFetch;
  mobileLayout?: boolean;
  onMobileBack?: () => void;
}

/**
 * Editable draft of a node.
 *
 * Numbers are kept as strings so a half-typed value ("33" on the way to 3306)
 * does not get coerced to NaN and thrown away mid-edit. The password is never
 * echoed back: empty means "keep the stored one", and clearing it is an
 * explicit checkbox.
 */
interface NodeDraft {
  id: string;
  label: string;
  role: DbNodeRole;
  priority: number;
  enabled: boolean;
  host: string;
  port: string;
  user: string;
  password: string;
  hasStoredPassword: boolean;
  clearPassword: boolean;
  database: string;
  ssl: boolean;
  connectionLimit: string;
  isNew?: boolean;
}

type Notice = { kind: 'ok' | 'error' | 'info'; text: string };

function newDraft(index: number): NodeDraft {
  return {
    id: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label: `节点 ${index + 1}`,
    role: 'replica',
    priority: index + 1,
    enabled: true,
    host: '',
    port: '3306',
    user: '',
    password: '',
    hasStoredPassword: false,
    clearPassword: false,
    database: '',
    ssl: true,
    connectionLimit: '5',
    isNew: true,
  };
}

function toDraft(node: MaskedDbNode): NodeDraft {
  return {
    id: node.id,
    label: node.label,
    role: node.role,
    priority: node.priority,
    enabled: node.enabled,
    host: node.host,
    port: String(node.port || 3306),
    user: node.user,
    password: '',
    hasStoredPassword: node.passwordSet,
    clearPassword: false,
    database: node.database,
    ssl: node.ssl !== false,
    connectionLimit: String(node.connectionLimit || 5),
  };
}

function toInput(draft: NodeDraft): DbNodeInput {
  return {
    id: draft.isNew ? undefined : draft.id,
    label: draft.label.trim(),
    role: draft.role,
    priority: draft.priority,
    enabled: draft.enabled,
    host: draft.host.trim(),
    port: Number(draft.port) || 3306,
    user: draft.user.trim(),
    database: draft.database.trim(),
    ssl: draft.ssl,
    connectionLimit: Number(draft.connectionLimit) || 5,
    ...(draft.password ? { password: draft.password } : {}),
    // The backend treats an empty password field as "keep the stored one";
    // clearing it must be explicit or an empty MySQL password is impossible.
    ...(draft.clearPassword && !draft.password ? { clearPassword: true } : {}),
  };
}

/** Keep priorities dense (1..n) so the failover order is unambiguous. */
function reindex(list: NodeDraft[]): NodeDraft[] {
  return list.map((node, index) => ({ ...node, priority: index + 1 }));
}

function statusTone(draft: NodeDraft, probe?: NodeProbeResult, health?: NodeHealthSnapshot): { tone: string; text: string } {
  if (!draft.enabled) return { tone: 'muted', text: '已停用' };
  if (probe) {
    if (probe.ok) return { tone: 'ok', text: `${probe.latencyMs}ms · ${probe.version || 'MySQL'}` };
    return { tone: 'error', text: probe.error || '连接失败' };
  }
  if (health?.writeBlocked) return { tone: 'warn', text: '只读节点（不参与写入）' };
  if (health?.downUntil && health.downUntil > Date.now()) return { tone: 'error', text: '已熔断（自动切换中）' };
  if (health?.needsFullSync) return { tone: 'error', text: '落后过多，需要完整同步' };
  if (health?.lastError) return { tone: 'warn', text: '近期失败' };
  if (health?.lastOkAt) return { tone: 'ok', text: '运行中' };
  return { tone: 'idle', text: '未测试' };
}

/** Human-readable sync state of a node: "never synced" must be loud (B-4). */
function syncTone(node: MaskedDbNode, health?: NodeHealthSnapshot): { tone: string; text: string } | null {
  if (node.role === 'primary') return null;
  const status = node.syncStatus;
  if (!status) return { tone: 'warn', text: '尚未同步（不可接管）' };
  const when = new Date(status.at).toLocaleString();
  if (health?.needsFullSync) return { tone: 'error', text: '落后过多，需要完整同步' };
  if (health?.lag) return { tone: 'warn', text: `落后 ${health.lag} 条写入（正在补齐）` };
  if (status.truncated) return { tone: 'warn', text: `上次同步未完成（${when}），可再次同步继续` };
  if (!status.complete) return { tone: 'warn', text: `上次同步未完成（${when}）` };
  return { tone: 'ok', text: `已同步 ${when} · ${status.tables} 张表` };
}

const SYNC_MODE_LABEL: Record<string, string> = {
  native: '由数据库自身复制（只读副库 + 故障接管）',
  'write-through': '应用层实时双写（把每次写入同步到副库）',
};

export default function DatabaseSettingsPage(props: DatabaseSettingsPageProps) {
  const [status, setStatus] = useState<DbConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [nodes, setNodes] = useState<NodeDraft[]>([]);
  const [policy, setPolicy] = useState<DbClusterPolicy>(DEFAULT_CLUSTER_POLICY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, NodeProbeResult>>({});
  const [dirty, setDirty] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);
  // Which node the rows are read from. The primary is the wrong source the
  // moment a failover happened, so this is explicit rather than implied.
  const [syncSourceId, setSyncSourceId] = useState('');
  const [syncMode, setSyncMode] = useState<DbSyncCopyMode>('merge');

  const healthById = useMemo(() => {
    const map: Record<string, NodeHealthSnapshot> = {};
    (status?.health ?? []).forEach((entry) => {
      map[entry.id] = entry;
    });
    return map;
  }, [status]);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const next = await getDbConfigStatus(props.authedFetch);
      setStatus(next);
      setNodes(next.cluster.nodes.map(toDraft));
      setPolicy(next.cluster.policy ?? next.defaultPolicy ?? DEFAULT_CLUSTER_POLICY);
      setProbes({});
      setDirty(false);
      setEditingId(null);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [props.authedFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateNode = (id: string, patch: Partial<NodeDraft>) => {
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, ...patch } : node)));
    setDirty(true);
  };

  const addNode = () => {
    const draft = newDraft(nodes.length);
    setNodes((current) => reindex([...current, draft]));
    setEditingId(draft.id);
    setDirty(true);
  };

  const removeNode = (id: string) => {
    setNodes((current) => {
      const next = reindex(current.filter((node) => node.id !== id));
      // Never leave the cluster without a writer: promote the first remaining
      // node when the removed one was the primary.
      if (!next.some((node) => node.role === 'primary') && next.length > 0) {
        next[0] = { ...next[0], role: 'primary' };
      }
      return next;
    });
    setProbes((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (editingId === id) setEditingId(null);
    setDirty(true);
  };

  const makePrimary = (id: string) => {
    setNodes((current) =>
      current.map((node) => ({ ...node, role: node.id === id ? 'primary' : node.role === 'primary' ? 'replica' : node.role }))
    );
    setDirty(true);
  };

  const moveNode = (id: string, direction: -1 | 1) => {
    setNodes((current) => {
      const index = current.findIndex((node) => node.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return reindex(next);
    });
    setDirty(true);
  };

  const updatePolicy = (patch: Partial<DbClusterPolicy>) => {
    setPolicy((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  const onTestNode = async (draft: NodeDraft) => {
    setBusy(`test:${draft.id}`);
    setNotice(null);
    try {
      const result = await testDbNode(props.authedFetch, toInput(draft));
      setProbes((current) => ({ ...current, [draft.id]: result }));
      setNotice({
        kind: result.ok ? 'ok' : 'error',
        text: result.ok
          ? `「${draft.label}」连接成功 · ${result.version || 'MySQL'} · ${result.latencyMs}ms · 数据表 ${
              result.schemaState === 'ready' ? '已就绪' : result.schemaState === 'empty' ? '为空（保存时自动建表）' : '未知'
            }`
          : `「${draft.label}」连接失败：${result.error || 'unknown error'}`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const onTestAll = async () => {
    const enabled = nodes.filter((node) => node.enabled);
    if (enabled.length === 0) {
      setNotice({ kind: 'error', text: '没有启用的节点可测试。' });
      return;
    }
    setBusy('test-all');
    setNotice(null);
    try {
      const result = await probeDbNodes(props.authedFetch, enabled.map(toInput));
      const map: Record<string, NodeProbeResult> = {};
      result.results.forEach((entry) => {
        map[entry.id] = entry;
      });
      setProbes((current) => ({ ...current, ...map }));
      const failed = result.results.filter((entry) => !entry.ok);
      setNotice(
        failed.length === 0
          ? { kind: 'ok', text: `全部 ${result.results.length} 个节点连接正常。` }
          : {
              kind: 'error',
              text: `${failed.length}/${result.results.length} 个节点异常：${failed.map((entry) => entry.label).join('、')}`,
            }
      );
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    const enabled = nodes.filter((node) => node.enabled);
    if (enabled.length === 0) {
      setNotice({ kind: 'error', text: '至少需要启用一个数据库节点。' });
      return;
    }
    if (enabled.filter((node) => node.role === 'primary').length !== 1) {
      setNotice({ kind: 'error', text: '必须且只能有一个主库（primary）。' });
      return;
    }
    const incomplete = enabled.find((node) => !node.host.trim() || !node.user.trim() || !node.database.trim());
    if (incomplete) {
      setNotice({ kind: 'error', text: `「${incomplete.label}」缺少 host / 用户名 / 数据库名。` });
      return;
    }
    if (enabled.length > 1 && policy.syncMode === 'write-through' && !policy.failoverEnabled) {
      setNotice({
        kind: 'info',
        text: '已开启应用层双写但关闭了自动切换：副库会保持同步，但主库故障时不会自动接管。',
      });
    }

    setBusy('save');
    setNotice(null);
    try {
      const result = await saveDbConfig(props.authedFetch, {
        mode: 'mysql',
        nodes: nodes.map(toInput),
        policy,
      });
      if (result.nodes) {
        const map: Record<string, NodeProbeResult> = {};
        result.nodes.forEach((entry) => {
          map[entry.id] = entry;
        });
        setProbes((current) => ({ ...current, ...map }));
      }
      if (result.ok) {
        setNotice({
          kind: result.warning ? 'info' : 'ok',
          text:
            result.warning ??
            `已保存并生效：${enabled.length} 个节点，主库 ${result.version || 'MySQL'}，${result.latencyMs ?? 0}ms。配置已加密存储，密码不再回显。`,
        });
        await load();
      } else {
        setNotice({
          kind: 'error',
          text: result.schemaError ? `${result.error}（${result.schemaError}）` : result.error || '保存失败',
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const onClear = async () => {
    setConfirmClear(false);
    setBusy('clear');
    setNotice(null);
    try {
      await clearDbConfig(props.authedFetch);
      setNotice({ kind: 'ok', text: '已清除运行时数据库配置，回退到 D1（或 DB_* 环境变量）。' });
      await load();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const onSync = async () => {
    setConfirmSync(false);
    setBusy('sync');
    setNotice(null);
    try {
      const result = await syncDbCluster(props.authedFetch, {
        sourceId: syncSourceId || undefined,
        mode: syncMode,
      });
      const failed = result.targets.filter((target) => !target.ok);
      const partial = result.targets.filter((target) => target.ok && !target.complete);
      const mismatched = result.targets.flatMap((target) => target.countsMismatch ?? []);
      if (failed.length > 0) {
        setNotice({
          kind: 'error',
          text:
            `${failed.length}/${result.targets.length} 个副库同步失败：` +
            failed.map((target) => `${target.label}（${target.error ?? '部分数据表出错'}）`).join('、'),
        });
      } else if (partial.length > 0) {
        setNotice({
          kind: 'info',
          text:
            `已写入 ${result.rowsWritten} 行，但 ${partial.length} 个副库还没同步完（` +
            `${partial.map((target) => target.label).join('、')}）。` +
            '再次点击会从上次的位置继续，直到提示「已完成」为止。',
        });
      } else {
        setNotice({
          kind: mismatched.length > 0 ? 'info' : 'ok',
          text:
            `同步完成：${result.targets.length} 个副库共写入 ${result.rowsWritten} 行，行数校验通过。` +
            (mismatched.length > 0
              ? ` 仍有 ${mismatched.length} 张表行数不一致（${mismatched.slice(0, 3).join('、')}${mismatched.length > 3 ? '…' : ''}）：` +
                '多为同步期间的并发写入，可再同步一次；若持续不一致，说明目标端有源端已删除的行。'
              : ''),
        });
      }
      await load();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !status) {
    return <LoadingState card lines={6} />;
  }

  const mode = status?.cluster.mode ?? status?.config.mode ?? 'd1';
  const sourceLabel =
    status?.cluster.source === 'env' ? '环境变量' : status?.cluster.source === 'runtime' ? '运行时（加密存储）' : '默认 D1';
  const enabledCount = nodes.filter((node) => node.enabled).length;
  const saving = busy === 'save';
  const occupied = busy !== null;

  return (
    <div className="stack db-cluster-page">
      {props.mobileLayout && props.onMobileBack && (
        <div className="mobile-settings-subhead">
          <button type="button" className="btn btn-secondary small mobile-settings-back" onClick={props.onMobileBack}>
            <span className="btn-icon" aria-hidden="true">{'<'}</span>
            返回
          </button>
        </div>
      )}

      {!!notice && (
        <div className={notice.kind === 'error' ? 'local-error' : notice.kind === 'ok' ? 'local-ok' : 'db-callout'}>
          <span>{notice.text}</span>
        </div>
      )}

      {/* ── Overview ─────────────────────────────────────────────── */}
      <section className="card">
        <div className="section-head">
          <h3><Database size={16} className="btn-icon" /> 数据库设置（外接 MySQL / 多节点）</h3>
          <div className="actions">
            <button type="button" className="btn btn-secondary small" disabled={loading || occupied} onClick={() => void load()}>
              <RefreshCw size={14} className="btn-icon" /> 刷新
            </button>
          </div>
        </div>

        <div className="db-status-strip">
          <div className="db-status-item">
            <span className="db-status-label">当前模式</span>
            <strong>{mode === 'mysql' ? '外接 MySQL' : 'D1（平台内置）'}</strong>
          </div>
          <div className="db-status-item">
            <span className="db-status-label">配置来源</span>
            <strong>{sourceLabel}</strong>
          </div>
          <div className="db-status-item">
            <span className="db-status-label">节点</span>
            <strong>{mode === 'mysql' ? `${enabledCount} 启用 / ${nodes.length} 配置` : '—'}</strong>
          </div>
          <div className="db-status-item">
            <span className="db-status-label">同步方式</span>
            <strong>{mode === 'mysql' ? SYNC_MODE_LABEL[policy.syncMode]?.split('（')[0] : '—'}</strong>
          </div>
        </div>

        {status?.envOverrideActive && (
          <p className="local-error">
            <span>检测到 DB_HOST 环境变量：环境变量优先，下方保存的集群配置不会生效。</span>
          </p>
        )}
        {!status?.configStoreAvailable && (
          <p className="local-error">
            <span>未绑定 SETTINGS_KV / ATTACHMENTS 配置存储：可以测试连接，但保存集群需要配置存储（或改用 DB_* 环境变量）。</span>
          </p>
        )}
        {dirty && <p className="db-inline-hint">有未保存的修改。</p>}
      </section>

      {/* ── Nodes ────────────────────────────────────────────────── */}
      <section className="card">
        <div className="section-head">
          <h3>连接节点（{nodes.length}）</h3>
          <div className="actions">
            <button type="button" className="btn btn-secondary small" disabled={occupied} onClick={() => void onTestAll()}>
              {busy === 'test-all' ? <Loader2 size={14} className="btn-icon spin" /> : <PlugZap size={14} className="btn-icon" />}
              测试全部
            </button>
            <button
              type="button"
              className="btn btn-secondary small"
              disabled={occupied || nodes.length >= (status?.limits?.maxNodes ?? 8)}
              onClick={addNode}
            >
              <Plus size={14} className="btn-icon" /> 添加节点
            </button>
          </div>
        </div>

        {nodes.length === 0 ? (
          <p className="db-empty">还没有配置外接数据库。点击「添加节点」开始，或继续使用平台内置 D1。</p>
        ) : (
          <div className="db-node-list">
            {nodes.map((node, index) => {
              const probe = probes[node.id];
              const health = healthById[node.id];
              const tone = statusTone(node, probe, health);
              const stored = status?.cluster.nodes.find((entry) => entry.id === node.id);
              const sync = stored && node.enabled ? syncTone(stored, health) : null;
              const editing = editingId === node.id;
              const testing = busy === `test:${node.id}`;
              return (
                <article
                  key={node.id}
                  className={[
                    'db-node-card',
                    node.role === 'primary' ? 'is-primary' : '',
                    node.enabled ? '' : 'is-disabled',
                    tone.tone === 'error' ? 'is-down' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className="db-node-head">
                    <div className="db-node-title">
                      <span className={`db-node-badge ${node.role === 'primary' ? 'is-primary' : 'is-replica'}`}>
                        {node.role === 'primary' ? '主库' : '副库'}
                      </span>
                      <strong>{node.label || '未命名节点'}</strong>
                      <span className={`db-node-status is-${tone.tone}`}>{tone.text}</span>
                      {!node.enabled && <span className="db-node-status is-muted">不参与路由</span>}
                    </div>
                    <div className="db-node-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="上移（更早接管）"
                        aria-label="上移"
                        disabled={occupied || index === 0}
                        onClick={() => moveNode(node.id, -1)}
                      >
                        <ChevronUp size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="下移"
                        aria-label="下移"
                        disabled={occupied || index === nodes.length - 1}
                        onClick={() => moveNode(node.id, 1)}
                      >
                        <ChevronDown size={15} />
                      </button>
                      {node.role !== 'primary' && (
                        <button
                          type="button"
                          className="btn btn-secondary small"
                          disabled={occupied}
                          title="把该节点设为主库，原主库自动降为副库"
                          onClick={() => makePrimary(node.id)}
                        >
                          <Check size={13} className="btn-icon" /> 设为主库
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary small"
                        disabled={occupied}
                        onClick={() => void onTestNode(node)}
                      >
                        {testing ? <Loader2 size={13} className="btn-icon spin" /> : <PlugZap size={13} className="btn-icon" />}
                        测试
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary small"
                        disabled={occupied}
                        onClick={() => setEditingId(editing ? null : node.id)}
                      >
                        {editing ? <X size={13} className="btn-icon" /> : <Pencil size={13} className="btn-icon" />}
                        {editing ? '收起' : '编辑'}
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="删除节点"
                        aria-label="删除节点"
                        disabled={occupied}
                        onClick={() => removeNode(node.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="db-node-meta">
                    <span className="db-node-addr">{node.host ? `${node.host}:${node.port}` : '未填写主机'}{node.database ? ` / ${node.database}` : ''}</span>
                    <span>{node.user || '未填写用户'}</span>
                    <span>连接池 {node.connectionLimit}</span>
                    <span>{node.ssl ? 'TLS 开启' : 'TLS 关闭'}</span>
                    <span>优先级 {node.priority}</span>
                    {probe?.ok && probe.schemaState && (
                      <span>{probe.schemaState === 'ready' ? '数据表已就绪' : probe.schemaState === 'empty' ? '空库（保存时建表）' : '数据表未知'}</span>
                    )}
                    {healthById[node.id]?.syncErrors ? (
                      <span className="db-node-warn">同步失败 {healthById[node.id].syncErrors} 次</span>
                    ) : null}
                    {sync ? <span className={sync.tone === 'ok' ? 'db-node-ok' : 'db-node-warn'}>{sync.text}</span> : null}
                  </div>

                  {editing && (
                    <div className="db-node-form">
                      <div className="db-grid">
                        <label className="field">
                          <span>名称</span>
                          <input
                            className="input"
                            value={node.label}
                            placeholder="主库 / 华东备用"
                            onInput={(e) => updateNode(node.id, { label: (e.target as HTMLInputElement).value })}
                          />
                        </label>
                        <label className="field">
                          <span>角色</span>
                          <select
                            className="input"
                            value={node.role}
                            onChange={(e) => {
                              const role = (e.target as HTMLSelectElement).value as DbNodeRole;
                              if (role === 'primary') makePrimary(node.id);
                              else updateNode(node.id, { role });
                            }}
                          >
                            <option value="primary">主库（读写）</option>
                            <option value="replica">副库（备用 / 只读）</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>主机 host</span>
                          <input
                            className="input"
                            value={node.host}
                            placeholder="gz-xxx.tidbcloud.com 或 1.2.3.4"
                            onInput={(e) => updateNode(node.id, { host: (e.target as HTMLInputElement).value })}
                          />
                        </label>
                        <label className="field">
                          <span>端口 port</span>
                          <input
                            className="input"
                            value={node.port}
                            placeholder="3306 / 4000"
                            onInput={(e) => updateNode(node.id, { port: (e.target as HTMLInputElement).value })}
                          />
                        </label>
                        <label className="field">
                          <span>用户名 user</span>
                          <input
                            className="input"
                            value={node.user}
                            placeholder="nodewarden"
                            onInput={(e) => updateNode(node.id, { user: (e.target as HTMLInputElement).value })}
                          />
                        </label>
                        <label className="field">
                          <span>密码 password</span>
                          <input
                            className="input"
                            type="password"
                            value={node.password}
                            autocomplete="new-password"
                            placeholder={node.hasStoredPassword ? '已保存（留空则不修改）' : '必填'}
                            onInput={(e) => updateNode(node.id, { password: (e.target as HTMLInputElement).value })}
                          />
                        </label>
                        <label className="field">
                          <span>数据库名 database</span>
                          <input
                            className="input"
                            value={node.database}
                            placeholder="nodewarden"
                            onInput={(e) => updateNode(node.id, { database: (e.target as HTMLInputElement).value })}
                          />
                        </label>
                        <label className="field">
                          <span>连接池上限</span>
                          <input
                            className="input"
                            value={node.connectionLimit}
                            placeholder="5"
                            onInput={(e) => updateNode(node.id, { connectionLimit: (e.target as HTMLInputElement).value })}
                          />
                        </label>
                      </div>

                      <div className="db-node-toggles">
                        <label className="checkbox-field">
                          <input
                            type="checkbox"
                            checked={node.ssl}
                            onChange={(e) => updateNode(node.id, { ssl: (e.target as HTMLInputElement).checked })}
                          />
                          <span>启用 TLS（TiDB Serverless 等云库必须开启）</span>
                        </label>
                        <label className="checkbox-field">
                          <input
                            type="checkbox"
                            checked={node.enabled}
                            onChange={(e) => updateNode(node.id, { enabled: (e.target as HTMLInputElement).checked })}
                          />
                          <span>启用该节点（停用后不参与读写与故障切换）</span>
                        </label>
                        {node.hasStoredPassword && (
                          <label className="checkbox-field">
                            <input
                              type="checkbox"
                              checked={node.clearPassword}
                              disabled={!!node.password}
                              onChange={(e) => updateNode(node.id, { clearPassword: (e.target as HTMLInputElement).checked })}
                            />
                            <span>清除已保存的密码（输入新密码时无效）</span>
                          </label>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ── High availability policy ─────────────────────────────── */}
      <section className="card">
        <div className="section-head">
          <h3>高可用与同步策略</h3>
          <div className="actions">
            <button
              type="button"
              className="btn btn-secondary small"
              disabled={occupied || policy.syncMode !== 'write-through' || nodes.filter((node) => node.enabled && node.role === 'replica').length === 0}
              title={
                policy.syncMode !== 'write-through'
                  ? '仅「应用层实时双写」需要手动同步：数据库自身复制由数据库负责'
                  : '把源节点的数据补到副库；默认只插入缺失行，不会覆盖已有的更新'
              }
              onClick={() => setConfirmSync(true)}
            >
              {busy === 'sync' ? <Loader2 size={14} className="btn-icon spin" /> : <RefreshCw size={14} className="btn-icon" />}
              同步数据到副库
            </button>
          </div>
        </div>

        {policy.syncMode === 'write-through' && (
          <div className="db-grid">
            <label className="field">
              <span>同步源（从哪个节点读数据）</span>
              <select
                className="input"
                value={syncSourceId}
                onChange={(e) => setSyncSourceId((e.target as HTMLSelectElement).value)}
              >
                <option value="">主库（默认）</option>
                {nodes
                  .filter((node) => node.enabled)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.label}（{node.role === 'primary' ? '主库' : '副库'}）
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>写入方式</span>
              <select
                className="input"
                value={syncMode}
                onChange={(e) => setSyncMode((e.target as HTMLSelectElement).value as DbSyncCopyMode)}
              >
                <option value="merge">只补缺失行（安全，不覆盖已有数据）</option>
                <option value="overwrite">覆盖已有行（修复不一致）</option>
              </select>
            </label>
          </div>
        )}

        <div className="db-grid">
          <label className="field">
            <span>副库同步方式</span>
            <select
              className="input"
              value={policy.syncMode}
              onChange={(e) => updatePolicy({ syncMode: (e.target as HTMLSelectElement).value as DbClusterPolicy['syncMode'] })}
            >
              <option value="native">数据库自身复制（推荐）</option>
              <option value="write-through">应用层实时双写</option>
            </select>
          </label>
          <label className="field">
            <span>连续失败阈值</span>
            <input
              className="input"
              value={String(policy.failureThreshold)}
              placeholder="3"
              onInput={(e) => updatePolicy({ failureThreshold: Number((e.target as HTMLInputElement).value) || 3 })}
            />
          </label>
          <label className="field">
            <span>熔断冷却（秒）</span>
            <input
              className="input"
              value={String(Math.round(policy.cooldownMs / 1000))}
              placeholder="30"
              onInput={(e) => updatePolicy({ cooldownMs: (Number((e.target as HTMLInputElement).value) || 30) * 1000 })}
            />
          </label>
        </div>

        <div className="db-node-toggles">
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={policy.failoverEnabled}
              onChange={(e) => updatePolicy({ failoverEnabled: (e.target as HTMLInputElement).checked })}
            />
            <span>主库连接失败时自动切换到下一个健康节点（按优先级）</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={policy.readSplit}
              onChange={(e) => updatePolicy({ readSplit: (e.target as HTMLInputElement).checked })}
            />
            <span>读请求分摊到副库（写请求仍然只走主库）</span>
          </label>
          {policy.syncMode === 'write-through' && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={policy.syncAsync}
                onChange={(e) => updatePolicy({ syncAsync: (e.target as HTMLInputElement).checked })}
              />
              <span>双写异步执行（请求更快，但副库失败只会在本页告警）</span>
            </label>
          )}
        </div>

        <div className="db-callout">
          <strong>同步方式怎么选</strong>
          <ul>
            <li>
              <b>数据库自身复制</b>：副库由 MySQL 主从 / 云厂商只读副本维护。应用不双写，只在主库不可用时切换。数据一致性由数据库保证，
              <b>推荐用于生产</b>。
            </li>
            <li>
              <b>应用层实时双写</b>：每次写入成功后立即在其他节点重放，适合“两台互不相关、想互为备份”的场景。
              跨库写入<b>不是原子操作</b>：主库已提交但副库失败时，以主库为准，失败会记录在节点状态里，需要人工重新同步。
              不要与数据库自身的复制同时开启，否则重复写入会触发主键冲突。
            </li>
            <li>
              应用层双写只覆盖<b>配置生效之后</b>的写入。给已有数据的部署新增副库时，保存后请点一次
              <b>「同步数据到副库」</b>，把历史数据补齐；<b>未同步完成的副库不会被用于读取，也不会在故障时接管</b>，
              避免空库上线后账号全丢。
            </li>
            <li>
              同步默认<b>只补缺失行</b>，不会覆盖副库上已有的数据；需要纠正不一致时才选「覆盖已有行」。
              单次跑不完（行数上限或时间预算）时提示里会说明，再点一次会<b>从上次的位置继续</b>，
              不会每次从头开始。
            </li>
            <li>
              主库故障期间写入落在副库，主库恢复后<b>不会立刻收回写权</b>：先把落后的写入补上再切回，
              落后过多（超出内存补写日志范围）时该节点会被标红并要求完整同步。
            </li>
            <li>
              故障切换只针对<b>连接级失败</b>（拒绝连接、超时、连接被重置等）。SQL 语法错误、唯一键冲突不会切换节点，否则同一条语句会被执行两次。
              写入报「无法确认是否已提交」时不会自动重放——那正是避免重复写入的保护。
            </li>
            <li>节点健康与补写日志保存在当前进程内：多实例部署时每个实例各自判断，建议只让一个实例承担写入（或改用数据库自身复制）。</li>
          </ul>
        </div>
      </section>

      {/* ── Actions ──────────────────────────────────────────────── */}
      <div className="db-actions-bar">
        <button type="button" className="btn btn-primary" disabled={occupied} onClick={() => void onSave()}>
          {saving ? <Loader2 size={14} className="btn-icon spin" /> : <Save size={14} className="btn-icon" />}
          保存并应用
        </button>
        <button type="button" className="btn btn-secondary" disabled={occupied} onClick={() => setConfirmClear(true)}>
          <Trash2 size={14} className="btn-icon" />
          清除配置（回退 D1）
        </button>
        <span className="db-inline-hint">
          配置使用 AES-256-GCM 加密存储（主密钥来自 DB_CONFIG_KEY）；密码永不回显。保存时会对每个启用节点做连接测试并自动建表，全部通过才生效。
        </span>
      </div>

      <ConfirmDialog
        open={confirmSync}
        variant="warning"
        title="把源节点的数据同步到副库？"
        message={
          (syncMode === 'overwrite'
            ? '将逐表读取源节点并覆盖副库中主键相同的行——副库上更新的数据会被改回源节点的版本。'
            : '将逐表读取源节点，只把副库缺少的行插入（不会覆盖副库已有的数据）。') +
          '数据量大时会分批进行，未跑完可再次点击，从上次的位置继续。此操作只写副库，不影响源节点。'
        }
        confirmText="开始同步"
        cancelText="取消"
        onConfirm={() => void onSync()}
        onCancel={() => setConfirmSync(false)}
      />

      <ConfirmDialog
        open={confirmClear}
        variant="warning"
        title="清除外接数据库配置？"
        message="将删除已保存的集群配置并回退到 D1 或 DB_* 环境变量。如果当前运行环境没有任何内置数据库，此操作会被拒绝。"
        confirmText="清除配置"
        cancelText="取消"
        danger
        onConfirm={() => void onClear()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
