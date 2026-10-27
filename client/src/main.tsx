import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './saas/saas.css'
import App from './App'
import SaasApp from './saas/SaasApp'

// ALI-BOSS is the public product. The original FreeLLMAPI operator console
// is preserved under /console with its own router basename (see App.tsx).
const isConsole = typeof window !== 'undefined'
  && (window.location.pathname === '/console' || window.location.pathname.startsWith('/console/'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isConsole ? <App /> : <SaasApp />}
  </StrictMode>,
)
