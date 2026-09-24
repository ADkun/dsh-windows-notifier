import { strict as assert } from 'node:assert'
import test from 'node:test'

import { DEFAULT_CONFIG, POWERSHELL_APP_ID, normalizeConfig } from '../src/config.js'

test('an omitted config yields every default', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig('nonsense'), { ...DEFAULT_CONFIG })
})

test('a partial config keeps the other defaults', () => {
  const config = normalizeConfig({ includeSubagents: true, sound: 'silent' })
  assert.equal(config.includeSubagents, true)
  assert.equal(config.sound, 'silent')
  assert.equal(config.appId, POWERSHELL_APP_ID)
  assert.equal(config.notifyOnComplete, true)
})

test('malformed values fall back instead of throwing', () => {
  const config = normalizeConfig({
    enabled: 'yes',
    sound: 'loud',
    duration: 'eternal',
    minTaskDurationMs: Number.NaN,
    maxConcurrent: 99,
    timeoutMs: 10,
    appId: '   ',
  })
  assert.equal(config.enabled, true)
  assert.equal(config.sound, 'default')
  assert.equal(config.duration, 'short')
  assert.equal(config.minTaskDurationMs, 0)
  assert.equal(config.maxConcurrent, 8)
  assert.equal(config.timeoutMs, 1000)
  assert.equal(config.appId, POWERSHELL_APP_ID)
})

test('blank paths fall back to auto-detection', () => {
  const config = normalizeConfig({ powershellPath: '  ', scriptPath: '', logFile: '' })
  assert.equal(config.powershellPath, '')
  assert.equal(config.scriptPath, '')
  assert.equal(config.logFile, '')
})

test('explicit paths are trimmed and kept', () => {
  const config = normalizeConfig({ powershellPath: ' C:\\ps\\powershell.exe ', logFile: ' D:\\dsn.log ' })
  assert.equal(config.powershellPath, 'C:\\ps\\powershell.exe')
  assert.equal(config.logFile, 'D:\\dsn.log')
})