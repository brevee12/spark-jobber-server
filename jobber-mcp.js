import 'dotenv/config';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildAuthorizeUrl, exchangeCodeForTokens } from './jobber/oauth.js';
import { getInvoice, createExpense } from './jobber/client.js';
import { hasTokens, clearTokens } from './jobber/tokenStore.js';

const app = express();
app.use(express.json());

// Gemini (and browsers) need CORS to verify/connect the MCP endpoint
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, mcp-session-id, Accept, Last-Event-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function createMcpServer() {
  const server = new Server(
    { name: 'jobber-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_jobber_invoice',
        description: 'Gets invoice details from Jobber by invoice ID (GraphQL EncodedId)',
        inputSchema: {
          type: 'object',
          properties: {
            invoice_id: {
              type: 'string',
              description: 'The Jobber invoice EncodedId',
            },
          },
          required: ['invoice_id'],
        },
      },
      {
        name: 'create_jobber_expense',
        description: 'Logs a business expense in Jobber',
        inputSchema: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Expense total' },
            description: { type: 'string', description: 'Expense description' },
            title: { type: 'string', description: 'Optional short title' },
            date: {
              type: 'string',
              description: 'Optional ISO-8601 date (defaults to now)',
            },
            linked_job_id: {
              type: 'string',
              description: 'Optional Jobber job EncodedId to link',
            },
          },
          required: ['amount', 'description'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'get_jobber_invoice') {
        const invoice = await getInvoice(args.invoice_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(invoice, null, 2) }],
        };
      }

      if (name === 'create_jobber_expense') {
        const expense = await createExpense({
          amount: args.amount,
          description: args.description,
          title: args.title,
          date: args.date,
          linkedJobId: args.linked_job_id,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(expense, null, 2) }],
        };
      }

      throw new Error(`Tool not found: ${name}`);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    jobberConnected: hasTokens(),
    transport: 'streamable-http',
    env: {
      JOBBER_CLIENT_ID: Boolean(process.env.JOBBER_CLIENT_ID),
      JOBBER_CLIENT_SECRET: Boolean(process.env.JOBBER_CLIENT_SECRET),
      JOBBER_REDIRECT_URI: Boolean(process.env.JOBBER_REDIRECT_URI),
    },
  });
});

app.get('/oauth/start', (_req, res) => {
  try {
    const url = buildAuthorizeUrl();
    res.redirect(url);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    res.status(400).send(`Jobber OAuth error: ${errorDescription || error}`);
    return;
  }

  if (!code || !state) {
    res.status(400).send('Missing code or state from Jobber callback');
    return;
  }

  try {
    await exchangeCodeForTokens(String(code), String(state));
    res.send(
      'Jobber connected. Tokens saved. You can close this tab and use the MCP tools.'
    );
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

app.post('/oauth/disconnect', (_req, res) => {
  clearTokens();
  res.json({ ok: true, jobberConnected: false });
});

// Gemini Spark expects Streamable HTTP MCP (POST /mcp), not legacy SSE
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — works on Render free tier
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for Streamable HTTP.' },
    id: null,
  });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Jobber MCP server running on port ${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log(`MCP:     POST http://localhost:${PORT}/mcp`);
  console.log(`Connect: http://localhost:${PORT}/oauth/start`);
});
