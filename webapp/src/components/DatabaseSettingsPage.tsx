import { useCallback, useEffect, useState } from 'preact/hooks';
import { Database, Loader2, PlugZap, RefreshCw, Save, Trash2 } from 'lucide-preact';
import LoadingState from '@/components/LoadingState';
import type { AuthedFetch } from '@/lib/api/shared';
import {
  clearDbConfig,
  getDbConfigStatus,
  saveDbConfig,
  testDbConfig,
  type DbConfigInput,
  type DbConfigStatus,
  type DbConfigTestResult,
} from '@/lib/api/db-config';

interface DatabaseSettingsPageProps {
  authedFetch: AuthedFetch;
  mobileLayout?: boolean;
  onMobileBack?: () => void;
}

// Standalone admin page for the BYO-DB (external MySQL) configuration.
// Strings are intentionally hardcoded (fork feature) to avoid churn across
// the 10 locale bundles.
export default function DatabaseSettingsPage(props: DatabaseSettingsPageProps) {
  const [status, setStatus] = useState<DbConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<DbConfigTestResult | null>(null);

  const [host, setHost] = useState('');
  const [port, setPort] = useState('3306');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState('');
  const [ssl, setSsl] = useState(true);
  const [connectionLimit, setConnectionLimit] = useState('5');
  const [clearPassword, setClearPassword] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const next = await getDbConfigStatus(props.authedFetch);
      setStatus(next);
      setHost(next.config.host || '');
      setPort(String(next.config.port || 3306));
      setUser(next.config.user || '');
      setDatabase(next.config.database || '');
      setSsl(next.config.ssl !== false);
      setConnectionLimit(String(next.config.connectionLimit || 5));
      setPassword('');
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [props.authedFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const collectInput = (): DbConfigInput => ({
    mode: 'mysql',
    host: host.trim(),
    port: Number(port) || 3306,
    user: user.trim(),
    database: database.trim(),
    ssl,
    connectionLimit: Number(connectionLimit) || 5,
    ...(password ? { password } : {}),
    // The backend treats an empty password field as "keep the stored one";
    // clearing it must be explicit or an empty MySQL password is impossible.
    ...(clearPassword && !password ? { clearPassword: true } : {}),
  });

  const onTest = async () => {
    setTesting(true);
    setNotice(null);
    setTestResult(null);
    try {
      const result = await testDbConfig(props.authedFetch, collectInput());
      setTestResult(result);
      setNotice({
        kind: result.ok ? 'ok' : 'error',
        text: result.ok
          ? `连接成功 · ${result.version || 'unknown'} · ${result.latencyMs}ms · schema: ${result.schemaState || 'unknown'}`
          : `连接失败：${result.error || 'unknown error'}`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const result = await saveDbConfig(props.authedFetch, collectInput());
      if (result.ok) {
        if (result.warning) {
          setNotice({ kind: 'error', text: result.warning });
        } else {
          setNotice({
            kind: 'ok',
            text: `已保存并生效（${result.version || 'MySQL'}，${result.latencyMs ?? 0}ms）。配置已加密存储，密码不再回显。`,
          });
        }
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
      setSaving(false);
    }
  };

  const onClear = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await clearDbConfig(props.authedFetch);
      setNotice({ kind: 'ok', text: '已清除运行时数据库配置，回退到 D1（或 DB_* 环境变量）。' });
      await load();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  if (loading && !status) {
    return <LoadingState card lines={5} />;
  }

  const mode = status?.config.mode || 'd1';

  return (
    <div className="stack">
      {props.mobileLayout && props.onMobileBack && (
        <div className="mobile-settings-subhead">
          <button type="button" className="btn btn-secondary small mobile-settings-back" onClick={props.onMobileBack}>
            <span className="btn-icon" aria-hidden="true">{'<'}</span>
            返回
          </button>
        </div>
      )}

      {!!notice && (
        <div className={notice.kind === 'error' ? 'local-error' : 'local-ok'}>
          <span>{notice.text}</span>
        </div>
      )}

      <section className="card">
        <div className="section-head">
          <h3><Database size={16} className="btn-icon" /> 数据库设置（外接 MySQL / BYO DB）</h3>
          <button type="button" className="btn btn-secondary small" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={14} className="btn-icon" /> 刷新
          </button>
        </div>

        <div className="stack">
          <p>
            当前模式：<strong>{mode === 'mysql' ? '外接 MySQL' : 'D1（平台内置）'}</strong>
            {' · '}配置来源：<strong>{status?.config.source === 'env' ? '环境变量' : status?.config.source === 'runtime' ? '运行时（加密存储）' : '默认 D1'}</strong>
          </p>
          {status?.envOverrideActive && (
            <p className="local-error"><span>检测到 DB_HOST 环境变量，环境变量优先于下方保存的配置。</span></p>
          )}
          {!status?.configStoreAvailable && (
            <p className="local-error"><span>未绑定 SETTINGS_KV/ATTACHMENTS 配置存储：可测试连接，但保存需要配置存储（或改用 DB_* 环境变量）。</span></p>
          )}

          <div className="form-grid">
            <label className="field">
              <span>主机 host</span>
              <input value={host} onInput={(e) => setHost((e.target as HTMLInputElement).value)} placeholder="gz-xxx.tidbcloud.com 或 1.2.3.4" />
            </label>
            <label className="field">
              <span>端口 port</span>
              <input value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value)} placeholder="3306 / 4000" />
            </label>
            <label className="field">
              <span>用户名 user</span>
              <input value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} placeholder="nodewarden" />
            </label>
            <label className="field">
              <span>密码 password</span>
              <input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} placeholder={status?.config.passwordSet ? '已保存（留空则不修改）' : '必填'} autocomplete="new-password" />
            </label>
            <label className="field">
              <span>数据库名 database</span>
              <input value={database} onInput={(e) => setDatabase((e.target as HTMLInputElement).value)} placeholder="nodewarden" />
            </label>
            <label className="field">
              <span>连接池上限</span>
              <input value={connectionLimit} onInput={(e) => setConnectionLimit((e.target as HTMLInputElement).value)} placeholder="5" />
            </label>
            <label className="field checkbox-field">
              <input type="checkbox" checked={ssl} onChange={(e) => setSsl((e.target as HTMLInputElement).checked)} />
              <span>启用 TLS（TiDB Serverless 必须开启）</span>
            </label>
            {status?.config.passwordSet && (
              <label className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  disabled={!!password}
                  onChange={(e) => setClearPassword((e.target as HTMLInputElement).checked)}
                />
                <span>清除已保存的密码（保存时把密码置为空；输入新密码时无效）</span>
              </label>
            )}
          </div>

          <div className="row-actions">
            <button type="button" className="btn btn-secondary" disabled={testing || saving} onClick={() => void onTest()}>
              {testing ? <Loader2 size={14} className="btn-icon spin" /> : <PlugZap size={14} className="btn-icon" />}
              测试连接
            </button>
            <button type="button" className="btn btn-primary" disabled={testing || saving} onClick={() => void onSave()}>
              {saving ? <Loader2 size={14} className="btn-icon spin" /> : <Save size={14} className="btn-icon" />}
              保存并应用
            </button>
            <button type="button" className="btn btn-secondary" disabled={testing || saving} onClick={() => void onClear()}>
              <Trash2 size={14} className="btn-icon" />
              清除配置（回退 D1）
            </button>
          </div>

          {testResult && (
            <p>
              测试结果：{testResult.ok ? '成功' : '失败'}
              {testResult.version ? ` · MySQL ${testResult.version}` : ''}
              {typeof testResult.latencyMs === 'number' ? ` · ${testResult.latencyMs}ms` : ''}
              {testResult.schemaState ? ` · 数据表：${testResult.schemaState === 'ready' ? '已就绪' : testResult.schemaState === 'empty' ? '空（保存时自动建表）' : '未知'}` : ''}
            </p>
          )}

          <p>
            说明：配置使用 AES-256-GCM 加密后保存（主密钥来自 DB_CONFIG_KEY 环境变量）；密码永不回显。
            保存后将自动在目标库创建全部数据表。切换/清除配置即时生效，无需重启。
          </p>
        </div>
      </section>
    </div>
  );
}
