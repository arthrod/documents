import { createServer } from 'http'
import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import { html, Html } from '@elysiajs/html'
import { trpc } from '@elysiajs/trpc'
import { appRouter } from './api/root'
import { createTRPCContext } from './api/trpc'
import { setupWebSocket } from './websocket'
import { registerHealthcheck } from './routes/healthcheck'
import { registerLogRoute } from './routes/log'
import { registerUploadRoute } from './routes/upload'
import { registerFileRoutes } from './routes/files'
import { registerDocumentRoutes } from './routes/document'

const app = new Elysia()
  .use(cors())
  .use(html())
  .use(trpc(appRouter, { createContext: createTRPCContext }))
  .get('/', () => (
    <html lang="en">
      <head>
        <title>Hello World</title>
      </head>
      <body>
        <h1>Hello World</h1>
      </body>
    </html>
  ))

registerHealthcheck(app)
registerLogRoute(app)
registerUploadRoute(app)
registerFileRoutes(app)
registerDocumentRoutes(app)

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host}${req.url}`
  const request = new Request(url, {
    method: req.method,
    headers: req.headers as any,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (req as any)
  })

  const response = await app.handle(request)
  res.writeHead(response.status, Object.fromEntries(response.headers as any))
  const body = Buffer.from(await response.arrayBuffer())
  res.end(body)
})

setupWebSocket(server)

const port = Number(process.env.PORT) || 8080
server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})

export type App = typeof app
