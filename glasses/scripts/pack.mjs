// npm run pack — builds the app and packs ginn.ehpk.
// GINN_SERVER_URL (e.g. your tunnel URL) is added to the network whitelist and used as the default server.
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const url = (process.env.GINN_SERVER_URL ?? '').replace(/\/+$/, '')
const manifest = JSON.parse(fs.readFileSync('app.json', 'utf8'))
if (url) {
  if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error(`GINN_SERVER_URL must be an origin like https://ginn.example.com, got ${url}`)
  const net = manifest.permissions.find(p => p.name === 'network')
  if (!net.whitelist.includes(url)) net.whitelist.push(url)
}
fs.writeFileSync('.app.pack.json', JSON.stringify(manifest, null, 2))
const env = { ...process.env, ...(url ? { VITE_GINN_SERVER: url } : {}) }
try {
  execSync('npx tsc --noEmit && npx vite build', { stdio: 'inherit', env })
  execSync('npx evenhub pack .app.pack.json dist', { stdio: 'inherit' })
  fs.renameSync('out.ehpk', 'ginn.ehpk')
  console.log(`\nginn.ehpk ready${url ? ` (server ${url})` : ' (server: http://localhost:8787, change it in the phone panel)'}`)
} finally {
  fs.rmSync('.app.pack.json', { force: true })
}
