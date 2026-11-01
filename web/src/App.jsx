import { useEffect, useState } from 'react'
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
  const [expired, setExpired] = useState(false)
  const update = (s) => { saveSession(s); setSession(s); setExpired(false) }

  // a request came back saying the login ran out: forget it and ask the owner to log in again
  useEffect(() => {
    const onExpired = () => { saveSession(null); setSession(null); setExpired(true) }
    window.addEventListener('pagesense:session-expired', onExpired)
    return () => window.removeEventListener('pagesense:session-expired', onExpired)
  }, [])

  if (!session) return <Landing onConnected={update} notice={expired ? 'Your Facebook login expired. Log in again to carry on: your page and everything we learned are saved.' : null} />

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
