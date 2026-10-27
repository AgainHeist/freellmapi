import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, compact, money } from '../api';
import { useSaasAuth } from '../state';
import { Badge, Button, Card, Empty, Loading, SectionHead, Table } from '../ui';

const NAV = [
  { to: '/features', label: 'Features' },
  { to: '/models', label: 'Models' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/docs', label: 'Docs' },
  { to: '/contact', label: 'Contact' },
];

export function PublicLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user, signOut } = useSaasAuth();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => { setOpen(false); }, [location.pathname]);

  return (
    <div className="ab-root">
      <nav className="ab-nav">
        <div className="ab-container ab-nav-inner">
          <Link to="/" className="ab-brand">
            <span className="ab-brand-mark">A</span>
            ALI-BOSS <span className="ab-brand-sub">AI API</span>
          </Link>
          <div className="ab-nav-links">
            {NAV.map(n => <NavLink key={n.to} to={n.to} className={({ isActive }) => isActive ? 'active' : ''}>{n.label}</NavLink>)}
          </div>
          <div className="ab-nav-actions">
            {user ? (
              <>
                <Link to="/dashboard" className="ab-btn ab-btn-sm">Dashboard</Link>
                <Button size="sm" variant="ghost" onClick={async () => { await signOut(); navigate('/'); }}>Log out</Button>
              </>
            ) : (
              <>
                <Link to="/login" className="ab-btn ab-btn-ghost ab-btn-sm">Login</Link>
                <Link to="/signup" className="ab-btn ab-btn-primary ab-btn-sm">Get Started</Link>
              </>
            )}
            <button className="ab-mobile-toggle" aria-label="Menu" onClick={() => setOpen(v => !v)}>☰</button>
          </div>
        </div>
        {open && (
          <div className="ab-mobile-menu">
            {NAV.map(n => <Link key={n.to} to={n.to}>{n.label}</Link>)}
            {!user && <><Link to="/login">Login</Link><Link to="/signup">Sign up</Link></>}
            {user && <Link to="/dashboard">Dashboard</Link>}
          </div>
        )}
      </nav>
      <main>{children}</main>
      <footer className="ab-footer">
        <div className="ab-container ab-footer-inner">
          <div>
            <div className="ab-brand" style={{ marginBottom: 8 }}><span className="ab-brand-mark">A</span> ALI-BOSS</div>
            <div>Powering your AI products with one OpenAI-compatible endpoint.</div>
          </div>
          <div className="ab-row" style={{ gap: 16 }}>
            <Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link>
            <Link to="/refund">Refund</Link>
            <a href="https://t.me/alionera" target="_blank" rel="noreferrer">Telegram @alionera</a>
          </div>
        </div>
        <div className="ab-container" style={{ marginTop: 18, fontSize: 12, opacity: .7 }}>
          © {new Date().getFullYear()} ALI-BOSS · Admin: ALi-JDHD · Built on the FreeLLMAPI router engine.
        </div>
      </footer>
    </div>
  );
}

export function HomePage() {
  const { user } = useSaasAuth();
  const [models, setModels] = useState<any[]>([]);
  useEffect(() => { api.get('/api/saas/models?limit=8').then(r => setModels(r.models ?? [])).catch(() => {}); }, []);
  return (
    <>
      <section className="ab-hero ab-container">
        <div className="ab-eyebrow" style={{ justifyContent: 'center' }}>One API · Every model · Zero lock-in</div>
        <h1 className="ab-h1">
          Ship AI products on<br /><span className="ab-gradient">one powerful API.</span>
        </h1>
        <p className="ab-lead" style={{ margin: '20px auto 0' }}>
          ALI-BOSS gives every developer a production-grade, OpenAI-compatible AI gateway:
          multi-provider routing, automatic fallback, streaming, tool calling and real-time usage analytics — with your own API keys and hard quotas.
        </p>
        <div className="ab-hero-actions">
          <Link to={user ? '/dashboard' : '/signup'} className="ab-btn ab-btn-primary">{user ? 'Open Dashboard' : 'Get Started'}</Link>
          <Link to="/pricing" className="ab-btn">View Pricing</Link>
          <Link to="/docs" className="ab-btn ab-btn-ghost">Read Docs</Link>
        </div>
        <div className="ab-hero-stats">
          {[
            ['635+', 'Free model endpoints'],
            ['34', 'AI providers'],
            ['5', 'Compatible API surfaces'],
            ['99.9%', 'Gateway uptime target'],
          ].map(([v, l]) => <div className="ab-stat" key={l}><div className="ab-stat-value">{v}</div><div className="ab-stat-label">{l}</div></div>)}
        </div>
        <div className="ab-terminal">
          <div className="ab-terminal-bar"><span className="ab-dot" /><span className="ab-dot" /><span className="ab-dot" /><span className="ab-mono" style={{ marginLeft: 8, color: '#777' }}>quickstart.sh</span></div>
          <pre><span className="ab-k">curl</span> -X POST https://yourdomain.com/v1/chat/completions \
  -H <span className="ab-s">"Authorization: Bearer ALI-BOSS-..."</span> \
  -H <span className="ab-s">"Content-Type: application/json"</span> \
  -d '{`{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello!"}],"stream":true}`}'
          </pre>
        </div>
      </section>

      <section className="ab-section ab-container">
        <SectionHead eyebrow="Built for builders" title="Everything you need to run AI in production" sub="The original FreeLLMAPI routing engine, wrapped in a multi-tenant SaaS layer with billing, quotas and analytics." />
        <div className="ab-grid ab-grid-3">
          {[
            ['Multi-provider routing', '34 providers and 635+ endpoints behind one /v1 API. Automatic failover when a provider rate-limits you.'],
            ['Streaming + tools', 'SSE streaming, function calling, vision, embeddings, images and audio — the full OpenAI-compatible surface.'],
            ['Hard quota enforcement', 'Plan-based requests/day, tokens/month, RPM and TPM. Verified before a request ever reaches a provider.'],
            ['Your keys, isolated', 'Per-tenant API keys (hashed) and provider keys (AES-256-GCM encrypted). No cross-tenant reads.'],
            ['Payments built in', 'Gateway-verified checkout, signed webhooks, idempotent subscription activation and refunds.'],
            ['Real analytics', 'Requests, tokens, errors, latency, per-model and per-provider breakdowns with daily charts.'],
          ].map(([t, d]) => (
            <Card key={t} hover><div style={{ fontSize: 22, marginBottom: 12, color: 'var(--ab-red-soft)' }}>◆</div><div className="ab-card-title">{t}</div><div className="ab-card-sub">{d}</div></Card>
          ))}
        </div>
      </section>

      <section className="ab-section ab-container">
        <SectionHead eyebrow="Live catalog" title="Models available right now" sub="Dynamically read from the router's model catalog, not a static marketing list." />
        <div className="ab-table-wrap">
          <table className="ab-table"><thead><tr><th>Model</th><th>Provider</th><th>Context</th><th>Status</th></tr></thead>
            <tbody>{models.map(m => <tr key={`${m.provider}-${m.id}`}><td className="ab-mono">{m.id}</td><td>{m.provider}</td><td>{m.context?.toLocaleString() ?? '—'}</td><td><Badge tone="green">available</Badge></td></tr>)}</tbody>
          </table>
        </div>
        <div style={{ textAlign: 'center', marginTop: 20 }}><Link to="/models" className="ab-btn">Browse all models</Link></div>
      </section>

      <section className="ab-section ab-container">
        <Card className="ab-card-hover" >
          <div className="ab-grid ab-grid-2" style={{ alignItems: 'center' }}>
            <div><div className="ab-eyebrow">Start free</div><h2 className="ab-h2">Your first 1,000 requests are on us.</h2><p className="ab-lead" style={{ marginTop: 12 }}>No credit card. Create an account, generate an API key, and send your first request in under two minutes.</p></div>
            <div className="ab-row" style={{ justifyContent: 'flex-end' }}><Link to="/signup" className="ab-btn ab-btn-primary">Create free account</Link><Link to="/pricing" className="ab-btn">See plans</Link></div>
          </div>
        </Card>
      </section>
    </>
  );
}

export function FeaturesPage() {
  const groups: [string, string[]][] = [
    ['API compatibility', ['/v1/chat/completions (OpenAI)', '/v1/responses (Responses API)', '/v1/messages (Anthropic)', '/v1/embeddings', 'GET /v1/models', 'Native Gemini /v1beta']],
    ['Reliability', ['Automatic provider fallback', 'Rate-limit aware routing', 'Streaming preserved byte-for-byte', 'Tool-call rescue', 'Request retries and cooldowns', 'Per-key quota tracking']],
    ['SaaS control plane', ['Multi-tenant isolation', 'Hashed personal API keys', 'Encrypted provider keys', 'Plan quotas + rate limits', 'Usage analytics', 'Admin panel + audit logs']],
    ['Billing', ['Admin-configurable plans', 'Gateway-verified checkout', 'Signed webhooks + replay protection', 'Idempotent activation', 'Refunds + invoices', 'Revenue reporting']],
  ];
  return <div className="ab-section ab-container"><SectionHead eyebrow="Features" title="One shell, the full FreeLLMAPI engine" sub="We did not rewrite the router. We added authentication, tenancy, billing and quotas around it." />
    <div className="ab-grid ab-grid-2">{groups.map(([title, items]) => <Card key={title}><div className="ab-card-title" style={{ fontSize: 17, marginBottom: 14 }}>{title}</div><ul className="ab-feature-list" style={{ margin: 0 }}>{items.map(i => <li key={i}>{i}</li>)}</ul></Card>)}</div></div>;
}

export function ModelsPage() {
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.get('/api/saas/models?limit=300').then(setData).catch(() => setData({ models: [] })); }, []);
  const models = (data?.models ?? []).filter((m: any) => `${m.id} ${m.provider}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="ab-section ab-container">
      <SectionHead eyebrow="Model catalog" title="Every model your plan can reach" sub="Live from the router. Availability depends on the provider keys configured in your workspace." />
      <input className="ab-input" placeholder="Search models or providers…" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 16, maxWidth: 420 }} />
      {!data ? <Loading /> : models.length === 0 ? <Empty>No models match that search.</Empty> : (
        <Table head={['Model', 'Provider', 'Context', 'Capabilities', 'Status']}>
          {models.map((m: any) => (
            <tr key={`${m.provider}-${m.id}`}>
              <td className="ab-mono">{m.id}</td><td>{m.provider}</td><td>{m.context ? compact(m.context) : '—'}</td>
              <td className="ab-pill-row">{m.capabilities?.vision && <Badge>vision</Badge>}{m.capabilities?.tools && <Badge>tools</Badge>}</td>
              <td><Badge tone="green">{m.status}</Badge></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

export function PricingPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const { user } = useSaasAuth();
  useEffect(() => { api.get('/api/saas/plans').then(r => setPlans(r.plans ?? [])).catch(() => {}); }, []);
  return (
    <div className="ab-section ab-container">
      <SectionHead eyebrow="Pricing" title="Simple plans that scale with you" sub="Prices are managed by the admin panel — this page always shows the live values." />
      <div className="ab-grid ab-grid-4">
        {plans.map((p, i) => (
          <Card key={p.id} className={`ab-plan ${i === 2 ? 'ab-plan-popular' : ''}`}>
            {i === 2 && <span className="ab-badge ab-badge-red ab-plan-tag">MOST POPULAR</span>}
            <div className="ab-card-title" style={{ fontSize: 18 }}>{p.name}</div>
            <div className="ab-price" style={{ marginTop: 10 }}>{money(p.priceMinor, p.currency)}<span> / {p.billingCycleDays} days</span></div>
            <ul className="ab-feature-list">
              {(p.features ?? []).map((f: string) => <li key={f}>{f}</li>)}
              <li>{compact(p.limits?.requestsPerDay ?? 0)} requests/day</li>
              <li>{compact(p.limits?.requestsPerMinute ?? 0)} RPM</li>
              <li>{p.limits?.streaming ? 'Streaming included' : 'No streaming'}</li>
            </ul>
            <Button variant={i === 2 ? 'primary' : 'default'} className="ab-btn-block" onClick={() => window.location.assign(user ? `/dashboard/billing?plan=${p.slug}` : `/signup?next=${encodeURIComponent(`/dashboard/billing?plan=${p.slug}`)}`)}>
              {p.priceMinor === 0 ? 'Start free' : 'Choose Plan'}
            </Button>
          </Card>
        ))}
      </div>
      <p className="ab-form-note" style={{ textAlign: 'center', marginTop: 24 }}>All prices in INR. Subscriptions activate only after a backend-verified payment. See our <Link to="/refund" style={{ color: 'var(--ab-red-soft)' }}>refund policy</Link>.</p>
    </div>
  );
}

const DOC_TABS = ['curl', 'javascript', 'python', 'php'] as const;

export function DocsPage() {
  const [docs, setDocs] = useState<any>(null);
  const [tab, setTab] = useState<(typeof DOC_TABS)[number]>('curl');
  useEffect(() => { api.get('/api/saas/docs').then(setDocs).catch(() => {}); }, []);
  return (
    <div className="ab-section ab-container" style={{ maxWidth: 900 }}>
      <SectionHead eyebrow="Documentation" title="Quick start" sub="Point any OpenAI-compatible SDK at your ALI-BOSS endpoint." />
      {!docs ? <Loading /> : <>
        <Card>
          <div className="ab-card-title">1. Create an API key</div>
          <p className="ab-card-sub">Sign up, open the dashboard → API Keys → Create. Copy the key immediately; it is shown only once.</p>
          <div className="ab-divider" />
          <div className="ab-card-title">2. Authenticate</div>
          <pre className="ab-code">{docs.auth}</pre>
          <div className="ab-divider" />
          <div className="ab-card-title">3. Send a request</div>
          <div className="ab-tabs" style={{ marginTop: 10 }}>{DOC_TABS.map(t => <button key={t} className={`ab-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>)}</div>
          <pre className="ab-code">{docs.examples?.[tab]}</pre>
        </Card>
        <Card style={{ marginTop: 16 }}>
          <div className="ab-card-title">Endpoints</div>
          <Table head={['Method', 'Path', 'Description']}>{docs.endpoints.map((e: any) => <tr key={e.path}><td><Badge tone="red">{e.method}</Badge></td><td className="ab-mono">{e.path}</td><td className="ab-muted">{e.description}</td></tr>)}</Table>
        </Card>
        <Card style={{ marginTop: 16 }}>
          <div className="ab-card-title">Errors & limits</div>
          <p className="ab-card-sub">Consistent JSON errors: <span className="ab-mono">{'{ "error": { "message", "type", "code" } }'}</span></p>
          <div style={{ marginTop: 12 }}>{Object.entries(docs.errors).map(([code, text]) => <div className="ab-kv" key={code}><span>{code}</span><span>{text as string}</span></div>)}</div>
        </Card>
      </>}
    </div>
  );
}

export function ContactPage() {
  return (
    <div className="ab-section ab-container" style={{ maxWidth: 720 }}>
      <SectionHead eyebrow="Support" title="Talk to a human" sub="Questions about plans, provider keys or your account? Reach out directly." />
      <Card>
        <div className="ab-card-title">Telegram</div>
        <p className="ab-card-sub">Fastest response. Admin: ALi-JDHD.</p>
        <a href="https://t.me/alionera" target="_blank" rel="noreferrer" className="ab-btn ab-btn-primary" style={{ marginTop: 14 }}>@alionera</a>
        <div className="ab-divider" />
        <div className="ab-card-title">Before you write</div>
        <p className="ab-card-sub">Include your account email, the endpoint you called, the request ID from the <span className="ab-mono">X-ALI-BOSS-Request-ID</span> header, and the error code you received. Never send your API key or provider keys.</p>
      </Card>
    </div>
  );
}

const LEGAL: Record<string, { title: string; body: string[] }> = {
  terms: { title: 'Terms of Service', body: [
    'By creating an ALI-BOSS account you agree to use the service lawfully and not to attempt to access another tenant’s data, keys, usage or billing records.',
    'API quotas are enforced per plan. We may suspend accounts that abuse providers, circumvent rate limits, or use the service for illegal content generation.',
    'The service is provided “as is”. Model availability depends on upstream providers and may change without notice. Streaming, tool calling and model behavior are provided by those upstream systems.',
    'Subscriptions are activated only after a cryptographically verified payment event from the payment gateway. A successful browser message alone never activates a plan.',
  ] },
  privacy: { title: 'Privacy Policy', body: [
    'We store your name, email (normalized), password hash, workspace settings, subscription and payment records. Passwords are hashed with scrypt; raw passwords are never stored.',
    'Personal API keys are stored as SHA-256 hashes with an encrypted copy for explicit reveal. Provider keys are encrypted at rest with AES-256-GCM and never returned in full by any API response.',
    'Tenant isolation: every database query is scoped to the tenant resolved from your authenticated session or API key. A tenant_id supplied in a request body is never trusted.',
    'Usage records store endpoint, model, provider, token counts, latency and error codes for analytics and quota enforcement. Request prompts are not stored by the SaaS layer.',
  ] },
  refund: { title: 'Refund Policy', body: [
    'If a payment was charged but your subscription did not activate after a verified webhook, contact @alionera with the payment ID and we will investigate and refund where appropriate.',
    'Refunds are processed against verified payment records only. Once refunded, the linked paid subscription is cancelled and the workspace returns to the FREE plan.',
    'Duplicate webhook events and duplicate checkout attempts are deduplicated server-side; you are never charged twice for a single order.',
  ] },
};

export function LegalPage({ kind }: { kind: 'terms' | 'privacy' | 'refund' }) {
  const doc = LEGAL[kind];
  return (
    <div className="ab-section ab-container" style={{ maxWidth: 760 }}>
      <SectionHead eyebrow="Legal" title={doc.title} sub={`Last updated ${new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`} />
      <Card>{doc.body.map((p, i) => <p key={i} className="ab-card-sub" style={{ marginBottom: 14 }}>{p}</p>)}</Card>
    </div>
  );
}
