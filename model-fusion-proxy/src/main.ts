import * as http from 'node:http'
import * as fs from 'node:fs'
import { loadConfig } from './proxy/config'
import { ModelRegistry } from './proxy/registry'
import { FusionRouter } from './proxy/router'
import { createApp } from './proxy/app'
import type { FetchFn } from './proxy/provider'

const port = parseInt(process.env['PORT'] ?? '8787', 10)
const configPath = process.env['CONFIG_PATH'] ?? './config.json'

let configData: string
try {
  configData = fs.readFileSync(configPath, 'utf-8')
} catch (err) {
  console.error(`Failed to read config at ${configPath}:`, err)
  process.exit(1)
}

const config = loadConfig(configData)
const registry = new ModelRegistry(config)
const nodeFetch: FetchFn = (url, init) => fetch(url, init)
const router = new FusionRouter(registry, nodeFetch)
const handler = createApp(registry, router)

http.createServer(handler).listen(port, () => {
  console.log(`Model fusion proxy listening on port ${port}`)
})
