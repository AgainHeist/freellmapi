import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, compact, dateTime, money } from '../api';
import { useAction, useData } from '../hooks';
import { errText, useSaasAuth, useToast } from '../state';
import { Badge, BarChart, Button, Card, Empty, ErrorNote, Field, Loading, Modal, Stat, Table } from '../ui';

const TABS = ['dashboard', 'users', 'plans', 'subscriptions', 'payments', 'revenue', 'webhooks', 'audit', 'emails', 'system'] as const;
type Tab = typeof TABS[number];

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const { user, signOut } = useSaasAuth();
  const navigate = useNavigate();
  return (
    <div className="ab-root">
      <nav className="ab-nav"><div className="ab-container ab-nav-inner">
        <Link to="/" className="ab-brand"><span className="ab-brand-mark">A</span> ALI-BOSS <span className="ab-brand-sub">ADMIN · ALi-JDHD</span></Link>
        <div className="ab-nav-actions">
          <Link to="/dashboard" className="ab-btn ab-btn-ghost ab-btn-sm">Customer dashboard</Link>
          <Button size="sm" variant="ghost" onClick={async () => { await signOut(); navigate('/login'); }}>Log out</Button>
        </div>
      </div></nav>
      <div className="ab-container" style={{ paddingTop: 28, paddingBottom: 60 }}>
        <div className="ab-page-head"><div><div className="ab-page-title">Admin panel</div><div className="ab-page-sub">Signed in as {user?.email}. Every mutation is written to the audit log.</div></div></div>
        <div className="ab-tabs">{TABS.map(t => <button key={t} className={`ab-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>)}</div>
        {tab === 'dashboard' && <AdminDashboard />}
        {tab === 'users' && <UsersTab />}
        {tab === 'plans' && <PlansTab />}
        {tab === 'subscriptions' && <SubscriptionsTab />}
        {tab === 'payments' && <PaymentsTab />}
        {tab === 'revenue' && <RevenueTab />}
        {tab === 'webhooks' && <WebhooksTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'emails' && <EmailsTab />}
        {tab === 'system' && <SystemTab />}
      </div>
    </div>
  );
}

function AdminDashboard() {
  const { data, loading, error } = useData<any>('/api/saas/admin/stats');
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  const s = data!;
  return <>
    <div className="ab-grid ab-grid-4">
      <Stat label="TOTAL USERS" value={compact(s.totalUsers)} /><Stat label="ACTIVE SUBSCRIPTIONS" value={compact(s.activeSubscriptions)} />
      <Stat label="MONTHLY REVENUE" value={money(s.monthlyRevenueMinor)} /><Stat label="TOTAL REVENUE" value={money(s.totalRevenueMinor)} />
      <Stat label="API REQUESTS" value={compact(s.apiRequests)} /><Stat label="TOKENS USED" value={compact(s.tokensUsed)} />
      <Stat label="FAILED REQUESTS" value={compact(s.failedRequests)} /><Stat label="SUCCESSFUL PAYMENTS" value={compact(s.successfulPayments)} />
    </div>
    <Card style={{ marginTop: 16 }}><div className="ab-card-title">System health</div><p className="ab-card-sub">Revenue figures are computed from verified (paid) payment records only. Pending and failed payments never count.</p></Card>
  </>;
}

function UsersTab() {
  const [search, setSearch] = useState('');
  const { data, loading, reload } = useData<any>(`/api/saas/admin/users?search=${encodeURIComponent(search)}`, [search]);
  const [selected, setSelected] = useState<any>(null);
  const [days, setDays] = useState(30);
  const [planId, setPlanId] = useState('');
  const plans = useData<any>('/api/saas/admin/plans');
  const { busy, error, run } = useAction();
  const toast = useToast();
  const act = (path: string, msg: string) => run(() => api.post(path, path.includes('/extend') ? { days } : path.includes('/plan') ? { planId } : {}), () => { toast(msg); reload(); setSelected(null); });
  return <>
    <div className="ab-row" style={{ marginBottom: 14 }}><input className="ab-input" style={{ maxWidth: 320 }} placeholder="Search email or name…" value={search} onChange={e => setSearch(e.target.value)} /><Button onClick={() => reload()}>Search</Button></div>
    <ErrorNote message={error} />
    {loading ? <Loading /> : !data?.users?.length ? <Empty>No users.</Empty> : <Table head={['Email', 'Name', 'Role', 'Status', 'Plan', 'Created', 'Actions']}>
      {data.users.map((u: any) => <tr key={u.id}>
        <td className="ab-mono">{u.email}</td><td>{u.name}</td><td><Badge tone={u.role === 'admin' ? 'red' : ''}>{u.role}</Badge></td>
        <td><Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge></td><td>{u.subscription?.plan?.name ?? '—'}</td><td>{dateTime(u.createdAt)}</td>
        <td><Button size="sm" onClick={() => { setSelected(u); setPlanId(u.subscription?.plan?.id ?? ''); }}>Manage</Button></td>
      </tr>)}
    </Table>}
    {selected && <Modal title={`Manage ${selected.email}`} onClose={() => setSelected(null)}>
      <div className="ab-kv"><span>Status</span><span>{selected.status}</span></div>
      <div className="ab-kv"><span>Current plan</span><span>{selected.subscription?.plan?.name ?? '—'}</span></div>
      <div className="ab-kv"><span>Tenant</span><span className="ab-mono">{selected.tenantId.slice(0, 18)}…</span></div>
      <div className="ab-divider" />
      <Field label="Change plan"><select className="ab-select" value={planId} onChange={e => setPlanId(e.target.value)}>{(plans.data?.plans ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name} · {money(p.priceMinor, p.currency)}</option>)}</select></Field>
      <Button size="sm" loading={busy} onClick={() => act(`/api/saas/admin/users/${selected.id}/plan`, 'Plan changed.')}>Apply plan</Button>
      <div className="ab-divider" />
      <Field label="Extend subscription (days)"><input className="ab-input" type="number" value={days} onChange={e => setDays(Number(e.target.value))} /></Field>
      <Button size="sm" loading={busy} onClick={() => act(`/api/saas/admin/users/${selected.id}/extend`, 'Subscription extended.')}>Extend</Button>
      <div className="ab-divider" />
      <div className="ab-row">
        {selected.status === 'active'
          ? <Button size="sm" variant="danger" loading={busy} onClick={() => act(`/api/saas/admin/users/${selected.id}/suspend`, 'User suspended.')}>Suspend</Button>
          : <Button size="sm" loading={busy} onClick={() => act(`/api/saas/admin/users/${selected.id}/unsuspend`, 'User unsuspended.')}>Unsuspend</Button>}
        <Button size="sm" variant="danger" loading={busy} onClick={() => act(`/api/saas/admin/users/${selected.id}/cancel`, 'Subscription cancelled.')}>Cancel sub</Button>
        <Button size="sm" loading={busy} onClick={() => act(`/api/saas/admin/users/${selected.id}/reset-api-access`, 'API keys revoked.')}>Reset API access</Button>
      </div>
    </Modal>}
  </>;
}

function PlansTab() {
  const { data, loading, reload } = useData<any>('/api/saas/admin/plans');
  const [edit, setEdit] = useState<any>(null);
  const [create, setCreate] = useState(false);
  const [form, setForm] = useState<any>({});
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(
    () => create ? api.post('/api/saas/admin/plans', form) : api.patch(`/api/saas/admin/plans/${edit.id}`, form),
    () => { toast('Plan saved.'); setEdit(null); setCreate(false); reload(); },
  );
  return <>
    <div className="ab-row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}><Button variant="primary" onClick={() => { setForm({ slug: '', name: '', priceMinor: 0, billingCycleDays: 30, features: [], limits: {} }); setCreate(true); }}>New plan</Button></div>
    {loading ? <Loading /> : <Table head={['Name', 'Slug', 'Price', 'Cycle', 'Limits', 'Active', '']}>
      {data.plans.map((p: any) => <tr key={p.id}>
        <td>{p.name}</td><td className="ab-mono">{p.slug}</td><td>{money(p.priceMinor, p.currency)}</td><td>{p.billingCycleDays}d</td>
        <td className="ab-mono" style={{ fontSize: 11 }}>{compact(p.limits.requestsPerDay)} req/d · {compact(p.limits.tokensPerMonth)} tok/m</td>
        <td><Badge tone={p.isActive ? 'green' : ''}>{p.isActive ? 'yes' : 'no'}</Badge></td>
        <td><Button size="sm" onClick={() => { setCreate(false); setEdit(p); setForm({ priceMinor: p.priceMinor, features: p.features, limits: p.limits, isActive: p.isActive }); }}>Edit</Button></td>
      </tr>)}
    </Table>}
    {(edit || create) && <Modal title={create ? 'New plan' : `Edit ${edit.name}`} onClose={() => { setEdit(null); setCreate(false); }} footer={<><Button variant="ghost" onClick={() => { setEdit(null); setCreate(false); }}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save plan</Button></>}>
      {create && <><Field label="Slug"><input className="ab-input" value={form.slug ?? ''} onChange={e => setForm((v: any) => ({ ...v, slug: e.target.value }))} placeholder="pro-plus" /></Field><Field label="Name"><input className="ab-input" value={form.name ?? ''} onChange={e => setForm((v: any) => ({ ...v, name: e.target.value }))} /></Field></>}
      <Field label="Price (minor units, e.g. 79900 = ₹799)"><input className="ab-input" type="number" value={form.priceMinor ?? 0} onChange={e => setForm((v: any) => ({ ...v, priceMinor: Number(e.target.value) }))} /></Field>
      <Field label="Billing cycle (days)"><input className="ab-input" type="number" value={form.billingCycleDays ?? 30} onChange={e => setForm((v: any) => ({ ...v, billingCycleDays: Number(e.target.value) }))} /></Field>
      <Field label="Requests / day"><input className="ab-input" type="number" value={form.limits?.requestsPerDay ?? 1000} onChange={e => setForm((v: any) => ({ ...v, limits: { ...v.limits, requestsPerDay: Number(e.target.value) } }))} /></Field>
      <Field label="Requests / minute"><input className="ab-input" type="number" value={form.limits?.requestsPerMinute ?? 20} onChange={e => setForm((v: any) => ({ ...v, limits: { ...v.limits, requestsPerMinute: Number(e.target.value) } }))} /></Field>
      <Field label="Tokens / month"><input className="ab-input" type="number" value={form.limits?.tokensPerMonth ?? 10000000} onChange={e => setForm((v: any) => ({ ...v, limits: { ...v.limits, tokensPerMonth: Number(e.target.value) } }))} /></Field>
      <label className="ab-row" style={{ fontSize: 13, gap: 8 }}><input type="checkbox" checked={Boolean(form.limits?.streaming)} onChange={e => setForm((v: any) => ({ ...v, limits: { ...v.limits, streaming: e.target.checked } }))} /> Streaming</label>
      <label className="ab-row" style={{ fontSize: 13, gap: 8, marginTop: 8 }}><input type="checkbox" checked={Boolean(form.limits?.embeddings)} onChange={e => setForm((v: any) => ({ ...v, limits: { ...v.limits, embeddings: e.target.checked } }))} /> Embeddings</label>
      <ErrorNote message={error} />
    </Modal>}
  </>;
}

function SubscriptionsTab() {
  const { data, loading } = useData<any>('/api/saas/admin/subscriptions');
  if (loading) return <Loading />;
  return <Table head={['Email', 'Plan', 'Status', 'Start', 'End', 'Payment']}>
    {data.subscriptions.map((s: any) => <tr key={s.id}>
      <td className="ab-mono">{s.email}</td><td>{s.plan_name}</td><td><Badge tone={s.status === 'active' ? 'green' : s.status === 'expired' ? 'amber' : ''}>{s.status}</Badge></td>
      <td>{dateTime(s.start_at)}</td><td>{dateTime(s.end_at)}</td><td className="ab-mono">{s.payment_id ?? '—'}</td>
    </tr>)}
  </Table>;
}

function PaymentsTab() {
  const [status, setStatus] = useState('');
  const { data, loading, reload } = useData<any>(`/api/saas/admin/payments${status ? `?status=${status}` : ''}`, [status]);
  const { busy, error, run } = useAction();
  const toast = useToast();
  return <>
    <div className="ab-row" style={{ marginBottom: 14 }}><select className="ab-select" style={{ maxWidth: 200 }} value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{['pending', 'paid', 'failed', 'refunded', 'cancelled'].map(s => <option key={s} value={s}>{s}</option>)}</select><Button onClick={() => reload()}>Refresh</Button></div>
    <ErrorNote message={error} />
    {loading ? <Loading /> : !data?.payments?.length ? <Empty>No payments.</Empty> : <Table head={['Date', 'Order', 'Amount', 'Status', 'Gateway', 'Verified', 'Action']}>
      {data.payments.map((p: any) => <tr key={p.id}>
        <td>{dateTime(p.createdAt)}</td><td className="ab-mono">{p.orderId.slice(0, 20)}</td><td>{money(p.amountMinor, p.currency)}</td>
        <td><Badge tone={p.status === 'paid' ? 'green' : p.status === 'refunded' ? 'amber' : p.status === 'failed' ? 'red' : ''}>{p.status}</Badge></td>
        <td>{p.gateway}</td><td>{p.verifiedAt ? dateTime(p.verifiedAt) : '—'}</td>
        <td>{p.status === 'paid' && <Button size="sm" variant="danger" loading={busy} onClick={() => run(() => api.post(`/api/saas/payments/${p.id}/refund`, { reason: 'admin panel' }), () => { toast('Refund processed.'); reload(); })}>Refund</Button>}</td>
      </tr>)}
    </Table>}
  </>;
}

function RevenueTab() {
  const { data, loading } = useData<any>('/api/saas/admin/revenue');
  if (loading) return <Loading />;
  return <>
    <div className="ab-grid ab-grid-4"><Stat label="TODAY" value={money(data.today)} /><Stat label="THIS WEEK" value={money(data.week)} /><Stat label="THIS MONTH" value={money(data.month)} /><Stat label="ALL TIME" value={money(data.total)} /></div>
    <Card style={{ marginTop: 16 }}><div className="ab-card-title">Daily verified revenue</div><BarChart data={(data.daily ?? []).map((d: any) => ({ day: d.day, requests: d.amount, tokens: d.amount })).reverse()} field="requests" /></Card>
  </>;
}

function WebhooksTab() {
  const { data, loading } = useData<any>('/api/saas/admin/webhooks');
  if (loading) return <Loading />;
  return !data?.events?.length ? <Empty>No webhook events yet.</Empty> : <Table head={['Received', 'Gateway', 'Event id', 'Type', 'Signature', 'Status', 'Error']}>
    {data.events.map((e: any) => <tr key={e.id}>
      <td>{dateTime(e.received_at)}</td><td>{e.gateway}</td><td className="ab-mono">{e.event_id.slice(0, 22)}</td><td>{e.event_type}</td>
      <td><Badge tone={e.signature_valid ? 'green' : 'red'}>{e.signature_valid ? 'valid' : 'invalid'}</Badge></td>
      <td><Badge tone={e.status === 'processed' ? 'green' : e.status === 'failed' ? 'red' : ''}>{e.status}</Badge></td><td className="ab-mono">{e.error ?? '—'}</td>
    </tr>)}
  </Table>;
}

function AuditTab() {
  const { data, loading } = useData<any>('/api/saas/admin/audit-logs');
  if (loading) return <Loading />;
  return !data?.logs?.length ? <Empty>No audit entries.</Empty> : <Table head={['Time', 'Actor', 'Role', 'Action', 'Target', 'IP']}>
    {data.logs.map((l: any) => <tr key={l.id}><td>{dateTime(l.created_at)}</td><td>{l.actor_email ?? 'system'}</td><td>{l.actor_role}</td><td className="ab-mono">{l.action}</td><td className="ab-mono">{l.target_id ?? '—'}</td><td>{l.ip ?? '—'}</td></tr>)}
  </Table>;
}

function EmailsTab() {
  const { data, loading, reload } = useData<any>('/api/saas/admin/email-outbox');
  const toast = useToast();
  const { busy, run } = useAction();
  if (loading) return <Loading />;
  return <>
    <div className="ab-row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}><Button loading={busy} onClick={() => run(() => api.post('/api/saas/admin/email-outbox/flush', {}), (r: any) => { toast(`Sent ${r.sent} email(s).`); reload(); })}>Flush queue</Button></div>
    {!data?.emails?.length ? <Empty>Outbox is empty.</Empty> : <Table head={['Created', 'To', 'Template', 'Status', 'Sent', 'Error']}>
      {data.emails.map((e: any) => <tr key={e.id}><td>{dateTime(e.created_at)}</td><td className="ab-mono">{e.to_email}</td><td>{e.template}</td><td><Badge tone={e.status === 'sent' ? 'green' : e.status === 'failed' ? 'red' : 'amber'}>{e.status}</Badge></td><td>{e.sent_at ? dateTime(e.sent_at) : '—'}</td><td>{e.error ?? '—'}</td></tr>)}
    </Table>}
    <p className="ab-form-note" style={{ marginTop: 12 }}>Set EMAIL_PROVIDER_KEY to enable delivery. Without it, mail stays queued here (useful for local development).</p>
  </>;
}

function SystemTab() {
  const { data, loading } = useData<any>('/api/saas/admin/system');
  if (loading) return <Loading />;
  return <Card style={{ maxWidth: 620 }}>
    <div className="ab-card-title">System settings</div>
    <div className="ab-kv"><span>Payment gateway</span><span>{data.gateway}</span></div>
    <div className="ab-kv"><span>Payment configured</span><span><Badge tone={data.paymentConfigured ? 'green' : 'red'}>{data.paymentConfigured ? 'yes' : 'no'}</Badge></span></div>
    <div className="ab-kv"><span>Email configured</span><span><Badge tone={data.emailConfigured ? 'green' : 'amber'}>{data.emailConfigured ? 'yes' : 'no'}</Badge></span></div>
    <div className="ab-kv"><span>Database</span><span>{data.database}</span></div>
    <div className="ab-kv"><span>Environment</span><span>{data.nodeEnv}</span></div>
    <div className="ab-kv"><span>Server time</span><span>{dateTime(data.serverTime)}</span></div>
    <p className="ab-form-note" style={{ marginTop: 14 }}>Secrets are never returned by this endpoint. Configure them as environment variables on the host — see .env.example and docs/SAAS.md.</p>
  </Card>;
}

export function AdminGuardFallback({ error }: { error: string }) {
  return <div className="ab-section ab-container"><ErrorNote message={error || 'Administrator access required.'} /><Link to="/login" className="ab-btn" style={{ marginTop: 12 }}>Back to login</Link></div>;
}

export function adminError(err: unknown): string { return errText(err); }
