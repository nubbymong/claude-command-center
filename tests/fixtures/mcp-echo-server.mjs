#!/usr/bin/env node
/**
 * Minimal real MCP server over stdio, used by the live proxy integration test
 * (tests/integration/mcp-proxy-live.test.ts). Exposes two tools so the test can
 * exercise real tools/list + tools/call through the actual stdio transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' }, { capabilities: {} })

server.tool(
  'echo',
  'Echo back the provided text',
  { text: z.string().describe('text to echo back') },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
)

server.tool(
  'add',
  'Add two numbers and return the sum',
  { a: z.number().describe('first addend'), b: z.number().describe('second addend') },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
