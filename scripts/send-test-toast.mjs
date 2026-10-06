#!/usr/bin/env node
/**
 * Send one real toast through the exact transport the plugin uses.
 *
 * Use it to confirm the Windows side works before wiring the plugin into a
 * profile — if this script shows nothing, neither will the plugin.
 *
 * Usage:
 *   node scripts/send-test-toast.mjs
 *   node scripts/send-test-toast.mjs "自定义标题" "自定义正文"
 */

import { normalizeConfig } from '../src/config.js'
import { createNotifier } from '../src/notify.js'

const config = normalizeConfig({})
const notifier = createNotifier(config, (message) => console.log(message))

notifier.send(
  process.argv[2] ?? '🔔 dsh-windows-notifier 测试通知',
  [process.argv[3] ?? '看到这条通知，说明 Windows Toast 通道工作正常。'],
)

// Give the short-lived powershell host time to show the toast, then release it.
await new Promise((resolve) => setTimeout(resolve, 6000))
notifier.dispose()