import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { api, compact, date, dateTime, money } from '../api';
import { useAction, useData } from '../hooks';
import { errText, useSaasAuth, useToast } from '../state';
import { Badge, BarChart, Button, Card, Empty, ErrorNote, Field, Loading, Modal, Progress, Stat, Table } from '../ui';
import { ContactPage, DocsPage } from './Public';

const SIDE = [
  { to: '/dashboard', label: 'Overview', icon: '◈', end: true },
  { to: '/dashboard/playground', label: 'Playground', icon: '▶' },
  { to: '/dashboard/api-keys', label: 'API Keys', icon: '⚿' },
  { to: '/dashboard/provider-keys', label: 'Provider Keys', icon: '⛁' },
  { to: '/dashboard/models', label: 'Models', icon: '≋' },
  { to: '/dashboard/routing', label: 'Routing / Fallback', icon: '⇄' },
  { to: '/dashboard/usage', label: 'Usage', icon: '▤' },
  { to: '/dashboard/analytics', label: 'Analytics', icon: '◫' },
  { to: '/dashboard/billing', label: 'Billing', icon: '₹' },
  { to: '/dashboard/subscription', label: 'Subscription', icon: '★' },
  { to: '/dashboard/docs', label: 'Documentation', icon: '⌘' },
  { to: '/dashboard/account', label: 'Account', icon: '◉' },
  { to: '/dashboard/support', label: 'Support', icon: '✦' },
];

export function DashboardLayout() {
  const { user, signOut, subscription } = useSaasAuth();
  const navigate = useNavigate();
  return (
    <div className="ab-root">
      <nav className="ab-nav" style={{ position: 'sticky', top: 0, width: '100%' }}>
        <div className="ab-container ab-nav-inner" style={{ maxWidth: 'none' }}>
          <Link to="/" className="ab-brand"><span className="ab-brand-mark">A</span> ALI-BOSS <span className="ab-brand-sub">AI API</span></Link>
          <div className="ab-nav-actions">
            {subscription?.plan && <Badge tone="red">{subscription.plan.name}</Badge>}
            {user?.role === 'admin' && <Link to="/admin" className="ab-btn ab-btn-sm">Admin</Link>}
            <Link to="/console" className="ab-btn ab-btn-ghost ab-btn-sm" title="Original FreeLLMAPI operator console">Advanced console</Link>
            <Button size="sm" variant="ghost" onClick={async () => { await signOut(); navigate('/'); }}>Log out</Button>
          </div>
        </div>
      </nav>
      <div className="ab-body">
        <aside className="ab-sidebar">
          {SIDE.map(s => <NavLink key={s.to} end={s.end} to={s.to} className={({ isActive }) => `ab-side-link ${isActive ? 'active' : ''}`}><span>{s.icon}</span>{s.label}</NavLink>)}
        </aside>
        <main className="ab-main"><div className="ab-container"><Outlet /></div></main>
      </div>
    </div>
  );
}

function PageHead({ title, sub, actions }: { title: string; sub: string; actions?: ReactNode }) {
  return <div className="ab-page-head"><div><div className="ab-page-title">{title}</div><div className="ab-page-sub">{sub}</div></div>{actions && <div className="ab-row">{actions}</div>}</div>;
}

export function OverviewPage() {
  const { data, loading, error } = useData<any>('/api/saas/overview');
  const { user } = useSaasAuth();
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  const o = data!;
  return <>
    <PageHead title={`Welcome, ${user?.name ?? 'developer'}`} sub="Your workspace at a glance." actions={<Link to="/dashboard/api-keys" className="ab-btn ab-btn-primary ab-btn-sm">Create API key</Link>} />
    <div className="ab-grid ab-grid-4" style={{ marginBottom: 18 }}>
      <Stat label="PLAN" value={o.plan.name} sub={o.status.toUpperCase()} />
      <Stat label="REQUESTS (30d)" value={compact(o.requests)} />
      <Stat label="TOKENS (30d)" value={compact(o.tokens)} />
      <Stat label="REMAINING TODAY" value={`${o.remainingPercent}%`} />
    </div>
    <div className="ab-grid ab-grid-2">
      <Card>
        <div className="ab-card-title">Subscription</div>
        <div className="ab-kv"><span>Status</span><span><Badge tone={o.status === 'active' ? 'green' : 'amber'}>{o.status}</Badge></span></div>
        <div className="ab-kv"><span>Plan</span><span>{o.plan.name} · {money(o.plan.priceMinor, o.plan.currency)}/{o.plan.billingCycleDays}d</span></div>
        <div className="ab-kv"><span>Renews / expires</span><span>{date(o.subscription.endAt)}</span></div>
        <div className="ab-kv"><span>Active API keys</span><span>{o.counts.apiKeys}</span></div>
        <div className="ab-kv"><span>Active providers</span><span>{o.counts.providers}</span></div>
        <div style={{ marginTop: 16 }}><Link to="/dashboard/billing" className="ab-btn ab-btn-sm">Manage billing</Link></div>
      </Card>
      <Card>
        <div className="ab-card-title">Daily quota</div>
        <div className="ab-form-note" style={{ marginBottom: 10 }}>{compact(o.quota.requestsToday)} / {compact(o.quota.requestsDayLimit)} requests today</div>
        <Progress value={(o.quota.requestsToday / Math.max(1, o.quota.requestsDayLimit)) * 100} />
        <div className="ab-form-note" style={{ margin: '16px 0 10px' }}>{compact(o.quota.tokensToday)} / {compact(o.quota.tokensDayLimit)} tokens today</div>
        <Progress value={(o.quota.tokensToday / Math.max(1, o.quota.tokensDayLimit)) * 100} />
        <div className="ab-divider" />
        <div className="ab-card-title">Requests / day</div>
        <BarChart data={o.charts ?? []} field="requests" />
      </Card>
    </div>
    <Card style={{ marginTop: 16 }}>
      <div className="ab-card-title">Quick start</div>
      <pre className="ab-code" style={{ marginTop: 10 }}>{`curl -X POST ${window.location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer ALI-BOSS-..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"...","messages":[{"role":"user","content":"Hello"}]}'`}</pre>
    </Card>
  </>;
}

export function ApiKeysPage() {
  const { data, loading, reload } = useData<any>('/api/saas/api-keys');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const create = () => run(() => api.post('/api/saas/api-keys', { name: name || 'Default' }), (r: any) => { setCreated(r.key); setName(''); reload(); toast('API key created. Copy it now.'); });
  const action = (path: string, label: string) => run(() => api.post(path, {}), (r: any) => { if (r?.key) setCreated(r.key); reload(); toast(label); });
  const remove = (id: string) => run(() => api.del(`/api/saas/api-keys/${id}`), () => { reload(); toast('Key deleted.'); });
  return <>
    <PageHead title="API Keys" sub="Personal keys for the /v1 API. Stored hashed; shown once at creation." />
    <Card style={{ marginBottom: 16 }}>
      <div className="ab-row">
        <input className="ab-input" style={{ maxWidth: 300 }} placeholder="Key name (e.g. production)" value={name} onChange={e => setName(e.target.value)} />
        <Button variant="primary" loading={busy} onClick={create}>Create key</Button>
      </div>
      <ErrorNote message={error} />
    </Card>
    {created && <Card style={{ marginBottom: 16, borderColor: 'rgba(255,45,70,.45)' }}>
      <div className="ab-card-title">Copy your key now — it will not be shown again</div>
      <pre className="ab-code" style={{ marginTop: 10 }}>{created}</pre>
      <div className="ab-row" style={{ marginTop: 12 }}>
        <Button size="sm" onClick={() => { void navigator.clipboard.writeText(created); toast('Copied to clipboard.'); }}>Copy</Button>
        <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>Done</Button>
      </div>
    </Card>}
    {revealed && <Modal title="Revealed API key" onClose={() => setRevealed(null)}><pre className="ab-code">{revealed}</pre><p className="ab-form-note" style={{ marginTop: 10 }}>This reveal was written to the audit log.</p></Modal>}
    {loading ? <Loading /> : !data?.keys?.length ? <Empty>No API keys yet. Create one above.</Empty> : (
      <Table head={['Name', 'Key', 'Status', 'Created', 'Actions']}>
        {data.keys.map((k: any) => <tr key={k.id}>
          <td>{k.name}</td><td className="ab-mono">{k.prefix}</td>
          <td><Badge tone={k.status === 'active' ? 'green' : 'red'}>{k.status}</Badge></td><td>{date(k.createdAt)}</td>
          <td><div className="ab-row" style={{ gap: 5 }}>
            <Button size="sm" variant="ghost" onClick={() => run(() => api.post(`/api/saas/api-keys/${k.id}/reveal`, {}), (r: any) => setRevealed(r.key))}>Reveal</Button>
            <Button size="sm" onClick={() => action(`/api/saas/api-keys/${k.id}/rotate`, 'Key rotated.')}>Rotate</Button>
            <Button size="sm" variant="danger" onClick={() => action(`/api/saas/api-keys/${k.id}/revoke`, 'Key revoked.')}>Revoke</Button>
            <Button size="sm" variant="ghost" onClick={() => remove(k.id)}>Delete</Button>
          </div></td>
        </tr>)}
      </Table>
    )}
  </>;
}

const PROVIDERS = ['google', 'openai', 'anthropic', 'openrouter', 'groq', 'together', 'mistral', 'cohere', 'cerebras', 'huggingface', 'nvidia', 'cloudflare', 'ollama', 'custom'];

export function ProviderKeysPage() {
  const { data, loading, reload } = useData<any>('/api/saas/provider-keys');
  const [form, setForm] = useState({ platform: 'google', label: '', secret: '', baseUrl: '' });
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const add = () => run(() => api.post('/api/saas/provider-keys', form), () => { setOpen(false); setForm({ platform: 'google', label: '', secret: '', baseUrl: '' }); reload(); toast('Provider key added and encrypted.'); });
  return <>
    <PageHead title="Provider Keys" sub="Encrypted at rest (AES-256-GCM), tenant-scoped, never returned in full." actions={<Button variant="primary" onClick={() => setOpen(true)}>Add provider key</Button>} />
    {loading ? <Loading /> : !data?.keys?.length ? <Empty>No provider keys configured. Add one to unlock paid upstream models.</Empty> : (
      <Table head={['Platform', 'Label', 'Key', 'Base URL', 'Enabled', 'Actions']}>
        {data.keys.map((k: any) => <tr key={k.id}>
          <td>{k.platform}</td><td>{k.label}</td><td className="ab-mono">{k.masked}</td><td className="ab-mono">{k.baseUrl ?? '—'}</td>
          <td><Badge tone={k.enabled ? 'green' : ''}>{k.enabled ? 'enabled' : 'disabled'}</Badge></td>
          <td><div className="ab-row" style={{ gap: 5 }}>
            <Button size="sm" onClick={() => run(() => api.patch(`/api/saas/provider-keys/${k.id}`, { enabled: !k.enabled }), () => { reload(); toast('Updated.'); })}>{k.enabled ? 'Disable' : 'Enable'}</Button>
            <Button size="sm" variant="danger" onClick={() => run(() => api.del(`/api/saas/provider-keys/${k.id}`), () => { reload(); toast('Deleted.'); })}>Delete</Button>
          </div></td>
        </tr>)}
      </Table>
    )}
    {open && <Modal title="Add provider key" onClose={() => setOpen(false)} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={add}>Save encrypted</Button></>}>
      <Field label="Provider"><select className="ab-select" value={form.platform} onChange={e => setForm(v => ({ ...v, platform: e.target.value }))}>{PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}</select></Field>
      <Field label="Label"><input className="ab-input" value={form.label} onChange={e => setForm(v => ({ ...v, label: e.target.value }))} placeholder="My Google key" /></Field>
      <Field label="API key / secret" hint="Encrypted before it touches the database."><input className="ab-input" type="password" value={form.secret} onChange={e => setForm(v => ({ ...v, secret: e.target.value }))} placeholder="sk-..." /></Field>
      <Field label="Base URL (optional, for custom/Ollama)"><input className="ab-input" value={form.baseUrl} onChange={e => setForm(v => ({ ...v, baseUrl: e.target.value }))} placeholder="http://localhost:11434" /></Field>
      <ErrorNote message={error} />
    </Modal>}
  </>;
}

export function CatalogPage() {
  const { data, loading } = useData<any>('/api/saas/catalog');
  const [q, setQ] = useState('');
  const models = (data?.models ?? []).filter((m: any) => `${m.id} ${m.provider}`.toLowerCase().includes(q.toLowerCase()));
  return <>
    <PageHead title="Models" sub={`Available on the ${data?.plan ?? '…'} plan (limit: ${data?.limit ?? '…'} models).`} />
    <input className="ab-input" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 14, maxWidth: 360 }} />
    {loading ? <Loading /> : !models.length ? <Empty>No models available.</Empty> : (
      <Table head={['Model', 'Provider', 'Context', 'Vision', 'Tools']}>
        {models.map((m: any) => <tr key={`${m.provider}-${m.id}`}><td className="ab-mono">{m.id}</td><td>{m.provider}</td><td>{m.context ? compact(m.context) : '—'}</td><td>{m.vision ? '✓' : '—'}</td><td>{m.tools ? '✓' : '—'}</td></tr>)}
      </Table>
    )}
  </>;
}

export function RoutingPage() {
  const { data, loading, reload } = useData<any>('/api/saas/routing');
  const [form, setForm] = useState<any>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  useEffect(() => { if (data) setForm(data); }, [data]);
  if (loading || !form) return <Loading />;
  return <>
    <PageHead title="Routing & Fallback" sub="Choose your preferred provider order. The FreeLLMAPI engine applies automatic failover." />
    <Card style={{ maxWidth: 620 }}>
      <Field label="Primary provider" hint="Tried first for each request."><input className="ab-input" value={form.primary ?? ''} onChange={e => setForm((v: any) => ({ ...v, primary: e.target.value }))} placeholder="google" /></Field>
      <Field label="Secondary provider"><input className="ab-input" value={form.secondary ?? ''} onChange={e => setForm((v: any) => ({ ...v, secondary: e.target.value }))} placeholder="openrouter" /></Field>
      <Field label="Fallback provider"><input className="ab-input" value={form.fallback ?? ''} onChange={e => setForm((v: any) => ({ ...v, fallback: e.target.value }))} placeholder="groq" /></Field>
      <Field label="Routing strategy"><select className="ab-select" value={form.strategy ?? 'balanced'} onChange={e => setForm((v: any) => ({ ...v, strategy: e.target.value }))}><option value="balanced">Balanced</option><option value="speed">Speed first</option><option value="quality">Quality first</option></select></Field>
      <ErrorNote message={error} />
      <Button variant="primary" loading={busy} onClick={() => run(() => api.put('/api/saas/routing', form), () => { reload(); toast('Routing preferences saved.'); })}>Save routing</Button>
      <p className="ab-form-note" style={{ marginTop: 14 }}>Note: these preferences are stored per workspace. The underlying router's global provider chain remains the operator's configuration — see the Advanced console.</p>
    </Card>
  </>;
}

export function UsagePage({ analytics = false }: { analytics?: boolean }) {
  const [days, setDays] = useState(30);
  const { data, loading, error } = useData<any>(`/api/saas/${analytics ? 'analytics' : 'usage'}?days=${days}`, [days]);
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  const u = data!;
  return <>
    <PageHead title={analytics ? 'Analytics' : 'Usage'} sub="Requests, tokens, latency and provider breakdown." actions={<select className="ab-select" style={{ width: 140 }} value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>} />
    <div className="ab-grid ab-grid-4" style={{ marginBottom: 18 }}>
      <Stat label="REQUESTS" value={compact(u.totals.requests)} /><Stat label="TOKENS" value={compact(u.totals.tokens)} />
      <Stat label="ERRORS" value={compact(u.totals.errors)} /><Stat label="AVG LATENCY" value={`${u.totals.avgLatencyMs} ms`} />
    </div>
    <div className="ab-grid ab-grid-2">
      <Card><div className="ab-card-title">Requests / day</div><BarChart data={u.daily} field="requests" /></Card>
      <Card><div className="ab-card-title">Tokens / day</div><BarChart data={u.daily} field="tokens" color="linear-gradient(180deg,#8b5cf6,rgba(139,92,246,.15))" /></Card>
    </div>
    <div className="ab-grid ab-grid-2" style={{ marginTop: 16 }}>
      <Card><div className="ab-card-title">Top models</div>{!u.models.length ? <Empty>No data.</Empty> : u.models.map((m: any) => <div className="ab-kv" key={m.model}><span className="ab-mono">{m.model}</span><span>{compact(m.requests)} req · {compact(m.tokens)} tok</span></div>)}</Card>
      <Card><div className="ab-card-title">Top providers</div>{!u.providers.length ? <Empty>No data.</Empty> : u.providers.map((p: any) => <div className="ab-kv" key={p.provider}><span>{p.provider}</span><span>{compact(p.requests)} req · {compact(p.tokens)} tok</span></div>)}</Card>
    </div>
    <Card style={{ marginTop: 16 }}><div className="ab-card-title">Recent requests</div>
      {!u.recent.length ? <Empty>No requests yet.</Empty> : <div style={{ marginTop: 10 }}><Table head={['Time', 'Endpoint', 'Model', 'Provider', 'Tokens', 'Latency', 'Status']}>
        {u.recent.slice(0, 15).map((r: any) => <tr key={r.id}><td>{dateTime(r.createdAt)}</td><td className="ab-mono">{r.endpoint.slice(0, 32)}</td><td className="ab-mono">{r.model ?? '—'}</td><td>{r.provider ?? '—'}</td><td>{compact(r.totalTokens)}</td><td>{r.latencyMs} ms</td><td><Badge tone={r.status === 'ok' ? 'green' : 'red'}>{r.status}</Badge></td></tr>)}
      </Table></div>}
    </Card>
  </>;
}

function loadRazorpayScript(): Promise<boolean> {
  if ((window as any).Razorpay) return Promise.resolve(true);
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(Boolean((window as any).Razorpay));
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

export function BillingPage({ subscriptionOnly = false }: { subscriptionOnly?: boolean }) {
  const [params] = useSearchParams();
  const { data, loading, reload } = useData<any>('/api/saas/billing');
  const plans = useData<any>('/api/saas/plans');
  const config = useData<any>('/api/saas/config');
  const [pending, setPending] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { refresh } = useSaasAuth();

  const startCheckout = async (slug: string) => {
    setError(null); setBusy(true);
    try {
      const order = await api.post('/api/saas/payments/order', { planSlug: slug, idempotencyKey: `${slug}-${Date.now()}` });
      if (order.gateway === 'mock') { setPending({ ...order, slug }); setBusy(false); return; }
      const ok = await loadRazorpayScript();
      if (!ok) { setError('Could not load the payment checkout. Check your connection and try again.'); setBusy(false); return; }
      const rzp = new (window as any).Razorpay({
        key: order.keyId, amount: order.amountMinor, currency: order.currency,
        name: 'ALI-BOSS', description: `${order.planName} subscription`, order_id: order.orderId,
        handler: async (response: any) => {
          try {
            await api.post('/api/saas/payments/verify', {
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            });
            toast('Payment verified. Subscription active!');
            await reload(); await refresh();
          } catch (err) { setError(errText(err)); }
        },
        theme: { color: '#ff2d46' },
      });
      rzp.open();
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  const devCapture = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api.post('/api/saas/payments/dev-capture', { orderId: pending.orderId });
      if (result.processed || result.duplicate) {
        toast('Mock webhook verified — subscription activated.');
        setPending(null); await reload(); await refresh();
      } else setError(`Webhook was not processed: ${result.reason ?? 'unknown'}`);
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  useEffect(() => {
    const plan = params.get('plan');
    if (plan && plan !== 'free' && data && plans.data && !busy) void startCheckout(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('plan'), data?.subscription?.id, plans.data]);

  if (loading) return <Loading />;
  const b = data!;
  return <>
    <PageHead title={subscriptionOnly ? 'Subscription' : 'Billing'} sub="Your plan, payment history and invoices." />
    <ErrorNote message={error} />
    <div className="ab-grid ab-grid-2" style={{ marginBottom: 18 }}>
      <Card>
        <div className="ab-row" style={{ justifyContent: 'space-between' }}><div className="ab-card-title">Current subscription</div><Badge tone={b.subscription.status === 'active' ? 'green' : 'amber'}>{b.subscription.status}</Badge></div>
        <div className="ab-kv"><span>Plan</span><span>{b.plan.name}</span></div>
        <div className="ab-kv"><span>Price</span><span>{money(b.plan.priceMinor, b.plan.currency)} / {b.plan.billingCycleDays} days</span></div>
        <div className="ab-kv"><span>Expires / renews</span><span>{date(b.subscription.endAt)}</span></div>
        <div className="ab-kv"><span>RPM / day requests</span><span>{compact(b.plan.limits.requestsPerMinute)} / {compact(b.plan.limits.requestsPerDay)}</span></div>
        <div className="ab-kv"><span>Token budget / month</span><span>{compact(b.plan.limits.tokensPerMonth)}</span></div>
      </Card>
      <Card>
        <div className="ab-card-title">Upgrade or change plan</div>
        <p className="ab-card-sub" style={{ marginBottom: 12 }}>Prices come from the admin-configurable plan table. Activation happens only after a verified gateway event.</p>
        <div className="ab-stack">
          {(plans.data?.plans ?? []).filter((p: any) => p.priceMinor > 0 && p.slug !== b.plan.slug).map((p: any) => (
            <div className="ab-row" key={p.id} style={{ justifyContent: 'space-between', border: '1px solid var(--ab-border)', padding: 10, borderRadius: 10 }}>
              <div><div style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</div><div className="ab-muted" style={{ fontSize: 12 }}>{money(p.priceMinor, p.currency)} / {p.billingCycleDays} days</div></div>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void startCheckout(p.slug)}>Choose</Button>
            </div>
          ))}
        </div>
        {config.data?.gateway === 'mock' && <p className="ab-form-note" style={{ marginTop: 10 }}>Sandbox mode: PAYMENT_GATEWAY=mock is active. No real money is charged.</p>}
      </Card>
    </div>
    {!subscriptionOnly && <>
      <Card style={{ marginBottom: 16 }}><div className="ab-card-title">Payments</div>
        {!b.payments.length ? <Empty>No payments yet.</Empty> : <div style={{ marginTop: 10 }}><Table head={['Date', 'Order', 'Amount', 'Status', 'Gateway', 'Verified']}>
          {b.payments.map((p: any) => <tr key={p.id}><td>{dateTime(p.createdAt)}</td><td className="ab-mono">{p.orderId.slice(0, 22)}</td><td>{money(p.amountMinor, p.currency)}</td><td><Badge tone={p.status === 'paid' ? 'green' : p.status === 'refunded' ? 'amber' : p.status === 'failed' ? 'red' : ''}>{p.status}</Badge></td><td>{p.gateway}</td><td>{p.verifiedAt ? dateTime(p.verifiedAt) : '—'}</td></tr>)}
        </Table></div>}
      </Card>
      <Card><div className="ab-card-title">Invoices</div>{!b.invoices.length ? <Empty>No invoices yet.</Empty> : b.invoices.map((i: any) => <div className="ab-kv" key={i.number}><span className="ab-mono">{i.number}</span><span>{money(i.amountMinor, i.currency)} · {date(i.issuedAt)}</span></div>)}</Card>
    </>}
    {pending && <Modal title="Sandbox payment" onClose={() => setPending(null)} footer={<><Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={devCapture}>Simulate successful payment</Button></>}>
      <p className="ab-card-sub">Order <span className="ab-mono">{pending.orderId}</span> for <b>{pending.planName}</b> — {money(pending.amountMinor, pending.currency)}.</p>
      <p className="ab-form-note" style={{ marginTop: 10 }}>This sends a signed, gateway-shaped webhook through the real verification path. Duplicate deliveries are ignored.</p>
    </Modal>}
  </>;
}

export function AccountPage() {
  const { data, loading, reload } = useData<any>('/api/saas/account');
  const { user, refresh } = useSaasAuth();
  const [name, setName] = useState('');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const { signOut } = useSaasAuth();
  useEffect(() => { if (data?.user) setName(data.user.name); }, [data]);
  if (loading) return <Loading />;
  return <>
    <PageHead title="Account" sub="Profile, security and workspace details." />
    <div className="ab-grid ab-grid-2">
      <Card>
        <div className="ab-card-title">Profile</div>
        <Field label="Name"><input className="ab-input" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Email"><input className="ab-input" value={data.user.email} disabled /></Field>
        <Field label="Workspace"><input className="ab-input" value={data.tenant?.name ?? ''} disabled /></Field>
        <div className="ab-kv"><span>Email verified</span><span><Badge tone={data.user.emailVerified ? 'green' : 'amber'}>{data.user.emailVerified ? 'yes' : 'pending'}</Badge></span></div>
        <div className="ab-kv"><span>Referral code</span><span className="ab-mono">{data.user.referralCode}</span></div>
        <ErrorNote message={error} />
        <Button variant="primary" loading={busy} onClick={() => run(() => api.patch('/api/saas/account', { name }), () => { reload(); refresh(); toast('Profile updated.'); })}>Save profile</Button>
      </Card>
      <Card>
        <div className="ab-card-title">Security</div>
        <p className="ab-card-sub" style={{ marginBottom: 12 }}>Changing your password signs out every session, including this one.</p>
        <Field label="Current password"><input className="ab-input" type="password" value={pw.currentPassword} onChange={e => setPw(v => ({ ...v, currentPassword: e.target.value }))} /></Field>
        <Field label="New password"><input className="ab-input" type="password" value={pw.newPassword} onChange={e => setPw(v => ({ ...v, newPassword: e.target.value }))} /></Field>
        <Button loading={busy} onClick={() => run(() => api.post('/api/saas/auth/change-password', pw), async () => { toast('Password changed. Please sign in again.'); await signOut(); window.location.assign('/login'); })}>Change password</Button>
        <div className="ab-divider" />
        <div className="ab-card-title">Session</div>
        <p className="ab-form-note">Signed in as {user?.email}. Role: {user?.role}. User ID: <span className="ab-mono">{user?.id}</span></p>
      </Card>
    </div>
  </>;
}

export function DashboardDocsPage() { return <><PageHead title="Documentation" sub="Everything you need to call the API." /><DocsPage /></>; }
export function DashboardSupportPage() { return <><PageHead title="Support" sub="We're here to help." /><ContactPage /></>; }
