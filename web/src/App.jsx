import { useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Landing } from './screens/Landing'
import { Home } from './screens/Home'
import { Playbook } from './screens/Playbook'
import { Create } from './screens/Create'
import { Orders } from './screens/Orders'
import { Catalog } from './screens/Catalog'
import { loadSession, saveSession } from './session'

export default function App() {
  const [session, setSession] = useState(loadSession)
  const update = (s) => { saveSession(s); setSession(s) }

  if (!session) return <Landing onConnected={update} />

  return (
    <BrowserRouter>
      <Routes>
        {/* key: switching page or demo/real remounts the shell and its polling */}
        <Route element={<Shell key={session.page.id} session={session} onDisconnect={() => update(null)} />}>
          <Route index element={<Home />} />
          <Route path="playbook" element={<Playbook />} />
          <Route path="create" element={<Create />} />
          <Route path="orders" element={<Orders />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
