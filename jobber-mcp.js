import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
// This line brings in the new strict schemas the SDK requires
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const server = new Server(
  { name: "jobber-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// We now use ListToolsRequestSchema instead of a text string
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_jobber_invoice",
        description: "Gets invoice details from Jobber",
        inputSchema: {
          type: "object",
          properties: {
            invoice_id: { type: "string", description: "The Jobber invoice ID" }
          },
          required: ["invoice_id"]
        }
      },
      {
        name: "create_jobber_expense",
        description: "Logs an expense in Jobber",
        inputSchema: {
          type: "object",
          properties: {
            amount: { type: "number" },
            description: { type: "string" }
          },
          required: ["amount", "description"]
        }
      }
    ]
  };
});

// We now use CallToolRequestSchema instead of a text string
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === "get_jobber_invoice") {
    // We will put the actual Jobber API fetch here later
    return { content: [{ type: "text", text: `Successfully retrieved Jobber invoice ${args.invoice_id}` }] };
  }
  
  if (name === "create_jobber_expense") {
    // We will put the actual Jobber API post here later
    return { content: [{ type: "text", text: `Successfully created Jobber expense for $${args.amount}` }] };
  }
  
  throw new Error(`Tool not found: ${name}`);
});

let transport;
app.get('/mcp', async (req, res) => {
  transport = new SSEServerTransport('/mcp/messages', res);
  await server.connect(transport);
});

app.post('/mcp/messages', express.json(), async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Jobber MCP server running on port ${PORT}`);
});