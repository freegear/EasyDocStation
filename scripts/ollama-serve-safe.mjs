import { spawn } from 'node:child_process'

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
