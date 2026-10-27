import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSaasAuth, errText, useToast } from '../state';
import { Button, Card, ErrorNote, Field } from '../ui';

function AuthShell({ title, sub, children, footer }: { title: string; sub: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="ab-section ab-container" style={{ maxWidth: 460, paddingTop: 56 }}>
      <div style={{ textAlign: 'center', marginBottom: 22 }}>
        <div className="ab-eyebrow" style={{ justifyContent: 'center' }}>ALI-BOSS account</div>
        <h1 className="ab-h2">{title}</h1>
        <p className="ab-form-note" style={{ marginTop: 8 }}>{sub}</p>
      </div>
      <Card>{children}</Card>
      {footer && <div style={{ textAlign: 'center', marginTop: 18, fontSize: 13 }} className="ab-muted">{footer}</div>}
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { acceptToken } = useSaasAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const res = await api.post('/api/saas/auth/login', { email, password });
      acceptToken(res.token, res.user);
      toast('Signed in. Welcome back!');
      navigate(params.get('next') || '/dashboard', { replace: true });
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  return <AuthShell title="Welcome back" sub="Sign in to your workspace." footer={<>New here? <Link to="/signup" style={{ color: 'var(--ab-red-soft)' }}>Create an account</Link></>}>
    <form onSubmit={submit}>
      <Field label="Email"><input className="ab-input" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></Field>
      <Field label="Password"><input className="ab-input" type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" /></Field>
      <ErrorNote message={error} />
      <Button type="submit" variant="primary" className="ab-btn-block" loading={busy}>Login</Button>
      <div style={{ textAlign: 'right', marginTop: 12, fontSize: 12.5 }}><Link to="/forgot-password" className="ab-muted">Forgot password?</Link></div>
    </form>
  </AuthShell>;
}

export function SignupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { acceptToken } = useSaasAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '', referralCode: params.get('ref') ?? '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(v => ({ ...v, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const res = await api.post('/api/saas/auth/signup', form);
      acceptToken(res.token, res.user);
      toast('Account created. Your FREE plan is active.');
      navigate(params.get('next') || '/dashboard', { replace: true });
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  return <AuthShell title="Create your account" sub="Free plan included. No credit card required." footer={<>Already have an account? <Link to="/login" style={{ color: 'var(--ab-red-soft)' }}>Login</Link></>}>
    <form onSubmit={submit}>
      <Field label="Name"><input className="ab-input" required value={form.name} onChange={set('name')} placeholder="Your name" /></Field>
      <Field label="Email"><input className="ab-input" type="email" required value={form.email} onChange={set('email')} placeholder="you@example.com" /></Field>
      <Field label="Password" hint="At least 8 characters."><input className="ab-input" type="password" required minLength={8} value={form.password} onChange={set('password')} placeholder="••••••••" /></Field>
      <Field label="Confirm password"><input className="ab-input" type="password" required minLength={8} value={form.confirmPassword} onChange={set('confirmPassword')} placeholder="••••••••" /></Field>
      <Field label="Referral code (optional)"><input className="ab-input" value={form.referralCode} onChange={set('referralCode')} placeholder="e.g. A1B2C3" /></Field>
      <ErrorNote message={error} />
      <Button type="submit" variant="primary" className="ab-btn-block" loading={busy}>Get Started</Button>
      <p className="ab-form-note" style={{ marginTop: 12, textAlign: 'center' }}>By signing up you agree to our <Link to="/terms" style={{ color: 'var(--ab-red-soft)' }}>Terms</Link> and <Link to="/privacy" style={{ color: 'var(--ab-red-soft)' }}>Privacy Policy</Link>.</p>
    </form>
  </AuthShell>;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const res = await api.post('/api/saas/auth/forgot-password', { email });
      setDone(true);
      if (res.devToken) setDevLink(`/reset-password?token=${res.devToken}`);
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  return <AuthShell title="Reset your password" sub="We'll email you a one-hour reset link." footer={<Link to="/login" style={{ color: 'var(--ab-red-soft)' }}>Back to login</Link>}>
    {done ? <div><p className="ab-card-sub">If an account exists for that email, a reset link is on its way.</p>
      {devLink && <div style={{ marginTop: 14, padding: 12, border: '1px solid var(--ab-border)', borderRadius: 10 }}><div className="ab-form-note">Development mode — email delivery is queued in the outbox. Use this link:</div><Link to={devLink} className="ab-btn ab-btn-primary" style={{ marginTop: 10 }}>Open reset link</Link></div>}
    </div> : <form onSubmit={submit}><Field label="Email"><input className="ab-input" type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field><ErrorNote message={error} /><Button type="submit" variant="primary" className="ab-btn-block" loading={busy}>Send reset link</Button></form>}
  </AuthShell>;
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.post('/api/saas/auth/reset-password', { token: params.get('token') ?? '', password });
      toast('Password updated. Please sign in.');
      navigate('/login', { replace: true });
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  return <AuthShell title="Choose a new password" sub="All existing sessions will be signed out." footer={<Link to="/login" style={{ color: 'var(--ab-red-soft)' }}>Back to login</Link>}>
    <form onSubmit={submit}>
      <Field label="New password"><input className="ab-input" type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} /></Field>
      <Field label="Confirm new password"><input className="ab-input" type="password" required minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} /></Field>
      <ErrorNote message={error} />
      <Button type="submit" variant="primary" className="ab-btn-block" loading={busy}>Update password</Button>
    </form>
  </AuthShell>;
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [token, setToken] = useState(params.get('token') ?? '');
  const [busy, setBusy] = useState(false);
  const verify = async (e?: React.FormEvent) => {
    e?.preventDefault(); setBusy(true);
    try { await api.post('/api/saas/auth/verify-email', { token }); setStatus('ok'); }
    catch { setStatus('fail'); } finally { setBusy(false); }
  };
  return <AuthShell title="Verify your email" sub="Confirm your address to secure your account." footer={<Link to="/dashboard" style={{ color: 'var(--ab-red-soft)' }}>Go to dashboard</Link>}>
    {status === 'ok' ? <p className="ab-card-sub" style={{ color: 'var(--ab-green)' }}>Your email is verified.</p> : <>
      <form onSubmit={verify}><Field label="Verification token"><input className="ab-input" value={token} onChange={e => setToken(e.target.value)} placeholder="Paste the token from your email" /></Field>
        {status === 'fail' && <ErrorNote message="That link is invalid or has expired." />}
        <Button type="submit" variant="primary" className="ab-btn-block" loading={busy}>Verify email</Button></form>
    </>}
  </AuthShell>;
}

export function AuthPage(props: { kind: 'login' | 'signup' | 'forgot' | 'reset' | 'verify' }) {
  // PublicShell in SaasApp.tsx already supplies the nav/footer.
  return props.kind === 'login' ? <LoginPage /> : props.kind === 'signup' ? <SignupPage />
    : props.kind === 'forgot' ? <ForgotPasswordPage /> : props.kind === 'reset' ? <ResetPasswordPage />
    : <VerifyEmailPage />;
}
