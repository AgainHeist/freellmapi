import { type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { SaasAuthProvider, SaasToastProvider, useSaasAuth } from './state';
import { AuthPage } from './pages/Auth';
import { ContactPage, DocsPage, FeaturesPage, HomePage, LegalPage, ModelsPage, PricingPage, PublicLayout } from './pages/Public';
import {
  AccountPage, ApiKeysPage, BillingPage, CatalogPage, DashboardDocsPage, DashboardLayout,
  DashboardSupportPage, OverviewPage, ProviderKeysPage, RoutingPage, UsagePage,
} from './pages/Dashboard';
import { PlaygroundPage } from './pages/Playground';
import { AdminPage } from './pages/Admin';
import { Loading } from './ui';

function PublicShell() {
  return <PublicLayout><Outlet /></PublicLayout>;
}

function Protected({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useSaasAuth();
  const location = useLocation();
  if (loading) return <div className="ab-root" style={{ padding: 80 }}><Loading label="Checking your session…" /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function NotFound() {
  return <div className="ab-section ab-container" style={{ textAlign: 'center', paddingBottom: 120 }}>
    <div className="ab-eyebrow" style={{ justifyContent: 'center' }}>404</div>
    <h1 className="ab-h1">Page not found</h1>
    <p className="ab-lead" style={{ margin: '16px auto 24px' }}>That route does not exist in the ALI-BOSS platform.</p>
    <Link to="/" className="ab-btn ab-btn-primary">Back to home</Link>
  </div>;
}

function AppRoutes() {
  return <Routes>
    <Route element={<PublicShell />}>
      <Route path="/" element={<HomePage />} />
      <Route path="/features" element={<FeaturesPage />} />
      <Route path="/models" element={<ModelsPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/contact" element={<ContactPage />} />
      <Route path="/terms" element={<LegalPage kind="terms" />} />
      <Route path="/privacy" element={<LegalPage kind="privacy" />} />
      <Route path="/refund" element={<LegalPage kind="refund" />} />
      <Route path="/login" element={<AuthPage kind="login" />} />
      <Route path="/signup" element={<AuthPage kind="signup" />} />
      <Route path="/forgot-password" element={<AuthPage kind="forgot" />} />
      <Route path="/reset-password" element={<AuthPage kind="reset" />} />
      <Route path="/verify-email" element={<AuthPage kind="verify" />} />
      <Route path="*" element={<NotFound />} />
    </Route>

    <Route path="/dashboard" element={<Protected><DashboardLayout /></Protected>}>
      <Route index element={<OverviewPage />} />
      <Route path="playground" element={<PlaygroundPage />} />
      <Route path="api-keys" element={<ApiKeysPage />} />
      <Route path="provider-keys" element={<ProviderKeysPage />} />
      <Route path="models" element={<CatalogPage />} />
      <Route path="routing" element={<RoutingPage />} />
      <Route path="fallback" element={<RoutingPage />} />
      <Route path="usage" element={<UsagePage />} />
      <Route path="analytics" element={<UsagePage analytics />} />
      <Route path="billing" element={<BillingPage />} />
      <Route path="subscription" element={<BillingPage subscriptionOnly />} />
      <Route path="docs" element={<DashboardDocsPage />} />
      <Route path="account" element={<AccountPage />} />
      <Route path="support" element={<DashboardSupportPage />} />
    </Route>

    <Route path="/admin" element={<Protected admin><AdminPage /></Protected>} />
  </Routes>;
}

export default function SaasApp() {
  return (
    <SaasAuthProvider>
      <SaasToastProvider>
        <div className="ab-root">
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </div>
      </SaasToastProvider>
    </SaasAuthProvider>
  );
}
