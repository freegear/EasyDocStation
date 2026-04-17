import { spawn } from 'node:child_process'
import net from 'node:net'

function isPortOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false

    const finish = (result) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', (err) => {
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH')) {
        finish(false)
        return
      }
      finish(false)
    })

    socket.connect(port, host)
  })
}

const host = '127.0.0.1'
const port = 11434
const alreadyRunning = await isPortOpen(host, port)

if (alreadyRunning) {
  console.log(`[Ollama] already running on ${host}:${port}, skipping duplicate serve.`)
  process.exit(0)
}

const child = spawn('ollama', ['serve'], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderrBuf = ''

child.stdout.on('data', (d) => process.stdout.write(d))
child.stderr.on('data', (d) => {
  const msg = d.toString()
  stderrBuf += msg
  process.stderr.write(msg)
})

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.warn('[Ollama] not installed. skipping local ollama serve.')
    process.exit(0)
  }
  console.error('[Ollama] serve spawn failed:', err.message)
  process.exit(1)
})

child.on('close', (code) => {
  const alreadyRunning = /address already in use/i.test(stderrBuf)
  if (alreadyRunning) {
    console.log('[Ollama] already running on 127.0.0.1:11434, skipping duplicate serve.')
    process.exit(0)
  }
  process.exit(code ?? 1)
})
