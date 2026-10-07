import 'dotenv/config';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildAuthorizeUrl, exchangeCodeForTokens, ensureJobberSession } from './jobber/oauth.js';
import { hasTokens, clearTokens, getJobberAuthStatus } from './jobber/tokenStore.js';
import { toolDefinitions, callTool, runBookkeepingReview } from './src/mcp/tools.js';
import {
  buildQboAuthorizeUrl,
  exchangeQboCode,
  hasQboTokens,
  clearQboTokens,
  ensureQboSession,
  startQboTokenKeepalive,
  getQboAuthStatus,
} from './src/services/qbo.js';
import {
  hasSimpleFinAccess,
  claimSetupToken,
  getAccessUrl,
  markTransactionsProcessedDurable,
} from './src/services/simplefin.js';
import { durableSyncConfigured } from './src/lib/durableTokens.js';
import { emailConfigured, defaultNotifyEmail } from './src/services/email.js';
import { runBookkeepingNotify } from './src/services/bookkeepingNotify.js';

const app = express();
app.use(express.json());

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
    { name: 'jobber-mcp', version: '1.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args || {});
  });

  return server;
}

app.get('/health', async (req, res) => {
  const probe = String(req.query.probe || '') === '1';
  let jobberAuth = getJobberAuthStatus();

  if (probe) {
    // Live refresh — also clears dead tokens from Render when invalid
    try {
      const jobberProbe = await ensureJobberSession();
      jobberAuth = {
        connected: Boolean(jobberProbe.ok),
        reason: jobberProbe.reason,
        validated: true,
        error: jobberProbe.error || undefined,
        reconnect: jobberProbe.reconnect,
      };
    } catch (err) {
      jobberAuth = {
        connected: false,
        reason: 'probe_error',
        validated: true,
        error: err.message,
        reconnect: '/oauth/start',
      };
    }

    try {
      await ensureQboSession();
    } catch {
      // qboAuth snapshot below reflects cleared/failed state
    }
  }

  res.json({
    ok: true,
    transport: 'streamable-http',
    jobberConnected: hasTokens() && jobberAuth.reason !== 'token_invalid',
    qboConnected: hasQboTokens(),
    jobberAuth,
    qboAuth: getQboAuthStatus(),
    simplefinConfigured: hasSimpleFinAccess(),
    simplefinAccessUrlSaved: Boolean(getAccessUrl()),
    durableTokenSync: durableSyncConfigured(),
    hint:
      'Add ?probe=1 to validate refresh tokens live (clears dead Jobber/QBO secrets from Render env).',
    env: {
      JOBBER_CLIENT_ID: Boolean(process.env.JOBBER_CLIENT_ID),
      JOBBER_CLIENT_SECRET: Boolean(process.env.JOBBER_CLIENT_SECRET),
      JOBBER_REDIRECT_URI: Boolean(process.env.JOBBER_REDIRECT_URI),
      JOBBER_REFRESH_TOKEN: Boolean(process.env.JOBBER_REFRESH_TOKEN),
      QBO_CLIENT_ID: Boolean(process.env.QBO_CLIENT_ID),
      QBO_CLIENT_SECRET: Boolean(process.env.QBO_CLIENT_SECRET),
      QBO_REDIRECT_URI: Boolean(process.env.QBO_REDIRECT_URI),
      QBO_REFRESH_TOKEN: Boolean(process.env.QBO_REFRESH_TOKEN),
      QBO_REALM_ID: Boolean(process.env.QBO_REALM_ID),
      SIMPLEFIN_SETUP_TOKEN: Boolean(process.env.SIMPLEFIN_SETUP_TOKEN),
      SIMPLEFIN_ACCESS_URL: Boolean(process.env.SIMPLEFIN_ACCESS_URL),
      RENDER_API_KEY: Boolean(process.env.RENDER_API_KEY),
      RENDER_SERVICE_ID: Boolean(process.env.RENDER_SERVICE_ID),
      RESEND_API_KEY: Boolean(process.env.RESEND_API_KEY),
      RESEND_FROM: Boolean(
        process.env.RESEND_FROM || process.env.BOOKKEEPING_EMAIL_FROM
      ),
      BOOKKEEPING_NOTIFY_EMAIL: Boolean(process.env.BOOKKEEPING_NOTIFY_EMAIL),
      CURSOR_AGENT_URL: Boolean(
        process.env.CURSOR_AGENT_URL ||
          process.env.BOOKKEEPING_CURSOR_AGENT_URL
      ),
    },
    emailConfigured: emailConfigured(),
    bookkeepingNotifyEmail: defaultNotifyEmail(),
  });
});

function legalPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — VP CFO</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}
  h1{font-size:1.5rem} h2{font-size:1.1rem;margin-top:1.5rem}
  a{color:#0b57d0}
</style></head><body>
<h1>${title}</h1>
${bodyHtml}
<p><small>Private internal app for Veenstra Painting bookkeeping (Jobber + QuickBooks + bank feeds).</small></p>
</body></html>`;
}

app.get('/privacy', (_req, res) => {
  res.type('html').send(
    legalPage(
      'Privacy Policy',
      `<p>Effective date: September 20, 2026</p>
<p>VP CFO is a private internal tool used by Veenstra Painting to connect Jobber, QuickBooks Online, and read-only bank feeds for bookkeeping.</p>
<h2>Data we access</h2>
<ul>
  <li>QuickBooks Online accounting data you authorize (expenses, bills, accounts, reports).</li>
  <li>Jobber data you authorize (invoices, expenses, related job records).</li>
  <li>Read-only bank transaction data via SimpleFIN Bridge for accounts you connect.</li>
</ul>
<h2>How we use data</h2>
<p>Data is used only to perform bookkeeping, categorization, job costing, and reporting for the business that authorized the connections. We do not sell data.</p>
<h2>Storage</h2>
<p>OAuth tokens and processed-transaction markers are stored securely for the service to operate. Access is limited to authorized operators of this private app.</p>
<h2>Third parties</h2>
<p>Connections use Intuit (QuickBooks), Jobber, and SimpleFIN. Their policies also apply to data held on their platforms.</p>
<h2>Contact</h2>
<p>Questions: contact the Veenstra Painting operations team that manages this app.</p>`
    )
  );
});

app.get('/terms', (_req, res) => {
  res.type('html').send(
    legalPage(
      'End-User License Agreement',
      `<p>Effective date: September 20, 2026</p>
<p>VP CFO is licensed for internal use by Veenstra Painting only. It is not a public App Store product.</p>
<h2>License</h2>
<p>You may use this app solely to manage the authorizing company's Jobber, QuickBooks Online, and connected bank-feed workflows.</p>
<h2>Restrictions</h2>
<p>Do not redistribute, resell, or provide the app to unrelated third parties. Do not attempt to access data for companies you are not authorized to manage.</p>
<h2>Disclaimer</h2>
<p>The app is provided as-is for internal operations. You are responsible for reviewing AI-assisted or automated bookkeeping actions before relying on them.</p>
<h2>Termination</h2>
<p>Disconnect the app in QuickBooks or revoke OAuth access to end the connection at any time.</p>`
    )
  );
});

app.get('/', (_req, res) => {
  res.type('html').send(
    legalPage(
      'VP CFO',
      `<p>Private bookkeeping bridge for Jobber, QuickBooks Online, and SimpleFIN.</p>
<ul>
  <li><a href="/qbo/auth">Connect QuickBooks</a></li>
  <li><a href="/oauth/start">Connect Jobber</a></li>
  <li><a href="/privacy">Privacy Policy</a></li>
  <li><a href="/terms">Terms / EULA</a></li>
  <li><a href="/health">Health</a></li>
</ul>`
    )
  );
});

// --- Jobber OAuth ---
app.get('/oauth/start', (_req, res) => {
  try {
    res.redirect(buildAuthorizeUrl());
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
    const saved = await exchangeCodeForTokens(String(code), String(state));
    const syncNote = saved?.durableSync?.synced
      ? 'Refresh token saved to Render env (survives deploys).'
      : saved?.durableSync?.updated?.length === 0
        ? 'Refresh token unchanged — no Render redeploy triggered.'
      : 'Tip: set RENDER_API_KEY + RENDER_SERVICE_ID so tokens survive deploys automatically.';
    res.type('html').send(
      `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:36rem;margin:2rem auto;padding:0 1rem">
      <h1>Jobber connected</h1>
      <p>Tokens saved. You can close this tab.</p>
      <p><small>${syncNote}</small></p>
      </body></html>`
    );
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

app.post('/oauth/disconnect', async (_req, res) => {
  await clearTokens({ clearDurable: true });
  res.json({ ok: true, jobberConnected: false });
});

// --- QuickBooks OAuth ---
app.get('/qbo/auth', (_req, res) => {
  try {
    res.redirect(buildQboAuthorizeUrl());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/qbo/callback', async (req, res) => {
  const { code, state, realmId, error, error_description: errorDescription } = req.query;
  if (error) {
    res.status(400).send(`QBO OAuth error: ${errorDescription || error}`);
    return;
  }
  if (!code || !state) {
    res.status(400).send('Missing code or state from Intuit callback');
    return;
  }
  try {
    const saved = await exchangeQboCode({
      code: String(code),
      state: String(state),
      realmId: realmId ? String(realmId) : null,
    });
    const syncNote = saved?.durableSync?.synced
      ? 'Refresh token saved to Render env (survives deploys).'
      : saved?.durableSync?.updated?.length === 0
        ? 'Refresh token unchanged — no Render redeploy triggered.'
      : 'Tip: set RENDER_API_KEY + RENDER_SERVICE_ID so tokens survive deploys automatically.';
    res.type('html').send(
      `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:36rem;margin:2rem auto;padding:0 1rem">
      <h1>QuickBooks connected</h1>
      <p>Tokens saved. You can close this tab and use QBO MCP tools.</p>
      <p><small>${syncNote}</small></p>
      </body></html>`
    );
  } catch (err) {
    res.status(500).send(`QBO token exchange failed: ${err.message}`);
  }
});

app.post('/qbo/disconnect', async (_req, res) => {
  await clearQboTokens({ clearDurable: true });
  res.json({ ok: true, qboConnected: false });
});

app.get('/qbo/disconnect', async (_req, res) => {
  await clearQboTokens({ clearDurable: true });
  res.type('html').send(
    legalPage(
      'QuickBooks disconnected',
      `<p>VP CFO has cleared local QuickBooks tokens for this server.</p>
<p><a href="/qbo/auth">Reconnect QuickBooks</a></p>`
    )
  );
});

/**
 * Stage-only bookkeeping brief → email (Resend).
 * Body: { to?, startDate?, includeProcessed?, dryRun?, agentUrl?, maxItems?, skipHealthGate? }
 * Optional header: x-bookkeeping-notify-secret (when BOOKKEEPING_NOTIFY_SECRET is set).
 */
app.post('/bookkeeping/notify', async (req, res) => {
  const secret = process.env.BOOKKEEPING_NOTIFY_SECRET?.trim();
  if (secret) {
    const provided =
      req.get('x-bookkeeping-notify-secret') ||
      (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (provided !== secret) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
  }

  try {
    const body = req.body || {};
    const result = await runBookkeepingNotify({
      runReview: runBookkeepingReview,
      to: body.to,
      agentUrl: body.agentUrl,
      dryRun: Boolean(body.dryRun),
      skipHealthGate: Boolean(body.skipHealthGate),
      probeQbo: Boolean(body.probeQbo),
      maxItems: body.maxItems,
      reviewArgs: {
        startDate: body.startDate,
        includeProcessed: Boolean(body.includeProcessed),
        excludeBookedInQbo:
          body.excludeBookedInQbo === undefined
            ? true
            : Boolean(body.excludeBookedInQbo),
        includeSherwinBills: body.includeSherwinBills,
        accountId: body.accountId,
      },
    });
    const status = result.blocked ? 503 : 200;
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Mark staging lines seen after approve/skip in Cursor (dedupe only — no QBO writes).
 * Body: { transactionIds: string[], durable?: boolean }
 */
app.post('/bookkeeping/mark-seen', async (req, res) => {
  const secret = process.env.BOOKKEEPING_NOTIFY_SECRET?.trim();
  if (secret) {
    const provided =
      req.get('x-bookkeeping-notify-secret') ||
      (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (provided !== secret) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
  }

  try {
    const ids = Array.isArray(req.body?.transactionIds)
      ? req.body.transactionIds
      : [];
    if (!ids.length) {
      res.status(400).json({ ok: false, error: 'transactionIds required' });
      return;
    }
    const result = await markTransactionsProcessedDurable(ids);
    res.json({
      ok: true,
      ...result,
      note: 'Marked seen for email dedupe only — no QuickBooks writes.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- SimpleFIN one-time claim helper (optional HTTP) ---
app.post('/simplefin/claim', async (req, res) => {
  try {
    const token = req.body?.setupToken || process.env.SIMPLEFIN_SETUP_TOKEN;
    if (!token) {
      res.status(400).json({ error: 'Provide setupToken in body or SIMPLEFIN_SETUP_TOKEN env' });
      return;
    }
    const accessUrl = await claimSetupToken(token);
    // Never echo credentials — only confirm host
    const scrubbed = accessUrl.replace(/^(https?:\/\/)[^/]+@/, '$1***@');
    res.json({
      ok: true,
      message:
        'Access URL claimed and saved to .simplefin-access.json. Copy SIMPLEFIN_ACCESS_URL into Render env for persistence across deploys.',
      accessUrlPreview: scrubbed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MCP (Streamable HTTP) ---
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
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
  console.log(`Spark CFO MCP server running on port ${PORT}`);
  console.log(`Health:     http://localhost:${PORT}/health`);
  console.log(`MCP:        POST http://localhost:${PORT}/mcp`);
  console.log(`Notify:     POST http://localhost:${PORT}/bookkeeping/notify`);
  console.log(`Jobber:     http://localhost:${PORT}/oauth/start`);
  console.log(`QuickBooks: http://localhost:${PORT}/qbo/auth`);

  // Restore sessions from durable refresh tokens; clear dead ones from Render
  ensureJobberSession().then((result) => {
    if (result.ok) {
      console.log('Jobber session restored from refresh token');
    } else if (result.reason === 'token_invalid') {
      console.warn('Jobber refresh token invalid — reconnect at /oauth/start');
    } else if (result.reason !== 'not_connected') {
      console.warn('Jobber session restore:', result.reason, result.error || '');
    }
  });

  ensureQboSession().then((result) => {
    if (result.ok) {
      console.log('QBO session restored from refresh token');
    } else if (result.reason !== 'not_connected') {
      console.warn('QBO session restore:', result.reason);
    }
  });
  startQboTokenKeepalive();
});
