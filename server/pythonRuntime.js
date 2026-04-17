const fs = require('fs')
const path = require('path')

function getPythonExecutable() {
  const envBin = process.env.PYTHON_BIN
  if (typeof envBin === 'string' && envBin.trim()) {
    const candidate = envBin.trim()
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  const venv = process.env.VIRTUAL_ENV
  if (typeof venv === 'string' && venv.trim()) {
    const py3 = path.join(venv, 'bin', 'python3')
    if (fs.existsSync(py3)) return py3
    const py = path.join(venv, 'bin', 'python')
    if (fs.existsSync(py)) return py
  }

  return 'python3'
}

module.exports = { getPythonExecutable }
